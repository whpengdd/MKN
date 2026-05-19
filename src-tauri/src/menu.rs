//! 原生菜单 + 加速键。对齐 electron/menu.ts:菜单项只负责把对应 MenuAction
//! emit 给渲染端,具体行为由壳层接 onMenuAction 决定,后端不在这里读写文件。
//!
//! 与 Electron 差异:zoom / devTools 是 Electron role,Tauri 无对应预定义项,
//! 且不属于 MknApi 契约(纯装饰),移植时省略;其余结构/加速键逐一对齐。

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Wry};

/// 自定义菜单项 id 即 MknApi 的 MenuAction 字符串,on_menu_event 直接转发。
const ACTIONS: &[&str] = &[
    "new",
    "open",
    "openFolder",
    "save",
    "saveAs",
    "find",
    "toggleSidebar",
    "exportHtml",
    "exportPdf",
    "exportDocx",
];

pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let is_mac = cfg!(target_os = "macos");

    let mi = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::new(label).id(id);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    // ── 文件 ──
    let export_sub = SubmenuBuilder::new(app, "导出")
        .item(&mi("exportHtml", "导出 HTML…", None)?)
        .item(&mi("exportPdf", "导出 PDF…", None)?)
        .item(&mi("exportDocx", "导出 Word(pandoc)…", None)?)
        .build()?;

    let mut file = SubmenuBuilder::new(app, "文件")
        .item(&mi("new", "新建", Some("CmdOrCtrl+N"))?)
        .item(&mi("open", "打开…", Some("CmdOrCtrl+O"))?)
        .item(&mi("openFolder", "打开文件夹…", Some("Shift+CmdOrCtrl+O"))?)
        .separator()
        .item(&mi("save", "保存", Some("CmdOrCtrl+S"))?)
        .item(&mi("saveAs", "另存为…", Some("Shift+CmdOrCtrl+S"))?)
        .separator()
        .item(&export_sub)
        .separator()
        .item(&mi("find", "查找", Some("CmdOrCtrl+F"))?)
        .separator();
    file = if is_mac {
        file.item(&PredefinedMenuItem::close_window(app, Some("关闭窗口"))?)
    } else {
        file.item(&PredefinedMenuItem::quit(app, Some("退出"))?)
    };
    let file = file.build()?;

    // ── 编辑 ──
    let edit = SubmenuBuilder::new(app, "编辑")
        .item(&PredefinedMenuItem::undo(app, Some("撤销"))?)
        .item(&PredefinedMenuItem::redo(app, Some("重做"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("剪切"))?)
        .item(&PredefinedMenuItem::copy(app, Some("复制"))?)
        .item(&PredefinedMenuItem::paste(app, Some("粘贴"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("全选"))?)
        .build()?;

    // ── 视图 ──
    let view = SubmenuBuilder::new(app, "视图")
        .item(&mi("toggleSidebar", "切换侧栏", Some("CmdOrCtrl+\\"))?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, Some("全屏"))?)
        .build()?;

    // ── 窗口 ──
    let window = SubmenuBuilder::new(app, "窗口")
        .item(&PredefinedMenuItem::minimize(app, Some("最小化"))?)
        .item(&PredefinedMenuItem::maximize(app, Some("缩放"))?)
        .build()?;

    let mut menu = MenuBuilder::new(app);

    // macOS 首菜单为应用名,含 关于/隐藏/退出 标准项。
    if is_mac {
        let app_name = "隐墨";
        let app_menu = SubmenuBuilder::new(app, app_name)
            .item(&PredefinedMenuItem::about(app, Some(&format!("关于 {app_name}")), None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, Some(&format!("隐藏 {app_name}")))?)
            .item(&PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?)
            .item(&PredefinedMenuItem::show_all(app, Some("全部显示"))?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, Some(&format!("退出 {app_name}")))?)
            .build()?;
        menu = menu.item(&app_menu);
    }

    menu.item(&file)
        .item(&edit)
        .item(&view)
        .item(&window)
        .build()
}

/// 菜单点击 → emit mkn:menu-action(对齐 menu.ts 的 webContents.send)。
pub fn handle_menu_event(app: &AppHandle, id: &str) {
    if ACTIONS.contains(&id) {
        let _ = app.emit("mkn:menu-action", id);
    }
}

