//! 文件命令(对齐 electron/main.ts 的 IPC handler 一一对应)。
//! 弹窗用 tauri-plugin-dialog 的阻塞 API,放进 spawn_blocking 避免占用 async 执行线程。
//! 写盘前 mark_self_write,避免触发自身的 onFileChanged(与 main.ts saveFile 一致)。

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

/// 与 src/shell/ipc.ts 的 FileEntry 字段逐一对应(camelCase 经 serde 重命名)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 打开文件返回 {path, content}(对话框已读好内容,省一次 IPC 往返,对齐 main.ts)。
#[derive(Serialize)]
pub struct OpenedFile {
    pub path: String,
    pub content: String,
}

const MD_EXTS: &[&str] = &["md", "markdown", "txt"];

/// 打开文件对话框:取消返回 None;选中则连内容一起返回。
///
/// `.docx`:有损转成 markdown 子集,`path` 置空字符串 —— 渲染端据此当作
/// 「未命名草稿」载入(不自动保存、不回写原 .docx,见 doc.ts)。
#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) -> Result<Option<OpenedFile>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Markdown / 文本", MD_EXTS)
            .add_filter("Word 文档(仅查看)", &["docx"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;

    let is_docx = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("docx"))
        .unwrap_or(false);

    if is_docx {
        // 解析放阻塞线程池(读盘 + zip 解压 + XML 解析)。
        let p = path.clone();
        let content = tauri::async_runtime::spawn_blocking(move || crate::docx::docx_to_markdown(&p))
            .await
            .map_err(|e| e.to_string())??;
        // path 置空 → 渲染端走「导入草稿」,原 .docx 永不被回写。
        return Ok(Some(OpenedFile {
            path: String::new(),
            content,
        }));
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|_| "该文件不是纯文本 / Markdown,无法打开".to_string())?;
    Ok(Some(OpenedFile {
        path: path.to_string_lossy().into_owned(),
        content,
    }))
}

/// 选文件夹作为文件树根;取消返回 None。
#[tauri::command]
pub async fn open_folder_dialog(app: AppHandle) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    match picked {
        None => Ok(None),
        Some(fp) => {
            let p = fp.into_path().map_err(|e| e.to_string())?;
            Ok(Some(p.to_string_lossy().into_owned()))
        }
    }
}

/// 列目录:过滤 . 开头隐藏项;目录在前,组内按名称排序(对齐 main.ts readDir)。
#[tauri::command]
pub async fn read_dir(dir_path: String) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<FileEntry> = Vec::new();
        let rd = std::fs::read_dir(&dir_path).map_err(|e| e.to_string())?;
        for ent in rd {
            let ent = ent.map_err(|e| e.to_string())?;
            let name = ent.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
            out.push(FileEntry {
                path: ent.path().to_string_lossy().into_owned(),
                name,
                is_dir,
            });
        }
        // 目录在前;组内按名称(大小写不敏感,贴近 localeCompare 的常见预期)。
        out.sort_by(|a, b| match b.is_dir.cmp(&a.is_dir) {
            std::cmp::Ordering::Equal => {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            }
            ord => ord,
        });
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读文件文本(UTF-8)。
#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 原样写回:UTF-8 零转换,保证 .md 零损失往返。写前打 self_write 标记。
#[tauri::command]
pub async fn save_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    state.mark_self_write(&p);
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

/// 另存为对话框;返回所选路径,取消返回 None。写前打 self_write 标记。
#[tauri::command]
pub async fn save_file_as(
    content: String,
    default_path: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let app2 = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut b = app2.dialog().file().add_filter("Markdown / 文本", MD_EXTS);
        if let Some(dp) = default_path {
            let pb = PathBuf::from(&dp);
            if let Some(name) = pb.file_name().and_then(|s| s.to_str()) {
                b = b.set_file_name(name);
            }
            if let Some(dir) = pb.parent() {
                b = b.set_directory(dir);
            }
        }
        b.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    match picked {
        None => Ok(None),
        Some(fp) => {
            let p = fp.into_path().map_err(|e| e.to_string())?;
            state.mark_self_write(&p);
            std::fs::write(&p, content).map_err(|e| e.to_string())?;
            Ok(Some(p.to_string_lossy().into_owned()))
        }
    }
}

/// 反映"未保存"状态到窗口标题(macOS 文档已编辑圆点经 objc2 在 Task 2.10 段一并补;
/// 此处先保证契约存在且不崩 —— set_document_edited 在 Tauri 无直接 API,降级为 no-op)。
#[tauri::command]
pub fn set_document_edited(_edited: bool, _app: AppHandle) {
    // macOS setDocumentEdited: 标题栏圆点为纯装饰;Tauri 无直接 API。
    // 真·原生圆点在 Task 2.10 与 createPDF 同批走 objc2;此处不崩即可。
}

/// 让系统窗口标题跟随当前文档(null = 未命名)。macOS 代理图标(setRepresentedFilename)
/// 同样留待 Task 2.10 objc2 批次;标题本身用 Tauri 原生 API,先到位。
#[tauri::command]
pub fn set_doc_title(path: Option<String>, app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let title = match &path {
            Some(p) => {
                let base = PathBuf::from(p)
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| p.clone());
                format!("{base} — 隐墨")
            }
            None => "隐墨".to_string(),
        };
        let _ = win.set_title(&title);
    }
}
