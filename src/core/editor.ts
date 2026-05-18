import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap, drawSelection, dropCursor } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { insertNewlineContinueMarkup, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { markdownLang } from "./markdown";
import { livePreview } from "./livePreview";
import { theme } from "./theme";

/**
 * 实时预览放进 Compartment —— 源码模式切换靠重配它(开:livePreview;
 * 关:空,露出带语法高亮的原始 markdown)。Phase 3 新增。
 */
const liveCompartment = new Compartment();

/** 每个 view 当前是否处于"源码模式"。WeakMap 随 view 生命周期回收。 */
const sourceModeOf = new WeakMap<EditorView, boolean>();

/**
 * 编辑器内核装配 —— 纯 Web,零外壳依赖。
 * Phase 2 由 Electron 原样包裹这同一份装配。
 *
 * `EditorView.lineWrapping` 让长行像文档一样折行(而非横向滚动),
 * 这是写作工具的基本体感。
 *
 * @param extra 外壳/特性层注入的额外扩展(专注模式、KaTeX、Mermaid、
 *   图片粘贴等)。Phase 3 接缝:特性各自是自包含 CM 扩展,经此注入,
 *   不必改动本装配。省略时行为与 Phase 0/1 完全一致(向后兼容)。
 */
export function createEditor(
  parent: HTMLElement,
  doc: string,
  extra: Extension[] = []
): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      EditorView.lineWrapping,
      search({ top: true }),
      keymap.of([
        // 列表/引用自动续行与智能退格(置于 defaultKeymap 之前;
        // 不在列表中时返回 false 自动回退到默认行为)
        { key: "Enter", run: insertNewlineContinueMarkup },
        { key: "Backspace", run: deleteMarkupBackward },
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      markdownLang(),
      liveCompartment.of(livePreview()),
      theme(),
      ...extra,
    ],
  });

  return new EditorView({ state, parent });
}

/** 设置源码模式:on=true 关掉实时预览,露出原始 markdown(带语法高亮)。 */
export function setSourceMode(view: EditorView, on: boolean): void {
  sourceModeOf.set(view, on);
  view.dispatch({
    effects: liveCompartment.reconfigure(on ? [] : livePreview()),
  });
}

/** 切换源码模式,返回切换后的新状态。 */
export function toggleSourceMode(view: EditorView): boolean {
  const next = !(sourceModeOf.get(view) ?? false);
  setSourceMode(view, next);
  return next;
}

/** 当前是否处于源码模式。 */
export function isSourceMode(view: EditorView): boolean {
  return sourceModeOf.get(view) ?? false;
}

/** 用新内容整体替换文档(加载本地 .md 时用)。 */
export function loadDoc(view: EditorView, doc: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: doc },
    selection: { anchor: 0 },
  });
}
