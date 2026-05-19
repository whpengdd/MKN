//! 粘贴/拖拽图片 → 写入当前文档同级 assets/,返回相对路径供插入 markdown。
//! 对齐 electron/main.ts 的 saveAsset:目录递归创建、扩展名清洗、随机文件名、
//! 写前打 self_write 标记(图片落到正被 watch 的目录不误报外部改动)。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::State;

use crate::state::AppState;

/// data 由渲染端以 number[] / Uint8Array 传来,serde 收成 Vec<u8>。
#[tauri::command]
pub async fn save_asset(
    doc_path: String,
    data: Vec<u8>,
    ext: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let doc = PathBuf::from(&doc_path);
    let dir = doc
        .parent()
        .ok_or_else(|| "文档路径无父目录".to_string())?
        .join("assets");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // 扩展名清洗:仅留字母数字,空则回退 png(对齐 main.ts 的 replace 正则)。
    let safe_ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    let safe_ext = if safe_ext.is_empty() { "png".into() } else { safe_ext };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    let ts = now.as_millis();
    // 随机段:用纳秒低位转 base36 风格的十六进制(无需额外 rand crate;碰撞概率足够低)。
    let rand = format!("{:x}", now.subsec_nanos());
    let name = format!("img-{ts}-{rand}.{safe_ext}");
    let full = dir.join(&name);

    state.mark_self_write(&full);
    std::fs::write(&full, data).map_err(|e| e.to_string())?;

    // markdown 用正斜杠相对路径(对齐 main.ts 返回 `assets/xxx`)。
    Ok(format!("assets/{name}"))
}
