import { zipSync, strToU8 } from "fflate";
import { getConfiguredMarkdownIt } from "./markdownIt";

/**
 * ★ 内置 Word(.docx)导出 —— 不依赖 pandoc。
 *
 * 设计要点(对齐 render.ts 的取舍与风格):
 *
 *  1. 纯函数:markdown(+预解析好的图片字节)→ 合法 .docx 字节(Uint8Array)。
 *     不碰 DOM、不依赖 Tauri/Electron,可单测;绝不修改源 markdown。
 *
 *  2. 复用 render.ts 同一套已装配的 markdown-it(数学 / Mermaid / 任务列表 /
 *     表格规则齐备),只取其 token 流生成 OOXML(WordprocessingML),避免再写
 *     一套 markdown 解析与既有 HTML 导出漂移。
 *
 *  3. .docx 本质是 zip + 一组固定 XML。用 fflate(~10KB)打包,免手写 zip
 *     容器(本地文件头 / 中央目录 / CRC32)的出错风险。
 *
 *  4. 降级约定(与 render.ts 一致,不丢信息):数学公式降级为保留 TeX 源的
 *     等宽文本;Mermaid 降级为带说明的等宽源码段;无法读取的图片降级为占位
 *     文本而非中断导出。
 *
 *  5. 图片为保持纯函数:本模块不读磁盘 —— 由调用方(app.ts)预先把 data URI
 *     与本地路径解析成字节,经 opts.images 传入(键为 markdown 里的原始 src)。
 */

/* ===========================================================================
   类型与对外签名
   =========================================================================== */

/** 一张已解析好字节的图片(由调用方预先把 data URI / 本地文件读成字节)。 */
export interface DocxImage {
  bytes: Uint8Array;
  /** MIME,如 image/png、image/jpeg、image/gif。 */
  mime: string;
}

export interface RenderDocxOptions {
  title?: string;
  /** key 为 markdown 里图片的原始 src(与 collectImageSources 返回一致)。 */
  images?: Record<string, DocxImage>;
}

/**
 * ★ 扫描 markdown,收集所有图片的原始 src(去重)。调用方据此预解析字节,
 * 再经 renderDocx 的 opts.images 传回。纯函数。
 */
export function collectImageSources(markdown: string): string[] {
  const md = getConfiguredMarkdownIt();
  const tokens = md.parse(markdown ?? "", {});
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.type !== "inline" || !t.children) continue;
    for (const c of t.children) {
      if (c.type === "image") {
        const src = attr(c, "src");
        if (src) seen.add(src);
      }
    }
  }
  return [...seen];
}

/**
 * ★ markdown → 合法 .docx 字节。纯函数:同输入恒同输出,不改源、不碰 DOM。
 */
export function renderDocx(
  markdown: string,
  opts?: RenderDocxOptions
): Uint8Array {
  const md = getConfiguredMarkdownIt();
  const tokens = md.parse(markdown ?? "", {});

  const ctx: Ctx = {
    relId: 2, // rId1=styles、rId2=numbering 已占,动态从 3 起
    imgId: 0,
    rels: [],
    media: [],
    exts: new Set<string>(),
    images: opts?.images ?? {},
  };

  const body = renderBody(tokens, ctx);

  const documentXml =
    XML_DECL +
    `<w:document ${DOC_NS}><w:body>` +
    body +
    SECT_PR +
    "</w:body></w:document>";

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes(ctx.exts)),
    "_rels/.rels": strToU8(ROOT_RELS),
    "word/document.xml": strToU8(documentXml),
    "word/styles.xml": strToU8(STYLES_XML),
    "word/numbering.xml": strToU8(NUMBERING_XML),
    "word/_rels/document.xml.rels": strToU8(documentRels(ctx.rels)),
  };
  for (const m of ctx.media) {
    files[`word/media/${m.name}`] = m.bytes;
  }

  return zipSync(files, { level: 6 });
}

/* ===========================================================================
   生成上下文(关系 / 媒体 / 内容类型收集)
   =========================================================================== */

