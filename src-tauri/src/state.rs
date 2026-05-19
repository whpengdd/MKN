//! 跨命令共享状态。对齐 electron/main.ts 的三组可变量:
//!  - selfWrites:刚被我们自己写过的路径 + 到期时间戳,watcher 在窗口内忽略其变更
//!  - watcher / watched:当前单文件监听句柄与目标路径(切文件即换 watcher)
//!  - pending_open / renderer_ready:访达冷启动早于渲染端就绪时,先暂存路径
//!
//! 风格对齐内核:注释解释"为何这样接线",不复述每行。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::Instant;

use notify::RecommendedWatcher;

/// 自写 grace 窗口:1.2s 足够覆盖 write 落盘 + notify 多事件触发的整段抖动
/// (与 electron/main.ts 的 markSelfWrite 一致)。
pub const SELF_WRITE_GRACE_MS: u64 = 1200;
/// 一次保存常触发多个文件事件,用 120ms 去抖压平(对齐 main.ts 的 fs.watch 去抖)。
pub const WATCH_DEBOUNCE_MS: u64 = 120;
/// 最近文件最多保留条数(对齐 main.ts)。
pub const RECENT_MAX: usize = 10;

#[derive(Default)]
pub struct AppState {
    /// path -> 到期 Instant;在到期前该路径的 watcher 事件视为"自写"忽略。
    pub self_writes: Mutex<HashMap<PathBuf, Instant>>,
    /// 当前 notify watcher(持有以维持监听;切文件时整体替换)。
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    /// 当前被监听的文件绝对路径。
    pub watched: Mutex<Option<PathBuf>>,
    /// 访达双击/Dock/argv 传入但渲染端尚未就绪时暂存的待打开文件。
    pub pending_open: Mutex<Option<String>>,
    /// 渲染端是否已 ready(收到前端发来的 mkn:renderer-ready)。
    pub renderer_ready: AtomicBool,
}

impl AppState {
    /// 标记某路径"刚被我们自己写过",grace 窗口内忽略其 change 事件。
    pub fn mark_self_write(&self, path: &Path) {
        let key = canon(path);
        let mut m = self.self_writes.lock().unwrap();
        m.insert(
            key,
            Instant::now() + std::time::Duration::from_millis(SELF_WRITE_GRACE_MS),
        );
    }

    /// 该路径的变更是否应被当作"我们自己保存"而忽略(到期即清理并放行)。
    pub fn is_self_write(&self, path: &Path) -> bool {
        let key = canon(path);
        let mut m = self.self_writes.lock().unwrap();
        match m.get(&key).copied() {
            None => false,
            Some(until) => {
                if Instant::now() > until {
                    m.remove(&key);
                    false
                } else {
                    true
                }
            }
        }
    }
}

/// 规范化路径用作 key:尽量取 canonicalize,失败(文件不存在等)回退原路径。
/// 与 main.ts 的 path.resolve 同义——保证"同一文件不同写法"映射到同一 key。
pub fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}
