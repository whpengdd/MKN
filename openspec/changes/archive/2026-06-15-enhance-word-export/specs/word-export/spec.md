## ADDED Requirements

### Requirement: 内置 Word(.docx)导出(不依赖 pandoc)

应用 SHALL 提供一条不依赖外部 `pandoc` 的内置 Word 导出通路:把当前文档的 markdown 转为合法的 WordprocessingML 并打包为 `.docx`,经另存对话框落盘。该生成 MUST 为纯函数语义(同输入恒同输出、不依赖 DOM/Electron),MUST NOT 修改源文档。产物 MUST 能被 Microsoft Word / WPS / LibreOffice 正常打开。

#### Scenario: 无 pandoc 也能导出 Word

- **WHEN** 系统未安装 pandoc,用户在 Electron 外壳触发"导出 Word"并选择保存位置
- **THEN** 应用用内置生成器产出 `.docx` 落盘,不再弹"需安装 pandoc"死路提示,文件可正常打开

#### Scenario: 导出不改源文档

- **WHEN** 触发内置 Word 导出
- **THEN** 编辑器内容与源文件保持不变,仅在另存路径产出新 `.docx`

#### Scenario: 浏览器预览态提示不可用

- **WHEN** 在无 Electron 外壳的浏览器预览中触发"导出 Word"
- **THEN** 提示该功能仅在 Electron 外壳可用(无文件系统),不产生半截文件

### Requirement: 内置 Word 导出元素覆盖

内置生成器 SHALL 覆盖常见 markdown 元素并映射到对应 Word 结构:标题(h1–h6)、段落、加粗 / 斜体 / 删除线、行内代码、有序 / 无序列表、引用、代码块、GFM 表格、分隔线、链接、图片(本地路径或 data URI)。任务列表项 SHALL 以可见复选标记(如 `☐ / ☑`)前缀呈现。

#### Scenario: 富文本与结构元素正确转换

- **WHEN** 文档含标题、加粗 / 斜体 / 删除线、列表、引用、代码块、表格、分隔线
- **THEN** 导出的 `.docx` 中各元素呈现为对应的 Word 段落样式 / 表格 / 字符格式,层级与顺序与源文一致

#### Scenario: 任务列表带复选标记

- **WHEN** 文档含 `- [ ]` / `- [x]` 任务项
- **THEN** 导出的 `.docx` 中对应项以未勾选 / 已勾选的可见复选标记前缀呈现

#### Scenario: 图片嵌入

- **WHEN** 文档含可读取的本地图片或 data URI 图片
- **THEN** 图片被嵌入 `.docx`(media + 关系条目)并正常显示;无法读取的图片降级为占位文本,不中断导出

### Requirement: 内置 Word 导出降级约定

对内置通路无法高保真呈现的元素,生成器 SHALL 降级为不丢信息的文本表示而非中断导出:数学公式(行内 / 块级)SHALL 降级为保留原 TeX 源的等宽文本;Mermaid 代码块 SHALL 降级为带说明的等宽源码段。

#### Scenario: 数学公式降级保源

- **WHEN** 文档含 `$...$` 或 `$$...$$` 数学公式
- **THEN** 导出的 `.docx` 中以等宽文本保留原始 TeX 源,不丢失内容、不抛错中断

#### Scenario: Mermaid 降级保源

- **WHEN** 文档含 ```mermaid 代码块
- **THEN** 导出的 `.docx` 中以带说明的等宽源码段保留图源码(导出未渲染),不丢失内容
