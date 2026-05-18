# Tasks

> 回填归档:以下任务均已实现并经用户分期真机验收,故全部勾选完成。

## 1. Phase 0 — 无缝编辑器内核

- [x] 1.1 Vite + TS + CodeMirror 6 + `@codemirror/lang-markdown` 骨架
- [x] 1.2 `cursorReveal`(行内/块级隐现判定)
- [x] 1.3 行内 decoration(粗/斜/行内码/删除线/链接)
- [x] 1.4 块级 decoration(标题/引用/分隔线/列表)
- [x] 1.5 代码围栏高亮、表格渲染 + 光标进入露源码(StateField)
- [x] 1.6 中文 IME 组合输入冻结;默认主题(中文排版)
- [x] 1.7 用户验收 Phase 0 手感

## 2. Phase 1 — 编辑器 MVP

- [x] 2.1 `tableModel` 纯逻辑 + 单元测试(增删行列/对齐/转义)
- [x] 2.2 表格可视化编辑工具条(增删行列/对齐,改写底层 pipe)
- [x] 2.3 查找替换(`@codemirror/search`)
- [x] 2.4 列表自动续行、任务列表复选框、行内图片
- [x] 2.5 修复任务列表点击命中(规范 ignoreEvent + 集中 mousedown)
- [x] 2.6 修复键盘移动跳整段(所有 replace 进 atomicRanges)
- [x] 2.7 用户验收 Phase 1

## 3. Phase 2 — Electron 外壳

- [x] 3.1 冻结 IPC 契约 `src/shell/ipc.ts`
- [x] 3.2 主进程 + 文件树 + 打开/保存/防抖自保存 + 外部监听 + 原生菜单
- [x] 3.3 修集成 bug:chokidar→`fs.watch`(原生 fsevents 不可打包)
- [x] 3.4 修集成 bug:app.ts 入口 TDZ
- [x] 3.5 修集成 bug:ESM preload → CJS `preload.cjs`(window.mkn 缺失)
- [x] 3.6 查找面板主题化;用户验收 Phase 2

## 4. Phase 3 — Typora 对标特性

- [x] 4.1 `createEditor` 加 `extra` 扩展位 + 源码模式 Compartment
- [x] 4.2 专注 / 打字机模式(自包含 CM 扩展)
- [x] 4.3 KaTeX 数学 + Mermaid(StateField + atomic + 异步缓存)
- [x] 4.4 大纲面板、字数统计、图片粘贴入 `assets/`(IPC saveAsset)
- [x] 4.5 修复专注(无空行文档退化为当前行)与打字机(滚动留白)
- [x] 4.6 用户验收 Phase 3

## 5. Phase 4 — 导出与打磨

- [x] 5.1 导出契约 + `markdown-it`;`renderStandaloneHtml` 纯函数
- [x] 5.2 主进程 exportHtml / exportPdf(离屏 printToPDF) / hasPandoc / pandocExport
- [x] 5.3 设置面板 + 暗色模式(`:root[data-theme=dark]` 变量覆盖)
- [x] 5.4 导出三路接线;用户验收 Phase 4

## 6. 会话缓存(hot-exit)

- [x] 6.1 契约加 `cacheSession`/`loadSession` + `SessionCache`
- [x] 6.2 主进程会话读写;移除关闭"是否保存"确认弹窗
- [x] 6.3 `doc.ts` 防抖缓存/`flushCache`/`restoreSession`
- [x] 6.4 `app.ts` 启动恢复 + 失焦/关闭前 flush;用户验收

## 7. 验证与打包

- [x] 7.1 全程 src/electron typecheck、单测、渲染+electron 构建绿
- [x] 7.2 浏览器侧逐项 DOM 断言、各阶段零回归零报错
- [x] 7.3 `electron:build` 打包 `release/MKN-0.0.0-arm64.dmg`