interface RelEntry {
  id: string;
  type: string;
  target: string;
  external: boolean;
}
interface MediaEntry {
  name: string;
  bytes: Uint8Array;
}
interface Ctx {
  relId: number;
  imgId: number;
  rels: RelEntry[];
  media: MediaEntry[];
  exts: Set<string>;
  images: Record<string, DocxImage>;
}

const REL_HYPERLINK =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const REL_IMAGE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

function addRel(
  ctx: Ctx,
  type: string,
  target: string,
  external: boolean
): string {
  const id = `rId${++ctx.relId}`;
  ctx.rels.push({ id, type, target, external });
  return id;
}

/** 把图片字节登记为 media + 关系,返回内联绘图所需的 rId 与显示尺寸(EMU)。 */
function addImage(ctx: Ctx, img: DocxImage): { rid: string; id: number } {
  const ext = mimeToExt(img.mime);
  const id = ++ctx.imgId;
  const name = `image${id}.${ext}`;
  ctx.media.push({ name, bytes: img.bytes });
  ctx.exts.add(ext);
  const rid = addRel(ctx, REL_IMAGE, `media/${name}`, false);
  return { rid, id };
}

/* ===========================================================================
   XML 转义与小工具
   =========================================================================== */

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** markdown-it token 的属性读取(运行期方法存在;派生类型未暴露,故收口此处)。 */
function attr(tok: unknown, name: string): string | null {
  const t = tok as { attrGet?: (n: string) => string | null };
  return typeof t.attrGet === "function" ? t.attrGet(name) : null;
}

function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpeg";
  if (m.includes("gif")) return "gif";
  if (m.includes("bmp")) return "bmp";
  return "png";
}

/* ===========================================================================
   行内:children → run(s)
   =========================================================================== */

interface Fmt {
  b?: boolean;
  i?: boolean;
  strike?: boolean;
  code?: boolean; // 行内代码:等宽 + 底纹 + 强调色
  mono?: boolean; // 仅等宽(数学源降级用)
  link?: boolean; // 超链接字符样式
}

