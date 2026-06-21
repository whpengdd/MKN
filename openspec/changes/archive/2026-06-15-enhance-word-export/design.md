## Context

`src/export/render.ts` 已有一套成熟的 markdown-it 装配:数学行内/块级规则、Mermaid 降级、任务列表 core 规则、代码高亮 MVP,产出独立 HTML(供 HTML 导出与 PDF 离屏渲染共用)。Word 导出却是另一条路:`src/app.ts` 调 `shell.pandocExport(markdown, "docx", …)`,主进程 `electron/main.ts` 用 `spawn("pandoc")` 把 markdown 喂 stdin 转 .docx。`hasPandoc` 探测不到 pandoc 时,`src/app.ts` 直接弹"需安装 pandoc"并 return,Word 导出对没装 pandoc 的用户完全不可用。

.docx 本质是一个 zip 包,内含若干固定结构的 XML(WordprocessingML)。要做"无 pandoc 内置导出",需要:markdown → OOXML 文档 XML → 连同最小的包骨架(`[Content_Types].xml`、`_rels/.rels`、`word/_rels/document.xml.rels`、`word/document.xml`)打成 zip。

约束(沿用本仓既有取舍):渲染端纯函数、不碰 DOM/Electron、不改源文档;倾向零新增重依赖(对照已声明的"不引 highlight.js / 不引 puppeteer")。

## Goals / Non-Goals

**Goals:**
- 无 pandoc 时,Word 导出仍可用 —— 内置生成器产出可被 Word / WPS / LibreOffice 正常打开的合法 .docx。
- Word 导出分层降级:有 pandoc 优先 pandoc(保真高),无 pandoc 自动回落内置,不再死路提示。
- 内置通路复用现有 markdown 解析(token 流),覆盖核心元素;降级元素(数学/Mermaid)有明确兜底、不丢内容。
- 纯函数生成、不依赖 DOM/Electron、不修改源 markdown,可单测。

**Non-Goals:**
- 不追求与 pandoc 等同的高保真排版(数学真排版、复杂嵌套样式留给 pandoc / PDF)。
- 不在内置通路真渲染数学公式与 Mermaid 图(无 DOM,沿用 render.ts 的降级声明)。
- 不引入富样式映射框架(主题色值精细映射到 Word 样式)——MVP 用一套干净内置样式即可。
- 不改 HTML / PDF 导出现有行为。

## Decisions

### 决策 1:复用 markdown-it token 流,新增 .docx 渲染目标
从 `render.ts` 抽出/复用同一个配置好的 markdown-it 实例(数学、Mermaid、任务列表、表格规则已就绪),遍历其 token 流生成 OOXML,而不是再写一套 markdown 解析。
- **为什么**:避免解析逻辑二套漂移(数学定界、任务列表、代码块边界这些坑已在 render.ts 验证过);token 流是稳定中间表示。
- **替代**:① 从 HTML 再转 docx(html→ooxml)——需要 DOM 解析、依赖更重且易丢语义;② 重写独立 markdown→docx 解析——重复造轮、易漂移。均否决。
- **落点**:新增 `src/export/docx.ts`,导出纯函数 `renderDocx(markdown, opts) → Uint8Array`。必要时把 render.ts 的 `makeMarkdownIt()` 抽到共享模块供两者复用。

### 决策 2:手写最小 .docx 打包,zip 实现二选一(Open Question)
.docx = zip(store/deflate)+ 固定 XML 骨架。两种打包路径:
- **(A) 主进程用 Node 内置 zlib 手写 zip 容器**:zlib 有 `deflateRawSync`,zip 的本地文件头/中央目录/EOCD 结构固定可手写。零新增依赖,贴合"不引重依赖"取舍;缺点是要小心 CRC32、字节序、目录偏移等细节。
- **(B) 引入一个极轻量 zip 依赖**(如 fflate,~10KB):省去手写容器风险;代价是一个新依赖。
- **倾向 (A)**,与 render.ts 注释里反复声明的"零重依赖"一致;若手写 zip 风险/工期不划算,退 (B)。最终在 Open Questions 拍板。

