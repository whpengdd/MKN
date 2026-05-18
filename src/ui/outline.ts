/**
 * ★ 大纲面板(Phase 3)。
 *
 * 从编辑器内容里抽标题树(ATXHeading1-6),按层级缩进展示;点条目把
 * 编辑器滚动并定位到该标题行;光标所在标题高亮跟随;文档变化防抖刷新。
 *
 * 设计取向贴 Typora 大纲:窄、安静、靠缩进说话,配色全用 --mkn-* 变量,
 * 视觉语言与文件树(fileTree.css)一致 —— 它们同处左侧栏,做 Tab 切换。
 *
 * 与内核的边界:只读 view —— 用 @codemirror/language 的 syntaxTree 取
 * ATXHeading 节点(blockDecorations.ts 同款节点名),不改任何 core 装配,
 * 不写文档。变更/光标监听靠"动态追加扩展"挂到既有 view 上
 * (StateEffect.appendConfig),与 doc.ts 同一手法,绝不碰 src/core。
 */

import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import "./outline.css";

/** 文档变化后刷新大纲的防抖窗口(ms)。比自保存(800)短,跟手但不抖。 */
const REFRESH_DELAY = 250;

/** 一个标题条目。pos 是该标题行行首文档偏移,用于点击跳转 + 光标跟随。 */
interface Heading {
  level: number; // 1..6
  text: string; // 去掉 # 标记与首尾空白后的纯标题文字
  /** 标题行行首文档偏移(锚点);跳转定位到此,光标跟随按此判定所属标题。 */
  pos: number;
  /** 标题行结束偏移(行尾);光标跟随用 [pos, end] 区间判定。 */
  end: number;
}

export interface Outline {
  /** 挂载用根元素。 */
  element: HTMLElement;
  /** 重新抽取标题并重渲染(外部也可主动触发,如切换文档后)。 */
  refresh(): void;
  /** 销毁:解绑监听、清空 DOM。之后该实例不应再被使用。 */
  destroy(): void;
}

/**
 * 从语法树抽标题树。
 *
 * 节点名 ATXHeading1..6(与 blockDecorations.ts 一致);标题文字 = 整行
 * 去掉行首 HeaderMark(`#` 串)与可能的行尾 `#`(closing sequence)及空白。
 * 用语法树而非纯正则,天然不会把代码围栏里的 `# 注释` 误当标题
 * (Lezer 在 FencedCode 内不产出 ATXHeading)。
 */
