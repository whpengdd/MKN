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

test("转义管道 \\| 在解析与序列化中保留", () => {
  const m = parseTable(`| a |\n| - |\n| x \\| y |`);
  assert.equal(m.rows[0][0], "x | y");
  assert.match(serializeTable(m), /x \\\| y/);
});
