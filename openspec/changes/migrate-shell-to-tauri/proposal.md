## Why

隐墨 / Inkveil 主打"轻、隐"。但 Electron 外壳自带一份 Chromium 运行时(`Contents/Frameworks/` ~225MB),即便已把前端依赖从 `dependencies` 移走、asar 压到 ~7MB,安装后 App 仍 ~230MB,DMG ~105MB。这 225MB 是 Electron 的硬底线,无任何配置能压缩——它与"轻、隐"的产品定位直接冲突。

Tauri 用**操作系统自带的 WebView**(macOS = WKWebView,每台 Mac 都有)+ Rust 后端,不打包浏览器引擎。同等功能的桌面应用安装后通常 ~8–15MB,体积可降一个数量级。

本仓库的架构恰好极适合迁移:渲染端只经 `src/shell/ipc.ts` 的 `MknApi`(`window.mkn`)与外壳对话,外壳实现可整体替换而内核零改动。

## What Changes

- **替换桌面外壳**:移除 `electron/`(`main.ts` ~579 行 + `menu.ts` + CJS preload)与 `vite-plugin-electron`;引入 `src-tauri/`(Rust 后端 + `tauri.conf.json`)。
- **重写后端能力(Node → Rust)**:文件对话框、读/写/另存、目录懒加载、`fs.watch` 单文件监听(含 selfWrite 过滤)、recent/session JSON 持久化、图片入 `assets/`、HTML 导出、pandoc 探测与导出、原生菜单与快捷键、系统级打开文件(访达双击/Dock/argv)、单实例。
- **重写 `MknApi` 适配层**:`src/shell/ipc.ts` 的实现从 Electron preload 改为 Tauri `invoke()` / 事件;**对渲染端暴露的接口签名与语义保持不变**(`MknApi` 即冻结契约)。
- **PDF 导出换方案**:现依赖 Chromium `webContents.printToPDF`,WKWebView 无干净等价物——见 design.md 三个备选,本变更选定其一。
- **内核/UI/导出渲染器零改动**:`src/core/**`、`src/ui/**`、`src/export/**`、`src/styles/**` 不动;`npm run dev` 纯 vite 跑 5173 的铁律保留。

## Capabilities

### Modified Capabilities
- `desktop-shell`:外壳实现由 Electron 改为 Tauri;渲染端可见的能力契约(文件树/打开保存/外部监听/菜单/系统级打开)行为不变,新增"安装体积"作为显式产品要求,安全模型由 `contextIsolation` preload 改为 Tauri allowlist + IPC。

### Unaffected Capabilities
- `seamless-editor`、`authoring-features`、`export-and-appearance`(渲染部分)、`session-cache`:内核与渲染端不变;`session-cache` 的落盘后端从 Node 改 Rust,但缓存/恢复行为契约不变。

## Impact

- **新增**:`src-tauri/`(Rust crate、`tauri.conf.json`、图标/打包配置)、Rust 工具链(cargo)。
- **移除**:`electron/`、`vite-plugin-electron`、`vite-plugin-electron-renderer`、`electron`、`electron-builder`;`package.json` 的 `electron:*` 脚本与 `build` 段。
- **改写**:`src/shell/ipc.ts`(适配层,签名不变)、`vite.config.ts`(去 Electron 门控,改 Tauri 约定)、构建/打包脚本、PDF 导出路径。
- **平台**:macOS(Apple Silicon)优先,与现状一致。跨平台留作后续(Windows = WebView2、Linux = WebKitGTK,需三端验证)。
- **风险**:渲染引擎 Chromium → WKWebView,CodeMirror 6 / KaTeX / Mermaid 需逐项真机验证;PDF 导出为最高技术风险项(单列设计与备选)。
