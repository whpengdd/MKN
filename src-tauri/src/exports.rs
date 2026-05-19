//! 导出。对齐 electron/main.ts 的导出 handler:
//!  - export_html:整篇独立文档原样写盘(渲染端已内联主题 CSS)
//!  - has_pandoc / pandoc_export:探测 pandoc;markdown 走 stdin(绕命令行长度/转义,
//!    不经 shell 无注入面);非 0 退出码返回 None,不抛
//!  - export_pdf:方案 A(离屏 WKWebView createPDF)—— Task 2.10 经 objc2 实现,
//!    此处为诚实占位(明确报错,不静默假成功)

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

#[tauri::command]
pub async fn export_html(
    html: String,
    default_name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let app2 = app.clone();
    let name = default_name.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app2.dialog()
            .file()
            .add_filter("HTML", &["html"])
            .set_file_name(&format!("{name}.html"))
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    match picked {
        None => Ok(None),
        Some(fp) => {
            let p = fp.into_path().map_err(|e| e.to_string())?;
            state.mark_self_write(&p);
            std::fs::write(&p, html).map_err(|e| e.to_string())?;
            Ok(Some(p.to_string_lossy().into_owned()))
        }
    }
}

/// 是否装了 pandoc:探测 `pandoc --version`,任何异常都当"没有",绝不抛给渲染端。
#[tauri::command]
pub async fn has_pandoc() -> Result<bool, String> {
    let ok = tauri::async_runtime::spawn_blocking(|| {
        Command::new("pandoc")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false);
    Ok(ok)
}

/// 经 pandoc 把 markdown 转 docx/latex/epub 等。markdown 走 stdin;不经 shell。
/// 进程错误 / 非 0 退出码:返回 None(不抛),与 main.ts 一致。
#[tauri::command]
pub async fn pandoc_export(
    markdown: String,
    format: String,
    default_name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    // latex → .tex,其余取 format 本身(docx/epub…),对齐 main.ts。
    let ext = if format == "latex" { "tex".to_string() } else { format.clone() };
    let app2 = app.clone();
    let name = default_name.clone();
    let ext2 = ext.clone();
    let fmt_up = format.to_uppercase();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app2.dialog()
            .file()
            .add_filter(&fmt_up, &[ext2.as_str()])
            .set_file_name(&format!("{name}.{ext2}"))
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(fp) = picked else { return Ok(None) };
    let out_path = fp.into_path().map_err(|e| e.to_string())?;
    let out_str = out_path.to_string_lossy().into_owned();

    let result = tauri::async_runtime::spawn_blocking(move || -> Option<String> {
        let mut child = Command::new("pandoc")
            .args(["-f", "markdown", "-t", &format, "-o", &out_str])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .ok()?;
        // markdown 经 stdin 喂入,写完关闭以触发 pandoc 处理。
        child.stdin.take()?.write_all(markdown.as_bytes()).ok()?;
        let status = child.wait().ok()?;
        if status.success() {
            Some(out_str)
        } else {
            None
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(ref p) = result {
        state.mark_self_write(&PathBuf::from(p));
    }
    Ok(result)
}

/// 导出 PDF —— 方案 A(离屏 WKWebView createPDF)。Task 2.10 经 objc2 实现。
/// 占位实现:明确报错(渲染端会 notify「导出 PDF 失败」),绝不静默假成功。
#[tauri::command]
pub async fn export_pdf(
    _html: String,
    _default_name: String,
) -> Result<Option<String>, String> {
    Err("PDF 导出(WKWebView createPDF / 方案 A)将在 Task 2.10 经 objc2 实现".into())
}
