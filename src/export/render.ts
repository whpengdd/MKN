import MarkdownIt from "markdown-it";
// markdown-it 的类型是 `export = MarkdownIt` + 同名 namespace。开了
// esModuleInterop 后默认导入名只当"类型"用,写 `MarkdownIt.StateInline`
// 取 namespace 成员会 TS2702;具名导入 `{ StateInline }` 又 TS2614。
// 本文件受并行约束不能新建 .d.ts。解法:不直接点名 namespace 类型,
// 全部从「实例类型」用 Parameters/索引访问派生出来 —— 既类型精确,
// 又只用到合法的「默认导入当类型」。
type MdInlineRule = Parameters<MarkdownIt["inline"]["ruler"]["before"]>[2];
type MdBlockRule = Parameters<MarkdownIt["block"]["ruler"]["before"]>[2];
type MdStateInline = Parameters<MdInlineRule>[0];
type MdStateBlock = Parameters<MdBlockRule>[0];
type MdRenderRule = NonNullable<MarkdownIt["renderer"]["rules"]["fence"]>;
type MdToken = Parameters<MdRenderRule>[0][number];
type MdOptions = Parameters<MdRenderRule>[2];
type MdRenderer = Parameters<MdRenderRule>[4];
import katex from "katex";
// KaTeX 字体/排版样式。Vite 的 `?inline` 把 css 当字符串导出 —— 这样
// 才能整段塞进导出 HTML 的 <style>,实现"离线双击即开、零外链"。
// 但 src 下无 .css 模块声明、本文件又不能新建 .d.ts(并行约束:只许
// 建这一个文件),`tsc --noEmit` 会对该 import 报 TS2307。与 livePreview/
// math.ts 处理裸 css import 同策略:就地 @ts-ignore(运行期由 Vite 解析)。
// @ts-ignore -- css?inline 资源 import,无类型声明;运行期 Vite 提供字符串
import katexCss from "katex/dist/katex.min.css?inline";

/**
 * ★ 导出渲染器 —— 纯函数:markdown 字符串 → 完整独立 HTML 文档。
 *
 * 设计要点(对齐 livePreview/math.ts、mermaid.ts 的取舍与风格):
 *
 *  1. 纯函数、零副作用:不碰 DOM、不依赖 Electron,故 HTML 导出 / PDF
 *     导出可共用,也能直接单测。绝不修改源 markdown。
 *
 *  2. 数学不走"全文预处理 + 自己排除代码区",而是注册成 markdown-it
 *     的行内 / 块级规则。这样天然不碰代码块/行内码里的 `$`:markdown-it
 *     在每个位置按规则链尝试,走到反引号时 `backticks` 规则会把整段
 *     `` `…` `` 原子吞成一个 code_inline token 并整体跳过,光标根本不会
 *     落进代码区内部;块级同理——`fence`/缩进 `code` 规则会把整块连同
 *     内部所有 `$$` 一次性吃掉,后续行级规则不再逐行进入。故无需手动
 *     维护"代码禁区"(比 math.ts 那套 syntaxTree 禁区更省心)。转义
 *     `\$`、`$$` 优先、行内定界空白消歧义等细节,沿用 math.ts 里已验证
 *     过的扫描逻辑。
 *
 *  3. Mermaid:服务端无 DOM,不引 puppeteer 等重依赖(与 mermaid.ts
 *     文档注释同一取舍声明)。降级为带说明的代码块,原样保留图源码,
 *     不丢信息;真渲染交给"在浏览器里看导出文件"或后续迭代。
 *
 *  4. 代码高亮:MVP——仅转义后套 `language-x` class,配清爽等宽样式,
 *     不引 highlight.js(避免新依赖,符合任务约束)。
 *
 *  5. 主题 CSS 自带一段字符串(读不了也不该运行时读 theme-default.css):
 *     中文友好字体栈、舒适行高、限宽居中正文。配色"参考不照抄"主题
 *     文件的具体色值,贴近 Typora 默认浅色。这段 + katex 的 css 一起
 *     内联进 <head><style>,保证完全自包含、可离线打开。
 */

