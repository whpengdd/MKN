// 原生菜单 + 加速键。菜单项只负责把对应 MenuAction 经 webContents.send
// 发给渲染端,具体行为(新建/打开/保存…)由壳层接 onMenuAction 决定,
// 主进程不在这里读写文件——保持"菜单=纯触发器"。

import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { MenuAction } from "../src/shell/ipc";

const isMac = process.platform === "darwin";

// buildMenu 收一个取窗口的 getter(窗口可能在重建中为 null),
// 每次点击时现取 webContents,避免持有过期引用。
export function buildMenu(getWin: () => BrowserWindow | null): Menu {
  const send = (action: MenuAction) => {
    getWin()?.webContents.send("mkn:menu-action", action);
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: "文件",
    submenu: [
      { label: "新建", accelerator: "CmdOrCtrl+N", click: () => send("new") },
      { label: "打开…", accelerator: "CmdOrCtrl+O", click: () => send("open") },
      {
        label: "打开文件夹…",
        accelerator: "Shift+CmdOrCtrl+O",
        click: () => send("openFolder"),
      },
      { type: "separator" },
      { label: "保存", accelerator: "CmdOrCtrl+S", click: () => send("save") },
      {
        label: "另存为…",
        accelerator: "Shift+CmdOrCtrl+S",
        click: () => send("saveAs"),
      },
      { type: "separator" },
      {
        // 导出动作只下发 MenuAction;HTML 生成 / pandoc 可用性判断都在渲染端壳层。
        // "导出 Word" 常显:渲染端先 hasPandoc() 再决定是否提示安装,菜单不预先禁用。
        label: "导出",
        submenu: [
          { label: "导出 HTML…", click: () => send("exportHtml") },
          { label: "导出 PDF…", click: () => send("exportPdf") },
          { label: "导出 Word(pandoc)…", click: () => send("exportDocx") },
        ],
      },
      { type: "separator" },
      // 查找走渲染端的 CodeMirror 搜索面板;⌘F 统一在这里截获再下发。
      { label: "查找", accelerator: "CmdOrCtrl+F", click: () => send("find") },
      { type: "separator" },
      isMac ? { role: "close", label: "关闭窗口" } : { role: "quit", label: "退出" },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "编辑",
    submenu: [
      { role: "undo", label: "撤销" },
      { role: "redo", label: "重做" },
      { type: "separator" },
      { role: "cut", label: "剪切" },
      { role: "copy", label: "复制" },
      { role: "paste", label: "粘贴" },
      { role: "selectAll", label: "全选" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "视图",
    submenu: [
      {
        label: "切换侧栏",
        accelerator: "CmdOrCtrl+\\",
        click: () => send("toggleSidebar"),
      },
      { type: "separator" },
      { role: "resetZoom", label: "实际大小" },
      { role: "zoomIn", label: "放大" },
      { role: "zoomOut", label: "缩小" },
      { type: "separator" },
      { role: "togglefullscreen", label: "全屏" },
      // 开发期排障用;打包后保留无妨(不主动弹出)。
      { role: "toggleDevTools", label: "开发者工具" },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "窗口",
    role: "windowMenu",
  };

  const template: MenuItemConstructorOptions[] = [];

  // macOS 首菜单为应用名,含"关于/退出"等标准项。
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about", label: `关于 ${app.name}` },
        { type: "separator" },
        { role: "hide", label: `隐藏 ${app.name}` },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: `退出 ${app.name}` },
      ],
    });
  }

  template.push(fileMenu, editMenu, viewMenu, windowMenu);

  return Menu.buildFromTemplate(template);
}
