import { Decoration } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";
import type { BuildCtx } from "./decoCtx";

/**
 * 代码围栏:给整块逐行加盒子样式(背景 / 圆角 / 等宽字体)。
 * 语法着色由 markdown 语言层惰性加载对应语言 + highlight style 自动完成,
 * 无需在此干预。Phase 0 保留围栏 ``` 可见(隐藏围栏是块级 decoration
 * 边界活,留到后续),先验证"代码块手感"这个硬点。
 */
export function decorateCodeBlock(
  node: SyntaxNodeRef,
  state: EditorState,
  ctx: BuildCtx
): void {
  if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;

  const startLine = state.doc.lineAt(node.from).number;
  const endLine = state.doc.lineAt(node.to).number;

  for (let n = startLine; n <= endLine; n++) {
    const cls =
      "cm-hp-codeblock" +
      (n === startLine ? " cm-hp-codeblock-first" : "") +
      (n === endLine ? " cm-hp-codeblock-last" : "");
    ctx.decos.push(
      Decoration.line({ class: cls }).range(state.doc.line(n).from)
    );
  }
}
