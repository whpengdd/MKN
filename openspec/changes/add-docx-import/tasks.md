## 1. 依赖与脚手架

- [ ] 1.1 在 `src-tauri/Cargo.toml` 增加 `docx-rs` 依赖
- [ ] 1.2 新增 `src-tauri/src/docx.rs` 模块并在 `lib.rs` 挂载

## 2. docx → markdown 转换

- [ ] 2.1 实现读取 `.docx` 并解析为文档树(`docx-rs`)
- [ ] 2.2 映射标题(Heading 1..6 → `#`..`######`)与段落
- [ ] 2.3 映射行内:粗体 `**`、斜体 `*`、超链接 `[text](url)`、换行
- [ ] 2.4 映射有序/无序列表(含嵌套)
- [ ] 2.5 映射表格为 Markdown 管道表格
- [ ] 2.6 显式丢弃批注/修订/页眉页脚/字体颜色/公式/图片,不报错
- [ ] 2.7 解析失败/损坏/加密/旧版 .doc → 返回可读 `Err(String)`,不 panic

## 3. 接入打开流程

- [ ] 3.1 `open_file_dialog` 对话框 filter 增加 `.docx`
- [ ] 3.2 `open_file_dialog` 按扩展名分支:`.docx` 走转换、非文本不再 `read_to_string` 崩
- [ ] 3.3 `.docx` 分支返回 `{ path: null, content: <markdown> }`(未命名草稿)

## 4. 验证

- [ ] 4.1 前端验证:打开 .docx 后载入为未命名草稿,触发自动保存计时原文件不被回写
- [ ] 4.2 准备含标题/粗斜体/列表/表格/链接的样例 .docx,核对映射输出
- [ ] 4.3 用损坏文件/加密文件/旧版 .doc 验证错误路径不崩
- [ ] 4.4 量测 release 二进制体积增量,确认在 +1~2MB 预算内;超标则按 design D1 备选① 回退

## 5. 收尾

- [ ] 5.1 `npm run typecheck` 与 Rust 编译通过
- [ ] 5.2 README/帮助文案补充「可导入查看 .docx(样式丢弃,不回写)」
