# 技术设计

## 架构总览

```
Electron 主进程 (electron/, ESM)         渲染端 (src/, Vite + TS)
  main.ts  ── IPC ──>  preload.cjs ──>  window.mkn (MknApi)
  menu.ts                                  │
  文件IO/watch/导出/会话                    ├─ src/core/   编辑器内核(壳无关,冻结边界)
                                            ├─ src/shell/  ipc 契约 + doc 生命周期
                                            ├─ src/ui/     文件树 / 大纲 / 设置
                                            ├─ src/export/ markdown→独立 HTML(纯函数)
                                            └─ src/app.ts  应用壳:布局/菜单/特性接线
```

**铁律**:`src/core/**` 与外壳无关、可独立在浏览器跑;Electron 只是包裹层。所有特性都是自包含 CM 扩展,经 `createEditor(parent, doc, extra)` 的 `extra` 注入,不改内核装配。

## 关键决策

1. **内核 = CodeMirror 6 + 实时预览 decoration**(非 ProseMirror)。文档始终是 Markdown 纯文本,decoration 只负责"隐藏标记符号/渲染 widget";保存即 `view.state.doc.toString()` 原样写回 → 本地 .md 零损失往返(这是选 CM6 而非富文本树的根本原因)。
2. **隐现判定**集中在 `cursorReveal.ts`:`inlineRevealed`(行内,闭区间含边缘)、`blockRevealed`(块级,按行跨度)。所有 decoration 模块复用,语义一致。
3. **跨行/含换行符的 replace 必须由 StateField 提供**(CM6 约束:ViewPlugin 不能提供跨行 replace)。表格、Mermaid、块级数学走 StateField + `Decoration.replace({block:true})`;行内/行级走 ViewPlugin。
4. **所有 replace decoration 必须登记为 `EditorView.atomicRanges`**(`decoCtx.ts` 统一强制)。否则方向键会让 contentEditable 原生 caret 钻进隐藏区、跳过整段(实测真 bug,已修)。
5. **中文 IME 冻结**:组合输入进行中不重建 decoration,只按变更映射旧 set;`compositionend` 后强制刷新一次。
6. **源码模式**:`livePreview()` 包进 `Compartment`,`setSourceMode` 重配为空 → 露出带语法高亮的原始 Markdown。
7. **Electron preload 必须是 CommonJS**(`preload.cjs`)。ESM `.mjs` preload 在 Electron 静默加载失败 → `window.mkn` 缺失 → 渲染端误入浏览器降级(实测真 bug,已修);`vite-plugin-electron` 强制 `format:'cjs'`。
8. **`npm run dev` 必须保持纯 vite 跑 5173**;Electron 插件用环境变量 `MKN_ELECTRON` 门控,仅 `electron:dev/build` 启用。
9. **单文件监听用 Node `fs.watch`**,不用 chokidar(其原生 `fsevents.node` 无法被 Rollup 打进主进程包;单文件场景也用不上递归)。
10. **图片粘贴入 assets**:渲染端读 `Uint8Array` → IPC `saveAsset(docPath, bytes, ext)` → 主进程写当前文档同级 `assets/` → 返回相对路径插入 `![](assets/..)`。
11. **导出渲染器**为纯函数(`renderStandaloneHtml`,markdown-it + 服务端 KaTeX + 内联主题 CSS),HTML/PDF 共用;PDF 经主进程离屏窗口 `printToPDF`(用完销毁);Pandoc 经 stdin 喂入。
12. **hot-exit**:`doc.ts` 每次变更防抖 350ms + 失焦/关闭前 `flushCache()` 把 `{path, content}` 推给主进程写 `session.json`;启动 `loadSession()` 恢复(有路径则读磁盘内容作 baseline,使 dirty 真实反映未存盘改动)。据此**移除关闭确认弹窗**。

## 边界与取舍

- Mermaid 导出为 MVP:服务端无 DOM,导出 HTML 内是带说明的图源码块,非渲染图。
- 自保存 grace 窗口 1.2s 内的外部改动可能被当自写忽略一次。
- `fs.watch` 在外部编辑器"改名原子保存"后可能失效;下次打开仍读得到最新(可接受 MVP)。
- 打包未签名(无 Apple Developer ID),首次打开需绕过 Gatekeeper。
- 预览/沙箱视口异常(1px/0高),验证以 DOM 同步断言为准,不依赖截图。
