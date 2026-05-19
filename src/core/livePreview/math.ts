import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import katex from "katex";
// KaTeX 字体/排版样式。src 下无 .css 模块声明且本扩展不能新建 .d.ts,
// tsc(--noEmit)会对裸 css import 报 TS2307,这里就地抑制(运行期由 Vite 处理)。
// @ts-ignore -- css 资源 import,无类型声明
import "katex/dist/katex.min.css";
import {
  blockRevealed,
  inlineRevealed,
  selectionRanges,
} from "./cursorReveal";

/**
 * ★ KaTeX 数学公式 —— 自包含 CM 扩展(独立 StateField,不接入 index.ts)。
 *
 * 行内 `$...$`、块级 `$$...$$`。沿用项目无缝隐现铁律:
 *  - 光标未触碰公式 → 用 replace widget 换成 KaTeX 渲染后的 HTML;
 *  - 光标进入(行内 inlineRevealed / 块级 blockRevealed)→ 不替换,
 *    露出原始 `$...$` 源码可直接编辑(reveal 交接)。
 *
 * 关键 CM6 约束(与 table.ts 同):块级公式跨行、含换行符的 replace
 * "may not be specified via plugins",故行内+块级统一由这个 StateField
 * 提供;且**每个 replace 都登记为 atomic**(provide 里挂 atomicRanges),
 * 否则方向键会把被隐藏的 `$...$` 源码当普通文本、跳过或卡住整段。
 *
 * 不在代码块内误匹配 `$`:借 syntaxTree 把 FencedCode/CodeText/InlineCode
 * 等节点范围标记为"禁区",扫描到的 `$` 落在禁区内一律忽略。
 */

/** 行内公式 widget:渲染 `$tex$`。eq 按 tex 比较,源码不变则不重建 DOM。 */
class InlineMathWidget extends WidgetType {
  constructor(private readonly tex: string) {
    super();
  }
  eq(o: InlineMathWidget): boolean {
    return o.tex === this.tex;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "mkn-math mkn-math-inline";
    renderInto(span, this.tex, false);
    return span;
  }
  ignoreEvent(): boolean {
    return false; // 让点击正常落光标 → 触发 reveal 出源码
  }
}

/** 块级公式 widget:渲染 `$$tex$$`,整块替换(block:true)。 */
class BlockMathWidget extends WidgetType {
  constructor(private readonly tex: string) {
    super();
  }
  eq(o: BlockMathWidget): boolean {
    return o.tex === this.tex;
  }
  /** 测量前高度估计:避免块级公式上方点击坐标竖直漂移(同 table.ts 缘由)。 */
  get estimatedHeight(): number {
    return this.tex.split("\n").length * 28 + 16;
  }
  toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "mkn-math mkn-math-block";
    renderInto(div, this.tex, true);
    return div;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 用 KaTeX 把 tex 渲染进 el。throwOnError:false 让 KaTeX 自身不抛;
 * 再包一层 try/catch 兜底任何意外异常 —— 渲染失败只显示红色错误文本,
 * 绝不让异常冒泡导致编辑器崩溃。
 */
function renderInto(el: HTMLElement, tex: string, displayMode: boolean): void {
  try {
    el.innerHTML = katex.renderToString(tex, {
      throwOnError: false,
      displayMode,
    });
  } catch (err) {
    el.classList.add("mkn-math-error");
    el.textContent =
      "数学公式渲染失败: " + (err instanceof Error ? err.message : String(err));
  }
}

/** 一段"禁区"区间(代码块 / 行内代码),其中的 `$` 不当公式。 */
interface Forbidden {
  from: number;
  to: number;
}

/** 收集所有不应解析数学的节点范围(代码相关)。 */
function collectForbidden(state: EditorState): Forbidden[] {
  const zones: Forbidden[] = [];
  const tree = syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      // FencedCode/CodeBlock 整块跳过;InlineCode 行内代码也跳过。
      // 命中后返回 false 不再深入,范围已覆盖其内部全部 `$`。
      if (
        node.name === "FencedCode" ||
        node.name === "CodeBlock" ||
        node.name === "CodeText" ||
        node.name === "InlineCode" ||
        node.name === "HTMLBlock" ||
        node.name === "CommentBlock"
      ) {
        zones.push({ from: node.from, to: node.to });
        return false;
      }
      return undefined;
    },
  });
  return zones;
}

