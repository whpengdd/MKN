## Why

Typora 已转为收费软件,缺少一个免费的、本地优先、无损往返的等价物。本变更从零构建 MKN:一个仿 Typora 的本地 Markdown 编辑器,核心是"语法随光标隐现"的无缝实时预览体验。

> 说明:本变更为**回填归档**。Phase 0–4 + 会话缓存(hot-exit)已分阶段实现、经用户逐期真机验收,并已打包为 `release/MKN-0.0.0-arm64.dmg`。本文档与配套 specs/design/tasks 记录最终交付状态。

## What Changes

- 无缝混合编辑器内核:CodeMirror 6 + decoration,光标碰到的构造露出原始 Markdown、移开即渲染;文档内存中始终是 Markdown 纯文本,保存原样写回(本地 .md 零损失往返)。
- 表格可视化编辑、查找替换、列表自动续行、任务列表复选框、行内图片。
- Electron 外壳:文件树、打开/保存/防抖自动保存、外部改动监听、原生菜单与快捷键。
- 写作特性:大纲面板、专注模式、打字机模式、源码模式切换、KaTeX 数学、Mermaid 图、图片粘贴/拖拽入同级 `assets/`、字数统计。
- 导出与外观:导出独立 HTML、导出 PDF、可选 Pandoc(Word/LaTeX/epub)、设置面板、暗色模式。
- 会话缓存(hot-exit):持续缓存当前文件与全文,启动恢复;**移除关闭时的"是否保存"确认弹窗**。
- 打包:`electron-builder` 产出 macOS arm64 dmg(未签名)。

## Capabilities

### New Capabilities
- `seamless-editor`: CM6 实时预览内核——隐现机制、行内/块级 decoration、atomic 光标移动、表格可视化编辑、查找、列表/任务/图片。
- `desktop-shell`: Electron 外壳——文件树、文件打开/保存/自动保存、外部改动监听、原生菜单、CJS preload 桥。
- `authoring-features`: 大纲、专注/打字机、源码模式、KaTeX、Mermaid、图片入 assets、字数统计。
- `export-and-appearance`: 导出 HTML/PDF/Pandoc、设置面板、暗色主题。
- `session-cache`: hot-exit 会话缓存与免确认关闭。

### Modified Capabilities
<!-- 无:全部为新建能力,openspec/specs/ 此前为空。 -->

## Impact

- 全新代码库:`src/core/`(内核,壳无关)、`src/ui/`、`src/shell/`、`src/export/`、`electron/`、`src/styles/`。
- 依赖:CodeMirror 6 全家桶、`@codemirror/lang-markdown`(Lezer)、`katex`、`mermaid`、`markdown-it`、`electron`、`vite-plugin-electron`、`vite`、`typescript`。
- 平台:macOS(Apple Silicon)优先;内核为纯 Web,可独立在浏览器运行(降级:无文件系统)。
