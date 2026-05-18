// Electron 主进程:窗口生命周期 + 全部 IPC handler + 单文件 watcher。
// 渲染端只通过 src/shell/ipc.ts 的 MknApi 与这里对话(经 preload 暴露为 window.mkn)。
// 风格对齐 src/core/livePreview/*.ts:注释讲清"为什么这么做",而非复述代码。

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { promises as fs, watch as fsWatch, type FSWatcher } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildMenu } from "./menu";
import type { FileEntry } from "../src/shell/ipc";

// vite-plugin-electron 在 serve 模式注入此变量;prod 打包后为 undefined。
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

// package.json 是 "type":"module",vite-plugin-electron 据此把 main 打成 ESM
// (formats:["es"]),ESM 下 __dirname/__filename 不存在,必须由 import.meta.url 推。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 打包后目录结构:dist-electron/main.js + dist-electron/preload.cjs + dist/index.html。
// __dirname(此处)在 prod 指向 dist-electron。
// preload 走 CommonJS(.cjs):Electron ESM preload 不稳,会导致 window.mkn 缺失。
const PRELOAD = path.join(__dirname, "preload.cjs");
const RENDERER_HTML = path.join(__dirname, "../dist/index.html");
const RECENT_FILE = () => path.join(app.getPath("userData"), "recent.json");
// hot-exit 会话缓存:渲染端防抖写入,启动时回读 → 关闭无需提示保存。
const SESSION_FILE = () => path.join(app.getPath("userData"), "session.json");

const MD_FILTERS = [
  { name: "Markdown / 文本", extensions: ["md", "markdown", "txt"] },
];

let win: BrowserWindow | null = null;

// ── 单文件 watcher ───────────────────────────────────────────────
// 只盯"最近一次 watchFile 请求的那个文件";切换文件即换 watcher。
// 自己 saveFile 触发的变更必须忽略:保存时把目标路径压入 selfWrites,
// 短暂窗口内 fs.watch 的事件视为"自写",过窗口才当外部改动通知渲染端。
let watcher: FSWatcher | null = null;
let watchedPath: string | null = null;
const selfWrites = new Map<string, number>(); // path -> 到期时间戳(ms)

/** 标记某路径"刚被我们自己写过",在 grace 窗口内忽略其 change 事件。 */
function markSelfWrite(filePath: string): void {
  const key = path.resolve(filePath);
  // 1.2s 足够覆盖 fs.writeFile 落盘 + fs.watch 多事件触发的整段抖动。
  selfWrites.set(key, Date.now() + 1200);
}

/** 该 change 是否应被当作"我们自己保存"而忽略。 */
function isSelfWrite(filePath: string): boolean {
  const key = path.resolve(filePath);
  const until = selfWrites.get(key);
  if (until === undefined) return false;
  if (Date.now() > until) {
    selfWrites.delete(key);
    return false;
  }
  return true;
}

function watchFile(filePath: string): void {
  const resolved = path.resolve(filePath);
  // 已在盯同一个文件,无需重建。
  if (watchedPath === resolved && watcher) return;

  if (watcher) {
    void watcher.close();
    watcher = null;
  }
  watchedPath = resolved;

  // Node 内置 fs.watch:单文件监听,无原生依赖。
  // (chokidar 会拉入原生 fsevents.node,既无法被 Rollup 打进主进程包,
  //  单文件场景也用不上其递归/跨平台能力。)
  // fs.watch 一次保存常触发多个事件,用 120ms 去抖压平;与 selfWrites
  // 双保险过滤自写。外部编辑器原子保存(rename)后 watcher 可能失效,
  // 渲染端下次读文件仍能发现,属可接受的 MVP 取舍。
  try {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    watcher = fsWatch(resolved, () => {
      if (watchedPath !== resolved || isSelfWrite(resolved)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        if (watchedPath === resolved && !isSelfWrite(resolved)) {
          win?.webContents.send("mkn:file-changed", resolved);
        }
      }, 120);
    });
    // 监听出错(文件被删/卷弹出等)静默:渲染端下次读到才发现,避免误报。
    watcher.on("error", () => {});
  } catch {
    // 文件不存在等:忽略,渲染端实际读取时再处理。
    watcher = null;
  }
}

