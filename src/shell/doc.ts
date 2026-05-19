/**
 * 文档生命周期 —— 应用壳与编辑器内核之间的"当前文档"状态机。
 *
 * 职责:维护当前文件 path(可空 = 未命名草稿)、已保存基线内容、
 * dirty 判定、防抖自动保存,并把"未保存"态反映到窗口。
 *
 * 设计铁律(与 src/core 的关系):
 *  - 绝不改 src/core。内核只暴露 createEditor / loadDoc / view.state.doc.toString()。
 *  - 变更监听靠"动态追加扩展"挂到既有 view 上(StateEffect.appendConfig),
 *    不往内核装配里塞东西。
 *  - 保存严格写回 view.state.doc.toString(),零转换 —— 本地 .md 零损失往返。
 */

import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { loadDoc } from "../core/editor";
import type { MknApi } from "./ipc";

/** 自动保存防抖窗口(ms)。停止输入约 0.8s 落盘,够安静也够及时。 */
const AUTOSAVE_DELAY = 800;

/**
 * 会话缓存防抖窗口(ms)。比自保存短得多 —— hot-exit 的命脉,
 * 缓存越新,关闭后能恢复的越完整。停手 0.35s 即写一次。
 */
const CACHE_DELAY = 350;

/**
 * 是否像二进制文件(.docx/.pdf/图片/zip 等)。
 * MKN 是 Markdown 编辑器,只吃纯文本;按 UTF-8 读二进制会得到乱码,
 * 必须在灌进编辑器前拦下,给用户明确提示而不是一屏 .
 *  - NUL 字节:zip(docx/xlsx/pptx)、pdf、图片几乎必含;
 *  - 大量 U+FFFD:UTF-8 解码失败的替换符占比高 → 二进制。
 */
function looksBinary(s: string): boolean {
  const sample = s.slice(0, 8192);
  if (sample.includes("\u0000")) return true;
  const n = Math.min(sample.length, 1024);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    if (sample.charCodeAt(i) === 0xfffd) bad++;
  }
  return n > 0 && bad / n > 0.1;
}

export interface DocLifecycle {
  /** 打开一个磁盘文件:读内容 → loadDoc → 设基线/path/watch。 */
  openPath(path: string): Promise<void>;
  /** 用已知内容(对话框已读好的)打开:省一次 readFile。 */
  openWithContent(path: string, content: string): void;
  /**
   * 把外部格式(如 .docx)有损导入的内容载入为未命名草稿:
   * path 置空 → 不自动保存、不回写原文件,想留由用户显式另存为 .md。
   */
  openImported(content: string): void;
  /** 新建空白未命名草稿(清空编辑器,path 置空)。 */
  newDoc(): void;
  /** 主动保存。无 path 时走另存为;返回最终是否已落盘。 */
  save(): Promise<boolean>;
  /** 另存为:选路径 → 写盘 → 该路径成为当前文件。返回是否成功。 */
  saveAs(): Promise<boolean>;
  /** 当前是否有未保存修改。 */
  isDirty(): boolean;
  /** 当前文件路径(未命名草稿为 null)。 */
  currentPath(): string | null;
  /** 当前编辑器全文快照(零转换)。 */
  snapshot(): string;
  /**
   * 启动时从 hot-exit 缓存恢复会话。
   * @param baseline 壳层据磁盘文件给定:文件现存内容 → dirty 反映"缓存 vs
   *   磁盘"差异;未命名草稿或文件已不在,传 "" → 非空内容即视为未保存。
   */
  restoreSession(path: string | null, content: string, baseline: string): void;
  /** 立即把当前会话推给主进程缓存(失焦/关闭前补一次)。 */
  flushCache(): void;
  /** dirty 态变化时回调(供壳层刷新文件名圆点)。 */
  onDirtyChange(cb: (dirty: boolean) => void): void;
  /** 当前文件路径变化时回调(供壳层刷新标题 / 文件树高亮)。 */
  onPathChange(cb: (path: string | null) => void): void;
  /** 打开失败(二进制/非文本文件)时回调,壳层据此给用户友好提示。 */
  onOpenError(cb: (path: string) => void): void;
}