function extractHeadings(view: EditorView): Heading[] {
  const out: Heading[] = [];
  const tree = syntaxTree(view.state);
  const docText = view.state.doc;

  tree.iterate({
    enter(node) {
      const m = /^ATXHeading([1-6])$/.exec(node.name);
      if (!m) return;
      const level = Number(m[1]);
      // 取该标题节点对应的整行;以行首为锚点(跳转/光标跟随都按行首)。
      const line = docText.lineAt(node.from);
      let text = line.text;
      // 去行首 `#`*（HeaderMark）+ 紧随空格
      text = text.replace(/^\s{0,3}#{1,6}\s*/, "");
      // 去 ATX 可选的行尾 closing：空白 + 一串 # + 行尾
      text = text.replace(/\s+#+\s*$/, "").trim();
      out.push({
        level,
        text: text || "(空标题)",
        pos: line.from,
        end: line.to,
      });
    },
  });

  return out;
}

/**
 * 绑定一个已构建好的 EditorView,返回大纲控制器。
 * @param opts.view 由 createEditor 建好的编辑器(本模块不创建/不重建它)
 */
export function createOutline(opts: { view: EditorView }): Outline {
  const { view } = opts;

  const root = document.createElement("div");
  root.className = "mkn-outline";

  // 当前渲染出的条目:并行数组,索引对应,供光标跟随 O(n) 命中后高亮。
  let headings: Heading[] = [];
  let rows: HTMLElement[] = [];
  let activeEl: HTMLElement | null = null;

  // 防抖句柄(文档变化刷新)。
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** 一行不可点的淡灰提示(无标题时)。 */
  function noteRow(textContent: string): HTMLElement {
    const note = document.createElement("div");
    note.className = "mkn-ol-empty";
    note.textContent = textContent;
    return note;
  }

  /** 把光标移到目标偏移并滚动到可视区中部,再把焦点还给编辑器。 */
  function jumpTo(h: Heading): void {
    view.dispatch({
      selection: { anchor: h.pos },
      // center:标题落在视口中部,像 Typora 点大纲那样,而非贴边
      effects: EditorView.scrollIntoView(h.pos, { y: "center" }),
    });
    view.focus();
  }

  /** 重抽标题并整树重渲染。条目少、纯 DOM,直接重建最简单也够快。 */
  function rebuild(): void {
    headings = extractHeadings(view);
    rows = [];
    activeEl = null;
    root.textContent = "";

    if (headings.length === 0) {
      root.appendChild(noteRow("暂无标题"));
      return;
    }

    // 以全文最小标题级为基准做缩进,避免文档从 ## 起步时整体右移过多。
    let minLevel = 6;
    for (const h of headings) if (h.level < minLevel) minLevel = h.level;

    for (const h of headings) {
      const row = document.createElement("div");
      row.className = `mkn-ol-row mkn-ol-l${h.level}`;
      row.style.paddingLeft = 10 + (h.level - minLevel) * 14 + "px";
      row.title = h.text;

      const dot = document.createElement("span");
      dot.className = "mkn-ol-dot";

      const label = document.createElement("span");
      label.className = "mkn-ol-label";
      label.textContent = h.text; // textContent:中文/特殊字符天然安全

      row.append(dot, label);
      row.addEventListener("click", () => jumpTo(h));
      root.appendChild(row);
      rows.push(row);
    }

    syncActive();
  }

  /**
   * 光标跟随:找光标所在(或其上方最近)的标题并高亮。
   * 规则:光标位置 >= 某标题行首即"属于"它,取满足条件里最后一个
   * (因为 headings 按文档顺序),这样在标题正文段落里也高亮其所属章节。
   */
  function syncActive(): void {
    if (rows.length === 0) return;
    const cursor = view.state.selection.main.head;
    let idx = -1;
    for (let i = 0; i < headings.length; i++) {
      if (cursor >= headings[i].pos) idx = i;
      else break;
    }
    const next = idx >= 0 ? rows[idx] : null;
    if (next === activeEl) return;
    if (activeEl) activeEl.classList.remove("mkn-ol-active");
    if (next) {
      next.classList.add("mkn-ol-active");
      next.scrollIntoView({ block: "nearest" }); // 跟随但不抢编辑器焦点
    }
    activeEl = next;
  }

  /** 文档变化:防抖后重建(重建内含 syncActive)。 */
  function scheduleRebuild(): void {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      rebuild();
    }, REFRESH_DELAY);
  }

  // 动态追加监听 —— 不碰内核装配(与 doc.ts 同一手法)。
  // docChanged:防抖重建;selectionSet:光标跟随即时(轻量,无需防抖)。
  const listener = EditorView.updateListener.of((u) => {
    if (u.docChanged) scheduleRebuild();
    else if (u.selectionSet) syncActive();
  });
  view.dispatch({ effects: StateEffect.appendConfig.of(listener) });

  // 初次构建。
  rebuild();

  return {
    element: root,
    refresh: rebuild,
    destroy() {
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      root.textContent = "";
      rows = [];
      headings = [];
      activeEl = null;
      // 注:动态追加的 updateListener 随 view 生命周期存在;本应用单 view
      // 全程存活,destroy 仅用于面板复用场景的 DOM 清理,不需要(也无法
      // 干净地)抽掉 appendConfig 进去的扩展 —— 与 doc.ts 监听同样处理。
    },
  };
}