// ── 最近文件持久化 ───────────────────────────────────────────────
async function readRecent(): Promise<string[]> {
  try {
    const raw = await fs.readFile(RECENT_FILE(), "utf-8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // 文件不存在 / JSON 损坏:当作空列表,不让最近文件功能拖垮启动。
    return [];
  }
}

async function writeRecent(list: string[]): Promise<void> {
  await fs.writeFile(RECENT_FILE(), JSON.stringify(list, null, 2), "utf-8");
}

// ── IPC handlers(与 MknApi 一一对应) ────────────────────────────
function registerIpc(): void {
  // 打开文件对话框:取消返回 null,选中则连内容一起返回(省一次往返)。
  ipcMain.handle("mkn:openFileDialog", async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: MD_FILTERS,
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    const p = r.filePaths[0];
    const content = await fs.readFile(p, "utf-8");
    return { path: p, content };
  });

  ipcMain.handle("mkn:openFolderDialog", async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  // 列目录:过滤 . 开头隐藏项;目录在前,组内按 localeCompare 排序。
  ipcMain.handle("mkn:readDir", async (_e, dirPath: string): Promise<FileEntry[]> => {
    const ents = await fs.readdir(dirPath, { withFileTypes: true });
    const out: FileEntry[] = [];
    for (const ent of ents) {
      if (ent.name.startsWith(".")) continue;
      out.push({
        name: ent.name,
        path: path.join(dirPath, ent.name),
        isDir: ent.isDirectory(),
      });
    }
    out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  });

  ipcMain.handle("mkn:readFile", async (_e, p: string): Promise<string> => {
    return fs.readFile(p, "utf-8");
  });

  // 原样写回:UTF-8 零转换,保证 .md 零损失往返。
  // 写前打 selfWrite 标记,避免触发自身的 onFileChanged。
  ipcMain.handle("mkn:saveFile", async (_e, p: string, content: string): Promise<void> => {
    markSelfWrite(p);
    await fs.writeFile(p, content, { encoding: "utf-8" });
  });

  ipcMain.handle(
    "mkn:saveFileAs",
    async (_e, content: string, defaultPath?: string): Promise<string | null> => {
      if (!win) return null;
      const r = await dialog.showSaveDialog(win, {
        defaultPath,
        filters: MD_FILTERS,
      });
      if (r.canceled || !r.filePath) return null;
      markSelfWrite(r.filePath);
      await fs.writeFile(r.filePath, content, { encoding: "utf-8" });
      return r.filePath;
    }
  );

  // watchFile 是 fire-and-forget(MknApi 里返回 void),用 .on 而非 .handle。
  ipcMain.on("mkn:watchFile", (_e, p: string) => {
    watchFile(p);
  });

  ipcMain.handle("mkn:getRecentFiles", async (): Promise<string[]> => {
    return readRecent();
  });

  // 去重 + 最新置顶 + 最多 10 条。
  ipcMain.handle("mkn:addRecentFile", async (_e, p: string): Promise<void> => {
    const resolved = path.resolve(p);
    const list = await readRecent();
    const next = [resolved, ...list.filter((x) => path.resolve(x) !== resolved)].slice(0, 10);
    await writeRecent(next);
  });

  // 未保存状态:仅做 macOS 标题栏圆点的视觉提示(不再驱动关闭确认)。
  ipcMain.on("mkn:setDocumentEdited", (_e, edited: boolean) => {
    win?.setDocumentEdited(edited);
  });

  // ── 会话缓存(hot-exit) ──────────────────────────────────────────
  // cacheSession:fire-and-forget,渲染端防抖 + 失焦/关闭前补推;
  // 整篇 JSON 覆盖写,频率不高(text 很小),无需原子 rename。
  ipcMain.on("mkn:cacheSession", (_e, session: unknown) => {
    void fs
      .writeFile(SESSION_FILE(), JSON.stringify(session), "utf-8")
      .catch(() => {});
  });
  // loadSession:启动回读;文件不存在/损坏一律当无缓存,绝不拖垮启动。
  ipcMain.handle("mkn:loadSession", async () => {
    try {
      const raw = await fs.readFile(SESSION_FILE(), "utf-8");
      const o = JSON.parse(raw);
      if (o && typeof o.content === "string") {
        return {
          path: typeof o.path === "string" ? o.path : null,
          content: o.content,
        };
      }
      return null;
    } catch {
      return null;
    }
  });

  // 粘贴/拖拽图片 → 写入当前文档同级 assets/,返回相对路径供插入 markdown。
  ipcMain.handle(
    "mkn:saveAsset",
    async (_e, docPath: string, data: Uint8Array, ext: string): Promise<string> => {
      const assetsDir = path.join(path.dirname(docPath), "assets");
      await fs.mkdir(assetsDir, { recursive: true });
      const safeExt = (ext || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
      const name = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
      const full = path.join(assetsDir, name);
      markSelfWrite(full);
      await fs.writeFile(full, Buffer.from(data));
      return `assets/${name}`; // markdown 用正斜杠相对路径
    }
  );

  // ── Phase 4 导出 ─────────────────────────────────────────────────
  // 渲染端已把主题 CSS 内联进完整 HTML 文档,这里只管"落盘/转格式",不解析内容。

  // 导出 HTML:整篇独立文档原样写盘。导出目标不是当前文档,
  // 但仍打 selfWrite——万一用户导回正被 watch 的同名文件,避免误报外部改动。
  ipcMain.handle(
    "mkn:exportHtml",
    async (_e, html: string, defaultName: string): Promise<string | null> => {
      if (!win) return null;
      const r = await dialog.showSaveDialog(win, {
        defaultPath: `${defaultName}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (r.canceled || !r.filePath) return null;
      markSelfWrite(r.filePath);
      await fs.writeFile(r.filePath, html, { encoding: "utf-8" });
      return r.filePath;
    }
  );

  // 导出 PDF:用离屏窗口渲染同一份 HTML 再 printToPDF。
  // 关键点:
  //  - 经临时文件 + loadFile 加载(data: URL 在大文档/特殊字符下不可靠,
  //    且某些资源相对路径会失效);临时文件用完即删。
  //  - 必须等 did-finish-load 再 printToPDF,否则可能截到空白页;
  //    再给 10s 超时兜底,避免加载卡死永不 resolve。
  //  - 无论成功失败,finally 里务必 destroy 离屏窗口并清临时文件,杜绝句柄泄漏。
  ipcMain.handle(
    "mkn:exportPdf",
    async (_e, html: string, defaultName: string): Promise<string | null> => {
      if (!win) return null;
      const r = await dialog.showSaveDialog(win, {
        defaultPath: `${defaultName}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (r.canceled || !r.filePath) return null;

      const tmpHtml = path.join(
        os.tmpdir(),
        `mkn-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`
      );

      let off: BrowserWindow | null = null;
      try {
        await fs.writeFile(tmpHtml, html, { encoding: "utf-8" });

        off = new BrowserWindow({
          show: false,
          // 离屏渲染不需要 preload/Node;给个固定尺寸让分页稳定。
          width: 900,
          height: 1200,
          webPreferences: { contextIsolation: true, nodeIntegration: false },
        });
        const wc = off.webContents;

        // 等首帧加载完成或超时;两者先到先 resolve,避免卡死。
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("加载导出页面超时")),
            10_000
          );
          wc.once("did-finish-load", () => {
            clearTimeout(timer);
            resolve();
          });
          wc.once("did-fail-load", (_ev, _code, desc) => {
            clearTimeout(timer);
            reject(new Error(`导出页面加载失败: ${desc}`));
          });
          void off!.loadFile(tmpHtml);
        });

        const pdf = await wc.printToPDF({ printBackground: true });
        markSelfWrite(r.filePath);
        await fs.writeFile(r.filePath, pdf);
        return r.filePath;
      } catch (err) {
        console.error("[mkn:exportPdf] 导出失败:", err);
        return null;
      } finally {
        // 释放离屏窗口:destroy 不触发 close 事件,适合强制回收。
        if (off && !off.isDestroyed()) off.destroy();
        // 临时文件兜底清理,删不掉也不影响导出结果。
        await fs.unlink(tmpHtml).catch(() => {});
      }
    }
  );

  // 是否装了 pandoc:execFile 探测版本,任何异常都当"没有",绝不抛给渲染端。
  ipcMain.handle("mkn:hasPandoc", async (): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      try {
        execFile("pandoc", ["--version"], (err) => {
          resolve(!err);
        });
      } catch {
        resolve(false);
      }
    });
  });

  // 经 pandoc 把 markdown 转 docx/latex/epub 等。
  //  - markdown 走 stdin:绕开命令行长度上限与 shell 转义,内容零损失。
  //  - 不经 shell(spawn 直接执行 pandoc),无注入面。
  //  - 进程错误 / 非 0 退出码:console.error 后返回 null,不抛。
  ipcMain.handle(
    "mkn:pandocExport",
    async (
      _e,
      markdown: string,
      format: string,
      defaultName: string
    ): Promise<string | null> => {
      if (!win) return null;

      // 输出扩展名:latex→.tex,其余取 format 本身(docx/epub…)。
      const ext = format === "latex" ? "tex" : format;
      const r = await dialog.showSaveDialog(win, {
        defaultPath: `${defaultName}.${ext}`,
        filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      });
      if (r.canceled || !r.filePath) return null;
      const outPath = r.filePath;

      return new Promise<string | null>((resolve) => {
        let child;
        try {
          child = spawn("pandoc", [
            "-f",
            "markdown",
            "-t",
            format,
            "-o",
            outPath,
          ]);
        } catch (err) {
          console.error("[mkn:pandocExport] 启动 pandoc 失败:", err);
          resolve(null);
          return;
        }

        let stderr = "";
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        // spawn 错误(pandoc 不存在等)走 error 事件,不会抛同步异常。
        child.on("error", (err) => {
          console.error("[mkn:pandocExport] pandoc 进程错误:", err);
          resolve(null);
        });
        child.on("close", (code) => {
          if (code === 0) {
            markSelfWrite(outPath);
            resolve(outPath);
          } else {
            console.error(
              `[mkn:pandocExport] pandoc 退出码 ${code}: ${stderr.trim()}`
            );
            resolve(null);
          }
        });

        // markdown 经 stdin 喂入,写完关闭以触发 pandoc 处理。
        child.stdin.write(markdown);
        child.stdin.end();
      });
    }
  );
}

// 关闭不再弹"是否保存":渲染端 hot-exit 会话缓存已持续把
// 当前文件 + 全文写到 session.json,启动时自动恢复,关闭零打扰。

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    title: "MKN",
    titleBarStyle: "default",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需用 Node(无),实际逻辑都在 main;关 sandbox 保 preload 走 CJS/MJS 稳。
    },
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(RENDERER_HTML);
  }

  // 外链用系统浏览器打开,不在应用内导航。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => {
    win = null;
  });

  Menu.setApplicationMenu(buildMenu(() => win));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  // macOS:Dock 点击且无窗口时重建。
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 非 macOS:关完所有窗口即退出。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 防御:被外部信号要求退出时清理 watcher,避免句柄泄漏。
app.on("quit", () => {
  if (watcher) void watcher.close();
});
