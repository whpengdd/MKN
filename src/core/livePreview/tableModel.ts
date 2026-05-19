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

/**
 * 单元格分隔符:未被单个 `\` 转义的 `|`。splitCells 与 cellSourceOffset
 * 必须用同一规则,否则"渲染列序"与"源码偏移"会分叉。
 */
const UNESCAPED_PIPE = /(?<!\\)\|/;

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s
    .split(new RegExp(UNESCAPED_PIPE, "g"))
    .map((c) => c.trim().replace(/\\\|/g, "|"));
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

/**
 * 渲染态表格被点中的单元格 → 该格在**原始 source 字符串**内的字符偏移。
 *
 * 不能复用 parseTable 的模型索引:parseTable 会 trim + 过滤空行,模型行
 * 与源码物理行不是一一对应。这里独立扫物理行,与 widgets.ts 的 mkRow
 * 渲染顺序严格对应:
 *  - `rowIdx === -1`  → 表头物理行
 *  - `rowIdx >= 0`    → 分隔行之后第 rowIdx 条非空数据物理行
 * 列内偏移落到该列内容(去前导空白)的起点。所有越界一律 clamp,
 * 返回值保证落在 `[0, source.length]`,绝不抛错。
 */
export function cellSourceOffset(
  source: string,
  rowIdx: number,
  colIdx: number
): number {
  const lines = source.split("\n");

  // 各物理行在 source 内的起始偏移(每行 +1 还原被 split 吃掉的 \n)
  const lineStart: number[] = [];
  let acc = 0;
  for (const l of lines) {
    lineStart.push(acc);
    acc += l.length + 1;
  }

  const nonEmpty = (i: number) => lines[i]?.trim().length > 0;

  // 结构行定位:首条非空=表头;其后首条非空且为分隔行=分隔行
  let headerLine = lines.findIndex((_, i) => nonEmpty(i));
  if (headerLine < 0) return 0; // 空源码:兜底
  let delimLine = -1;
  for (let i = headerLine + 1; i < lines.length; i++) {
    if (!nonEmpty(i)) continue;
    if (isDelimiterLine(lines[i])) delimLine = i;
    break;
  }
  const dataFrom = delimLine >= 0 ? delimLine + 1 : headerLine + 1;
  const dataLines: number[] = [];
  for (let i = dataFrom; i < lines.length; i++) {
    if (nonEmpty(i)) dataLines.push(i);
  }

  // 目标物理行
  let lineIdx: number;
  if (rowIdx < 0) {
    lineIdx = headerLine;
  } else if (dataLines.length === 0) {
    lineIdx = headerLine; // 无数据行:降级到表头
  } else {
    lineIdx = dataLines[Math.min(rowIdx, dataLines.length - 1)];
  }

  // 行内列内容起点。与 splitCells 完全同构:先 trim,再各去掉至多一个
  // 前导/尾随竖线,在该区间内按未转义竖线切分;列越界停在最后一格
  // (尾随竖线已被排除,不会落进空的尾段)。
  const raw = lines[lineIdx] ?? "";
  const wantCol = Math.max(0, colIdx);
  let lo = 0;
  let hi = raw.length;
  while (lo < hi && /\s/.test(raw[lo])) lo++; // 左 trim
  while (hi > lo && /\s/.test(raw[hi - 1])) hi--; // 右 trim
  if (raw[lo] === "|") lo++; // 去前导竖线
  if (hi > lo && raw[hi - 1] === "|") hi--; // 去尾随竖线

  let i = lo;
  let cellStart = lo;
  for (let c = 0; ; c++) {
    while (i < hi && raw[i] === " ") i++; // 跳本格前导空格
    cellStart = i;
    while (i < hi && !(raw[i] === "|" && raw[i - 1] !== "\\")) i++;
    if (c === wantCol || i >= hi || raw[i] !== "|") break; // 命中 / 列越界
    i++; // 跨过分隔竖线
  }

  const offset = lineStart[lineIdx] + cellStart;
  return Math.max(0, Math.min(offset, source.length));
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