export interface RenderOptions {
  title?: string;
}

/* ===========================================================================
   一、HTML 转义
   - escapeHtml:正文里需要纯文本逐字呈现处(代码块、mermaid 源码)。
   - escapeAttr:暂未单独区分,统一用 escapeHtml(覆盖 & < > " ')即可。
   - <title> 注入防护:对 opts.title 转义,杜绝 `</title><script>` 之类。
   =========================================================================== */

/** 通用 HTML 文本转义。顺序固定:& 必须最先,避免二次转义已生成实体。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ===========================================================================
   二、KaTeX 渲染兜底
   throwOnError:false 让 KaTeX 自身不抛;再包 try/catch 兜任何意外异常,
   渲染失败只产出一段红色错误文本(与 math.ts 的 .mkn-math-error 同款),
   绝不让异常冒泡中断整篇导出。
   =========================================================================== */

function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      '<span class="mkn-math-error">数学公式渲染失败: ' +
      escapeHtml(msg) +
      "</span>"
    );
  }
}

/* ===========================================================================
   三、数学:markdown-it 行内 / 块级规则
   ---------------------------------------------------------------------------
   字符常量(charCodeAt 比逐字符串比较快,也更贴 markdown-it 内部写法):
   =========================================================================== */

const CH_DOLLAR = 0x24; // $
const CH_BACKSLASH = 0x5c; // \
const CH_NEWLINE = 0x0a; // \n

/** pos 处字符是否被反斜杠转义(数连续反斜杠的奇偶)。同 math.ts isEscaped。 */
function isEscaped(src: string, pos: number): boolean {
  let backslashes = 0;
  let k = pos - 1;
  while (k >= 0 && src.charCodeAt(k) === CH_BACKSLASH) {
    backslashes++;
    k--;
  }
  return backslashes % 2 === 1;
}

/**
 * 行内数学规则:`$...$`(单行内)。挂在 "escape" 之前(于是先于
 * `text`/`escape` 之后的其它规则匹配到 `$`)。
 *
 * 为什么 `` `$x$` `` 不会被误判:与本规则相对 `backticks` 的先后无关。
 * markdown-it 在每个 pos 顺序试规则;光标走到反引号时 `backticks`
 * 命中,把整段 `` `…` `` 原子吞成一个 code_inline 并把 pos 跳到其后,
 * 本规则的扫描窗口永远落不进代码区内部。而本规则自身只从 `$` 起、
 * 不吞反引号,也不会反向破坏代码段。
 *
 * 定界消歧义(沿用 math.ts / CommonMark-math 通行约定):
 *  - 开 `$` 后不能紧跟空白或行尾,否则不启动公式(避免 `$ 文字` 误吞);
 *  - 闭 `$` 前不能是空白;
 *  - 行内不跨行,遇 `\n` 即放弃;
 *  - 转义 `\$` 不作定界。
 * silent 模式(markdown-it 试探阶段)只判定能否匹配、不产 token。
 */
