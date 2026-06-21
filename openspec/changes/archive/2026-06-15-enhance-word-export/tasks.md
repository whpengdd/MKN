## 1. 共享解析与决策落地

- [x] 1.1 把 `src/export/render.ts` 的 `makeMarkdownIt()` 抽到共享处(供 HTML 与 docx 复用),保持 `renderStandaloneHtml` 对外签名与行为不变
- [x] 1.2 拍板 design Open Question:zip 打包用 Node zlib 手写(A)还是引入轻量 zip 库(B);若选 B 在 package.json 加依赖
- [x] 1.3 拍板:pandoc 运行期失败是否回落内置;图片首版支持范围(data URI / 本地路径)

## 2. 内置 .docx 生成器(渲染端纯函数)

- [x] 2.1 新增 `src/export/docx.ts`,导出 `renderDocx(markdown, opts) → Uint8Array`,遍历 markdown-it token 流生成 WordprocessingML
- [x] 2.2 实现最小 .docx 包骨架:`[Content_Types].xml`、`_rels/.rels`、`word/_rels/document.xml.rels`、`word/document.xml` 及 zip 打包
- [x] 2.3 映射核心元素:标题 h1–h6、段落、加粗/斜体/删除线、行内码、有序/无序列表、引用、代码块、分隔线、链接
- [x] 2.4 映射 GFM 表格 → Word 表格(表头/对齐/边框)
- [x] 2.5 任务列表 → `☐ / ☑` 复选标记前缀
- [x] 2.6 图片嵌入(media + relationship + Content-Types);无法读取的图片降级为占位文本,不中断导出
- [x] 2.7 降级:数学公式 → 保留 TeX 源的等宽文本;Mermaid → 带说明的等宽源码段

## 3. 落盘接线

- [x] 3.1 Tauri 后端 `src-tauri/src/exports.rs` 新增 `export_docx_bytes`(另存对话框 + 写盘 + `mark_self_write`)与 `read_image_bytes`(读本地图片字节);`lib.rs` 注册;`pandoc_export` 改为运行期失败抛 Err、取消返回 None(以区分回落)
- [x] 3.2 `src/shell/ipc.ts` 暴露 `exportDocxBytes` / `readImageBytes` 类型与 invoke 绑定
- [x] 3.3 `src/app.ts` 导出 Word 分支改分层降级:有 pandoc → `pandocExport`(失败抛错则回落);无 pandoc → `renderDocx` + `exportDocxBytes`;图片字节经 `readImageBytes` 预解析;浏览器预览态维持原提示

## 4. 测试与验证

- [x] 4.1 `src/export/docx.test.ts`:各元素 → OOXML 片段断言;产物 zip 结构/必需条目校验;不修改源 markdown
- [x] 4.2 回归:`renderStandaloneHtml` 既有行为与 HTML/PDF 导出不受影响
- [x] 4.3 `npm run typecheck` 与 `npm test` 通过
- [x] 4.4 三端手测:有 pandoc / 无 pandoc / 浏览器预览;产物用 Word / WPS / LibreOffice 打开校验排版(标题/表格/列表/图片/降级元素)