### 决策 3:生成在渲染端,落盘在主进程
`renderDocx` 在渲染端产出 `Uint8Array`(纯函数、可单测),经新 IPC `writeBinaryFile(bytes, defaultName)` 交主进程弹另存对话框并写盘;主进程对该路径 `markSelfWrite`(与 pandoc/PDF 一致,避免被外部改动监听误触发回读)。
- **为什么**:保持渲染端纯函数语义,主进程只做对话框 + 落盘 + 自写标记,与现有 PDF/pandoc 导出对称。
- **替代**:整个生成放主进程——会让 token 流/markdown-it 依赖进主进程,偏离现有"渲染端产内容、主进程落盘"的分工。

### 决策 4:导出 Word 分层降级逻辑
`src/app.ts` 导出 Word 分支改为:`await shell.hasPandoc()` → true 走 `pandocExport`;false(或 pandoc 执行失败)→ 走内置 `renderDocx` + `writeBinaryFile`。浏览器预览态(无 shell)维持"仅 Electron 外壳可用"提示。
- pandoc 运行期失败是否也回落内置:倾向回落(用户体验优先),并在 notify 说明已用内置通路。

### 决策 5:元素覆盖与降级约定
- 直接映射:标题(h1–h6→Word heading 段落样式)、段落、加粗/斜体/删除线、行内码(等宽+底纹)、有序/无序列表、引用、代码块(等宽段落+底纹)、表格(GFM→Word 表格)、分隔线、图片(本地路径/data URI→嵌入 media)、链接(超链接 relationship)。
- 任务列表:复选框降级为 `☐ / ☑` 字符前缀(Word 无统一只读 checkbox 内联控件,字符最稳)。
- 数学:行内/块级降级为等宽文本(原 TeX 源)。
- Mermaid:降级为带说明的等宽源码段(与 render.ts 同取舍)。

## Risks / Trade-offs

- [手写 zip 容器细节出错(CRC32/偏移/字节序)导致 Word 打不开] → 用最小固定骨架 + 充分单测(用真实 Word/WPS/LibreOffice 打开校验);风险过高则退决策 2(B) 轻量库。
- [图片嵌入与 relationship/Content-Types 配置易错] → MVP 可先支持 data URI / 本地文件两类,逐一校验;无法读取的图片降级为占位文本而非中断导出。
- [内置保真度低于 pandoc,用户预期落差] → 文档与 notify 明确:pandoc 在场优先、内置为兜底;高保真建议装 pandoc 或导出 PDF。
- [token 流共享改动影响现有 HTML/PDF 导出] → 抽 `makeMarkdownIt()` 时保持 render.ts 对外冻结签名 `renderStandaloneHtml` 不变,加单测守住。

## Migration Plan

1. 抽共享 markdown-it 装配(若需),`renderStandaloneHtml` 签名与行为保持不变(回归测试守住)。
2. 新增 `src/export/docx.ts`(`renderDocx`)+ 单测(各元素 → OOXML 片段断言;产物 zip 结构校验)。
3. 主进程新增 `writeBinaryFile` IPC + 保存对话框 + `markSelfWrite`;`src/shell/ipc.ts` 暴露。
4. `src/app.ts` 导出 Word 分支改分层降级。
5. 三端手测:有 pandoc / 无 pandoc / 浏览器预览;产物用 Word/WPS/LibreOffice 打开校验。
- 回滚:分层降级是增量,移除内置分支即回到原"无 pandoc 提示"行为;无数据迁移。

## Open Questions

- 决策 2 最终选 (A) 手写 zip 还是 (B) 轻量 zip 库?(影响是否新增依赖)
- pandoc **运行期失败**(非缺失)时是否也回落内置?倾向是,待确认。
- 图片首版支持范围:仅 data URI,还是含本地文件路径读取?(本地路径读取需主进程参与)
