import { WidgetType, EditorView } from "@codemirror/view";
import {
  parseTable,
  serializeTable,
  withRowInserted,
  withRowDeleted,
  withColInserted,
  withColDeleted,
  withAlign,
  nextAlign,
  type Align,
  type TableModel,
} from "./tableModel";

/** 水平分隔线 `---` 渲染成 <hr> */
export class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const hr = document.createElement("hr");
    hr.className = "mkn-hr";
    return hr;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** 无序列表项符号:把 `-`/`*`/`+` 渲染成圆点 */
export class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "mkn-bullet";
    span.textContent = "•";
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 任务列表复选框。
 *
 * 用 CM6 规范写法:`ignoreEvent` 返回 false 让编辑器正常处理事件,
 * toggle 由集中式 mousedown 处理器(livePreview 里的 taskToggle)接管。
 * 之前返回 true 会吞掉复选框附近的点击,导致只能点最前面才能定位光标
 * ——这正是"任务列表后面点不了、回车不了"的根因。
 */
export class TaskWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }
  eq(o: TaskWidget): boolean {
    return o.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "mkn-task";
    box.checked = this.checked;
    box.tabIndex = -1; // 不抢键盘焦点
    return box;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** 行内图片:`![alt](url)` 光标不在时渲染 <img> */
export class ImageWidget extends WidgetType {
  constructor(
    private readonly url: string,
    private readonly alt: string
  ) {
    super();
  }
  eq(o: ImageWidget): boolean {
    return o.url === this.url && o.alt === this.alt;
  }
  toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.className = "mkn-img";
    img.src = this.url;
    img.alt = this.alt;
    return img;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const ALIGN_GLYPH: Record<string, string> = {
  left: "⇤",
  center: "⇔",
  right: "⇥",
  default: "≡",
};

/**
 * 表格 widget(Phase 1:可视化编辑)。
 *
 * 光标不在表格 → 渲染 <table>,悬停出现工具条;增删行列/对齐都通过
 * tableModel 纯函数算出新 markdown,再一次 CM 事务替换底层 pipe 文本
 * (撤销/重做天然生效)。点击单元格本身 → reveal 出源码直接改文字。
 */
export class TableWidget extends WidgetType {
  private activeRow = 0; // 数据行索引;-1 表示表头
  private activeCol = 0;

  constructor(
    private readonly source: string,
    private readonly pos: number
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source && other.pos === this.pos;
  }

  ignoreEvent(): boolean {
    return true; // 事件我们自己处理,阻断 CM 默认行为
  }

  private apply(view: EditorView, next: TableModel): void {
    view.dispatch({
      changes: {
        from: this.pos,
        to: this.pos + this.source.length,
        insert: serializeTable(next),
      },
    });
  }

  toDOM(view: EditorView): HTMLElement {
    const model = parseTable(this.source);

    const wrap = document.createElement("div");
    wrap.className = "mkn-table-wrap";

    const table = document.createElement("table");
    table.className = "mkn-table";

    const mkRow = (cells: string[], isHeader: boolean, rowIdx: number) => {
      const tr = document.createElement("tr");
      cells.forEach((cell, c) => {
        const el = document.createElement(isHeader ? "th" : "td");
        el.textContent = cell;
        const a = model.aligns[c];
        if (a) el.style.textAlign = a;
        el.addEventListener("mouseenter", () => {
          this.activeRow = isHeader ? -1 : rowIdx;
          this.activeCol = c;
          highlight();
        });
        tr.appendChild(el);
      });
      return tr;
    };

    table.createTHead().appendChild(mkRow(model.header, true, -1));
    const tb = table.createTBody();
    model.rows.forEach((r, i) => tb.appendChild(mkRow(r, false, i)));

    // 高亮当前作用列,提示工具条将操作哪一列
    const highlight = () => {
      [...table.querySelectorAll("th,td")].forEach((c) =>
        c.classList.remove("mkn-cell-active")
      );
      const sel = `tr :nth-child(${this.activeCol + 1})`;
      table
        .querySelectorAll(sel)
        .forEach((c) => c.classList.add("mkn-cell-active"));
    };

    wrap.appendChild(this.buildToolbar(view, model));
    wrap.appendChild(table);

    // 点击单元格(非工具条)→ reveal 出源码改文字
    wrap.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".mkn-tbar")) return;
      e.preventDefault();
      view.focus();
      view.dispatch({ selection: { anchor: this.pos } });
    });

    return wrap;
  }

  private buildToolbar(view: EditorView, model: TableModel): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "mkn-tbar";

    const btn = (label: string, title: string, fn: () => void) => {
      const b = document.createElement("button");
      b.className = "mkn-tbar-btn";
      b.textContent = label;
      b.title = title;
      // 在 mousedown 上执行:apply 会触发 StateField 重建、widget DOM 被
      // 整体替换,若等 click 则按钮已被卸载、click 永不触发(这正是
      // "点了没反应、只剩显示原格式"的另一半原因)。
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation(); // 不冒泡到 wrap 的 reveal
        fn();
      });
      return b;
    };

    const dataRow = () => Math.max(0, this.activeRow);

    bar.append(
      btn("＋行", "在当前行下方插入一行", () =>
        this.apply(
          view,
          withRowInserted(
            model,
            this.activeRow < 0 ? 0 : this.activeRow + 1
          )
        )
      ),
      btn("－行", "删除当前行", () =>
        this.apply(view, withRowDeleted(model, dataRow()))
      ),
      btn("＋列", "在当前列右侧插入一列", () =>
        this.apply(view, withColInserted(model, this.activeCol + 1))
      ),
      btn("－列", "删除当前列", () =>
        this.apply(view, withColDeleted(model, this.activeCol))
      ),
      btn(
        ALIGN_GLYPH[model.aligns[this.activeCol] ?? "default"],
        "切换当前列对齐(左→中→右→默认)",
        () => {
          const a: Align = nextAlign(model.aligns[this.activeCol] ?? null);
          this.apply(view, withAlign(model, this.activeCol, a));
        }
      )
    );

    return bar;
  }
}
