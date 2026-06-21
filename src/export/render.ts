import { escapeHtml, getConfiguredMarkdownIt } from "./markdownIt";
// KaTeX 字体/排版样式。Vite 的 `?inline` 把 css 当字符串导出 —— 这样
// 才能整段塞进导出 HTML 的 <style>,实现"离线双击即开、零外链"。
// src 下无 .css 模块声明,`tsc --noEmit` 会对该 import 报 TS2307。与
// livePreview/math.ts 处理裸 css import 同策略:就地 @ts-ignore(运行期由
// Vite 解析)。
// @ts-ignore -- css?inline 资源 import,无类型声明;运行期 Vite 提供字符串
import katexCss from "katex/dist/katex.min.css?inline";

/**
 * ★ 导出渲染器 —— 纯函数:markdown 字符串 → 完整独立 HTML 文档。
 *
 * markdown-it 的装配(数学 / Mermaid / 任务列表 / 代码高亮等规则)已抽到
 * 共享的 ./markdownIt,HTML 导出与 Word 导出(docx.ts)共用同一套解析,
 * 避免漂移。本文件只负责把渲染出的 body 套上内联了主题 CSS 与 KaTeX CSS
 * 的完整 HTML 外壳,保证离线双击即开、零外链。纯函数:无副作用、不依赖
 * DOM/Electron、不改源 markdown。
 */

export interface RenderOptions {
  title?: string;
}

/* ===========================================================================
   内联主题 CSS(自带,不读 theme-default.css)
   配色"参考不照抄"主题文件具体色值,贴近 Typora 默认浅色。
   =========================================================================== */

const THEME_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: #ffffff;
  color: #2b2b2b;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.mkn-export {
  max-width: 760px;
  margin: 0 auto;
  padding: 56px 24px 96px;
  word-wrap: break-word;
}
.mkn-export > *:first-child { margin-top: 0; }

/* 标题:与 theme-default 节奏接近 */
.mkn-export h1, .mkn-export h2, .mkn-export h3,
.mkn-export h4, .mkn-export h5, .mkn-export h6 {
  font-weight: 700;
  line-height: 1.3;
  margin: 1.4em 0 0.6em;
}
.mkn-export h1 { font-size: 1.9em; }
.mkn-export h2 {
  font-size: 1.55em;
  padding-bottom: 0.25em;
  border-bottom: 1px solid #e8e8e8;
}
.mkn-export h3 { font-size: 1.3em; }
.mkn-export h4 { font-size: 1.12em; }
.mkn-export h5, .mkn-export h6 {
  font-size: 1em;
  font-weight: 600;
  color: #6b6b6b;
}

.mkn-export p { margin: 0.9em 0; }

.mkn-export a {
  color: #3a7afe;
  text-decoration: none;
}
.mkn-export a:hover { text-decoration: underline; }

.mkn-export strong { font-weight: 700; }
.mkn-export em { font-style: italic; }
.mkn-export del { color: #9b9b9b; }
.mkn-export mark { background: #fff3a3; padding: 0 0.2em; }

/* 列表 */
.mkn-export ul, .mkn-export ol {
  margin: 0.9em 0;
  padding-left: 1.8em;
}
.mkn-export li { margin: 0.3em 0; }
.mkn-export li > ul, .mkn-export li > ol { margin: 0.3em 0; }

/* 任务列表:去符号、复选框与文字对齐 */
.mkn-export li.mkn-task-item {
  list-style: none;
  margin-left: -1.4em;
}
.mkn-export .mkn-task-checkbox {
  margin: 0 0.5em 0 0;
  vertical-align: middle;
}

/* 引用 */
.mkn-export blockquote {
  margin: 1em 0;
  padding: 0.2em 1em;
  color: #6b6b6b;
  border-left: 4px solid #d8dde4;
  background: #fafbfc;
}
.mkn-export blockquote > *:first-child { margin-top: 0; }
.mkn-export blockquote > *:last-child { margin-bottom: 0; }

/* 行内代码 */
.mkn-export code {
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas,
    "PingFang SC", monospace;
  font-size: 0.88em;
  background: #f6f7f9;
  color: #d1395a;
  padding: 0.15em 0.4em;
  border-radius: 4px;
}

/* 围栏 / 缩进代码块 */
.mkn-export pre {
  margin: 1em 0;
  padding: 14px 16px;
  background: #f6f7f9;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  overflow-x: auto;
  line-height: 1.55;
}
.mkn-export pre code {
  display: block;
  padding: 0;
  background: none;
  color: #2b2b2b;
  font-size: 0.86em;
  white-space: pre;
}

/* Mermaid:MVP 当带说明的代码块呈现 */
.mkn-export .mkn-mermaid {
  margin: 1em 0;
}
.mkn-export .mkn-mermaid-note {
  font-size: 0.8em;
  color: #9b9b9b;
  margin-bottom: 0.4em;
}
.mkn-export .mkn-mermaid pre {
  margin: 0;
}

/* 表格(GFM) */
.mkn-export table {
  border-collapse: collapse;
  margin: 1em 0;
  width: 100%;
  font-size: 0.95em;
}
.mkn-export th, .mkn-export td {
  border: 1px solid #e8e8e8;
  padding: 7px 12px;
  text-align: left;
}
.mkn-export thead th {
  background: #f6f7f9;
  font-weight: 600;
}
.mkn-export tbody tr:nth-child(2n) { background: #fafbfc; }

/* 图片 */
.mkn-export img {
  max-width: 100%;
  height: auto;
}

/* 分隔线 */
.mkn-export hr {
  border: none;
  border-top: 1px solid #e8e8e8;
  margin: 2em 0;
}

/* 数学:行内居中对齐基线,块级独占居中、可横向滚动 */
.mkn-export .mkn-math-inline {
  display: inline-block;
  vertical-align: middle;
}
.mkn-export .mkn-math-block {
  display: block;
  text-align: center;
  margin: 1em 0;
  overflow-x: auto;
}
.mkn-export .mkn-math-error {
  color: #e45649;
  font-family: monospace;
  font-size: 0.9em;
  white-space: pre-wrap;
}
`;

/* ===========================================================================
   对外冻结签名
   =========================================================================== */

/**
 * ★ 冻结导出签名(集成方逐字按此调用,勿改):
 * markdown → 完整独立 HTML 文档(<!DOCTYPE html>…),主题 CSS 内联,
 * 可离线双击打开。纯函数:无副作用、不依赖 DOM/Electron、不改源 markdown。
 */
export function renderStandaloneHtml(
  markdown: string,
  opts?: RenderOptions
): string {
  const md = getConfiguredMarkdownIt();
  const body = md.render(markdown ?? "");
  // 标题转义:防 `</title>` / `<script>` 之类经标题注入 head。
  const title = escapeHtml((opts?.title ?? "导出").trim() || "导出");

  // katexCss 在运行期由 Vite 注入为字符串;类型层用 String() 收敛,
  // 避免 @ts-ignore import 的 any 扩散(对纯字符串拼接安全)。
  const katexStyle = String(katexCss ?? "");

  return (
    "<!DOCTYPE html>\n" +
    '<html lang="zh-CN">\n' +
    "<head>\n" +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>" +
    title +
    "</title>\n" +
    "<style>\n" +
    katexStyle +
    "\n" +
    THEME_CSS +
    "\n</style>\n" +
    "</head>\n" +
    "<body>\n" +
    '<article class="mkn-export">\n' +
    body +
    "</article>\n" +
    "</body>\n" +
    "</html>\n"
  );
}