function inlineMathRule(state: MdStateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;

  if (src.charCodeAt(start) !== CH_DOLLAR) return false;
  if (isEscaped(src, start)) return false;
  // `$$` 交给块级规则;行内只认单 `$`(后面紧跟另一个 `$` 视为非行内)。
  if (src.charCodeAt(start + 1) === CH_DOLLAR) return false;

  const max = state.posMax;
  const openCh = src.charCodeAt(start + 1);
  // 开定界后是行尾 / 空白 → 这个 `$` 不启动行内公式。
  if (
    Number.isNaN(openCh) ||
    openCh === CH_NEWLINE ||
    /\s/.test(src[start + 1] ?? "")
  ) {
    return false;
  }

  let pos = start + 1;
  let close = -1;
  while (pos < max) {
    const c = src.charCodeAt(pos);
    if (c === CH_NEWLINE) break; // 行内不跨行
    if (c === CH_DOLLAR && !isEscaped(src, pos)) {
      // 闭定界 `$` 前不能是空白(消歧义)。
      if (/\s/.test(src[pos - 1] ?? "")) {
        pos++;
        continue;
      }
      close = pos;
      break;
    }
    pos++;
  }

  if (close < 0) return false;

  const tex = src.slice(start + 1, close).trim();
  if (tex.length === 0) return false; // 空 `$$` 不当公式,按普通文本走

  if (!silent) {
    const token = state.push("math_inline", "", 0);
    token.content = tex;
    token.markup = "$";
  }
  state.pos = close + 1;
  return true;
}

/**
 * 块级数学规则:独占整行(可多行)的 `$$ ... $$`。挂在 "fence" 之前,
 * 但内置 `code`(缩进代码)仍排在更前。不会与代码块相撞:本规则要求
 * 行首(去缩进后)是 `$$`,而 ``` 围栏行以反引号开头会被本规则直接
 * 拒绝、转交 `fence`;一旦 `fence`/`code` 起块,会把整块连同内部所有
 * `$$` 行一次性吞掉,行级规则不再逐行进入,故块内 `$$` 天然安全。支持:
 *  - 同行闭合:`$$ x^2 $$`
 *  - 跨多行:首行以 `$$` 开,内容若干行,某行以 `$$` 结尾
 * 仅当该块独占其所跨行(不与正文混排)时按块级公式处理 —— 与正文
 * 同行的 `$$x$$` 留给行内规则按行内渲染(displayMode 仍保块级排版)。
 */
function blockMathRule(
  state: MdStateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const lineStart = state.bMarks[startLine] + state.tShift[startLine];
  const lineEnd = state.eMarks[startLine];
  const src = state.src;

  // 起始行去掉前导缩进后必须以 `$$` 开头(不含被转义的 `\$$`)。
  if (lineStart + 2 > lineEnd) return false;
  if (
    src.charCodeAt(lineStart) !== CH_DOLLAR ||
    src.charCodeAt(lineStart + 1) !== CH_DOLLAR
  ) {
    return false;
  }
  if (isEscaped(src, lineStart)) return false;

  // 先尝试"同一行内闭合":`$$ ... $$`(收尾 `$$` 后只允许空白)。
  const firstLineRest = src.slice(lineStart + 2, lineEnd);
  const sameLineClose = firstLineRest.search(/\$\$\s*$/);
  if (sameLineClose >= 0) {
    const tex = firstLineRest.slice(0, sameLineClose).trim();
    // 空 `$$$$` / `$$ $$` 不当公式(同 math.ts:空内容不渲染),
    // 返回 false 交回其它规则按普通文本呈现,不产空块。
    if (tex.length === 0) return false;
    if (silent) return true;
    const token = state.push("math_block", "", 0);
    token.content = tex;
    token.markup = "$$";
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }

  // 否则向下逐行找收尾 `$$`(该行须以 `$$` 结束,后面仅空白)。
  let nextLine = startLine;
  let found = false;
  while (nextLine < endLine) {
    nextLine++;
    if (nextLine >= state.lineMax) break;
    const bs = state.bMarks[nextLine] + state.tShift[nextLine];
    const be = state.eMarks[nextLine];
    const lineText = src.slice(bs, be);
    if (/\$\$\s*$/.test(lineText)) {
      found = true;
      break;
    }
  }
  if (!found) return false; // 没收尾:不是块级公式,交回其它规则(可能行内)

  // 拼接公式正文:首行 `$$` 之后 + 中间整行 + 末行去掉结尾 `$$`。
  const parts: string[] = [];
  parts.push(src.slice(lineStart + 2, lineEnd));
  for (let l = startLine + 1; l < nextLine; l++) {
    const bs = state.bMarks[l] + state.tShift[l];
    const be = state.eMarks[l];
    parts.push(src.slice(bs, be));
  }
  const lastBs = state.bMarks[nextLine] + state.tShift[nextLine];
  const lastBe = state.eMarks[nextLine];
  const lastText = src.slice(lastBs, lastBe).replace(/\$\$\s*$/, "");
  parts.push(lastText);

  const tex = parts.join("\n").trim();
  // 跨行但内容为空(如 `$$` 紧接 `$$`)同样不渲染,交回其它规则。
  if (tex.length === 0) return false;
  if (silent) return true;
  const token = state.push("math_block", "", 0);
  token.content = tex;
  token.markup = "$$";
  token.map = [startLine, nextLine + 1];
  state.line = nextLine + 1;
  return true;
}

