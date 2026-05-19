/**
 * ★ MknApi 契约 + 外壳适配层。
 *
 * 历史:Phase 2 曾是"冻结的 Electron IPC 契约",实现位于 electron/preload.ts。
 * Tauri 迁移后,preload 不复存在——本文件**接口定义逐字不变**(仍是渲染端
 * 唯一接缝,src/ui、src/app.ts 一行不改),仅把 `getShell()` 的实现从读
 * `window.mkn` 改为基于 `@tauri-apps/api` 的 invoke/event 适配。
 *
 * 边界:接口 = 冻结契约,任何方法签名/语义都不得改;若不够用反馈协调者统一改。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** hot-exit 会话快照:当前文件(未命名草稿为 null)+ 编辑器全文。 */
export interface SessionCache {
  path: string | null;
  content: string;
}

/** 原生菜单 / 快捷键触发的动作,主进程发给渲染端 */
export type MenuAction =
  | "new"
  | "open"
  | "openFolder"
  | "save"
  | "saveAs"
  | "find"
  | "toggleSidebar"
  | "exportHtml"
  | "exportPdf"
  | "exportDocx";

export interface MknApi {
  /**
   * 打开文件对话框;取消返回 null。
   * `path === ""` 表示后端有损导入(如 .docx):渲染端当作未命名草稿载入,
   * 绝不回写原文件。
   */
  openFileDialog(): Promise<{ path: string; content: string } | null>;
  /** 选择文件夹作为文件树根;取消返回 null */
  openFolderDialog(): Promise<string | null>;
  /** 列目录(文件树用),按 名称排序、目录在前 */
  readDir(dirPath: string): Promise<FileEntry[]>;
  /** 读文件文本内容(UTF-8) */
  readFile(path: string): Promise<string>;
  /** 写文件(原样写回,保证 .md 零损失往返) */
  saveFile(path: string, content: string): Promise<void>;
  /** 另存为对话框;返回所选路径,取消返回 null */
  saveFileAs(content: string, defaultPath?: string): Promise<string | null>;

  /** 监听某文件的外部改动(切换文件时主进程自动只盯当前文件即可) */
  watchFile(path: string): void;
  /** 外部改动回调;返回取消订阅函数 */
  onFileChanged(cb: (path: string) => void): () => void;

  /** 原生菜单 / 快捷键动作回调;返回取消订阅函数 */
  onMenuAction(cb: (action: MenuAction) => void): () => void;

  /** 最近文件列表(持久化在主进程) */
  getRecentFiles(): Promise<string[]>;
  addRecentFile(path: string): Promise<void>;

  /** 反映"未保存"状态到窗口(macOS 标题栏圆点;不再用于关闭确认) */
  setDocumentEdited(edited: boolean): void;

  /* ── 访达 / Dock / 命令行打开文件(Phase 2 后补:之前完全缺失,
        双击 .md 只会空开成"未命名")────────────────────────────── */

  /**
   * 主进程经访达双击 / 拖到 Dock 图标 / 命令行参数请求打开某文件时回调。
   * 返回取消订阅函数。渲染端据此走正常"打开文档"流程(脏文档先确认)。
   */
  onOpenPath(cb: (path: string) => void): () => void;

  /** 让系统窗口标题 / macOS 标题栏代理图标跟随当前文档(null = 未命名草稿)。 */
  setDocTitle(path: string | null): void;

  /* ── 会话缓存(hot-exit:关闭不再提示保存) ───────────────────── */

  /**
   * 缓存当前会话(当前文件路径 + 全文)。fire-and-forget,渲染端防抖调用,
   * 关闭/失焦时再补一次。主进程写到 userData/session.json。
   */
  cacheSession(session: SessionCache): void;

  /** 启动时取回上次缓存的会话;无缓存返回 null。 */
  loadSession(): Promise<SessionCache | null>;

  /**
   * 保存粘贴/拖拽进来的图片到当前文档同级 `assets/` 目录。
   * @param docPath 当前文档绝对路径(据此定位同级 assets/;未命名草稿不可用)
   * @param data    图片二进制
   * @param ext     扩展名(不含点,如 "png" / "jpg")
   * @returns 可直接写进 markdown 的相对路径(如 `assets/xxxx.png`)
   */
  saveAsset(docPath: string, data: Uint8Array, ext: string): Promise<string>;

  /* ── Phase 4 导出 ───────────────────────────────────────────────── */

  /**
   * 导出独立 HTML(已内联主题 CSS 的完整文档)。弹另存对话框。
   * @returns 保存路径;取消返回 null
   */
  exportHtml(html: string, defaultName: string): Promise<string | null>;

  /**
   * 导出 PDF。传入与导出 HTML 相同的独立 HTML,主进程用离屏窗口
   * printToPDF 渲染。弹另存对话框。
   * @returns 保存路径;取消返回 null
   */
  exportPdf(html: string, defaultName: string): Promise<string | null>;

