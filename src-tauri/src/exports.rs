//! 导出。对齐 electron/main.ts 的导出 handler:
//!  - export_html:整篇独立文档原样写盘(渲染端已内联主题 CSS)
//!  - has_pandoc / pandoc_export:探测 pandoc;markdown 走 stdin(绕命令行长度/转义,
//!    不经 shell 无注入面);非 0 退出码返回 None,不抛
//!  - export_pdf:方案 A —— 离屏 WKWebView 加载同一份独立 HTML,objc2 调
//!    macOS createPDF;时序对齐 electron/main.ts:exportPdf(临时文件 + 等
//!    加载完成 + 超时兜底 + finally 销毁窗口/删临时文件)

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

/// 导出 PDF —— 方案 A(离屏 WKWebView createPDF)。
/// 先弹另存对话框;取消返回 None。HTML 与导出 HTML 完全相同(渲染端已内联
/// 主题/KaTeX CSS),离屏 WKWebView 加载后 createPDF,字节写所选路径。
#[tauri::command]
pub async fn export_pdf(
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
            .add_filter("PDF", &["pdf"])
            .set_file_name(&format!("{name}.pdf"))
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(fp) = picked else { return Ok(None) };
    let out_path = fp.into_path().map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (html, &out_path, &state);
        return Err(
            "PDF 导出当前仅 macOS(WKWebView createPDF)实现;其余平台后续变更".into(),
        );
    }

    #[cfg(target_os = "macos")]
    {
        let bytes = macos_pdf::render_pdf(&app, html)
            .await
            .map_err(|e| format!("导出 PDF 失败:{e}"))?;
        state.mark_self_write(&out_path);
        std::fs::write(&out_path, bytes).map_err(|e| e.to_string())?;
        Ok(Some(out_path.to_string_lossy().into_owned()))
    }
}

/// 方案 A 的 macOS 实现:离屏 WKWebView 加载独立 HTML → createPDF。
/// 时序对齐 electron/main.ts:exportPdf —— 临时文件经 loadFile(data: URL
/// 大文档不可靠)、等 did-finish-load 等价信号 + 10s 超时、finally 销毁
/// 离屏窗口并清临时文件,杜绝句柄/临时文件泄漏。
#[cfg(target_os = "macos")]
mod macos_pdf {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use objc2_foundation::NSData;
    use objc2_web_kit::WKWebView;
    use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

    /// 离屏渲染分页尺寸:对齐 electron/main.ts 的 900x1200。
    const PAGE_W: f64 = 900.0;
    const PAGE_H: f64 = 1200.0;
    /// 等加载完成超时(对齐 electron 的 10s 兜底)。
    const LOAD_TIMEOUT: Duration = Duration::from_secs(10);
    /// 加载完成后给布局/字体一个安定窗口(KaTeX 为服务端预渲染、Mermaid 为
    /// 源码块,基本静态;短暂 settle 足够,过长无谓拖慢)。
    const SETTLE: Duration = Duration::from_millis(350);
    /// createPDF 完成回调超时(大文档分页留足余量)。
    const PDF_TIMEOUT: Duration = Duration::from_secs(20);

    pub async fn render_pdf(app: &AppHandle, html: String) -> Result<Vec<u8>, String> {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();

        // 临时文件(对齐 electron:经 loadFile,用完即删)。
        let tmp = std::env::temp_dir().join(format!("inkveil-export-{ts}.html"));
        std::fs::write(&tmp, &html).map_err(|e| e.to_string())?;
        let file_url = tauri::Url::from_file_path(&tmp)
            .map_err(|_| "临时文件路径非法".to_string())?;

        // 加载完成信号:on_page_load 要求 Send+Sync,Sender 非 Sync → Arc<Mutex>。
        let (load_tx, load_rx) = mpsc::channel::<()>();
        let load_tx = Arc::new(Mutex::new(load_tx));

        let label = format!("pdf-export-{ts}");
        let win = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::External(file_url),
        )
        .visible(false)
        .inner_size(PAGE_W, PAGE_H)
        .on_page_load(move |_w, payload| {
            if matches!(
                payload.event(),
                tauri::webview::PageLoadEvent::Finished
            ) {
                if let Ok(tx) = load_tx.lock() {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

        // 用完必清:RAII 守卫,无论成功失败/提前 return 都关窗 + 删临时文件
        // (对齐 electron 的 finally:off.destroy() + fs.unlink)。
        struct Cleanup {
            win: Option<tauri::WebviewWindow>,
            tmp: std::path::PathBuf,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Some(w) = self.win.take() {
                    let _ = w.close();
                }
                let _ = std::fs::remove_file(&self.tmp);
            }
        }
        let _guard = Cleanup {
            win: Some(win.clone()),
            tmp: tmp.clone(),
        };

        // 等加载完成或超时(阻塞 recv 放 spawn_blocking,不堵 async 执行线程)。
        let loaded = tauri::async_runtime::spawn_blocking(move || {
            load_rx.recv_timeout(LOAD_TIMEOUT)
        })
        .await
        .map_err(|e| e.to_string())?;
        if loaded.is_err() {
            return Err("加载导出页面超时".into());
        }
        // 安定窗口(布局/字体最终化)。
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(SETTLE))
            .await
            .map_err(|e| e.to_string())?;

        // createPDF 必须在主线程(WebKit UI 对象);with_webview 保证主线程。
        // 完成回调(WebKit 会 copy 这个 escaping block)把 NSData 拷成 Vec
        // 经 channel 回传;命令侧阻塞取回(再放 spawn_blocking)。
        let (pdf_tx, pdf_rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        win.with_webview(move |pw| {
            // PlatformWebview::inner() 在 macOS 返回指向 WKWebView 的 *mut c_void。
            let wv: &WKWebView =
                unsafe { &*(pw.inner() as *mut WKWebView) };
            let tx = pdf_tx;
            let handler = block2::RcBlock::new(
                move |data: *mut NSData, err: *mut objc2_foundation::NSError| {
                    if !err.is_null() {
                        let _ = tx.send(Err("createPDF 返回错误".into()));
                        return;
                    }
                    if data.is_null() {
                        let _ = tx.send(Err("createPDF 返回空数据".into()));
                        return;
                    }
                    // data 非空:拷出字节(to_vec 内部 memcpy,块返回后 NSData
                    // 释放也无妨)。
                    let bytes = unsafe { (*(data as *const NSData)).to_vec() };
                    let _ = tx.send(Ok(bytes));
                },
            );
            // 配置传 None → 整篇当前页(对齐 electron printToPDF 全文档)。
            unsafe {
                wv.createPDFWithConfiguration_completionHandler(None, &handler);
            }
        })
        .map_err(|e| e.to_string())?;

        let res = tauri::async_runtime::spawn_blocking(move || {
            pdf_rx.recv_timeout(PDF_TIMEOUT)
        })
        .await
        .map_err(|e| e.to_string())?;

        // _guard 在此作用域结束时 Drop → 关窗 + 删临时文件。
        match res {
            Ok(Ok(bytes)) if !bytes.is_empty() => Ok(bytes),
            Ok(Ok(_)) => Err("createPDF 生成空 PDF".into()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("createPDF 超时".into()),
        }
    }
}
