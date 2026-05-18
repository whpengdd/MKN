import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import {
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNodeRef } from "@lezer/common";
import { blockRevealed, selectionRanges, type Sel } from "./cursorReveal";
import { TableWidget } from "./widgets";

/**
 * GFM 表格 —— 必须用 StateField,不能用 ViewPlugin。
 *
 * 关键 CM6 约束(实测踩到):跨行、含换行符的 replace decoration
 * "may not be specified via plugins",与 block decoration 同一限制。
 * 表格整块替换天然跨多行,因此独立成一个 StateField:
 *  - 光标不在表格 → 用跨行 replace widget 替换整块,显示渲染后的 <table>
 *  - 光标进入表格行 → 不替换,露出原始 pipe 文本直接编辑(reveal 交接)
 *
 * 行内/行级 decoration 仍留在 ViewPlugin(保留 IME 冻结);表格不涉及
 * IME(隐藏态是 widget,要输入必先点击 → 已 reveal 成源码),故 field
 * 每次事务重建即可,无需冻结。
 */

/** 该 Table 节点当前是否处于"隐藏渲染"态(光标不在其上)。
 *  供 ViewPlugin 判断是否跳过表格子树,避免单元格 decoration 与整块替换重叠。*/
export function tableHidden(
  node: SyntaxNodeRef,
  state: EditorState,
  sel: Sel[]
): boolean {
  if (node.name !== "Table") return false;
  const from = state.doc.lineAt(node.from).from;
  const to = state.doc.lineAt(node.to).to;
  return !blockRevealed(state, sel, from, to);
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const sel = selectionRanges(state);
  const tree = syntaxTree(state);

  tree.iterate({
    enter: (node) => {
      if (node.name !== "Table") return undefined;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      if (!blockRevealed(state, sel, from, to)) {
        const source = state.doc.sliceString(from, to);
        decos.push(
          Decoration.replace({
            widget: new TableWidget(source, from),
            block: true,
          }).range(from, to)
        );
      }
      return false; // 不必深入表格内部
    },
  });

  return Decoration.set(decos, true);
}

const tableStateField = StateField.define<DecorationSet>({
  create: (state) => buildTableDecorations(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection) {
      return buildTableDecorations(tr.state);
    }
    return value.map(tr.changes);
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // 整块表格 widget 也作为 atomic:方向键不会钻进被隐藏的多行 pipe 源码
    EditorView.atomicRanges.of((view) => view.state.field(f) ?? Decoration.none),
  ],
});

export function tableField(): Extension {
  return tableStateField;
}