/**
 * 绑定一个已构建好的 EditorView,返回文档生命周期控制器。
 * @param view  由 createEditor 建好的编辑器(本模块不创建/不重建它)
 * @param api   IPC;纯浏览器 dev 下传 null —— 此时退化为"只跟踪 dirty、
 *              不落盘"的内存文档(壳层在无 shell 时本就不调用文件操作)。
 */
export function createDocLifecycle(
  view: EditorView,
  api: MknApi | null
): DocLifecycle {
  /** 当前文件路径;null = 未命名草稿。 */
  let path: string | null = null;
  /** 已保存基线:最后一次"打开/保存"后的全文。dirty = 当前文 ≠ 它。 */
  let baseline = view.state.doc.toString();
  /** 上一次对外广播的 dirty 值,用于去抖回调。 */
  let lastDirty = false;
  /**
   * "程序化整体替换"抑制标志。loadDoc 会触发 docChanged,
   * 但那是"打开/重载"不是用户编辑,绝不能误判为 dirty,也不能触发自保存。
   */
  let suppressChange = false;
  /** 自动保存防抖句柄。 */
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** 会话缓存防抖句柄。 */
  let cacheTimer: ReturnType<typeof setTimeout> | null = null;

  let dirtyCb: ((dirty: boolean) => void) | null = null;
  let pathCb: ((path: string | null) => void) | null = null;
  let openErrCb: ((path: string) => void) | null = null;

  /** 实时 dirty:逐字符比较当前全文与基线。 */
  function computeDirty(): boolean {
    return view.state.doc.toString() !== baseline;
  }

  /** dirty 态有变化才广播,并同步窗口"已编辑"标记。 */
  function syncDirty(): void {
    const d = computeDirty();
    if (d === lastDirty) return;
    lastDirty = d;
    api?.setDocumentEdited(d);
    dirtyCb?.(d);
  }

  function emitPath(): void {
    pathCb?.(path);
  }

  /** 清掉待执行的自动保存(打开/新建/手动保存后调用)。 */
  function cancelAutosave(): void {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
  }

  /**
   * 安排一次防抖自动保存:仅当有 path 且确实 dirty 才落盘。
   * 未命名草稿不自动弹另存为对话框(打扰),交由用户显式保存。
   */
  function scheduleAutosave(): void {
    if (!api || path === null) return;
    cancelAutosave();
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      void doSave();
    }, AUTOSAVE_DELAY);
  }

  /**
   * 实际写盘。把当前快照作为本次"目标基线"先取下来,写成功后再设为基线,
   * 避免落盘期间用户继续输入被错误并入基线(那会丢失 dirty)。
   */
  async function doSave(): Promise<boolean> {
    if (!api || path === null) return false;
    if (!computeDirty()) return true; // 已是干净的,无需写
    const content = view.state.doc.toString();
    await api.saveFile(path, content);
    baseline = content;
    syncDirty();
    api.setDocumentEdited(false);
    void api.addRecentFile(path);
    return true;
  }

  /** 立即把当前会话(path + 全文)推给主进程缓存。 */
  function flushCache(): void {
    if (cacheTimer !== null) {
      clearTimeout(cacheTimer);
      cacheTimer = null;
    }
    api?.cacheSession({ path, content: view.state.doc.toString() });
  }

  /** 防抖推送会话缓存 —— hot-exit 命脉,频率高于自保存,且与文件路径无关
   *  (未命名草稿也缓存),关闭/失焦再由 flushCache 补一次。 */
  function scheduleCache(): void {
    if (!api) return;
    if (cacheTimer !== null) clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      cacheTimer = null;
      api.cacheSession({ path, content: view.state.doc.toString() });
    }, CACHE_DELAY);
  }

  /** 编辑器内容变化(已排除程序化替换)时的统一入口。 */
  function onDocChanged(): void {
    if (suppressChange) return;
    syncDirty();
    scheduleAutosave();
    scheduleCache(); // 每次编辑都刷新 hot-exit 缓存
  }

  // 动态追加变更监听 —— 不碰内核装配。
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onDocChanged();
      })
    ),
  });

  /**
   * 程序化整体替换文档:抑制变更回调,replace 后把它定为新基线。
   * 用于打开文件与外部改动重载 —— 它们绝不是 dirty。
   */
  function applyContent(content: string): void {
    suppressChange = true;
    loadDoc(view, content);
    baseline = content;
    suppressChange = false;
    // 整体替换后必然回到"干净",同步态(可能从 dirty→clean)。
    syncDirty();
    // 打开/新建/重载后,缓存立即对齐新文档(否则关闭会恢复成旧文档)。
    flushCache();
  }

  async function openPath(p: string): Promise<void> {
    if (!api) return;
    const content = await api.readFile(p);
    if (looksBinary(content)) {
      openErrCb?.(p); // 不灌乱码、不改当前文档
      return;
    }
    cancelAutosave();
    applyContent(content);
    path = p;
    emitPath();
    api.watchFile(p);
    void api.addRecentFile(p);
    view.focus();
  }

  function openWithContent(p: string, content: string): void {
    if (looksBinary(content)) {
      openErrCb?.(p);
      return;
    }
    cancelAutosave();
    applyContent(content);
    path = p;
    emitPath();
    api?.watchFile(p);
    void api?.addRecentFile(p);
    view.focus();
  }

  function newDoc(): void {
    cancelAutosave();
    applyContent("");
    path = null;
    emitPath();
    view.focus();
  }

  function openImported(content: string): void {
    // 有损导入(.docx 等):当未命名草稿。path 保持 null →
    // scheduleAutosave 不落盘、不 watch、不进最近文件,原文件零副作用。
    cancelAutosave();
    applyContent(content);
    path = null;
    emitPath();
    view.focus();
  }

  async function saveAs(): Promise<boolean> {
    if (!api) return false;
    const content = view.state.doc.toString();
    const chosen = await api.saveFileAs(content, path ?? undefined);
    if (chosen === null) return false; // 用户取消
    // saveFileAs 主进程已写盘;这里只更新归属与基线。
    cancelAutosave();
    path = chosen;
    baseline = content;
    emitPath();
    syncDirty();
    api.setDocumentEdited(false);
    void api.addRecentFile(chosen);
    api.watchFile(chosen);
    flushCache(); // 路径已变,缓存对齐新归属
    view.focus();
    return true;
  }

  async function save(): Promise<boolean> {
    if (!api) return false;
    if (path === null) return saveAs();
    cancelAutosave();
    return doSave();
  }

  /**
   * 从缓存恢复:内容灌进编辑器,path 与 baseline 由壳层给定。
   * baseline 区别于 applyContent(后者总把内容设为基线 = 干净):
   * 这里 baseline 来自磁盘文件(或 ""),使 dirty 真实反映"缓存里
   * 还没存盘的改动",用户一打开就看到上次没保存的工作 + 圆点。
   */
  function restoreSession(
    p: string | null,
    content: string,
    base: string
  ): void {
    cancelAutosave();
    suppressChange = true;
    loadDoc(view, content);
    suppressChange = false;
    baseline = base;
    path = p;
    emitPath();
    syncDirty(); // dirty = content !== base
    if (p) api?.watchFile(p);
    flushCache(); // 缓存与恢复后的状态对齐
    view.focus();
  }

  return {
    openPath,
    openWithContent,
    openImported,
    newDoc,
    save,
    saveAs,
    isDirty: () => computeDirty(),
    currentPath: () => path,
    snapshot: () => view.state.doc.toString(),
    restoreSession,
    flushCache,
    onDirtyChange: (cb) => {
      dirtyCb = cb;
    },
    onPathChange: (cb) => {
      pathCb = cb;
    },
    onOpenError: (cb) => {
      openErrCb = cb;
    },
  };
}
