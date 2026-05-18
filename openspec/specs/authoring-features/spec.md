# authoring-features Specification

## Purpose
TBD - created by archiving change build-typora-style-editor. Update Purpose after archive.
## Requirements
### Requirement: 大纲面板

应用 SHALL 从文档标题生成可点击大纲;点击跳转并居中对应标题,光标所在标题高亮跟随,文档变化后刷新。

#### Scenario: 点击大纲跳转

- **WHEN** 点击大纲中的某标题项
- **THEN** 编辑器滚动并把该标题定位到视口

### Requirement: 专注模式

应用 SHALL 提供专注模式:非当前段落变暗;无空行分段的文档退化为仅当前行清晰,始终保证对比。

#### Scenario: 专注变暗

- **WHEN** 开启专注模式且光标在某段
- **THEN** 其余段落明显变暗,当前段清晰;移动光标实时跟随

### Requirement: 打字机模式

应用 SHALL 提供打字机模式:光标行保持视口垂直居中,并通过上下留白让任意行(含首行/短文档)均可居中。

#### Scenario: 光标行居中

- **WHEN** 开启打字机模式后输入或移动光标
- **THEN** 光标所在行保持在窗口垂直中央

### Requirement: 源码模式切换

应用 SHALL 支持在无缝预览与原始 Markdown(带语法高亮)之间切换。

#### Scenario: 切到源码

- **WHEN** 触发源码模式切换
- **THEN** 实时预览 decoration 关闭,显示原始 Markdown;再次切换恢复

### Requirement: 数学与图

应用 SHALL 渲染 KaTeX 行内 `$...$` 与块级 `$$...$$`,以及 Mermaid ` ```mermaid ` 代码块(异步、按源码缓存、出错只显错误文本);均遵循隐现与 atomic 规则;MUST NOT 误匹配代码块内的 `$`。

#### Scenario: 数学渲染与隐现

- **WHEN** 光标不在 `$E=mc^2$` 上
- **THEN** 显示 KaTeX 渲染结果;光标移入则露出 `$...$` 源码

#### Scenario: Mermaid 异步渲染

- **WHEN** 光标不在 ` ```mermaid ` 块且语法正确
- **THEN** 异步渲染为图;语法错误时显示错误文本而非崩溃

### Requirement: 图片粘贴入 assets

在 Electron 且文档已保存时,粘贴/拖拽图片 SHALL 写入当前文档同级 `assets/` 并插入相对路径;未保存或无外壳时给出提示,不崩。

#### Scenario: 粘贴图片落盘

- **WHEN** 在已保存文档中粘贴/拖入图片
- **THEN** 图片写入同级 `assets/`,光标处插入 `![](assets/<file>)`

### Requirement: 字数统计

应用 SHALL 在顶栏显示字数(中文按字符、拉丁按词),随文档变化防抖刷新。

#### Scenario: 字数实时

- **WHEN** 编辑文档
- **THEN** 顶栏字数在停手后短延迟内更新

