/**
 * ★ 冻结的 IPC 契约 —— 渲染端 ↔ Electron 主进程 的唯一接口。
 *
 * 这是 Phase 2 三个并行 agent 的共享接缝:
 *  - 主进程 / preload(electron/)实现并经 contextBridge 暴露为 window.mkn
 *  - 文件树(src/ui/)与应用壳(src/app.ts)只通过本契约调用
 *
 * 不要修改本文件。若发现契约不够用,反馈给协调者统一改,
 * 不要各自扩展(否则集成必崩)。
 */

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
  /** 打开文件对话框;取消返回 null */
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
    /** 仅在 Electron 渲染端存在;纯浏览器 dev 下为 undefined */
    mkn?: MknApi;
  }
}

/** 渲染端统一取用入口:浏览器 dev 下返回 null,壳层据此降级为无文件功能的纯编辑器 */
export function getShell(): MknApi | null {
  return typeof window !== "undefined" && window.mkn ? window.mkn : null;
}