function inForbidden(zones: Forbidden[], from: number, to: number): boolean {
  return zones.some((z) => from < z.to && to > z.from);
}

/**
 * 扫描全文找 `$...$` / `$$...$$`。手写扫描而非纯正则:需要正确处理
 * 转义 `\$`、`$$` 块级优先、以及配对边界。返回各公式的精确字节范围。
 */
interface MathSpan {
  from: number;
  to: number;
  tex: string;
  block: boolean;
}

function scanMath(doc: string, zones: Forbidden[]): MathSpan[] {
  const spans: MathSpan[] = [];
  const n = doc.length;
  let i = 0;

  // 某位置的 `$` 是否被反斜杠转义(计连续反斜杠奇偶)。
  const isEscaped = (pos: number): boolean => {
    let b = 0;
    let k = pos - 1;
    while (k >= 0 && doc[k] === "\\") {
      b++;
      k--;
    }
    return b % 2 === 1;
  };

  while (i < n) {
    if (doc[i] !== "$" || isEscaped(i)) {
      i++;
      continue;
    }

    const block = doc[i + 1] === "$";
    const open = i;
    const delim = block ? 2 : 1;

    // 行内 `$` 定界规则(Typora / CommonMark-math 通行约定,消歧义):
    // 开定界 `$` 后不能紧跟空白,否则该 `$` 不启动行内公式 —— 这样
    // `$ 文字` 里孤立的 `$` 不会错吞后面正常的 `$ok$`。块级 `$$`
    // 允许 `$$ x $$` 写法,不加此限。
    const openCh = doc[open + delim];
    if (!block && (openCh === undefined || /\s/.test(openCh))) {
      i = open + delim;
      continue;
    }

    let j = open + delim;
    let closed = -1;

    while (j < n) {
      if (doc[j] === "$" && !isEscaped(j)) {
        if (block) {
          if (doc[j + 1] === "$") {
            closed = j;
            break;
          }
          // 块级里出现单个未配对 `$`:跳过它继续找 `$$`
          j++;
          continue;
        }
        // 行内闭定界 `$` 前不能是空白(同上消歧义约定)。
        if (/\s/.test(doc[j - 1] ?? "")) {
          j++;
          continue;
        }
        closed = j;
        break;
      }
      // 行内 `$...$` 限定单行内:遇换行即视为未配对放弃。
      // 既符合标准行内数学语义,又避免"非 block 的 replace 跨行"边界。
      if (!block && doc[j] === "\n") break;
      j++;
    }

    if (closed < 0) {
      i = open + delim; // 没配对:从内容起点继续扫(避免漏掉后续公式)
      continue;
    }

    const to = closed + delim;
    const tex = doc.slice(open + delim, closed).trim();

    // 空内容($$ 或 $ $)不渲染;落在代码禁区内不渲染。
    if (tex.length > 0 && !inForbidden(zones, open, to)) {
      spans.push({ from: open, to, tex, block });
    }
    i = to;
  }

  return spans;
}

