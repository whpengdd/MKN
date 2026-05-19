# 技术设计

## 架构对比

```
现状(Electron)                              目标(Tauri)
────────────────────────────                ────────────────────────────
electron/main.ts (Node, ~579行)             src-tauri/src/*.rs (Rust)
  ── IPC ──> preload.cjs ──> window.mkn        ── invoke/event ──> window.__TAURI__
自带 Chromium (~225MB)                       系统 WKWebView (0 字节打包)

  渲染端(src/, Vite + TS)—— 两套方案下完全一致
   ├─ src/core/    编辑器内核(壳无关)        ← 零改动
   ├─ src/ui/      文件树 / 大纲 / 设置        ← 零改动
   ├─ src/export/  markdown→独立 HTML(纯函数) ← 零改动
   ├─ src/shell/ipc.ts  MknApi 契约            ← 仅换实现,签名不变
   └─ src/app.ts   应用壳接线                  ← 零改动
```

**铁律延续**:`src/core/**` 壳无关、可独立浏览器跑;`MknApi` 是冻结契约,迁移只换其底层实现(preload→invoke),不改一处调用方。这是本迁移可行且低风险的根本前提。

## 关键决策

1. **选 Tauri 而非其他**。Tauri 是用系统 WebView 的最成熟方案(社区/插件/文档),Rust 后端,macOS 用 WKWebView。备选 Wails(Go)生态略弱、Neutralinojs 能力不足以覆盖 fs.watch/menu/file-association。

2. **`MknApi` 作为不变量**。`src/shell/ipc.ts` 当前导出的每个方法(`openFileDialog/readDir/readFile/saveFile/saveFileAs/watchFile/getRecentFiles/addRecentFile/setDocumentEdited/setDocTitle/cacheSession/loadSession/saveAsset/exportHtml/exportPdf/hasPandoc/pandocExport` + `onMenuAction/onFileChanged/onOpenPath` 事件)签名与语义逐一保留。Rust 侧 `#[tauri::command]` 一一对应;事件用 Tauri event 通道。验收以"渲染端调用方一行不改仍工作"为准。

3. **PDF 导出 ✅ 已锁定方案 A(WKWebView 原生 createPDF)**。Task 1.3 spike 结论:
   - **环境实测(2026-05-18)**:macOS 26.4.1 → `WKWebView.createPDF`(需 11+)可用;Tauri v2 JS API **无任何 webview→PDF 接口**(`@tauri-apps/api` 内无 printToPdf/createPDF)→ 方案 A 必须在 Rust 侧经 objc2 原生绑定实现;本机 pandoc 与 LaTeX/typst/wkhtmltopdf/weasyprint **全未安装**。
   - **A(选定)**:Rust 建离屏 `WKWebView`(objc2/cocoa)加载 `renderStandaloneHtml` 产出的同一份 HTML,等首帧布局完成(`evaluateJavaScript` 探测 `document.readyState`/KaTeX·Mermaid 渲染完毕)后调 `createPDF(configuration:)`,字节写用户所选路径。**体验与现 Chromium `printToPDF` 完全一致**:一键静默(仅另存对话框)、保真度最高(同一 HTML/同一 WebKit 布局)、零用户依赖、不增体积。
   - **B 否决**:PDF 需额外 LaTeX 引擎(数 GB),与"轻、隐"定位直接冲突,且保真度偏离所见 HTML。(注:pandoc 通道仍保留给 docx/epub —— 那些 pandoc 单独够用。)
   - **C 否决**:`window.print()` 走系统打印面板=非一键、退化体验;打包 paged.js/pdf-lib 增体积且复杂表格/Mermaid 分页保真度不可控。
   - **代价与缓解**:A 是本迁移最高实现风险项(Rust `unsafe` objc2 FFI + WKWebView 加载/渲染完成时机)。缓解:Task 2.10 单列实现并预留充足调研;离屏 WebView 加载/超时/销毁逻辑对齐现 `electron/main.ts:exportPdf` 的成熟时序(等 did-finish-load 等价信号 + 10s 超时兜底 + finally 销毁)。跨平台(Windows WebView2 `CoreWebView2.PrintToPdf` / Linux WebKitGTK)留作后续变更,各端实现不同但 `MknApi.exportPdf` 契约不变。
   - **🔒 实现方案锁定(2.10 调研完成,降风险)**:不手搓 WKWebView 生命周期,改用 **Tauri 隐藏 WebviewWindow + `with_webview` 拿底层 WKWebView,objc2 只触 `createPDF` 一个点**:
     1. 另存对话框拿 out 路径(取消→None);`renderStandaloneHtml` 的 HTML 写入 `temp_dir()` 临时文件(对齐 electron 经临时文件 `loadFile`,data: URL 大文档不可靠)。
     2. `WebviewWindowBuilder::new(app, "pdf-export-…", WebviewUrl::External(file://temp)).visible(false).inner_size(900,1200).build()`;`.on_page_load` 收 `PageLoadEvent::Finished` 经 channel 通知"加载完成",外加 **10s 超时兜底**。
     3. `webview.with_webview(|w| …)`(Tauri 保证主线程)→ wry `WebViewExtMacOS::webview()` 返回 `Retained<WryWebView>`(WKWebView 子类)→ objc2 调 `createPDFWithConfiguration_completionHandler`,`WKPDFConfiguration` 默认(整篇);完成 block(`block2::RcBlock`)把 `NSData` 拷成 `Vec<u8>` 经 channel 送回;命令侧 `spawn_blocking` + `recv_timeout` 取回。
     4. 字节写 out 路径 + `mark_self_write`;`finally`:关隐藏窗口 + `unlink` 临时文件(杜绝句柄/临时文件泄漏,对齐 electron `off.destroy()` + `fs.unlink`)。
     5. 同批补 macOS 装饰:`ns_window().setRepresentedFilename:` / `setDocumentEdited:`(`set_doc_title`/`set_document_edited` 的真·原生圆点与代理图标)。
     - **关键:objc2 版本必须对齐 wry 0.55.1 所锁**——`objc2=0.6`、`objc2-foundation=0.3`、`objc2-web-kit=0.3`、`objc2-app-kit=0.3`、`block2=0.6`(版本不一致则 `Retained<WryWebView>` 与 objc2-web-kit 的 `WKWebView` 方法类型不兼容,编不过)。`WryWebView` 由 wry `pub use` 可直接命名/向上转 `WKWebView`。

