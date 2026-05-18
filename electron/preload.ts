// preload:唯一被 contextIsolation 信任的桥。把 MknApi 原样投影到 window.mkn,
// 渲染端(src/app.ts / src/ui)只认这个对象。这里只做"转发",不写业务。
// 风格对齐内核:注释解释"为何这样接线",而非复述每行。

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  FileEntry,
  MknApi,
  MenuAction,
  SessionCache,
} from "../src/shell/ipc";

// 把 ipcRenderer.on 包成"返回取消订阅函数"的形式,契合 MknApi 的回调约定。
// 注意:回调签名只暴露业务参数,不把 Electron 的 event 漏给渲染端。
function subscribe<T>(
  channel: string,
  cb: (payload: T) => void
): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: MknApi = {
  openFileDialog: () => ipcRenderer.invoke("mkn:openFileDialog"),
  openFolderDialog: () => ipcRenderer.invoke("mkn:openFolderDialog"),
  readDir: (dirPath: string): Promise<FileEntry[]> =>
    ipcRenderer.invoke("mkn:readDir", dirPath),
  readFile: (p: string): Promise<string> =>
    ipcRenderer.invoke("mkn:readFile", p),
  saveFile: (p: string, content: string): Promise<void> =>
    ipcRenderer.invoke("mkn:saveFile", p, content),
  saveFileAs: (content: string, defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke("mkn:saveFileAs", content, defaultPath),

  // watchFile 是 fire-and-forget(MknApi 返回 void),用 send 不用 invoke。
  watchFile: (p: string): void => {
    ipcRenderer.send("mkn:watchFile", p);
  },
  onFileChanged: (cb: (path: string) => void): (() => void) =>
    subscribe<string>("mkn:file-changed", cb),

  onMenuAction: (cb: (action: MenuAction) => void): (() => void) =>
    subscribe<MenuAction>("mkn:menu-action", cb),

  getRecentFiles: (): Promise<string[]> =>
    ipcRenderer.invoke("mkn:getRecentFiles"),
  addRecentFile: (p: string): Promise<void> =>
    ipcRenderer.invoke("mkn:addRecentFile", p),

  setDocumentEdited: (edited: boolean): void => {
    ipcRenderer.send("mkn:setDocumentEdited", edited);
  },

  // 访达双击 / 拖到 Dock / 命令行打开:主进程把文件路径推下来。
  onOpenPath: (cb: (path: string) => void): (() => void) =>
    subscribe<string>("mkn:open-path", cb),

  setDocTitle: (p: string | null): void => {
    ipcRenderer.send("mkn:setDocTitle", p);
  },

  saveAsset: (
    docPath: string,
    data: Uint8Array,
    ext: string
  ): Promise<string> =>
    ipcRenderer.invoke("mkn:saveAsset", docPath, data, ext),

  // ── Phase 4 导出 ───────────────────────────────────────────────
  // 仍是纯转发:落盘 / 离屏渲染 / 调 pandoc 全在 main,这里不碰文件系统。
  exportHtml: (html: string, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke("mkn:exportHtml", html, defaultName),
  exportPdf: (html: string, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke("mkn:exportPdf", html, defaultName),
  hasPandoc: (): Promise<boolean> => ipcRenderer.invoke("mkn:hasPandoc"),
  pandocExport: (
    markdown: string,
    format: string,
    defaultName: string
  ): Promise<string | null> =>
    ipcRenderer.invoke("mkn:pandocExport", markdown, format, defaultName),

  // ── 会话缓存(hot-exit) ────────────────────────────────────────
  cacheSession: (session: SessionCache): void => {
    ipcRenderer.send("mkn:cacheSession", session);
  },
  loadSession: (): Promise<SessionCache | null> =>
    ipcRenderer.invoke("mkn:loadSession"),
};

contextBridge.exposeInMainWorld("mkn", api);
