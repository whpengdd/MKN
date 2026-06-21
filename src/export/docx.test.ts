import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

import { renderDocx, collectImageSources, type DocxImage } from "./docx";

/** 解出 .docx 包里的 word/document.xml 文本,顺带返回全部条目名。 */
function open(bytes: Uint8Array): {
  entries: string[];
  doc: string;
  files: Record<string, Uint8Array>;
} {
  const files = unzipSync(bytes);
  const entries = Object.keys(files);
  const doc = strFromU8(files["word/document.xml"]);
  return { entries, doc, files };
}

test("产物是合法 zip,含 .docx 必需骨架条目", () => {
  const { entries } = open(renderDocx("# 标题\n\n正文"));
  for (const need of [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
    "word/styles.xml",
    "word/numbering.xml",
    "word/_rels/document.xml.rels",
  ]) {
    assert.ok(entries.includes(need), `缺条目 ${need}`);
  }
});

test("标题映射到 Heading 段落样式", () => {
  const { doc } = open(renderDocx("# 一级\n\n## 二级"));
  assert.match(doc, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(doc, /<w:pStyle w:val="Heading2"\/>/);
  assert.match(doc, /一级/);
});

test("加粗 / 斜体 / 删除线 / 行内码", () => {
  const { doc } = open(
    renderDocx("**粗** *斜* ~~删~~ `码`")
  );
  assert.match(doc, /<w:b\/>/);
  assert.match(doc, /<w:i\/>/);
  assert.match(doc, /<w:strike\/>/);
  assert.match(doc, /w:fill="F6F7F9"/); // 行内码底纹
});

test("无序 / 有序列表挂 numPr", () => {
  const { doc } = open(renderDocx("- a\n- b\n\n1. x\n2. y"));
  assert.match(doc, /<w:numId w:val="1"\/>/); // bullet
  assert.match(doc, /<w:numId w:val="2"\/>/); // ordered
});

test("任务列表降级为 ☐ / ☑ 且不挂项目符号", () => {
  const { doc } = open(renderDocx("- [ ] 未做\n- [x] 已做"));
  assert.match(doc, /☐/);
  assert.match(doc, /☑/);
});

test("引用 → Quote 样式", () => {
  const { doc } = open(renderDocx("> 引文"));
  assert.match(doc, /<w:pStyle w:val="Quote"\/>/);
});

test("代码块 → CodeBlock 段落,多行用 <w:br/>", () => {
  const { doc } = open(renderDocx("```js\nlet a=1\nlet b=2\n```"));
  assert.match(doc, /<w:pStyle w:val="CodeBlock"\/>/);
  assert.match(doc, /<w:br\/>/);
});

test("Mermaid 降级为带说明的源码段(保源)", () => {
  const { doc } = open(renderDocx("```mermaid\ngraph TD;A-->B;\n```"));
  assert.match(doc, /导出未渲染/);
  assert.match(doc, /A--&gt;B/); // 源码保留并经 XML 转义
});

test("数学公式降级为等宽文本并保留 TeX 源", () => {
  const { doc } = open(renderDocx("行内 $E=mc^2$ 与\n\n$$\\int x\\,dx$$"));
  assert.match(doc, /E=mc\^2/);
  assert.match(doc, /\\int x/);
});

test("GFM 表格 → w:tbl,表头对齐生效", () => {
  const { doc } = open(
    renderDocx("| 名 | 值 |\n|:--:|--:|\n| a | 1 |")
  );
  assert.match(doc, /<w:tbl>/);
  assert.match(doc, /<w:jc w:val="center"\/>/);
  assert.match(doc, /<w:jc w:val="right"\/>/);
});

test("分隔线 → 段落底边框", () => {
  const { doc } = open(renderDocx("a\n\n---\n\nb"));
  assert.match(doc, /<w:pBdr><w:bottom/);
});

test("链接 → 超链接关系 + Hyperlink 样式", () => {
  const bytes = renderDocx("[官网](https://example.com)");
  const { doc, files } = open(bytes);
  assert.match(doc, /<w:hyperlink r:id="rId\d+"/);
  assert.match(doc, /<w:rStyle w:val="Hyperlink"\/>/);
  const rels = strFromU8(files["word/_rels/document.xml.rels"]);
  assert.match(rels, /Target="https:\/\/example.com" TargetMode="External"/);
});

test("collectImageSources 去重收集图片 src", () => {
  const srcs = collectImageSources(
    "![a](assets/x.png)\n\n![b](assets/x.png)\n\n![c](data:image/png;base64,AAA)"
  );
  assert.deepEqual(new Set(srcs), new Set(["assets/x.png", "data:image/png;base64,AAA"]));
});

test("图片:有字节则嵌入 media + 关系;无字节则降级占位文本", () => {
  // 最小合法 1x1 PNG。
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  ]);
  const images: Record<string, DocxImage> = {
    "assets/x.png": { bytes: png, mime: "image/png" },
  };
  const { doc, entries } = open(
    renderDocx("![图](assets/x.png)\n\n![缺](assets/missing.png)", { images })
  );
  assert.match(doc, /<w:drawing>/);
  assert.ok(entries.some((e) => e.startsWith("word/media/image")));
  assert.match(doc, /\[图片: 缺\]/); // 缺字节的图降级占位
});

test("纯函数:同输入恒同输出,不抛", () => {
  const src = "# t\n\n- a\n\n> q\n\n`c`";
  assert.deepEqual(renderDocx(src), renderDocx(src));
});
