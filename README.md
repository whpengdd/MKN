# 隐墨 Inkveil

**一款本地优先的无缝 Markdown 编辑器,Typora 风格,体积仅 6.5MB。**

隐墨追求"写作时看不见 Markdown"的体验:语法标记在光标离开时自动隐藏,正文即所见,光标回到那一行才显现出 `**` `#` 等记号——所写即所得,却不丢任何原始语法。

## 核心特性

- **无缝隐现编辑**——标记按需隐现,零损失往返,源码与渲染随时切换,中文输入法下不丢字、不串行
- **沉浸写作**——专注模式、打字机模式、大纲面板、实时字数统计
- **富内容**——KaTeX 数学公式、Mermaid 图表、表格可视化编辑、图片粘贴自动归入 `assets`
- **真桌面应用**——原生文件树、原生菜单与快捷键、双击系统文件直接打开、外部改动自动监听
- **导入导出**——打开 Word `.docx`(有损转 Markdown,不回写原文件)、导出独立 HTML / PDF,可选 Pandoc
- **不丢稿**——会话热退出缓存,关闭无需确认,重启自动恢复到上次状态
- **顺手**——暗色模式、正文列宽随窗口自适应

## 关于体积

基于 Tauri 构建,复用系统 WebView,不打包 Chromium。同样的应用,Electron 版 94MB,隐墨 **6.5MB**——启动快、占用小,纯本地运行,不联网、不上传。

## 安装(macOS)

安装包未做 Apple 代码签名,首次打开会被 Gatekeeper 拦截(提示"已损坏"或"无法验证开发者")。把 App 拖到 `/Applications` 后,在终端执行一次以下命令去除隔离属性即可正常双击打开:

```bash
xattr -dr com.apple.quarantine /Applications/Inkveil.app
```

> 说明:隔离属性是浏览器/AirDrop 在下载时打上的标记,与应用本身无关。上述命令执行一次后永久生效,后续启动无需重复。

## 构建

```bash
npm install
npm run tauri:build
```

产物在 `src-tauri/target/release/bundle/`(DMG 安装包与免安装 `.app`)。

---

> 作者:彭大大 · 版本 2026.05 · macOS (Apple Silicon)
