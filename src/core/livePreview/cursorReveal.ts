import type { EditorState } from "@codemirror/state";

/**
 * ★ 无缝混合编辑器的核心判定。
 *
 * Typora 的灵魂:光标"碰到"某段 Markdown 就露出原始源码可编辑,
 * 移开就渲染。这里定义"碰到"的精确语义。
 *
 * - 行内构造(粗/斜/行内码/链接):光标进入范围或紧贴边缘即露出,
 *   这样把光标点到 `**` 旁边就能改语法。用闭区间相交。
 * - 块级构造(标题/引用/代码块/表格):光标落在该块所跨的任意一行
 *   即整块露出 —— 块级按"整段"露才符合手感。
 */

export interface Sel {
  from: number;
  to: number;
}

export function selectionRanges(state: EditorState): Sel[] {
  return state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
}

/** 行内:闭区间相交(含紧贴边缘) */
export function inlineRevealed(sel: Sel[], from: number, to: number): boolean {
  return sel.some((r) => r.from <= to && r.to >= from);
}

/** 块级:光标是否落在 [from,to] 所覆盖的行跨度内 */
export function blockRevealed(
  state: EditorState,
  sel: Sel[],
  from: number,
  to: number
): boolean {
  const lineFrom = state.doc.lineAt(from).from;
  const lineTo = state.doc.lineAt(to).to;
  return sel.some((r) => r.from <= lineTo && r.to >= lineFrom);
}
