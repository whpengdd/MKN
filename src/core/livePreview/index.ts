import {
  ViewPlugin,
  EditorView,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { StateEffect, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { selectionRanges } from "./cursorReveal";
import { decorateInline } from "./inlineDecorations";
import { decorateBlock } from "./blockDecorations";
import { decorateCodeBlock } from "./codeBlock";
import { tableField, tableHidden } from "./table";
import type { BuildCtx } from "./decoCtx";

/** 显式刷新信号:中文 IME 组合结束后,用它强制重建一次 decoration。 */
export const forceRefresh = StateEffect.define<null>();

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** replace 范围的 atomic RangeSet,供 EditorView.atomicRanges 使用 */
    atomic: DecorationSet;

    constructor(view: EditorView) {
      const b = buildDecorations(view);
      this.decorations = b.decorations;
      this.atomic = b.atomic;
    }

    update(update: ViewUpdate) {
      // ★ 中文输入法关键:组合输入进行中绝不重建 decoration
      //   (重建会重置光标附近的 replace,导致吞字 / 光标跳)。
      //   仅把旧 decoration 按文本变更映射过去,保持位置有效。
      if (update.view.composing) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
          this.atomic = this.atomic.map(update.changes);
        }
        return;
      }

      const refreshed = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(forceRefresh))
      );

      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        refreshed
      ) {
        const b = buildDecorations(update.view);
        this.decorations = b.decorations;
        this.atomic = b.atomic;
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // 让方向键把隐藏标记 / widget 当作单一原子单位跳过,
    // 否则光标在任务复选框等附近会乱跳、跳过整段
    provide: (plugin) =>
      EditorView.atomicRanges.of(
        (view) => view.plugin(plugin)?.atomic ?? Decoration.none
      ),
  }
);

function buildDecorations(view: EditorView): {
  decorations: DecorationSet;
  atomic: DecorationSet;
} {
  const ctx: BuildCtx = { decos: [], atomic: [] };
  const sel = selectionRanges(view.state);
  const tree = syntaxTree(view.state);
  const state = view.state;

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        // 表格隐藏态由独立 StateField 渲染整块 widget;
        // 这里仅跳过其子树,避免单元格 decoration 与整块替换重叠
        if (tableHidden(node, state, sel)) return false;
        decorateInline(node, state, sel, ctx);
        decorateBlock(node, state, sel, ctx);
        decorateCodeBlock(node, state, ctx);
        return undefined;
      },
    });
  }

  // sort=true:让 CM 按 from / side 排序,正确处理嵌套与同位 decoration
  return {
    decorations: Decoration.set(ctx.decos, true),
    atomic: Decoration.set(ctx.atomic, true),
  };
}

/** IME 组合结束后强制重建一次,把刚输入的内容重新渲染。 */
const compositionRefresh = EditorView.domEventHandlers({
  compositionend(_event, view) {
    setTimeout(() => {
      view.dispatch({ effects: forceRefresh.of(null) });
    }, 0);
  },
});

/**
 * 任务复选框集中式 toggle(CM6 规范模式)。
 * 只在点中复选框本身时切换 `[ ]`↔`[x]` 并阻止默认(光标不动、不 reveal);
 * 点其它任何地方都正常落光标 → 触发 reveal,可编辑文字、回车续行。
 */
const taskToggle = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    if (!target || !target.classList.contains("mkn-task")) return false;
    const pos = view.posAtDOM(target);
    const line = view.state.doc.lineAt(pos);
    const m = /\[[ xX]\]/.exec(line.text);
    if (!m) return false;
    const from = line.from + m.index;
    const checked = m[0][1] !== " ";
    view.dispatch({
      changes: { from, to: from + 3, insert: checked ? "[ ]" : "[x]" },
    });
    event.preventDefault();
    return true;
  },
});

export function livePreview(): Extension {
  // tableField 必须是 StateField(跨行 replace 不能由 plugin 提供);
  // 其余行内/行级 decoration 走 plugin 以保留 IME 冻结。
  return [tableField(), livePreviewPlugin, compositionRefresh, taskToggle];
}