/** 单个文本 run。code/mono 用等宽字体;link 套 Hyperlink 字符样式。 */
function runText(text: string, fmt: Fmt): string {
  const rpr: string[] = [];
  if (fmt.link) rpr.push('<w:rStyle w:val="Hyperlink"/>');
  if (fmt.b) rpr.push("<w:b/>");
  if (fmt.i) rpr.push("<w:i/>");
  if (fmt.strike) rpr.push("<w:strike/>");
  if (fmt.code || fmt.mono) {
    rpr.push(
      '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>'
    );
  }
  if (fmt.code) {
    rpr.push('<w:shd w:val="clear" w:color="auto" w:fill="F6F7F9"/>');
    rpr.push('<w:color w:val="D1395A"/>');
  }
  const rprXml = rpr.length ? `<w:rPr>${rpr.join("")}</w:rPr>` : "";
  return `<w:r>${rprXml}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

const BR_RUN = "<w:r><w:br/></w:r>";

/** markdown-it 任务列表 core 规则注入的 checkbox html → ☐ / ☑;非 checkbox 返回 null。 */
function checkboxFromHtml(html: string): string | null {
  if (!/type=("|')?checkbox/i.test(html)) return null;
  return /\bchecked\b/i.test(html) ? "☑" : "☐";
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/** EMU 换算与最大正文宽度(约 6 英寸)。 */
const EMU_PER_PX = 9525;
const MAX_IMG_EMU = 5486400; // 6in

/** 内联图片绘图 run;尺寸读不出时给个合理默认,过宽则等比缩放到正文宽。 */
function imageRun(ctx: Ctx, src: string, alt: string, fmt: Fmt): string {
  const img = ctx.images[src];
  if (!img) return runText(`[图片: ${alt || src}]`, fmt);

  const dim = imageSize(img.bytes, img.mime);
  let cx = dim ? dim.w * EMU_PER_PX : MAX_IMG_EMU;
  let cy = dim ? dim.h * EMU_PER_PX : Math.round(MAX_IMG_EMU * 0.66);
  if (cx > MAX_IMG_EMU) {
    cy = Math.round((cy * MAX_IMG_EMU) / cx);
    cx = MAX_IMG_EMU;
  }

  const { rid, id } = addImage(ctx, img);
  const name = xml(alt || `image${id}`);
  return (
    "<w:r><w:drawing>" +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${id}" name="${name}"/>` +
    "<wp:cNvGraphicFramePr>" +
    '<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>' +
    "</wp:cNvGraphicFramePr>" +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    "<pic:nvPicPr>" +
    `<pic:cNvPr id="${id}" name="${name}"/>` +
    "<pic:cNvPicPr/>" +
    "</pic:nvPicPr>" +
    "<pic:blipFill>" +
    `<a:blip r:embed="${rid}"/>` +
    "<a:stretch><a:fillRect/></a:stretch>" +
    "</pic:blipFill>" +
    "<pic:spPr>" +
    '<a:xfrm><a:off x="0" y="0"/>' +
    `<a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    "</pic:spPr>" +
    "</pic:pic>" +
    "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
  );
}

type MdChild = {
  type: string;
  content: string;
  children?: MdChild[] | null;
};

/** 一个 inline token → 一串 run XML(含超链接包裹、图片绘图)。 */
function renderInline(children: MdChild[] | null | undefined, ctx: Ctx): string {
  const out: string[] = [];
  let buf: string[] | null = null; // 超链接缓冲
  let href: string | null = null;
  const fmt: Fmt = {};
  const push = (s: string): void => {
    (buf ?? out).push(s);
  };

  for (const c of children ?? []) {
    switch (c.type) {
      case "text":
        if (c.content) push(runText(c.content, fmt));
        break;
      case "strong_open":
        fmt.b = true;
        break;
      case "strong_close":
        fmt.b = false;
        break;
      case "em_open":
        fmt.i = true;
        break;
      case "em_close":
        fmt.i = false;
        break;
      case "s_open":
        fmt.strike = true;
        break;
      case "s_close":
        fmt.strike = false;
        break;
      case "code_inline":
        push(runText(c.content, { ...fmt, code: true }));
        break;
      case "math_inline":
        push(runText(c.content, { ...fmt, mono: true }));
        break;
      case "softbreak":
        push(runText(" ", fmt));
        break;
      case "hardbreak":
        push(BR_RUN);
        break;
      case "image":
        push(imageRun(ctx, attr(c, "src") ?? "", c.content, fmt));
        break;
      case "html_inline": {
        const box = checkboxFromHtml(c.content);
        if (box != null) push(runText(box + " ", fmt));
        else {
          const t = stripTags(c.content);
          if (t) push(runText(t, fmt));
        }
        break;
      }
      case "link_open":
        href = attr(c, "href");
        fmt.link = true;
        buf = [];
        break;
      case "link_close": {
        const inner = (buf ?? []).join("");
        buf = null;
        fmt.link = false;
        if (href) {
          const rid = addRel(ctx, REL_HYPERLINK, href, true);
          out.push(`<w:hyperlink r:id="${rid}">${inner}</w:hyperlink>`);
        } else {
          out.push(inner);
        }
        href = null;
        break;
      }
      default:
        // 未识别的内联(如其它 html)按纯文本兜底,绝不漏内容。
        if (c.content && !c.children) push(runText(c.content, fmt));
        break;
    }
  }
  return out.join("");
}

/* ===========================================================================
   块级:token 流 → 段落 / 列表 / 引用 / 代码 / 表格 / 图片
   =========================================================================== */

type Ce =
  | { kind: "heading"; level: number }
  | { kind: "quote" }
  | { kind: "listItem"; numId: number; ilvl: number; isTask: boolean };

type MdTok = {
  type: string;
  tag: string;
  content: string;
  children?: MdChild[] | null;
};

function renderBody(tokens: MdTok[], ctx: Ctx): string {
  const out: string[] = [];
  const listStack: ("bullet" | "ordered")[] = [];
  const ctxStack: Ce[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case "heading_open":
        ctxStack.push({ kind: "heading", level: headingLevel(t.tag) });
        break;
      case "heading_close":
        ctxStack.pop();
        break;
      case "blockquote_open":
        ctxStack.push({ kind: "quote" });
        break;
      case "blockquote_close":
        ctxStack.pop();
        break;
      case "bullet_list_open":
        listStack.push("bullet");
        break;
      case "ordered_list_open":
        listStack.push("ordered");
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        listStack.pop();
        break;
      case "list_item_open": {
        const cls = attr(t, "class") ?? "";
        const type = listStack[listStack.length - 1] ?? "bullet";
        ctxStack.push({
          kind: "listItem",
          numId: type === "ordered" ? 2 : 1,
          ilvl: Math.max(0, listStack.length - 1),
          isTask: cls.includes("mkn-task-item"),
        });
        break;
      }
      case "list_item_close":
        ctxStack.pop();
        break;
      case "inline":
        out.push(renderParagraph(t, ctxStack, ctx));
        break;
      case "fence":
        out.push(renderFence(t, ctx));
        break;
      case "code_block":
        out.push(renderCodeBlock(t.content, ctx));
        break;
      case "math_block":
        out.push(renderCodeBlock(t.content, ctx));
        break;
      case "hr":
        out.push(HR_PARA);
        break;
      case "table_open": {
        const r = renderTable(tokens, i, ctx);
        out.push(r.xml);
        i = r.next;
        break;
      }
      default:
        break;
    }
  }
  return out.join("");
}

function headingLevel(tag: string): number {
  const n = parseInt(tag.replace(/^h/i, ""), 10);
  return n >= 1 && n <= 6 ? n : 1;
}

/** 一个 inline(段落正文)→ <w:p>,段落属性由上下文栈推导。 */
function renderParagraph(t: MdTok, ctxStack: Ce[], ctx: Ctx): string {
  let chosen: Ce | null = null;
  for (let k = ctxStack.length - 1; k >= 0; k--) {
    const e = ctxStack[k];
    if (e.kind === "heading" || e.kind === "listItem" || e.kind === "quote") {
      chosen = e;
      break;
    }
  }

  const pPr: string[] = [];
  if (chosen?.kind === "heading") {
    pPr.push(`<w:pStyle w:val="Heading${chosen.level}"/>`);
  } else if (chosen?.kind === "listItem") {
    if (chosen.isTask) {
      // 任务项不挂项目符号(☐/☑ 已由 html_inline 给出),走普通段落。
      pPr.push('<w:pStyle w:val="ListParagraph"/>');
    } else {
      pPr.push('<w:pStyle w:val="ListParagraph"/>');
      pPr.push(
        `<w:numPr><w:ilvl w:val="${chosen.ilvl}"/><w:numId w:val="${chosen.numId}"/></w:numPr>`
      );
    }
  } else if (chosen?.kind === "quote") {
    pPr.push('<w:pStyle w:val="Quote"/>');
  }

  const runs = renderInline(t.children, ctx);
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : "";
  return `<w:p>${pPrXml}${runs}</w:p>`;
}

function renderFence(t: MdTok, ctx: Ctx): string {
  const lang = fenceLang(t);
  if (lang.toLowerCase() === "mermaid") {
    const note =
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>' +
      runText("Mermaid 图(源码,导出未渲染):", { mono: true }) +
      "</w:p>";
    return note + renderCodeBlock(t.content, ctx);
  }
  return renderCodeBlock(t.content, ctx);
}

function fenceLang(t: MdTok): string {
  // fence 的语言在 info 字段;派生类型未暴露 info,运行期读取。
  const info = (t as unknown as { info?: string }).info ?? "";
  return info.trim().split(/\s+/)[0] ?? "";
}

/** 代码块 / 数学源降级:一个 CodeBlock 段落,行间用 <w:br/>。 */
function renderCodeBlock(content: string, _ctx: Ctx): string {
  void _ctx;
  const lines = content.replace(/\n+$/, "").split("\n");
  const runs = lines
    .map(
      (ln, idx) =>
        (idx > 0 ? BR_RUN : "") + runText(ln.length ? ln : " ", { mono: true })
    )
    .join("");
  return `<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>${runs}</w:p>`;
}

const HR_PARA =
  '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="E8E8E8"/></w:pBdr></w:pPr></w:p>';

/* ===========================================================================
   表格(GFM)→ w:tbl
   =========================================================================== */

interface Cell {
  runs: string;
  al: "left" | "center" | "right";
  header: boolean;
}

function renderTable(
  tokens: MdTok[],
  start: number,
  ctx: Ctx
): { xml: string; next: number } {
  const rows: Cell[][] = [];
  let cur: Cell[] | null = null;
  let i = start;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "table_close") break;
    if (t.type === "tr_open") cur = [];
    else if (t.type === "tr_close") {
      if (cur) rows.push(cur);
      cur = null;
    } else if (t.type === "th_open" || t.type === "td_open") {
      const style = attr(t, "style") ?? "";
      const al = style.includes("center")
        ? "center"
        : style.includes("right")
          ? "right"
          : "left";
      const next = tokens[i + 1];
      const runs =
        next && next.type === "inline" ? renderInline(next.children, ctx) : "";
      cur?.push({ runs, al, header: t.type === "th_open" });
    }
  }

  const ncol = rows.length ? rows[0].length : 0;
  if (ncol === 0) return { xml: "", next: i };

  const grid =
    "<w:tblGrid>" + '<w:gridCol/>'.repeat(ncol) + "</w:tblGrid>";

  const trXml = rows
    .map((cells) => {
      const tcs = cells
        .map((c) => {
          const jc = c.al !== "left" ? `<w:jc w:val="${c.al}"/>` : "";
          const shd = c.header
            ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>'
            : "";
          const ppr = jc ? `<w:pPr>${jc}</w:pPr>` : "";
          const body = c.runs || "<w:r><w:t></w:t></w:r>";
          return (
            "<w:tc>" +
            `<w:tcPr><w:tcW w:w="0" w:type="auto"/>${shd}</w:tcPr>` +
            `<w:p>${ppr}${body}</w:p>` +
            "</w:tc>"
          );
        })
        .join("");
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join("");

  const borders =
    "<w:tblBorders>" +
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
    "</w:tblBorders>";

  const xmlStr =
    "<w:tbl>" +
    `<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>` +
    grid +
    trXml +
    "</w:tbl>" +
    // 表后补一个空段落,避免与后续内容粘连(Word 习惯)。
    "<w:p/>";

  return { xml: xmlStr, next: i };
}

/* ===========================================================================
   图片尺寸读取(png / gif / jpeg / bmp)—— 读不出返回 null
   =========================================================================== */

function imageSize(
  b: Uint8Array,
  mime: string
): { w: number; h: number } | null {
  try {
    const m = mime.toLowerCase();
    // PNG: 8B 签名,IHDR 在 16..24(大端 width/height)
    if (m.includes("png") && b.length >= 24) {
      const w = readU32BE(b, 16);
      const h = readU32BE(b, 20);
      if (w && h) return { w, h };
    }
    // GIF: 6..10 小端 width/height
    if (m.includes("gif") && b.length >= 10) {
      const w = b[6] | (b[7] << 8);
      const h = b[8] | (b[9] << 8);
      if (w && h) return { w, h };
    }
    // BMP: 18..26 小端 width/height
    if (m.includes("bmp") && b.length >= 26) {
      const w = readU32LE(b, 18);
      const h = readU32LE(b, 22);
      if (w && h) return { w, h };
    }
    // JPEG: 扫描 SOF0/2 等标记
    if ((m.includes("jpeg") || m.includes("jpg")) && b.length >= 4) {
      let p = 2;
      while (p + 9 < b.length) {
        if (b[p] !== 0xff) {
          p++;
          continue;
        }
        const marker = b[p + 1];
        // SOF0..SOF15(除 C4/C8/CC):含尺寸
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          const h = (b[p + 5] << 8) | b[p + 6];
          const w = (b[p + 7] << 8) | b[p + 8];
          if (w && h) return { w, h };
          return null;
        }
        const len = (b[p + 2] << 8) | b[p + 3];
        if (len <= 0) break;
        p += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readU32BE(b: Uint8Array, o: number): number {
  return (
    ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
  );
}
function readU32LE(b: Uint8Array, o: number): number {
  return (
    (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
  );
}

/* ===========================================================================
   固定包骨架:命名空间 / sectPr / 关系 / 内容类型 / 样式 / 编号
   =========================================================================== */

const XML_DECL =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const DOC_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

// A4 纵向 + 约 1 英寸页边距(twip:1in=1440)。
const SECT_PR =
  "<w:sectPr>" +
  '<w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
  "</w:sectPr>";

const ROOT_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

function contentTypes(exts: Set<string>): string {
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
  ];
  const ctByExt: Record<string, string> = {
    png: "image/png",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
  };
  for (const e of exts) {
    const ct = ctByExt[e];
    if (ct) defaults.push(`<Default Extension="${e}" ContentType="${ct}"/>`);
  }
  return (
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    defaults.join("") +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    "</Types>"
  );
}

function documentRels(rels: RelEntry[]): string {
  const fixed =
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>';
  const dyn = rels
    .map(
      (r) =>
        `<Relationship Id="${r.id}" Type="${r.type}" Target="${xml(
          r.target
        )}"${r.external ? ' TargetMode="External"' : ""}/>`
    )
    .join("");
  return (
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    fixed +
    dyn +
    "</Relationships>"
  );
}

