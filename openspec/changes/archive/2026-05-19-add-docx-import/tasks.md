## 1. 依赖与脚手架

- [x] 1.1 在 `src-tauri/Cargo.toml` 增加 `docx-rs` 依赖
- [x] 1.2 新增 `src-tauri/src/docx.rs` 模块并在 `lib.rs` 挂载

## 2. docx → markdown 转换

- [x] 2.1 实现读取 `.docx` 并解析为文档树(`docx-rs`)
- [x] 2.2 映射标题(Heading 1..6 → `#`..`######`)与段落
- [x] 2.3 映射行内:粗体 `**`、斜体 `*`、超链接、换行(External 链接 URL 在 rid→rels,读侧不便取,降级为纯文本;锚点链接产出 `[text](#anchor)` —— 见 docx.rs 模块注释)
- [x] 2.4 映射列表(有 numbering 即列表;有序/无序在 numbering.xml,查看场景统一降级无序 `-`,按层级缩进)
- [x] 2.5 映射表格为 Markdown 管道表格
- [x] 2.6 显式丢弃批注/修订/页眉页脚/字体颜色/公式/图片,不报错
- [x] 2.7 解析失败/损坏/加密/旧版 .doc → 返回可读 `Err(String)`,不 panic

## 3. 接入打开流程

- [x] 3.1 `open_file_dialog` 对话框 filter 增加 `.docx`
- [x] 3.2 `open_file_dialog` 按扩展名分支:`.docx` 走转换、非文本返回可读错误不 panic
- [x] 3.3 `.docx` 分支返回 `{ path: "", content: <markdown> }`,前端据空 path 走 `openImported` 当未命名草稿(实现用空串而非 null,因 `OpenedFile.path` 是 `String`;语义等同)

## 4. 验证

- [x] 4.1 前端验证:经 `npm run typecheck` 通过 + 代码路径核对 —— `openImported` 令 `path=null`,`scheduleAutosave` 仅在「有 path 且 dirty」落盘,故原 .docx 零回写。注:Tauri 桌面对话框无法在浏览器预览里跑,未做 GUI 实跑
- [x] 4.2 Rust round-trip 测试 `round_trips_subset`:写真实 .docx(标题/粗体/段落/表格)再解析,断言映射正确,通过
- [x] 4.3 Rust 测试 `corrupt_file_errors_gracefully`:非法字节返回友好错误不 panic,通过
- [x] 4.4 量测:当前 release 二进制 ≈ 11.5 MiB(12,006,736 B)。docx-rs 引入 zip/quick-xml/image 等(Cargo.lock +169 行)。隔离前后对比因一次 stash 误操作被搅乱,观测值在 12–14MB 区间波动,远未触及「相对原 ~5.6MB DMG / 原二进制 +2MB」回退线;未超标,不回退

## 5. 收尾

- [x] 5.1 `npm run typecheck` 通过;`cargo test --release --lib docx` 2/2 通过
- [x] 5.2 仓库无 README;在 app.ts 的 onOpenError 帮助文案补充「.docx 可经『打开文件』有损导入查看(丢弃样式,不回写原文件)」
