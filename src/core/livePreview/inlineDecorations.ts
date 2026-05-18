import { Decoration } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";
import { inlineRevealed, type Sel } from "./cursorReveal";
import { ImageWidget } from "./widgets";
import { addReplace, type BuildCtx } from "./decoCtx";

const styleByNode: Record<string, { cls: string; mark: string }> = {
  StrongEmphasis: { cls: "cm-hp-strong", mark: "EmphasisMark" },
  Emphasis: { cls: "cm-hp-em", mark: "EmphasisMark" },
  InlineCode: { cls: "cm-hp-code", mark: "CodeMark" },
  Strikethrough: { cls: "cm-hp-strike", mark: "StrikethroughMark" },
};

/**
 * 行内构造:始终给文字加渲染样式(光标在场也保持,避免改语法时排版跳动),
 * 仅当光标未触碰时隐藏 `**` `` ` `` `~~` 等标记符号(隐藏即 atomic)。
 */
export function decorateInline(
  node: SyntaxNodeRef,
  state: EditorState,
  sel: Sel[],
  ctx: BuildCtx
): void {
  const spec = styleByNode[node.name];
  if (spec) {
    ctx.decos.push(
      Decoration.mark({ class: spec.cls }).range(node.from, node.to)
    );
    if (!inlineRevealed(sel, node.from, node.to)) {
      for (const m of node.node.getChildren(spec.mark)) {
        addReplace(ctx, m.from, m.to, {});
      }
    }
    return;
  }

  if (node.name === "Image") {
    const text = state.doc.sliceString(node.from, node.to);
    const m = /^!\[([^\]]*)\]\(\s*([^\s)]+)[^)]*\)/.exec(text);
    if (m && !inlineRevealed(sel, node.from, node.to)) {
      addReplace(ctx, node.from, node.to, {
        widget: new ImageWidget(m[2], m[1]),
      });
    }
    return;
  }

  if (node.name === "Link") {
    decorateLink(node, state, sel, ctx);
  }
}

/** `[文字](url)` → 未触碰时只留下"文字"并样式成链接,隐藏 `[` 与 `](url)` */
function decorateLink(
  node: SyntaxNodeRef,
  state: EditorState,
  sel: Sel[],
  ctx: BuildCtx
): void {
  const marks = node.node.getChildren("LinkMark");
  const open = marks[0];
  const close = marks.find(
    (m) =>
      m.from > (open?.to ?? node.from) &&
      state.doc.sliceString(m.from, m.to) === "]"
  );

  if (!open || !close) {
    ctx.decos.push(
      Decoration.mark({ class: "cm-hp-link" }).range(node.from, node.to)
    );
    return;
  }

  ctx.decos.push(
    Decoration.mark({ class: "cm-hp-link" }).range(open.to, close.from)
  );

  if (!inlineRevealed(sel, node.from, node.to)) {
    addReplace(ctx, node.from, open.to, {}); // 隐藏 [
    addReplace(ctx, close.from, node.to, {}); // 隐藏 ](url)
  }
}
