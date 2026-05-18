import {
  ViewPlugin,
  EditorView,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  StateField,
  StateEffect,
  type EditorState,
  type Extension,
} from "@codemirror/state";

/**
 * Phase 3:专注模式 + 打字机模式。
 *
 * 这是一个纯 CodeMirror 扩展,经 `createEditor(parent, doc, extra)` 的
 * `extra` 注入,不改装配处。两个模式相互独立、默认关闭,运行时各自用
 * `set*Mode` 切换。
 *
 * 接线总览(为何这么分层):
 * - 开关状态用 StateField + StateEffect 持有 —— StateField 在
 *   reconfigure 时默认保留(本项目源码模式靠 Compartment.reconfigure,
 *   切换时不能把专注/打字机状态冲掉),用 effect 改值符合 CM6 单向数据流。
 * - 专注变暗用 ViewPlugin:它读 StateField + 光标位置算出 line
 *   decoration,只处理 `view.visibleRanges`(大文档不全量遍历,
 *   与 livePreview/index.ts 同款做法)。
 * - 打字机居中用 updateListener:在 selection/doc 真正变化时
 *   dispatch 一次 scrollIntoView(center),并加守卫避免与用户滚动打架。
 */

/* ────────────────────────────────────────────────────────────────────────
 * 1. 开关状态:StateField + StateEffect
 * ──────────────────────────────────────────────────────────────────────── */

/** 设置专注模式开关(true=开启变暗)。 */
const setFocusEffect = StateEffect.define<boolean>();
/** 设置打字机模式开关(true=光标行强制居中)。 */
const setTypewriterEffect = StateEffect.define<boolean>();

/**
 * 两个开关合一存进同一个 StateField —— 用一个字段省一次遍历,
 * 且保证两标志在同一快照里一致。默认都 false(向后兼容:不注入
 * 任何效果时编辑器行为与未加本扩展时一致)。
 */
interface ModeState {
  focus: boolean;
  typewriter: boolean;
}

const modeField = StateField.define<ModeState>({
  create() {
    return { focus: false, typewriter: false };
  },
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setFocusEffect) && e.value !== next.focus) {
        next = { ...next, focus: e.value };
      } else if (e.is(setTypewriterEffect) && e.value !== next.typewriter) {
        next = { ...next, typewriter: e.value };
      }
    }
    return next;
  },
});

function modeOf(state: EditorState): ModeState {
  return state.field(modeField);
}

/* ────────────────────────────────────────────────────────────────────────
 * 2. 专注模式:当前块以外变暗
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 算"光标所在块"的行号闭区间 [from, to](1-based)。
 *
 * 块定义(刻意保持简单、不挂 syntaxTree):以光标所在行为锚点,
 * 向上向下吃掉**连续非空行** —— 即一个 Markdown 段落 / 列表 / 代码块
 * 体感上的"一段"。空行天然成为段落边界,落在空行上则该空行自成一块
 * (只它自己不暗)。多光标时取并集(每个光标各自的块都不暗)。
 *
 * 不暗的范围按行号收集进 Set:行级判定 O(1),后面只对可视行查表。
 */
function activeLineNumbers(state: EditorState): Set<number> {
  const doc = state.doc;
  const active = new Set<number>();

  const isBlank = (lineNo: number): boolean =>
    doc.line(lineNo).text.trim().length === 0;

  for (const range of state.selection.ranges) {
    // 选区跨多行时:从选区头所在行到尾所在行都视作"活动",
    // 再各自向外扩到段落边界,符合"正在操作这一段"的直觉。
    const headLine = doc.lineAt(range.from).number;
    const tailLine = doc.lineAt(range.to).number;

    // 锚点本身若是空行,只点亮这一行即可(空行是段落分隔,
    // 不该把上下两段一起点亮)。
    if (headLine === tailLine && isBlank(headLine)) {
      active.add(headLine);
      continue;
    }

    let top = headLine;
    while (top > 1 && !isBlank(top - 1)) top--;
    let bottom = tailLine;
    while (bottom < doc.lines && !isBlank(bottom + 1)) bottom++;

    // 边界修正:文档没有空行(整篇被当成"一段")时,段落扩展会覆盖
    // 全文 → 一行都不暗,用户看着"专注没反应"。此时退化为只点亮
    // 光标自身所在行,保证始终有对比。
    if (top === 1 && bottom === doc.lines && doc.lines > 1) {
      for (let n = headLine; n <= tailLine; n++) active.add(n);
    } else {
      for (let n = top; n <= bottom; n++) active.add(n);
    }
  }

  return active;
}

/** 非当前块的行加这个 class;主题里给它 opacity:.28 + 柔和过渡。 */
const dimDeco = Decoration.line({ class: "cm-mkn-dim" });

/**
 * 专注变暗插件。
 *
 * 只在以下时机重建 decoration:开关变化(effect)、光标移动
 * (selectionSet)、文档变化(docChanged,块边界可能移动)、
 * 视口变化(viewportChanged,滚动后新进入可视区的行要补暗)。
 * 关闭时返回空集 —— dim class 立即消失,过渡由 CSS 负责柔和收回。
 *
 * 性能:仅遍历 `view.visibleRanges` 内的行,大文档下与 livePreview
 * 同款,不会全量扫描整篇。
 */
const focusDimPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      const switched = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setFocusEffect))
      );
      if (
        switched ||
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged
      ) {
        this.decorations = this.build(update.view);
      }
    }

    private build(view: EditorView): DecorationSet {
      if (!modeOf(view.state).focus) return Decoration.none;

      const active = activeLineNumbers(view.state);
      const doc = view.state.doc;
      const decos = [];

      // 只处理可视区:逐可视范围按行号步进,给非活动行打 dim。
      // 用 doc.lineAt + line.to 推进,避免按字符遍历。
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = doc.lineAt(pos);
          if (!active.has(line.number)) {
            decos.push(dimDeco.range(line.from));
          }
          if (line.to + 1 > pos) {
            pos = line.to + 1;
          } else {
            break; // 末行(line.to === pos)防止死循环
          }
        }
      }

      // sort=true:line decoration 按 from 排序,符合 CM RangeSet 要求。
      return Decoration.set(decos, true);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/* ────────────────────────────────────────────────────────────────────────
 * 3. 打字机模式:光标行恒居中
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 打字机滚动:在 selection/doc 真正变化时,把主光标位置
 * scrollIntoView 到视口垂直中央。
 *
 * 防"和用户滚动打架"的三道守卫:
 * 1. 只在 `update.selectionSet || update.docChanged` 时触发 ——
 *    纯滚动(viewportChanged 而无选区/文档变化)绝不强制回滚,
 *    用户拿滚轮浏览别处时不会被拽回光标。
 * 2. 记录上次居中的 head 位置,位置没变就跳过 —— 避免重复 dispatch。
 * 3. scrollIntoView 用 requestMeasure 在测量后异步 dispatch:
 *    不在 update() 里同步派发(会递归触发 update / 抖动),也给
 *    DOM 一帧落稳再滚,过渡更稳。dispatch 仅含 scroll effect、
 *    不改文档/选区,不会引起内容层递归重建。
 */
const typewriterPlugin = ViewPlugin.fromClass(
  class {
    /** 上次已居中的主光标位置;-1 表示尚未居中过。 */
    private lastHead = -1;
    /** 已排程一次 measure 滚动,防同一帧重复排程。 */
    private scheduled = false;

    update(update: ViewUpdate) {
      const on = modeOf(update.state).typewriter;

      // 同步 .cm-tw 类:开启时由主题给 .cm-content 加上下大留白,
      // 让"任意行(含首行/短文档)都能滚到视口正中"——否则没有滚动
      // 空间,scrollIntoView(center) 无从居中,用户就觉得"打字机没反应"。
      update.view.dom.classList.toggle("cm-tw", on);

      // 关掉打字机:重置记忆,之后不再强制滚动(满足"关后不强制滚")。
      if (!on) {
        this.lastHead = -1;
        return;
      }

      const justSwitched = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setTypewriterEffect) && e.value === true)
      );

      // 守卫 1:只认选区/文档变化,或刚开启(开启瞬间把当前光标拉到中间)。
      if (!update.selectionSet && !update.docChanged && !justSwitched) return;

      const head = update.state.selection.main.head;

      // 守卫 2:光标位置没变(例如只是 docChanged 但 head 不动)就不滚。
      if (head === this.lastHead && !justSwitched) return;

      this.lastHead = head;
      this.schedule(update.view, head);
    }

    private schedule(view: EditorView, head: number) {
      if (this.scheduled) return;
      this.scheduled = true;
      // 守卫 3:测量后异步派发,避开在 update 周期内同步 dispatch
      // 造成的递归 / 抖动;只携带 scroll effect。
      view.requestMeasure({
        read: () => null,
        write: () => {
          this.scheduled = false;
          // 仍可能在这一帧前被关闭 / 文档被删短,重新校验。
          if (!modeOf(view.state).typewriter) return;
          const pos = Math.min(head, view.state.doc.length);
          view.dispatch({
            effects: EditorView.scrollIntoView(pos, { y: "center" }),
          });
        },
      });
    }
  }
);

/* ────────────────────────────────────────────────────────────────────────
 * 4. 自带样式
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 变暗样式自带(不写独立 CSS、不依赖外部 class)。
 * opacity 过渡 .15s 让进入/退出专注、光标移动换块时柔和淡变,
 * 不突兀。关闭专注时 dim class 整体移除,opacity 自动回到 1
 * 且同样走这条 transition,复原也是柔和的。
 */
const focusTheme = EditorView.theme({
  ".cm-mkn-dim": {
    opacity: "0.28",
    transition: "opacity .15s ease",
  },
  // 打字机模式:上下加大留白,使任意行(含首行、短文档)都能被
  // scrollIntoView 滚到视口垂直中央。关闭时类移除,留白即消失。
  "&.cm-tw .cm-content": {
    paddingTop: "42vh",
    paddingBottom: "42vh",
  },
});

/* ────────────────────────────────────────────────────────────────────────
 * 5. 冻结导出签名(逐字对齐集成方契约,勿改名/改签名)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 一次性注入:专注 + 打字机所需的全部扩展。放进 createEditor 的
 * `extra` 数组即可,两个模式默认关闭,需经 set*Mode 才生效。
 */
export function focusTypewriterExtension(): Extension {
  return [modeField, focusDimPlugin, typewriterPlugin, focusTheme];
}

/** 开关专注模式(on=true 启用非当前块变暗)。 */
export function setFocusMode(view: EditorView, on: boolean): void {
  if (modeOf(view.state).focus === on) return;
  view.dispatch({ effects: setFocusEffect.of(on) });
}

/** 开关打字机模式(on=true 启用光标行恒居中)。 */
export function setTypewriterMode(view: EditorView, on: boolean): void {
  if (modeOf(view.state).typewriter === on) return;
  view.dispatch({ effects: setTypewriterEffect.of(on) });
}

/** 当前是否处于专注模式。 */
export function getFocusMode(view: EditorView): boolean {
  return modeOf(view.state).focus;
}

/** 当前是否处于打字机模式。 */
export function getTypewriterMode(view: EditorView): boolean {
  return modeOf(view.state).typewriter;
}