4. **fs.watch 等价**。Rust 用 `notify` crate 做单文件监听;`selfWrite`(1.2s grace 忽略自身保存)与 120ms 去抖逻辑原样移植到 Rust,语义对齐现 `electron/main.ts`。

5. **系统级打开文件**。macOS 文件关联经 `tauri.conf.json` 的 bundle 配置 + `RunEvent::Opened`(等价 Electron `open-file`);冷启动早于窗口就绪同样需"暂存路径、渲染端 ready 后下发"。单实例用 `tauri-plugin-single-instance`,argv 解析逻辑移植。

6. **安全模型转换**。Electron 的 `contextIsolation + nodeIntegration:false + CJS preload` → Tauri 的 capability/allowlist:只放行实际用到的 command 与文件 scope,渲染端无 Node、无任意 FS。安全姿态等价或更收紧。

7. **会话缓存后端切换**。`session-cache` 能力的渲染端逻辑(`doc.ts` 防抖 + flush)不变;只把 `cacheSession/loadSession` 的落盘从 Node 改 Rust(写 app data dir 的 `session.json`),缓存/恢复/免确认关闭契约保持。

8. **构建链**。去掉 `vite-plugin-electron` 与 `MKN_ELECTRON` 门控;`npm run dev` 仍纯 vite 5173(Tauri dev 指向该端口)。`tauri build` 出 `.app` + `.dmg`,未签名延续现状(首次打开绕 Gatekeeper)。

9. **`src/app.ts` 布局 CSS 改一处(单一滚动容器,WebKit flex 健壮性)**。`injectShellStyles` 原 `#app{overflow:auto}` + 核心 `.cm-editor{height:100%}` 的布局链,在 WebKit 下父高来自 flex 拉伸时子级 `height:100%` 退化为 `auto`,滚动可能跑到外层 `#app`。**经用户确认放宽"app.ts 零改动":仅改 `injectShellStyles` 布局 CSS(`#app` 改 flex 列容器、`.cm-editor` flex 撑满、移除 `#app` overflow,`.cm-scroller` 复位为唯一滚动容器),零逻辑改动。** 注:实测此项**并非**用户所报"选字/表格定位错"的根因(改后仍错),根因见决策 10;但此改本身是正确的单滚动容器修正,保留。

10. **🐞 根因:`theme-default.css` 在 `.cm-line` 上用 `margin`(CodeMirror 6 约束违反)——选字/表格定位错的真凶**。真机诊断(浏览器原生 `caretRangeFromPoint` 正确、CM `posAtCoords` 错、Δ 随文档向下累积、标题/表格放大)定位到:主题给 `.cm-line.cm-hp-h1..h6`、`.cm-hp-codeblock-first/last`、`.mkn-hr`、`.mkn-table-wrap` 设了纵向 `margin`。CM6 用高度图按元素盒高(**不含 margin**,且相邻 margin 还会**合并**)算行位置,浏览器却按 margin 实际布局 → `posAtCoords` 命中行随文档向下累积偏移。**这是既有 bug(引擎无关;Chromium 也偏,margin 合并差异下 WebKit 偏更狠,故 Electron 期 + Phase 1 顶部快速验收漏过)。** 修法:`.cm-line*` 纵向 `margin` 一律改 `padding`(计入 CM 测量盒高 → 高度图与渲染同步);相邻间距由"合并"变"叠加",视觉间距略增,正确性优先。**经用户授权放宽"src/styles/** 不动":本属既有缺陷修复,Electron/WKWebView 同时受益。** preview(Chromium)复测:14 行 13 行 dy≈0 全部命中本行(余 1 为末空行撞 `40vh` 底 padding 的测试伪影)。临时可视诊断模块(`src/shell/cursorDiag.ts`)定位后已删除。

## 边界与取舍

- **渲染引擎差异**:Chromium → WKWebFiew(Safari 内核)。CodeMirror 6、KaTeX、Mermaid 均宣称支持 Safari,但 contentEditable/IME/SVG 细节需逐项真机回归——这是除 PDF 外的第二风险源,tasks 列专项验证。
- **PDF 保真度可能变化**:取决于备选落点;若降级 B/C,需在发布说明里明示与旧版差异。
- **跨平台暂不保证**:本变更只交付 macOS arm64;Windows/Linux 的 WebView 差异(尤其 Mermaid/KaTeX)留待后续变更。
- **Rust 工具链门槛**:贡献者需装 cargo;CI 也要加 Rust。换来的是体积一个数量级下降。
- **不可逆性**:迁移完成后 Electron 路径删除;迁移期间建议保留 Electron 分支直至 Tauri 版通过完整真机验收。
- **体积目标**:安装后 App ≤ 20MB(目标 ~10MB),作为该能力的显式可验收要求(见 spec delta)。