/* ===========================================================================
   四、组装 markdown-it 实例
   - html:true(允许文档内联 HTML,Typora 行为;任务声明此为可接受)
   - linkify:true(裸 URL 自动成链)
   - typographer:true(智能引号 / 破折号等)
   - GFM 表格:markdown-it 默认即支持,无需额外开关
   - 删除线 `~~x~~`:markdown-it 默认 `strikethrough` 规则已支持
   - 任务列表:GFM `- [ ] / - [x]`。markdown-it 无内置任务列表规则,
     用一条极小的 core 规则把 list_item 段首的 `[ ]/[x]` 文本替换为
     只读 checkbox(纯字符串改写,不依赖 DOM)。
   =========================================================================== */

/** 取已注册的 fence 默认渲染器(供 mermaid 分支回退到清爽代码块样式)。 */
function makeMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    // 代码高亮 MVP:不引 highlight.js,这里只负责把代码转义后塞进
    // <pre><code class="language-x">,配套 CSS 给等宽清爽样式。
    // 返回带标签的完整 HTML(故下面 fence 渲染器直接用其返回值)。
    highlight(code: string, lang: string): string {
      const langClass = lang
        ? ' class="language-' + escapeHtml(lang) + '"'
        : "";
      return (
        "<pre" +
        (lang ? ' data-lang="' + escapeHtml(lang) + '"' : "") +
        '><code' +
        langClass +
        ">" +
        escapeHtml(code) +
        "</code></pre>"
      );
    },
  });

  // --- 数学规则挂载 -------------------------------------------------------
  // 行内:置于 "escape" 之前(在 backticks 之后,故行内码内 `$` 安全)。
  md.inline.ruler.before("escape", "math_inline", inlineMathRule);
  // 块级:置于 "fence" 之前(故 ``` 围栏内 `$$` 安全)。
  md.block.ruler.before("fence", "math_block", blockMathRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });

  // 行内 / 块级公式 → KaTeX HTML(渲染器规则,内部已兜底不抛)。
  md.renderer.rules.math_inline = (tokens: MdToken[], idx: number): string => {
    return (
      '<span class="mkn-math mkn-math-inline">' +
      renderTex(tokens[idx].content, false) +
      "</span>"
    );
  };
  md.renderer.rules.math_block = (tokens: MdToken[], idx: number): string => {
    return (
      '<div class="mkn-math mkn-math-block">' +
      renderTex(tokens[idx].content, true) +
      "</div>\n"
    );
  };

  // --- Mermaid:覆盖 fence 渲染器 -----------------------------------------
  // 命中 ```mermaid → 原样保留源码的代码块 + 一行说明(MVP 取舍:
  // 服务端无 DOM 不真渲染,绝不引重依赖)。其余语言走默认高亮分支。
  const defaultFence: MdRenderRule | undefined = md.renderer.rules.fence;
  md.renderer.rules.fence = (
    tokens: MdToken[],
    idx: number,
    options: MdOptions,
    env: unknown,
    self: MdRenderer
  ): string => {
    const token = tokens[idx];
    const info = token.info ? token.info.trim().split(/\s+/)[0] : "";
    if (info.toLowerCase() === "mermaid") {
      return (
        '<figure class="mkn-mermaid">' +
        '<figcaption class="mkn-mermaid-note">Mermaid 图(源码,导出未渲染)</figcaption>' +
        "<pre>" +
        escapeHtml(token.content) +
        "</pre>" +
        "</figure>\n"
      );
    }
    if (defaultFence) {
      return defaultFence(tokens, idx, options, env as never, self);
    }
    // 理论上 highlight 已接管;留一层纯文本兜底,绝不产出未转义内容。
    return "<pre><code>" + escapeHtml(token.content) + "</code></pre>\n";
  };

  // --- GFM 任务列表(core 规则,纯字符串改写)-----------------------------
  // 扫描每个 list_item 起始 inline token 的文本:段首 `[ ] ` / `[x] `
  // → 只读 <input type=checkbox>。disabled 保证导出件不可改、纯展示。
  md.core.ruler.after("inline", "mkn_task_list", (state): boolean => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "inline") continue;
      // 该 inline 必须是某个 list_item 的首段(前两个 token 为
      // list_item_open → paragraph_open),才认作任务项。
      const open1 = tokens[i - 2];
      const open2 = tokens[i - 1];
      if (
        !open1 ||
        !open2 ||
        open1.type !== "list_item_open" ||
        open2.type !== "paragraph_open"
      ) {
        continue;
      }
      const inline = tokens[i];
      const m = /^\[([ xX])\]\s+/.exec(inline.content);
      if (!m) continue;
      const checked = m[1] !== " ";
      // 改写 content(用于无 children 的极端情形)与 children 文本,
      // 双写以稳妥覆盖 markdown-it 渲染实际取用的字段。
      inline.content = inline.content.slice(m[0].length);
      const children = inline.children;
      if (children && children.length > 0 && children[0].type === "text") {
        children[0].content = children[0].content.replace(
          /^\[([ xX])\]\s+/,
          ""
        );
      }
      // 在首段开头插一个只读 checkbox 的 html_inline token。
      const box = new state.Token("html_inline", "", 0);
      box.content =
        '<input class="mkn-task-checkbox" type="checkbox" disabled' +
        (checked ? " checked" : "") +
        "> ";
      if (children) {
        children.unshift(box);
      }
      // 给 list_item 加 class,便于 CSS 去掉项目符号、对齐复选框。
      open1.attrJoin("class", "mkn-task-item");
    }
    return true;
  });

  return md;
}

