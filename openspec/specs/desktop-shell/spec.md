# desktop-shell Specification

## Purpose
TBD - created by archiving change build-typora-style-editor. Update Purpose after archive.
## Requirements
### Requirement: Electron 外壳与安全桥

应用 SHALL 以 Electron 包裹同一份内核;渲染端经 `contextIsolation` 的 CommonJS preload 暴露 `window.mkn`,`nodeIntegration` MUST 关闭。

#### Scenario: 渲染端获得文件能力

- **WHEN** 在 Electron 中启动
- **THEN** `window.mkn` 存在,文件树/打开/保存等功能可用(非浏览器降级)

#### Scenario: 纯浏览器降级

- **WHEN** 以 `npm run dev` 在浏览器打开(无 `window.mkn`)
- **THEN** 仅挂载编辑器与样例,不崩,文件相关动作给出提示

### Requirement: 文件树与打开/保存

外壳 SHALL 提供文件夹树(懒加载、目录在前)、打开文件、保存、另存为,以及防抖自动保存(有路径且 dirty 时约 0.8s 落盘)。

#### Scenario: 打开并自动保存

- **WHEN** 从文件树打开 .md 并编辑
- **THEN** 顶栏出现未保存标记;停手约 0.8s 自动写回该文件

### Requirement: 外部改动监听

外壳 SHALL 监听当前文件的外部改动:不脏则静默重载,脏则询问;MUST 忽略自身保存触发的变更。

#### Scenario: 外部改动重载

- **WHEN** 当前文件在外部被修改且本地无未保存改动
- **THEN** 编辑器静默重载磁盘版本

### Requirement: 原生菜单与快捷键

外壳 SHALL 提供原生菜单与标准快捷键(新建/打开/打开文件夹/保存/另存/查找/导出等)并下发到渲染端处理。

#### Scenario: 菜单动作生效

- **WHEN** 触发"打开文件夹"菜单或 ⇧⌘O
- **THEN** 弹出系统目录选择,选定后文件树以其为根

### Requirement: 系统级打开文件

外壳 SHALL 接收操作系统传入的"打开此文件"请求:macOS 经 `open-file` 事件(冷启动早于 `whenReady` 也 MUST NOT 丢弃),Windows/Linux 经 `process.argv` 与单实例 `second-instance` 的 argv;文件路径 SHALL 在渲染端就绪(`did-finish-load`)后才下发。该方式打开 MUST 走与文件树一致的脏文档确认,并 MUST 优先于 hot-exit 会话恢复。系统窗口标题 SHALL 跟随当前文档名(macOS 同步标题栏代理图标);未命名草稿回落为应用名。

#### Scenario: 访达双击打开

- **WHEN** 在访达双击 `.md`、拖到 Dock 图标,或 `open file.md`
- **THEN** 该文件作为当前文档打开,顶栏与系统标题栏均显示其文件名(而非"未命名")

#### Scenario: 已开着时再打开另一个文件

- **WHEN** 应用已运行,再从访达双击另一个 `.md`
- **THEN** 复用现有窗口切换到该文件(不另起进程);若当前有未保存改动先弹确认

