/**
 * GFM pipe 表格的纯模型层 —— 解析 / 序列化 / 增删行列 / 对齐。
 *
 * 全部是纯函数,返回新模型,不碰编辑器。可视化编辑的每个操作都走:
 *   parseTable → 变换 → serializeTable → 一次 CM 事务替换底层文本。
 *
 * 序列化按列宽(CJK 记 2 宽)填充对齐,让原始 markdown 也整齐可读 ——
 * 这对"本地 .md 工具 + 中文写作"很重要,Typora 也是这么做的。
 */

export type Align = "left" | "center" | "right" | null;

export interface TableModel {
  header: string[];
  aligns: Align[];
  rows: string[][];
}

/** 显示宽度:CJK / 全角字符记 2,其余记 1 */
export function displayWidth(s: string): number {
  let n = 0;
  for (const ch of s) {
    n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦　-〿぀-ヿ㐀-䶿一-鿿]/.test(
      ch
    )
      ? 2
      : 1;
  }
  return n;
}

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isDelimiterLine(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) &&
    line.includes("-");
}

function parseAligns(line: string): Align[] {
  return splitCells(line).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    if (l) return "left";
    return null;
  });
}

export function parseTable(src: string): TableModel {
  const lines = src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const header = lines[0] ? splitCells(lines[0]) : [""];
  const delimIdx = lines.findIndex((l, i) => i > 0 && isDelimiterLine(l));
  const aligns: Align[] =
    delimIdx >= 0 ? parseAligns(lines[delimIdx]) : header.map(() => null);
  const dataStart = delimIdx >= 0 ? delimIdx + 1 : 1;
  const rows = lines.slice(dataStart).map((l) => splitCells(l));

  return normalize({ header, aligns, rows });
}

/** 规整为统一列数:补空、截断对齐数组 */
function normalize(m: TableModel): TableModel {
  const cols = Math.max(
    1,
    m.header.length,
    ...m.rows.map((r) => r.length),
    m.aligns.length
  );
  const fit = (arr: string[]) => {
    const a = arr.slice(0, cols);
    while (a.length < cols) a.push("");
    return a;
  };
  const aligns = m.aligns.slice(0, cols);
  while (aligns.length < cols) aligns.push(null);
  return {
    header: fit(m.header),
    aligns,
    rows: m.rows.map(fit),
  };
}

function pad(cell: string, width: number, align: Align): string {
  const gap = Math.max(0, width - displayWidth(cell));
  if (align === "right") return " ".repeat(gap) + cell;
  if (align === "center") {
    const l = Math.floor(gap / 2);
    return " ".repeat(l) + cell + " ".repeat(gap - l);
  }
  return cell + " ".repeat(gap);
}

function delimCell(width: number, align: Align): string {
  // 至少 3 个 dash,填充到列宽
  const dashes = "-".repeat(Math.max(3, width));
  if (align === "center") return ":" + dashes.slice(2) + ":";
  if (align === "right") return dashes.slice(1) + ":";
  if (align === "left") return ":" + dashes.slice(1);
  return dashes;
}

export function serializeTable(model: TableModel): string {
  const m = normalize(model);
  const cols = m.header.length;
  const esc = (s: string) => s.replace(/\|/g, "\\|");

  const colWidth = (c: number) =>
    Math.max(
      3,
      displayWidth(esc(m.header[c])),
      ...m.rows.map((r) => displayWidth(esc(r[c] ?? "")))
    );
  const widths = Array.from({ length: cols }, (_, c) => colWidth(c));

  const row = (cells: string[]) =>
    "| " +
    cells
      .map((cell, c) => pad(esc(cell), widths[c], m.aligns[c]))
      .join(" | ") +
    " |";

  const delim =
    "| " +
    widths.map((w, c) => delimCell(w, m.aligns[c])).join(" | ") +
    " |";

  return [row(m.header), delim, ...m.rows.map(row)].join("\n");
}

/* ---------- 变换(纯函数,index 基于数据行 / 列) ---------- */

export function withRowInserted(m: TableModel, at: number): TableModel {
  const rows = m.rows.slice();
  const empty = m.header.map(() => "");
  rows.splice(Math.max(0, Math.min(at, rows.length)), 0, empty);
  return { ...m, rows };
}

export function withRowDeleted(m: TableModel, at: number): TableModel {
  if (m.rows.length <= 1) return m; // 至少保留一行数据
  const rows = m.rows.slice();
  rows.splice(at, 1);
  return { ...m, rows };
}

export function withColInserted(m: TableModel, at: number): TableModel {
  const i = Math.max(0, Math.min(at, m.header.length));
  const ins = <T>(arr: T[], v: T) => {
    const a = arr.slice();
    a.splice(i, 0, v);
    return a;
  };
  return {
    header: ins(m.header, ""),
    aligns: ins(m.aligns, null),
    rows: m.rows.map((r) => ins(r, "")),
  };
}

export function withColDeleted(m: TableModel, at: number): TableModel {
  if (m.header.length <= 1) return m; // 至少保留一列
  const del = <T>(arr: T[]) => arr.filter((_, idx) => idx !== at);
  return {
    header: del(m.header),
    aligns: del(m.aligns),
    rows: m.rows.map(del),
  };
}

export function withAlign(
  m: TableModel,
  col: number,
  align: Align
): TableModel {
  const aligns = m.aligns.slice();
  aligns[col] = align;
  return { ...m, aligns };
}

/** 左 → 中 → 右 → 默认 循环 */
export function nextAlign(a: Align): Align {
  return a === "left"
    ? "center"
    : a === "center"
      ? "right"
      : a === "right"
        ? null
        : "left";
}
