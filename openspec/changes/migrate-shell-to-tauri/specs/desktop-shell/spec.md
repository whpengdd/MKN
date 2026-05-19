# desktop-shell Specification (delta)

## MODIFIED Requirements

### Requirement: 桌面外壳与安全桥

应用 SHALL 以系统 WebView 外壳(Tauri,macOS = WKWebView)包裹同一份内核;渲染端经 Tauri IPC(`invoke` / event)获得 `MknApi` 能力,等价于此前的 `window.mkn`。后端 SHALL 以最小 capability/allowlist 放行实际用到的命令与文件 scope;渲染端 MUST NOT 获得任意文件系统或任意进程执行能力。外壳 MUST NOT 打包独立浏览器引擎。

> 实现说明:本要求此前为 "Electron 外壳与安全桥"(`contextIsolation` CJS preload + `nodeIntegration` 关闭)。改为 Tauri 后,渲染端可见的 `MknApi` 接口签名与语义保持不变(冻结契约),仅底层实现由 preload 改为 Tauri 命令/事件。

#### Scenario: 渲染端获得文件能力

- **WHEN** 在 Tauri 外壳中启动
- **THEN** `MknApi` 可用,文件树/打开/保存等功能可用(非浏览器降级)

#### Scenario: 纯浏览器降级

- **WHEN** 以 `npm run dev` 在浏览器打开(无 Tauri 注入)
- **THEN** 仅挂载编辑器与样例,不崩,文件相关动作给出提示

#### Scenario: 最小权限

- **WHEN** 渲染端尝试访问未在 allowlist/scope 内的文件或命令
- **THEN** 该访问被外壳拒绝(纵深防御,等价或强于原 contextIsolation 模型)

## ADDED Requirements

### Requirement: 安装体积

桌面外壳 SHALL 复用操作系统自带 WebView,不内嵌浏览器运行时。`tauri build` 产出的 macOS 安装后 App SHALL ≤ 20MB(目标 ~10MB),并在变更验收时记录实测值。

#### Scenario: 体积验收

- **WHEN** 执行生产打包并安装
- **THEN** 安装后 App 体积 ≤ 20MB,且不含独立 Chromium/浏览器引擎