  /** 系统是否装了 pandoc(决定是否启用 Word/LaTeX/epub 导出)。 */
  hasPandoc(): Promise<boolean>;

  /**
   * 经 pandoc 把 markdown 转成指定格式(如 "docx"/"latex"/"epub")。
   * 弹另存对话框,主进程调 pandoc 落盘。
   * @returns 保存路径;取消/无 pandoc 返回 null
   */
  pandocExport(
    markdown: string,
    format: string,
    defaultName: string
  ): Promise<string | null>;
}

declare global {
  interface Window {
    /** 旧 Electron 渲染端遗留;Tauri 下不存在,仅保留类型不破坏既有引用。 */
    mkn?: MknApi;
    /** Tauri v2 注入;据此判定是否在 Tauri 外壳内(纯浏览器 dev 下缺失)。 */
    __TAURI_INTERNALS__?: unknown;
  }
}

/** 把 Tauri 的异步 listen(返回 Promise<UnlistenFn>)适配成 MknApi 约定的
 *  同步取消订阅函数:持有 promise,取消时 then 掉。 */
function toUnsub(p: Promise<UnlistenFn>): () => void {
  return () => {
    void p.then((f) => f()).catch(() => {});
  };
}

/** 构造基于 Tauri invoke/event 的 MknApi 实现。命令名用 Rust 侧 snake_case;
 *  参数键用 camelCase(Tauri 默认自动转 snake_case 形参)。 */
function createTauriApi(): MknApi {
  return {
    openFileDialog: () => invoke("open_file_dialog"),
    openFolderDialog: () => invoke("open_folder_dialog"),
    readDir: (dirPath) => invoke("read_dir", { dirPath }),
    readFile: (path) => invoke("read_file", { path }),
    saveFile: (path, content) => invoke("save_file", { path, content }),
    saveFileAs: (content, defaultPath) =>
      invoke("save_file_as", { content, defaultPath: defaultPath ?? null }),

    // fire-and-forget:不回传 promise(契约返回 void),失败静默。
    watchFile: (path) => {
      void invoke("watch_file", { path }).catch(() => {});
    },
    onFileChanged: (cb) =>
      toUnsub(listen<string>("mkn:file-changed", (e) => cb(e.payload))),

    onMenuAction: (cb) =>
      toUnsub(listen<MenuAction>("mkn:menu-action", (e) => cb(e.payload))),

    getRecentFiles: () => invoke("get_recent_files"),
    addRecentFile: (path) => invoke("add_recent_file", { path }),

    setDocumentEdited: (edited) => {
      void invoke("set_document_edited", { edited }).catch(() => {});
    },

    onOpenPath: (cb) =>
      toUnsub(listen<string>("mkn:open-path", (e) => cb(e.payload))),

    setDocTitle: (path) => {
      void invoke("set_doc_title", { path: path ?? null }).catch(() => {});
    },

    cacheSession: (session) => {
      void invoke("cache_session", { session }).catch(() => {});
    },
    loadSession: () => invoke("load_session"),

    saveAsset: (docPath, data, ext) =>
      // Tauri 把 number[] 反序列化为 Rust Vec<u8>。
      invoke("save_asset", { docPath, data: Array.from(data), ext }),

    exportHtml: (html, defaultName) =>
      invoke("export_html", { html, defaultName }),
    exportPdf: (html, defaultName) =>
      invoke("export_pdf", { html, defaultName }),
    hasPandoc: () => invoke("has_pandoc"),
    pandocExport: (markdown, format, defaultName) =>
      invoke("pandoc_export", { markdown, format, defaultName }),
  };
}

/** 单例:getShell 可能被多处多次调用(app.ts 顶层 + 每次粘贴图片),
 *  外壳实现只建一次;renderer_ready 也只发一次。 */
let cached: MknApi | null | undefined;

/**
 * 渲染端统一取用入口:
 *  - 在 Tauri 外壳内 → 返回基于 invoke/event 的 MknApi 实现
 *  - 纯浏览器 dev(无 __TAURI_INTERNALS__)→ 返回 null,壳层降级为无文件
 *    功能的纯编辑器(与旧行为一致,bootBrowser 路径不变)
 */
export function getShell(): MknApi | null {
  if (cached !== undefined) return cached;

  const inTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!inTauri) {
    cached = null;
    return cached;
  }

  cached = createTauriApi();

  // 通知后端"渲染端 IPC 已接好",补发访达冷启动暂存的待打开文件
  // (对齐 electron 的 did-finish-load → flush pendingOpenFile)。
  // 略微延后:让 app.ts 的 bootShell 先把 onOpenPath 等监听挂上、其
  // listen() 注册往返完成,backend 再 emit open-path 才不会漏
  // (与旧版 did-finish-load 同属"靠时机"的冷启动取舍)。
  setTimeout(() => {
    void invoke("renderer_ready").catch(() => {});
  }, 120);

  return cached;
}
