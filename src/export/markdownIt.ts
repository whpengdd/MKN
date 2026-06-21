import MarkdownIt from "markdown-it";
// markdown-it 的类型是 `export = MarkdownIt` + 同名 namespace。开了
// esModuleInterop 后默认导入名只当"类型"用,写 `MarkdownIt.StateInline`
// 取 namespace 成员会 TS2702;具名导入 `{ StateInline }` 又 TS2614。
// 解法:不直接点名 namespace 类型,全部从「实例类型」用 Parameters/索引
// 访问派生出来 —— 既类型精确,又只用到合法的「默认导入当类型」。
type MdInlineRule = Parameters<MarkdownIt["inline"]["ruler"]["before"]>[2];
type MdBlockRule = Parameters<MarkdownIt["block"]["ruler"]["before"]>[2];
type MdStateInline = Parameters<MdInlineRule>[0];
type MdStateBlock = Parameters<MdBlockRule>[0];
type MdRenderRule = NonNullable<MarkdownIt["renderer"]["rules"]["fence"]>;
type MdToken = Parameters<MdRenderRule>[0][number];
type MdOptions = Parameters<MdRenderRule>[2];
type MdRenderer = Parameters<MdRenderRule>[4];
import katex from "katex";

/**
 * ★ 共享的 markdown-it 装配 —— 不内联 CSS,故服务端单测可直接 import
 * (KaTeX 的 .css 只在 HTML 导出的 <style> 里用,见 render.ts)。
 *
 * 设计要点沿用原 render.ts:
 *  - 纯解析,数学走 markdown-it 行内/块级规则(天然避开代码区);
 *  - Mermaid 服务端不真渲染,降级为带说明的代码块;
 *  - 代码高亮 MVP:仅转义 + language-x class,不引 highlight.js;
 *  - GFM 任务列表用极小 core 规则把段首 `[ ]/[x]` 改写成只读 checkbox。
 * HTML 导出(render.ts)与 Word 导出(docx.ts)共用此装配,避免解析漂移。
 */

/* ===========================================================================
   HTML 转义
   =========================================================================== */

/** 通用 HTML 文本转义。顺序固定:& 必须最先,避免二次转义已生成实体。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ===========================================================================
   KaTeX 渲染兜底
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
   数学:markdown-it 行内 / 块级规则
   =========================================================================== */

const CH_DOLLAR = 0x24; // $
const CH_BACKSLASH = 0x5c; // \
const CH_NEWLINE = 0x0a; // \n

/** pos 处字符是否被反斜杠转义(数连续反斜杠的奇偶)。 */
function isEscaped(src: string, pos: number): boolean {
  let backslashes = 0;
  let k = pos - 1;
  while (k >= 0 && src.charCodeAt(k) === CH_BACKSLASH) {
    backslashes++;
    k--;
  }
  return backslashes % 2 === 1;
}

/** 行内数学规则:`$...$`(单行内)。挂在 "escape" 之前。 */
function inlineMathRule(state: MdStateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;

  if (src.charCodeAt(start) !== CH_DOLLAR) return false;
  if (isEscaped(src, start)) return false;
  if (src.charCodeAt(start + 1) === CH_DOLLAR) return false;

  const max = state.posMax;
  const openCh = src.charCodeAt(start + 1);
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
  if (tex.length === 0) return false;

  if (!silent) {
    const token = state.push("math_inline", "", 0);
    token.content = tex;
    token.markup = "$";
  }
  state.pos = close + 1;
  return true;
}

/** 块级数学规则:独占整行(可多行)的 `$$ ... $$`。挂在 "fence" 之前。 */
function blockMathRule(
  state: MdStateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const lineStart = state.bMarks[startLine] + state.tShift[startLine];
  const lineEnd = state.eMarks[startLine];
  const src = state.src;

  if (lineStart + 2 > lineEnd) return false;
  if (
    src.charCodeAt(lineStart) !== CH_DOLLAR ||
    src.charCodeAt(lineStart + 1) !== CH_DOLLAR
  ) {
    return false;
  }
  if (isEscaped(src, lineStart)) return false;

  const firstLineRest = src.slice(lineStart + 2, lineEnd);
  const sameLineClose = firstLineRest.search(/\$\$\s*$/);
  if (sameLineClose >= 0) {
    const tex = firstLineRest.slice(0, sameLineClose).trim();
    if (tex.length === 0) return false;
    if (silent) return true;
    const token = state.push("math_block", "", 0);
    token.content = tex;
    token.markup = "$$";
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }

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
  if (!found) return false;

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
   组装 markdown-it 实例
   =========================================================================== */

function makeMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight(code: string, lang: string): string {
      const langClass = lang
        ? ' class="language-' + escapeHtml(lang) + '"'
        : "";
      return (
        "<pre" +
        (lang ? ' data-lang="' + escapeHtml(lang) + '"' : "") +
        "><code" +
        langClass +
        ">" +
        escapeHtml(code) +
        "</code></pre>"
      );
    },
  });

  // 数学规则挂载。
  md.inline.ruler.before("escape", "math_inline", inlineMathRule);
  md.block.ruler.before("fence", "math_block", blockMathRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });

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

  // Mermaid:覆盖 fence 渲染器(服务端不真渲染,降级带说明的代码块)。
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
    return "<pre><code>" + escapeHtml(token.content) + "</code></pre>\n";
  };

  // GFM 任务列表(core 规则,纯字符串改写)。
  md.core.ruler.after("inline", "mkn_task_list", (state): boolean => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "inline") continue;
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
      inline.content = inline.content.slice(m[0].length);
      const children = inline.children;
      if (children && children.length > 0 && children[0].type === "text") {
        children[0].content = children[0].content.replace(
          /^\[([ xX])\]\s+/,
          ""
        );
      }
      const box = new state.Token("html_inline", "", 0);
      box.content =
        '<input class="mkn-task-checkbox" type="checkbox" disabled' +
        (checked ? " checked" : "") +
        "> ";
      if (children) {
        children.unshift(box);
      }
      open1.attrJoin("class", "mkn-task-item");
    }
    return true;
  });

  return md;
}

/* ===========================================================================
   对外:共享单例(无状态,每次 render/parse 独立)
   =========================================================================== */

let mdSingleton: MarkdownIt | null = null;

/**
 * ★ 取共享的、已装配好的 markdown-it 实例(数学 / Mermaid / 任务列表 /
 * 表格规则齐备)。HTML 导出取其 render(),Word 导出取其 parse() token 流。
 */
export function getConfiguredMarkdownIt(): MarkdownIt {
  if (!mdSingleton) mdSingleton = makeMarkdownIt();
  return mdSingleton;
}
