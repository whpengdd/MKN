## Why

当前「导出 Word(.docx)」完全依赖系统装了 `pandoc`:没装时只弹一句"请安装 pandoc"提示,什么都导不出。而 HTML / PDF 都是内置渲染、开箱即用。对绝大多数没装也不愿装 pandoc 的普通用户来说,Word 导出实际等于不可用。本次补一条**不依赖 pandoc 的内置 .docx 导出**通路,让 Word 导出与 HTML/PDF 一样开箱即用;pandoc 在场时仍优先走它(保真更高)。

## What Changes

- 新增**内置 .docx 生成器**:复用现有 markdown-it token 流(`src/export/render.ts` 同一套解析),把 markdown 转成 OpenXML(WordprocessingML)并打包为合法 .docx,纯函数、不依赖 pandoc、不改源文档。
- **导出 Word 改为分层降级**:有 pandoc → 仍走 pandoc(保真优先);无 pandoc → 自动回落到内置生成器,**不再弹"请装 pandoc"死路**。
- 内置生成器覆盖核心元素:标题、段落、**加粗/斜体/删除线/行内码**、有序/无序列表、任务列表(复选框)、引用、代码块、表格、分隔线、图片(本地/data URI)、链接。
- **降级元素明确兜底**(不静默丢信息):数学公式与 Mermaid 在内置通路下降级为等宽文本/源码段并附说明,保证内容不丢;真渲染仍建议走 pandoc 或导出 PDF。
- 浏览器预览态(无 Electron 外壳)维持现有行为:提示仅 Electron 外壳可用。

## Capabilities

### New Capabilities
- `word-export`: 不依赖 pandoc 的内置 Word(.docx)导出能力 —— markdown → WordprocessingML → 合法 .docx 包,含元素覆盖范围与降级约定。

### Modified Capabilities
- `export-and-appearance`: 「可选 Pandoc 导出」需求改为「Word 导出分层降级」—— 从"无 pandoc 即提示不可用"改为"无 pandoc 自动回落到内置生成器"。

## Impact

- 渲染端:`src/export/render.ts`(复用/抽出 markdown-it token 流);新增 .docx 生成模块(如 `src/export/docx.ts`)。
- 接线:`src/app.ts` 导出 Word 分支改为分层降级;`src/shell/ipc.ts` 可能新增"写二进制到另存路径"的 IPC(内置生成在渲染端产 Buffer,主进程落盘)。
- 主进程:`electron/main.ts` 现有 `pandocExport`/`hasPandoc` 保留;新增内置导出的保存对话框 + 写盘处理。
- 依赖:倾向零新增重依赖(.docx 即 zip+XML,可手写最小打包,与现有"不引 highlight.js/puppeteer"取舍一致);若引入轻量 zip 库需在 design 权衡。
