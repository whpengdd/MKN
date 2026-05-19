//! 最近文件 + hot-exit 会话缓存。对齐 electron/main.ts:
//!  - recent.json:去重 + 最新置顶 + 最多 10 条;损坏/缺失当空列表,不拖垮启动
//!  - session.json:cache_session fire-and-forget 覆盖写;load_session 启动回读
//! 落盘目录由 Electron 的 app.getPath("userData") 换成 Tauri app_config_dir。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::state::RECENT_MAX;

/// 与 src/shell/ipc.ts 的 SessionCache 对齐:path 可为 null(未命名草稿)。
#[derive(Serialize, Deserialize, Clone)]
pub struct SessionCache {
    pub path: Option<String>,
    pub content: String,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn recent_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("recent.json"))
}

fn session_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("session.json"))
}

fn read_recent(app: &AppHandle) -> Vec<String> {
    // 文件不存在 / JSON 损坏:一律当空列表,绝不让最近文件功能拖垮启动。
    let Ok(path) = recent_file(app) else {
        return vec![];
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return vec![];
    };
    match serde_json::from_str::<Vec<String>>(&raw) {
        Ok(v) => v,
        Err(_) => vec![],
    }
}

#[tauri::command]
pub async fn get_recent_files(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(read_recent(&app))
}

/// 去重 + 最新置顶 + 最多 10 条(resolve 后比较,"同文件不同写法"算同一条)。
#[tauri::command]
pub async fn add_recent_file(path: String, app: AppHandle) -> Result<(), String> {
    let resolved = std::fs::canonicalize(&path)
        .unwrap_or_else(|_| PathBuf::from(&path))
        .to_string_lossy()
        .into_owned();

    let mut list = read_recent(&app);
    list.retain(|x| {
        let xr = std::fs::canonicalize(x)
            .unwrap_or_else(|_| PathBuf::from(x))
            .to_string_lossy()
            .into_owned();
        xr != resolved
    });
    list.insert(0, resolved);
    list.truncate(RECENT_MAX);

    let path = recent_file(&app)?;
    let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// fire-and-forget:渲染端防抖 + 失焦/关闭前补推;整篇 JSON 覆盖写。
/// 失败静默(与 main.ts 的 .catch(()=>{}) 一致)——缓存写不进不该打断编辑。
#[tauri::command]
pub fn cache_session(session: SessionCache, app: AppHandle) {
    if let Ok(path) = session_file(&app) {
        if let Ok(json) = serde_json::to_string(&session) {
            let _ = std::fs::write(&path, json);
        }
    }
}

/// 启动回读;文件不存在/损坏/无 content 一律当无缓存(返回 None),绝不拖垮启动。
#[tauri::command]
pub async fn load_session(app: AppHandle) -> Result<Option<SessionCache>, String> {
    let Ok(path) = session_file(&app) else {
        return Ok(None);
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    match serde_json::from_str::<SessionCache>(&raw) {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}
