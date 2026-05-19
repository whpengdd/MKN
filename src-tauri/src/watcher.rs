//! 单文件外部改动监听。对齐 electron/main.ts:
//!  - 只盯"最近一次 watch_file 的那个文件";切文件即换 watcher(drop 旧的即停)
//!  - 自己 save 触发的变更必须忽略(is_self_write 1.2s grace)
//!  - 一次保存常触发多个事件,用 120ms 去抖压平
//!  - 过滤后向渲染端 emit "mkn:file-changed"

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::{AppState, WATCH_DEBOUNCE_MS};

/// watch_file 是 fire-and-forget(MknApi 返回 void),命令返回 ()。
/// 已在盯同一文件则跳过重建(对齐 main.ts 的 watchedPath 短路)。
#[tauri::command]
pub fn watch_file(path: String, app: AppHandle, state: tauri::State<AppState>) {
    let resolved = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));

    {
        let cur = state.watched.lock().unwrap();
        if cur.as_deref() == Some(resolved.as_path()) {
            return; // 已在盯同一文件,无需重建
        }
    }

    // 去抖 generation:每个 watcher 一份;事件 +1 并捕获,120ms 后仅当未被新事件
    // 顶替(generation 未变)且仍在盯该文件且非自写,才 emit。
    let gen = Arc::new(AtomicU64::new(0));
    let app_cb = app.clone();
    let watched_target = resolved.clone();
    let gen_cb = gen.clone();

    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // 只关心内容/元数据类变更(create/modify/remove);access 噪声忽略。
        if !matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        ) {
            return;
        }
        let state = app_cb.state::<AppState>();
        // 仍在盯这个文件吗?(切文件后旧 watcher 可能仍有残余事件)
        {
            let w = state.watched.lock().unwrap();
            if w.as_deref() != Some(watched_target.as_path()) {
                return;
            }
        }
        if state.is_self_write(&watched_target) {
            return; // 自己 save 触发:忽略
        }
        let my_gen = gen_cb.fetch_add(1, Ordering::SeqCst) + 1;
        let app_emit = app_cb.clone();
        let gen_check = gen_cb.clone();
        let target = watched_target.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(WATCH_DEBOUNCE_MS));
            // 去抖窗口内又来了新事件 → 让最后一个负责 emit
            if gen_check.load(Ordering::SeqCst) != my_gen {
                return;
            }
            let state = app_emit.state::<AppState>();
            {
                let w = state.watched.lock().unwrap();
                if w.as_deref() != Some(target.as_path()) {
                    return;
                }
            }
            if state.is_self_write(&target) {
                return;
            }
            let _ = app_emit.emit("mkn:file-changed", target.to_string_lossy().into_owned());
        });
    }) {
        Ok(w) => w,
        Err(_) => return, // 创建 watcher 失败:静默,渲染端下次读文件仍能发现
    };

    // 文件不存在等:watch 失败则静默(对齐 main.ts try/catch)
    if watcher
        .watch(&resolved, RecursiveMode::NonRecursive)
        .is_err()
    {
        return;
    }

    // 先记 watched 再存 watcher;替换旧 watcher(drop → 停止旧监听)。
    *state.watched.lock().unwrap() = Some(resolved);
    *state.watcher.lock().unwrap() = Some(watcher);
}
