# Tasks

> 全部未实现。建议迁移期保留 Electron 分支,直至 Tauri 版通过 4. 的完整真机验收再删除 `electron/`。

## 1. 调研与决策(写代码前)

- [x] 1.1 搭最小 Tauri 骨架,在 WKWebView 里加载现 `dist/`,确认 CodeMirror 6 基本可编辑
- [x] 1.2 WKWebView 回归清单真机过一遍:中文 IME 组合输入、隐现/atomic 光标移动、KaTeX、Mermaid SVG、表格可视化编辑 — 用户真机验收通过(点大纲不还原源码为既有 bug,Electron/WebKit 均复现,已拆为独立任务,与迁移无关)
- [x] 1.3 PDF 导出三备选 spike 完成,**锁定方案 A(WKWebView 原生 createPDF),已回写 design.md 决策 3**(环境实测:macOS 26.4.1 支持 createPDF;Tauri 无 JS PDF API 须走 Rust objc2;pandoc/LaTeX 均未装故否决 B;C 退化体验故否决)
- [x] 1.4 用户确认:WKWebView 渲染验收通过、PDF 选定方案 A → Phase 1 关口通过,进入实现

## 2. Tauri 后端(Rust)

- [x] 2.1 `src-tauri/` 骨架、`tauri.conf.json`、capability/allowlist(最小放行 core+dialog;自有命令免声明)
- [x] 2.2 文件命令:open_file_dialog / open_folder_dialog / read_dir(目录在前、隐藏项过滤)/ read_file / save_file / save_file_as
- [x] 2.3 单文件 watcher(`notify`):selfWrite 1.2s grace + 120ms 去抖(generation 计数器),语义对齐 main.ts
- [x] 2.4 持久化:recent.json(去重/置顶/最多10)、session.json(cache_session/load_session),落盘改 app_config_dir
- [x] 2.5 save_asset:写当前文档同级 `assets/`,扩展名清洗 + 写前 selfWrite,返回相对路径
- [x] 2.6 原生菜单 + 加速键,点击 emit `mkn:menu-action`(对齐 onMenuAction 集合;zoom/devtools 为 Electron role 已省略)
- [x] 2.7 系统级打开文件:tauri.conf fileAssociations + RunEvent::Opened + 冷启动 argv 暂存 + renderer_ready 就绪下发 + single-instance 插件
- [x] 2.8 set_doc_title(窗口标题用 Tauri 原生 API);set_document_edited 与 macOS 代理图标/圆点为装饰,降级 no-op,真·objc2 实现并入 2.10 批次
- [x] 2.9 export_html 落盘;has_pandoc 探测;pandoc_export(stdin 喂入,不经 shell,非0退出码返 null)
- [x] 2.10 PDF 导出(方案 A,objc2 离屏 WKWebView createPDF):exports.rs `macos_pdf` —— 另存 → 临时 HTML → 隐藏 WebviewWindow → on_page_load(10s 超时)+350ms settle → with_webview 主线程 `createPDFWithConfiguration_completionHandler(None,…)` → block 拷 NSData→Vec → 写盘+selfWrite;RAII Cleanup 关窗+删临时文件(对齐 electron exportPdf)。**用户真机验收通过**。遗留(非阻塞小项):macOS setDocumentEdited 圆点/代理图标仍 no-op

## 3. 渲染端适配层

- [x] 3.1 重写 `src/shell/ipc.ts`:preload→`invoke()`/`listen()`,接口逐字保留,命令 snake_case + camelCase 参数,renderer_ready 延后下发
- [x] 3.2 `vite.config.ts` 去 vite-plugin-electron,strictPort 5173;`npm run dev` 仍纯 vite;加 tauri 脚本;补 tauri.conf `beforeDevCommand: npm run dev`(原漏配致 `tauri dev` 空等 5173)
- [x] 3.3 确认 `src/core/** | src/ui/** | src/export/**` 零改动 + `src/app.ts` 逻辑零改动 — `npm run typecheck` 通过(EXIT=0);app.ts 后因 3.5 放宽:仅 injectShellStyles 布局 CSS 一处
- [x] 3.4 浏览器降级路径正常 — preview 实测:vite dev 无 `__TAURI_INTERNALS__` → getShell 返 null → bootBrowser 挂载编辑器/字数/大纲/设置,零报错
- [x] 3.5 单滚动容器修正(WebKit flex 健壮性):injectShellStyles 改 #app flex 列容器 + .cm-editor flex 撑满 + 去 overflow。design.md 决策 9 —— 注:实测**非**根因(改后仍错),但为正确修正,保留
- [x] 3.6 **根因修复**:`theme-default.css` 的 `.cm-line` 用 margin 违反 CM6 约束 → 高度图与渲染失同步 → posAtCoords 落错行(选字/表格定位错的真凶,既有 bug、引擎无关)。`.cm-line.cm-hp-h1..6 / codeblock-first/last / .mkn-hr / .mkn-table-wrap` 纵向 margin 全改 padding;design.md 决策 10、放宽 src/styles 约束;临时诊断 cursorDiag.ts 已删。preview 复测 dy≈0;**用户真机(WKWebView)确认选字/拖选/表格定位恢复**

## 4. 验收与收尾

- [ ] 4.1 全功能真机回归:打开/保存/自保存/外部监听/菜单/访达双击/单实例/图片粘贴/会话恢复/三路导出
- [x] 4.2 体积验收:`tauri build` 实测 **App 12MB / DMG 5.7MB**(vs Electron 351MB / 125MB,-97%)≤ 20MB 目标达成
- [ ] 4.3 用户最终验收
- [ ] 4.4 移除 `electron/`、相关依赖与脚本;更新 README / 打包说明 / 主 specs
