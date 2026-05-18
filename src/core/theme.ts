import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * 单套精调默认主题(Phase 0)。
 *
 * Typora 的"简洁"很大程度是默认主题排版调出来的,因此重点在:
 * 中文友好的字体栈、舒适行高、文档式居中正文列、克制的色彩。
 * 这里只放 CM 结构相关样式与代码高亮;视觉细节放 styles/theme-default.css,
 * 用 CSS 变量预留未来可换主题(架构成本极低)。
 */

const editorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--mkn-fg)",
      backgroundColor: "var(--mkn-bg)",
      fontSize: "16px",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: "var(--mkn-font-body)",
      lineHeight: "1.75",
      overflow: "auto",
    },
    // 文档式正文列:居中、限宽,贴近 Typora 的写作区
    ".cm-content": {
      maxWidth: "var(--mkn-content-width)",
      margin: "0 auto",
      padding: "56px 24px 40vh",
      caretColor: "var(--mkn-accent)",
    },
    ".cm-line": { padding: "0" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--mkn-accent)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "var(--mkn-selection)",
    },
    ".cm-gutters": { display: "none" },
  },
  { dark: false }
);

// 代码围栏与行内代码的语法着色 —— 克制的低饱和配色
const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700" },
  { tag: [t.keyword, t.modifier], color: "#a626a4" },
  { tag: [t.controlKeyword, t.operatorKeyword], color: "#a626a4" },
  { tag: [t.string, t.special(t.string)], color: "#50a14f" },
  { tag: [t.number, t.bool, t.null], color: "#986801" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#4078f2" },
  { tag: [t.definition(t.variableName), t.propertyName], color: "#e45649" },
  { tag: [t.typeName, t.className, t.namespace], color: "#c18401" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#a0a1a7", fontStyle: "italic" },
  { tag: [t.regexp, t.escape], color: "#0184bc" },
  { tag: t.invalid, color: "#e45649" },
]);

export function theme(): Extension {
  return [editorTheme, syntaxHighlighting(highlight)];
}
