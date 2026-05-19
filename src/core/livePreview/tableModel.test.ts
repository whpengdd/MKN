import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTable,
  serializeTable,
  withRowInserted,
  withRowDeleted,
  withColInserted,
  withColDeleted,
  withAlign,
  nextAlign,
  cellSourceOffset,
} from "./tableModel";

const SRC = `| 功能 | Phase | 状态 |
| :--- | :---: | ---: |
| 无缝隐现 | 0 | 验证中 |
| 表格编辑 | 1 | 进行 |`;

test("parse 解析表头/对齐/数据", () => {
  const m = parseTable(SRC);
  assert.deepEqual(m.header, ["功能", "Phase", "状态"]);
  assert.deepEqual(m.aligns, ["left", "center", "right"]);
  assert.equal(m.rows.length, 2);
  assert.deepEqual(m.rows[0], ["无缝隐现", "0", "验证中"]);
});

test("serialize 按列宽(CJK 记 2)对齐填充,且可被重新解析", () => {
  const out = serializeTable(parseTable(SRC));
  // 每行管道数一致 = 结构合法
  const lines = out.split("\n");
  assert.equal(lines.length, 4);
  for (const l of lines) assert.equal((l.match(/\|/g) || []).length, 4);
  // 往返:再解析应得到同样模型
  const m2 = parseTable(out);
  assert.deepEqual(m2.header, ["功能", "Phase", "状态"]);
  assert.deepEqual(m2.aligns, ["left", "center", "right"]);
  assert.deepEqual(m2.rows[1], ["表格编辑", "1", "进行"]);
});

test("增删行:底层 pipe 文本符合预期", () => {
  const m = parseTable(SRC);
  const added = parseTable(serializeTable(withRowInserted(m, 1)));
  assert.equal(added.rows.length, 3);
  assert.deepEqual(added.rows[1], ["", "", ""]);

  const removed = parseTable(serializeTable(withRowDeleted(m, 0)));
  assert.equal(removed.rows.length, 1);
  assert.deepEqual(removed.rows[0], ["表格编辑", "1", "进行"]);
});

test("增删列:表头/对齐/每行同步", () => {
  const m = parseTable(SRC);
  const added = parseTable(serializeTable(withColInserted(m, 1)));
  assert.equal(added.header.length, 4);
  assert.equal(added.header[1], "");
  assert.equal(added.rows[0][1], "");

  const removed = parseTable(serializeTable(withColDeleted(m, 2)));
  assert.deepEqual(removed.header, ["功能", "Phase"]);
  assert.deepEqual(removed.rows[0], ["无缝隐现", "0"]);
  assert.deepEqual(removed.aligns, ["left", "center"]);
});

test("对齐切换与循环", () => {
  const m = withAlign(parseTable(SRC), 0, "right");
  assert.equal(parseTable(serializeTable(m)).aligns[0], "right");
  assert.equal(nextAlign("left"), "center");
  assert.equal(nextAlign("center"), "right");
  assert.equal(nextAlign("right"), null);
  assert.equal(nextAlign(null), "left");
});

test("守卫:不能删到 0 行 / 0 列", () => {
  const one = parseTable(`| a |\n| - |\n| x |`);
  assert.equal(withRowDeleted(one, 0).rows.length, 1);
  assert.equal(withColDeleted(one, 0).header.length, 1);
});

test("cellSourceOffset:表头各列落到列内容起点", () => {
  const at = (r: number, c: number) => SRC.slice(cellSourceOffset(SRC, r, c));
  assert.ok(at(-1, 0).startsWith("功能"));
  assert.ok(at(-1, 1).startsWith("Phase"));
  assert.ok(at(-1, 2).startsWith("状态"));
});

test("cellSourceOffset:首/末数据行定位正确(不偏行)", () => {
  const at = (r: number, c: number) => SRC.slice(cellSourceOffset(SRC, r, c));
  assert.ok(at(0, 0).startsWith("无缝隐现"));
  assert.ok(at(0, 2).startsWith("验证中"));
  assert.ok(at(1, 0).startsWith("表格编辑"));
  assert.ok(at(1, 2).startsWith("进行"));
});

test("cellSourceOffset:CJK 列宽填充后仍跳过空白落到内容", () => {
  const padded = serializeTable(parseTable(SRC));
  assert.ok(padded.slice(cellSourceOffset(padded, 0, 0)).startsWith("无缝隐现"));
  assert.ok(padded.slice(cellSourceOffset(padded, 1, 2)).startsWith("进行"));
});

test("cellSourceOffset:转义 \\| 不被当作列分隔", () => {
  const s = `| a | b |\n| - | - |\n| x \\| y | z |`;
  assert.ok(s.slice(cellSourceOffset(s, 0, 0)).startsWith("x \\| y"));
  assert.ok(s.slice(cellSourceOffset(s, 0, 1)).startsWith("z"));
});

test("cellSourceOffset:缺分隔行降级,行/列越界 clamp 不抛错", () => {
  const noDelim = `| a | b |\n| c | d |`;
  assert.ok(noDelim.slice(cellSourceOffset(noDelim, -1, 1)).startsWith("b"));
  assert.ok(noDelim.slice(cellSourceOffset(noDelim, 0, 1)).startsWith("d"));

  const off = cellSourceOffset(SRC, 999, 999);
  assert.ok(off >= 0 && off <= SRC.length);
  // 末行最后一格:落在 "进行" 处(列越界停在最后一格)
  assert.ok(SRC.slice(off).startsWith("进行"));
});

test("转义管道 \\| 在解析与序列化中保留", () => {
  const m = parseTable(`| a |\n| - |\n| x \\| y |`);
  assert.equal(m.rows[0][0], "x | y");
  assert.match(serializeTable(m), /x \\\| y/);
});
