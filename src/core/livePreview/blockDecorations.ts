import { Decoration } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { blockRevealed, type Sel } from "./cursorReveal";
import { HrWidget, BulletWidget, TaskWidget } from "./widgets";
import { addReplace, type BuildCtx } from "./decoCtx";

/** 递归收集子树内所有指定名字的节点(多行引用、嵌套引用的 QuoteMark
 *  不是直接子节点,getChildren 取不全,必须深度遍历)。 */
function descendants(node: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const cur = node.cursor();
  if (!cur.firstChild()) return out;
  do {
    if (cur.name === name) out.push(cur.node);
    out.push(...descendants(cur.node, name));
  } while (cur.nextSibling());
  return out;
}

/**
 * 块级构造:标题 / 引用 / 分隔线 / 列表。
 * 始终保留视觉样式(标题大、引用竖线),仅在光标未落在该块时
 * 隐藏 `#` `>` 等前导标记;块级按"整段"露出。
 */
export function decorateBlock(
  node: SyntaxNodeRef,
  state: EditorState,
  sel: Sel[],
  ctx: BuildCtx
): void {
  const heading = /^ATXHeading([1-6])$/.exec(node.name);
  if (heading) {
    const level = heading[1];
    const line = state.doc.lineAt(node.from);
    ctx.decos.push(
      Decoration.line({ class: `cm-hp-h${level}` }).range(line.from)
    );
    if (!blockRevealed(state, sel, node.from, node.to)) {
      const mark = node.node.getChild("HeaderMark");
      if (mark) {
        // 连同 `#` 后的空格一起隐藏,使标题左对齐到正文
        const text = line.text;
        let end = mark.to - line.from;
        while (end < text.length && text[end] === " ") end++;
        addReplace(ctx, line.from, line.from + end, {});
      }
    }
    return;
  }

  if (node.name === "Blockquote") {
    const startLine = state.doc.lineAt(node.from).number;
    const endLine = state.doc.lineAt(node.to).number;
    for (let n = startLine; n <= endLine; n++) {
      ctx.decos.push(
        Decoration.line({ class: "cm-hp-quote" }).range(state.doc.line(n).from)
      );
    }
    if (!blockRevealed(state, sel, node.from, node.to)) {
      for (const q of descendants(node.node, "QuoteMark")) {
        // `>` 及其后空格
        const ln = state.doc.lineAt(q.from);
        let end = q.to - ln.from;
        while (end < ln.text.length && ln.text[end] === " ") end++;
        addReplace(ctx, q.from, ln.from + end, {});
      }
    }
    return;
  }

  if (node.name === "HorizontalRule") {
    const line = state.doc.lineAt(node.from);
    if (!blockRevealed(state, sel, node.from, node.to)) {
      addReplace(ctx, line.from, line.to, { widget: new HrWidget() });
    }
    return;
  }

  if (node.name === "ListMark") {
    const ch = state.doc.sliceString(node.from, node.to);
    // 仅无序列表符号 -/*/+ 渲染成圆点;有序列表保留数字
    if (/^[-*+]$/.test(ch.trim())) {
      if (!blockRevealed(state, sel, node.from, node.to)) {
        addReplace(ctx, node.from, node.to, { widget: new BulletWidget() });
      }
    }
    return;
  }

  if (node.name === "TaskMarker") {
    // `[ ]` / `[x]` —— 光标不在该行时渲染可点击复选框
    if (!blockRevealed(state, sel, node.from, node.to)) {
      const checked = /[xX]/.test(state.doc.sliceString(node.from, node.to));
      addReplace(ctx, node.from, node.to, {
        widget: new TaskWidget(checked),
      });
    }
  }
}