function buildMathDecorations(state: EditorState): {
  decos: DecorationSet;
  atomic: DecorationSet;
} {
  const sel = selectionRanges(state);
  const zones = collectForbidden(state);
  const doc = state.doc.toString();
  const spans = scanMath(doc, zones);

  const decos: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];

  for (const s of spans) {
    if (s.block) {
      // 块级 `$$...$$`。CM6 约束:block:true 的 replace 必须对齐行边界
      // (覆盖整行块),否则与 table.ts/mermaid.ts 的范式不符、行为异常。
      // 故仅当 `$$...$$` 独占其所跨行(前后仅空白)时按 block 整行替换,
      // 范围扩到 lineAt(from).from ~ lineAt(to).to(与 table.ts 一致);
      // 否则(与其它文本同行,如 `text $$x$$ text`)降级为行内渲染。
      const lineFrom = state.doc.lineAt(s.from).from;
      const lineTo = state.doc.lineAt(s.to).to;
      const before = doc.slice(lineFrom, s.from);
      const after = doc.slice(s.to, lineTo);
      const standalone = before.trim() === "" && after.trim() === "";

      if (standalone) {
        // 光标落在所跨任意行则露出源码(blockRevealed 按行跨度判定)。
        if (blockRevealed(state, sel, lineFrom, lineTo)) continue;
        decos.push(
          Decoration.replace({
            widget: new BlockMathWidget(s.tex),
            block: true,
          }).range(lineFrom, lineTo)
        );
        atomic.push(ATOMIC.range(lineFrom, lineTo));
      } else {
        // 与文本混排:当行内渲染(仍用 displayMode 保留块级排版),
        // 非 block、不跨行(scanMath 已保证 inline 不跨行;此处 `$$`
        // 与文本同行也必不含内部换行)。
        if (inlineRevealed(sel, s.from, s.to)) continue;
        decos.push(
          Decoration.replace({
            widget: new BlockMathWidget(s.tex),
          }).range(s.from, s.to)
        );
        atomic.push(ATOMIC.range(s.from, s.to));
      }
    } else {
      // 行内 `$...$`:闭区间相交(含紧贴边缘)则露出源码。
      if (inlineRevealed(sel, s.from, s.to)) continue;
      decos.push(
        Decoration.replace({
          widget: new InlineMathWidget(s.tex),
        }).range(s.from, s.to)
      );
      // 铁律:每个 replace 同步登记 atomic,方向键整体跳过隐藏的 `$...$`。
      atomic.push(ATOMIC.range(s.from, s.to));
    }
  }

  return {
    // sort=true:行内/块级按 from 排序,正确处理同位/相邻
    decos: Decoration.set(decos, true),
    atomic: Decoration.set(atomic, true),
  };
}

/** 仅作 atomic RangeSet 占位值(同 decoCtx 的约定)。 */
const ATOMIC = Decoration.replace({});

interface MathState {
  decos: DecorationSet;
  atomic: DecorationSet;
}

const mathStateField = StateField.define<MathState>({
  create: (state) => buildMathDecorations(state),
  update(value, tr) {
    // 文本或选区变化都重算(隐现取决于光标位置);否则按变更映射旧值。
    // 不需要 IME 冻结:与 table.ts 同理 —— 数学隐藏态是 widget,要输入
    // 必先点击让光标进入 → 早已 reveal 成纯文本源码,组合输入发生在
    // reveal 后的普通文本上,StateField 每事务重建不会干扰 IME。
    if (tr.docChanged || tr.selection) {
      return buildMathDecorations(tr.state);
    }
    return {
      decos: value.decos.map(tr.changes),
      atomic: value.atomic.map(tr.changes),
    };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decos),
    // 块级 widget 跨行 + 行内隐藏的 `$...$` 都进 atomic:
    // 方向键不会钻进被隐藏的源码、不卡段。
    EditorView.atomicRanges.of(
      (view) => view.state.field(f)?.atomic ?? Decoration.none
    ),
  ],
});

const mathTheme = EditorView.baseTheme({
  ".mkn-math": {
    cursor: "text",
  },
  ".mkn-math-inline": {
    display: "inline-block",
    verticalAlign: "middle",
  },
  ".mkn-math-block": {
    display: "block",
    textAlign: "center",
    margin: "0.7em 0",
    overflowX: "auto",
  },
  ".mkn-math-error": {
    color: "#e45649",
    fontFamily: "monospace",
    fontSize: "0.9em",
    whiteSpace: "pre-wrap",
  },
});

/** ★ 冻结导出签名:自包含 KaTeX 渲染扩展。 */
export function mathExtension(): Extension {
  return [mathStateField, mathTheme];
}
