# seamless-editor Specification

## Purpose
TBD - created by archiving change build-typora-style-editor. Update Purpose after archive.
## Requirements
### Requirement: 无缝隐现编辑

编辑器 SHALL 在单一视图内编辑 Markdown:当光标未触碰某构造时渲染该构造,触碰时露出其原始 Markdown 源码以供编辑。文档在内存中 SHALL 始终保持为 Markdown 纯文本。

#### Scenario: 光标移开后渲染

- **WHEN** 光标不在某个加粗 `**文字**` / 标题 `## ` / 表格 区域
- **THEN** 该区域以渲染形态显示(标记符号隐藏 / 表格为 HTML 表)

#### Scenario: 光标触碰后露出源码

- **WHEN** 光标移入或紧贴该构造
- **THEN** 还原显示其原始 Markdown 文本,可直接编辑

### Requirement: 零损失往返

保存 SHALL 原样写回编辑器缓冲文本,不做任何转换。

#### Scenario: 保存即原文

- **WHEN** 用户保存文档
- **THEN** 落盘内容逐字节等于 `view.state.doc.toString()`

### Requirement: 中文输入法安全

组合输入(IME)进行中,编辑器 SHALL 不重建 decoration,避免吞字/光标跳动。

#### Scenario: 组合输入中不抖动

- **WHEN** 用户用中文输入法在标记符号附近连续输入
- **THEN** 不丢字符、光标不跳;组合结束后正常渲染

### Requirement: 键盘移动原子化

被隐藏的标记与 widget 范围 SHALL 注册为 atomic,使方向键将其作为单一单位跨越。

#### Scenario: 方向键不钻入隐藏区

- **WHEN** 用方向键经过隐藏的标记 / 列表符号 / 任务复选框
- **THEN** 光标整体跨过,不卡入隐藏区、不跳过整段

### Requirement: 表格可视化编辑

表格渲染态 SHALL 提供增删行列与列对齐操作,直接改写底层 pipe 文本;操作可被撤销/重做。

#### Scenario: 增删行列改写源码

- **WHEN** 在渲染表格的工具条点击增/删行列或切换对齐
- **THEN** 底层 Markdown pipe 表格相应更新,且 `⌘Z` 可回退

### Requirement: 基础编辑增强

编辑器 SHALL 支持查找替换、列表回车自动续行、任务列表复选框勾选、行内图片渲染。

#### Scenario: 列表自动续行

- **WHEN** 在列表项行尾按回车
- **THEN** 自动生成下一个列表项;在空列表项再回车结束列表

#### Scenario: 任务复选框

- **WHEN** 点击渲染出的任务复选框
- **THEN** 底层 `- [ ]` / `- [x]` 相应切换

