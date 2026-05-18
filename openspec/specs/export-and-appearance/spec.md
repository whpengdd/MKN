# export-and-appearance Specification

## Purpose
TBD - created by archiving change build-typora-style-editor. Update Purpose after archive.
## Requirements
### Requirement: 导出独立 HTML

应用 SHALL 把当前文档渲染为一份内联了主题 CSS 与 KaTeX 的完整独立 HTML 文档(可离线打开),并经另存对话框落盘。导出 MUST NOT 修改源文档。

#### Scenario: 导出 HTML 可离线打开

- **WHEN** 触发"导出 HTML"并选择保存位置
- **THEN** 生成的 `.html` 以 `<!DOCTYPE html>` 开头、样式内联,双击可离线查看,排版含标题/表格/数学

### Requirement: 导出 PDF

应用 SHALL 用主进程离屏窗口渲染同一份 HTML 并 `printToPDF` 落盘;离屏窗口用完 MUST 销毁,临时文件 MUST 清理。

#### Scenario: 导出 PDF

- **WHEN** 触发"导出 PDF"并选择保存位置
- **THEN** 生成可正常打开的 PDF;无离屏窗口/临时文件泄漏

### Requirement: 可选 Pandoc 导出

应用 SHALL 在检测到 `pandoc` 时提供 Word/LaTeX/epub 导出(markdown 经 stdin 喂入);未安装时给出提示。

#### Scenario: 无 pandoc 提示

- **WHEN** 触发"导出 Word"但系统无 pandoc
- **THEN** 提示需安装 pandoc,不产生半截文件

### Requirement: 设置面板

应用 SHALL 提供设置面板:主题(浅色/暗色/跟随系统)、正文字号、专注/打字机默认值;偏好持久化(localStorage),启动即应用。

#### Scenario: 偏好持久化

- **WHEN** 在设置面板调整主题或字号后重启应用
- **THEN** 上次选择被保留并在首屏即生效(无浅色闪烁)

### Requirement: 暗色模式

应用 SHALL 提供暗色主题,经 `:root[data-theme="dark"]` 覆盖 `--mkn-*` 变量实现,既有规则不改动;编辑器、侧栏、顶栏一致变暗。

#### Scenario: 切换暗色

- **WHEN** 选择暗色主题
- **THEN** 整个应用切换为协调的暗色配色;选回浅色可还原

### Requirement: 正文列宽随窗口伸缩

编辑器正文列 SHALL 居中并保留两侧留白,列宽 SHALL 随窗口尺寸按比例伸缩(经 `--mkn-content-width` 百分比 + `.cm-content` 的 `max-width` 生效),MUST NOT 被 CodeMirror 给 `.cm-content` 的 `min-width` 顶满整宽。导出 HTML 的正文宽度独立设定,不受此影响。

#### Scenario: 拉伸窗口正文随之变化

- **WHEN** 拉宽或收窄应用窗口
- **THEN** 正文可读列宽按比例随之变化,始终居中且两侧留白(窗口越宽正文越宽)