/* ===========================================================================
   五、内联主题 CSS(自带,不读 theme-default.css)
   配色"参考不照抄"主题文件具体色值,贴近 Typora 默认浅色:
     正文 #2b2b2b / 弱化 #6b6b6b / 强调链接 #3a7afe
     代码底 #f6f7f9 / 行内码字 #d1395a / 分隔线 #e8e8e8 / 引用条 #d8dde4
   中文友好字体栈、行高 1.7、限宽 760px 居中正文列。
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
   六、对外冻结签名
   =========================================================================== */

// 模块级单例:markdown-it 实例无状态(每次 render 独立),复用省去重复
// 装配规则的开销。纯函数语义不受影响(同输入恒同输出)。
let mdSingleton: MarkdownIt | null = null;
function getMd(): MarkdownIt {
  if (!mdSingleton) mdSingleton = makeMarkdownIt();
  return mdSingleton;
}

/**
 * ★ 冻结导出签名(集成方逐字按此调用,勿改):
 * markdown → 完整独立 HTML 文档(<!DOCTYPE html>…),主题 CSS 内联,
 * 可离线双击打开。纯函数:无副作用、不依赖 DOM/Electron、不改源 markdown。
 */
export function renderStandaloneHtml(
  markdown: string,
  opts?: RenderOptions
): string {
  const md = getMd();
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