/** 样式:Normal / Heading1-6 / Title / Quote / ListParagraph / CodeBlock /
 *  Hyperlink / TableGrid。色值参考 render.ts 内联主题,贴近 Typora 浅色。 */
const STYLES_XML =
  XML_DECL +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  "<w:docDefaults><w:rPrDefault><w:rPr>" +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/>' +
  '<w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  "</w:docDefaults>" +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  heading(1, 36, "2F2F2F") +
  heading(2, 30, "2F2F2F") +
  heading(3, 26, "2F2F2F") +
  heading(4, 24, "2F2F2F") +
  heading(5, 22, "6B6B6B") +
  heading(6, 22, "6B6B6B") +
  '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D8DDE4"/></w:pBdr>' +
  '<w:ind w:left="240"/></w:pPr><w:rPr><w:i/><w:color w:val="6B6B6B"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:ind w:left="420"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F7F9"/><w:spacing w:after="160" w:line="276" w:lineRule="auto"/>' +
  '<w:ind w:left="120" w:right="120"/></w:pPr>' +
  '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>' +
  '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
  '<w:rPr><w:color w:val="3A7AFE"/><w:u w:val="single"/></w:rPr></w:style>' +
  '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>' +
  '<w:tblPr><w:tblBorders>' +
  '<w:top w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
  '<w:left w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
  '<w:right w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
  '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="E8E8E8"/>' +
  "</w:tblBorders></w:tblPr></w:style>" +
  "</w:styles>";

function heading(level: number, sz: number, color: string): string {
  return (
    `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
    `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/>` +
    '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr>' +
    `<w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${sz}"/></w:rPr>` +
    "</w:style>"
  );
}

/** 编号:num 1 = 项目符号、num 2 = 有序(十进制),各 9 级。 */
const NUMBERING_XML = (() => {
  const bulletLvls = Array.from({ length: 9 }, (_, l) =>
    `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
    '<w:lvlText w:val="•"/><w:lvlJc w:val="left"/>' +
    `<w:pPr><w:ind w:left="${(l + 1) * 420}" w:hanging="360"/></w:pPr>` +
    '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>'
  ).join("");
  const decimalLvls = Array.from({ length: 9 }, (_, l) =>
    `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
    `<w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${(l + 1) * 420}" w:hanging="360"/></w:pPr></w:lvl>`
  ).join("");
  return (
    XML_DECL +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:abstractNum w:abstractNumId="0">${bulletLvls}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1">${decimalLvls}</w:abstractNum>` +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    "</w:numbering>"
  );
})();
