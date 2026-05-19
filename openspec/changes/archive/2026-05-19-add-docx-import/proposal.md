## Why

用户经常收到同事/外部发来的 `.docx`,目前隐墨打开会直接崩(`open_file_dialog` 用 `read_to_string` 读 zip 二进制)。用户的真实需求很窄:**只想把 Word 内容看一眼**,不在意排版样式,也不需要改回 `.docx`。在不破坏隐墨「小体积 + 本地 .md 零损失往返」核心信条的前提下,补上这块缺口。

## What Changes

- 打开文件对话框的 filter 增加 `.docx`,用户可直接选中 Word 文件。
- `open_file_dialog` 命令对 `.docx` 走专门分支:解析为 Markdown 子集,而非 `read_to_string` 崩溃。
- 新增 docx→markdown 转换模块(Rust 侧,基于 `docx-rs`):映射标题 / 段落 / 粗体 / 斜体 / 列表 / 表格 / 超链接 / 换行;**丢弃**批注、修订、页眉页脚、字体颜色、公式、图片。
- 导入结果以**未命名草稿**载入(`path = null`):自动保存不触发、watcher 不盯原文件、原 `.docx` 永不被回写。想保留由用户显式「另存为」存成 `.md`。
- 非文本/无法解析的文件不再让命令 panic,返回明确错误。

## Capabilities

### New Capabilities
- `docx-import`: 以「只读查看」为目标,把 `.docx` 有损转换为 Markdown 子集并作为未命名草稿载入,绝不回写原文件。

### Modified Capabilities
<!-- openspec/specs/ 下暂无既有 spec,本次不修改既有 capability 的需求。 -->

## Impact

- **Rust 命令**:`src-tauri/src/files.rs` 的 `open_file_dialog`(分支 + filter);新增转换模块(如 `src-tauri/src/docx.rs`)。
- **依赖**:新增 `docx-rs` crate;体积预算 +1~2MB 二进制,DMG 由 ~5.6MB 增至 ~6MB 出头,可接受。
- **前端**:几乎不改 —— 复用现有「未命名草稿」机制(`src/shell/doc.ts`),依赖 `path = null` 时不自动保存的既有行为。
- **非目标**:不打包 pandoc;不做样式/高保真;不做 `.docx` 回写/往返;不做 `.doc`(老二进制格式)。
