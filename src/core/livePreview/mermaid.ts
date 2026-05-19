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
import mermaid from "mermaid";
import { blockRevealed, selectionRanges } from "./cursorReveal";

/**
 * ★ Mermaid 图渲染 —— 自包含 CM 扩展,严格照搬 table.ts 的范式:
 * StateField<DecorationSet> + 跨行 `Decoration.replace({ widget, block:true })`
 * + provide 同时挂 EditorView.decorations 和 EditorView.atomicRanges。
 *
 * 行为(无缝隐现铁律):
 *  - 光标不在 ```mermaid 围栏所跨任意行 → 整块替换成渲染好的 SVG;
 *  - 光标进入该块 → 不替换,露出围栏源码可编辑(blockRevealed 交接)。
 *
 * CM6 约束(与 table.ts 同):围栏天然跨多行,跨行/含换行的 replace
 * "may not be specified via plugins",故独立成 StateField;且整块
 * widget 登记为 atomic,方向键不会钻进被隐藏的多行源码。
 *
 * mermaid 渲染是**异步**的(mermaid.render 返回 Promise)。处理:
 *  - 模块级按源码缓存渲染结果(成功 SVG / 失败信息),避免每键重渲抖动;
 *  - 缓存命中 → widget 同步直接出图/出错,DOM 一次到位、零闪烁;
 *  - 未命中 → widget 先放"渲染中"占位,后台 render 完成写缓存,
 *    再就地替换该 widget 实例的 DOM 内容(不触发 CM 重排);
 *  - render 出错 → 仅在 widget 内显示错误文本,绝不抛出致编辑器崩溃。
 */

/** mermaid 全局只初始化一次(模块加载即执行)。startOnLoad:false:
 *  我们自己用 render() 主动渲染,不让 mermaid 扫描整页 DOM。 */
let initialized = false;
function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  try {
    mermaid.initialize({ startOnLoad: false });
  } catch {
    // initialize 理论上不抛;真抛也不能连累编辑器,渲染时再各自兜底。
  }
}
ensureInit();

/** 单次渲染结果:成功带 svg,失败带 error 文本。 */
type RenderResult =
  | { ok: true; svg: string }
  | { ok: false; error: string };

/**
 * 按源码缓存。值可能是"渲染中的 Promise"或"已完成结果",用一个
 * 联合体区分:in-flight 时存 Promise 供并发去重,完成后存 RenderResult。
 */
const cache = new Map<string, RenderResult | Promise<RenderResult>>();

/** 自增 id:mermaid.render 需要一个 DOM id,且每次须唯一避免冲突。 */
let renderSeq = 0;

/** 启动一次渲染(若缓存已有/在途则复用),返回最终结果 Promise。 */
function renderMermaid(code: string): Promise<RenderResult> {
  const hit = cache.get(code);
  if (hit) return hit instanceof Promise ? hit : Promise.resolve(hit);

  const p: Promise<RenderResult> = (async () => {
    try {
      const id = "mkn-mermaid-" + renderSeq++;
      const { svg } = await mermaid.render(id, code);
      const result: RenderResult = { ok: true, svg };
      cache.set(code, result);
      return result;
    } catch (err) {
      const result: RenderResult = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      cache.set(code, result);
      return result;
    }
  })();

  cache.set(code, p);
  return p;
}

/**
 * Mermaid 块 widget。
 * - eq 按 code 比较:源码不变则 CM 不重建 DOM(配合缓存彻底消抖)。
 * - 缓存命中已完成:toDOM 同步直接填 SVG / 错误,一次到位。
 * - 未命中:先填"渲染中"占位,后台渲染完再就地替换本实例 DOM。
 */
class MermaidWidget extends WidgetType {
  constructor(private readonly code: string) {
    super();
  }

  eq(o: MermaidWidget): boolean {
    return o.code === this.code;
  }

  ignoreEvent(): boolean {
    return false; // 点击正常落光标 → 触发 reveal 出源码
  }

  /**
   * 测量前高度估计。Mermaid 图通常较高,默认 -1 会让 CM 严重低估,
   * 其下方文本的点击坐标→位置映射竖直漂移。给个偏大的量级兜底,
   * 渲染完成后由真实 DOM 高覆盖(同 table.ts/math.ts 缘由)。
   */
  get estimatedHeight(): number {
    return Math.max(160, this.code.split("\n").length * 24);
  }

  private paint(host: HTMLElement, r: RenderResult): void {
    if (r.ok) {
      host.classList.remove("mkn-mermaid-error");
      host.innerHTML = r.svg;
    } else {
      host.classList.add("mkn-mermaid-error");
      host.textContent = "Mermaid 渲染失败: " + r.error;
    }
  }

  toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = "mkn-mermaid";

    const cached = cache.get(this.code);
    if (cached && !(cached instanceof Promise)) {
      // 缓存命中已完成:同步出图/出错,DOM 一次到位、零闪烁。
      this.paint(host, cached);
      return host;
    }

    // 未命中或在途:占位 + 后台渲染完成后就地替换本实例 DOM。
    host.classList.add("mkn-mermaid-loading");
    host.textContent = "图表渲染中…";
    renderMermaid(this.code)
      .then((r) => {
        host.classList.remove("mkn-mermaid-loading");
        this.paint(host, r);
      })
      .catch((err) => {
        // renderMermaid 内部已兜底,这里再保一层,绝不让 reject 逃逸。
        host.classList.remove("mkn-mermaid-loading");
        host.classList.add("mkn-mermaid-error");
        host.textContent =
          "Mermaid 渲染失败: " +
          (err instanceof Error ? err.message : String(err));
      });
    return host;
  }
}

/** 取 FencedCode 的语言标识(CodeInfo 子节点,trim 后比较)。 */
function fenceLang(node: { node: import("@lezer/common").SyntaxNode }, state: EditorState): string {
  const info = node.node.getChild("CodeInfo");
  if (!info) return "";
  return state.doc.sliceString(info.from, info.to).trim().toLowerCase();
}

/** 取围栏内代码正文(CodeText 子节点);空块返回空串。 */
function fenceCode(node: { node: import("@lezer/common").SyntaxNode }, state: EditorState): string {
  const text = node.node.getChild("CodeText");
  if (!text) return "";
  return state.doc.sliceString(text.from, text.to);
}

const ATOMIC = Decoration.replace({}); // atomic RangeSet 占位值(同 decoCtx 约定)

interface MermaidState {
  decos: DecorationSet;
  atomic: DecorationSet;
}

function buildMermaidDecorations(state: EditorState): MermaidState {
  const decos: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const sel = selectionRanges(state);
  const tree = syntaxTree(state);

  tree.iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return undefined;
      if (fenceLang(node, state) !== "mermaid") return false;

      // 整块按行跨度判隐现(与 table.ts 一致)。
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      if (blockRevealed(state, sel, from, to)) return false;

      const code = fenceCode(node, state).trim();
      if (code.length === 0) return false; // 空 mermaid 块不渲染,露出源码

      decos.push(
        Decoration.replace({
          widget: new MermaidWidget(code),
          block: true,
        }).range(from, to)
      );
      // 铁律:整块 widget 同步登记 atomic,方向键不钻进被隐藏的多行源码。
      atomic.push(ATOMIC.range(from, to));
      return false; // 不深入围栏内部
    },
  });

  return {
    // sort=true:与 table.ts 一致,交给 CM 正确排序
    decos: Decoration.set(decos, true),
    atomic: Decoration.set(atomic, true),
  };
}

const mermaidStateField = StateField.define<MermaidState>({
  create: (state) => buildMermaidDecorations(state),
  update(value, tr) {
    // 文本或选区变化都重算(隐现取决于光标位置);否则按变更映射旧值。
    // 与 table.ts 同:隐藏态是 widget,要编辑必先点击 reveal 成源码,
    // 不涉及 IME,故每事务重建即可。源码不变时 widget.eq 命中 + 渲染
    // 缓存命中 → CM 不重建 DOM、无抖动。
    if (tr.docChanged || tr.selection) {
      return buildMermaidDecorations(tr.state);
    }
    return {
      decos: value.decos.map(tr.changes),
      atomic: value.atomic.map(tr.changes),
    };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decos),
    // 整块 mermaid widget 也作为 atomic:方向键不会钻进被隐藏的多行源码
    EditorView.atomicRanges.of(
      (view) => view.state.field(f)?.atomic ?? Decoration.none
    ),
  ],
});

const mermaidTheme = EditorView.baseTheme({
  ".mkn-mermaid": {
    display: "block",
    textAlign: "center",
    margin: "0.7em 0",
    overflowX: "auto",
    cursor: "text",
  },
  ".mkn-mermaid svg": {
    maxWidth: "100%",
    height: "auto",
  },
  ".mkn-mermaid-loading": {
    color: "#888",
    fontStyle: "italic",
    fontSize: "0.9em",
  },
  ".mkn-mermaid-error": {
    color: "#e45649",
    fontFamily: "monospace",
    fontSize: "0.9em",
    whiteSpace: "pre-wrap",
    textAlign: "left",
  },
});

/** ★ 冻结导出签名:自包含 Mermaid 渲染扩展。 */
export function mermaidExtension(): Extension {
  return [mermaidStateField, mermaidTheme];
}
