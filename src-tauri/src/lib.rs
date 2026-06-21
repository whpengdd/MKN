//! Tauri 后端总装。把 electron/main.ts 的窗口生命周期 + 全部 IPC + 单文件
//! watcher + 系统级打开文件,逐一移植到 Rust。渲染端经 invoke/event 与这里
//! 对话(替代 Electron 的 contextBridge preload)。
//!
//! 模块切分对齐 main.ts 的职责段:
//!   files / watcher / persist / assets / exports / menu / state

mod assets;
mod docx;
mod exports;
mod files;
mod menu;
mod persist;
mod state;
mod watcher;

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager, RunEvent};

use state::AppState;

/// 只把这些后缀当"要打开的文档"(隐墨是纯文本 Markdown 编辑器),对齐 main.ts TEXT_EXT。
const TEXT_EXT: &[&str] = &["md", "markdown", "txt", "mdown", "mkd"];

fn is_text_doc(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| TEXT_EXT.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
        && p.is_file()
}

/// 从 argv 里挑出"看起来要打开的文本文件"(存在且确为文件;非法路径跳过,
/// 绝不拖垮启动)。对齐 main.ts 的 pickFileFromArgv。
fn pick_file_from_argv<I: IntoIterator<Item = String>>(argv: I) -> Option<String> {
    for a in argv.into_iter().skip(1) {
        if a.is_empty() || a.starts_with('-') {
            continue;
        }
        let p = PathBuf::from(&a);
        if is_text_doc(&p) {
            return Some(
                std::fs::canonicalize(&p)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    None
}

/// 请求渲染端打开某文件:渲染端就绪则直接 emit + 聚焦窗口;否则暂存,
/// 待 renderer_ready 命令到来时由 flush 补发(对齐 main.ts requestOpenInRenderer)。
fn request_open_in_renderer(app: &tauri::AppHandle, file_path: &str) {
    let resolved = std::fs::canonicalize(file_path)
        .unwrap_or_else(|_| PathBuf::from(file_path))
        .to_string_lossy()
        .into_owned();
    let st = app.state::<AppState>();
    if st.renderer_ready.load(Ordering::SeqCst) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
        let _ = app.emit("mkn:open-path", resolved);
    } else {
        *st.pending_open.lock().unwrap() = Some(resolved);
    }
}

/// 渲染端 IPC 接好后调用一次:置 ready,补发暂存的待打开文件
/// (对齐 main.ts did-finish-load → flush pendingOpenFile)。
#[tauri::command]
fn renderer_ready(app: tauri::AppHandle) {
    let st = app.state::<AppState>();
    st.renderer_ready.store(true, Ordering::SeqCst);
    let pending = st.pending_open.lock().unwrap().take();
    if let Some(p) = pending {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
        let _ = app.emit("mkn:open-path", p);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 单实例插件必须最先注册(Tauri 要求)。已开着时再"双击文件"不另起
        // 进程,而是把文件交给现有窗口(对齐 main.ts second-instance)。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(f) = pick_file_from_argv(argv) {
                request_open_in_renderer(app, &f);
            } else if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 原生菜单:点击 → emit mkn:menu-action(壳层接 onMenuAction)。
            let m = menu::build_menu(app.handle())?;
            app.set_menu(m)?;
            app.on_menu_event(|app, event| {
                menu::handle_menu_event(app, event.id().as_ref());
            });

            // 冷启动:Windows/Linux 双击文件把路径放进 argv;macOS 走下面的
            // RunEvent::Opened。这里兜底解析一次(渲染端没就绪会先暂存)。
            if let Some(f) = pick_file_from_argv(std::env::args().collect::<Vec<_>>()) {
                let st = app.state::<AppState>();
                *st.pending_open.lock().unwrap() = Some(f);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            renderer_ready,
            files::open_file_dialog,
            files::open_folder_dialog,
            files::read_dir,
            files::read_file,
            files::save_file,
            files::save_file_as,
            files::set_document_edited,
            files::set_doc_title,
            watcher::watch_file,
            persist::get_recent_files,
            persist::add_recent_file,
            persist::cache_session,
            persist::load_session,
            assets::save_asset,
            exports::export_html,
            exports::has_pandoc,
            exports::pandoc_export,
            exports::export_pdf,
            exports::export_docx_bytes,
            exports::read_image_bytes,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // macOS:访达双击 / 拖到 Dock 图标 → 'Opened' 携带 file:// URL。
        // 冷启动时此事件可能早于窗口就绪,request_open_in_renderer 内部据
        // renderer_ready 决定立即下发还是暂存(对齐 main.ts open-file)。
        if let RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if is_text_doc(&path) {
                        request_open_in_renderer(app_handle, &path.to_string_lossy());
                    }
                }
            }
        }
    });
}
