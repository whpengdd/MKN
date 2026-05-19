//! .docx 有损导入(仅查看)。把 Word 文档解析成 Markdown 子集:
//! 标题 / 段落 / 粗体 / 斜体 / 列表 / 表格 / 超链接 / 换行。
//!
//! 显式丢弃(不报错、不阻断):批注、修订标记、页眉页脚、字体颜色、
//! 公式、图片、嵌入对象。解析失败 / 损坏 / 加密 / 旧版 .doc 二进制 →
//! 返回可读 Err(String),绝不 panic。
//!
//! 设计取舍(对齐 design.md):本特性目标是「能看」,凡解析不到的结构
//! 一律降级为纯文本而非报错。超链接 URL 需 relationship 解析,docx-rs
//! 读侧不便取 rid→URL,故仅锚点链接产出 [text](#anchor),其余降级为纯
//! 文本 —— 对「查看」足够,不为只读特性铺重逻辑。

use std::path::Path;

use docx_rs::{
    DocumentChild, HyperlinkData, ParagraphChild, RunChild, Table, TableCellContent, TableChild,
    TableRowChild,
};

/// 读取并把 .docx 转成 Markdown 子集。任何 IO / 解析错误都转成可读字符串。
pub fn docx_to_markdown(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败:{e}"))?;
    let docx = docx_rs::read_docx(&bytes).map_err(|_| {
        "无法解析为 .docx(可能已损坏、加密,或是旧版 .doc 二进制格式 —— 暂不支持)"
            .to_string()
    })?;

    let mut out = String::new();
    for child in &docx.document.children {
        match child {
            DocumentChild::Paragraph(p) => {
                push_paragraph(&mut out, p);
            }
            DocumentChild::Table(t) => {
                push_table(&mut out, t);
            }
            // 书签 / 批注锚点 / 目录 / 结构化标签等:查看无意义,丢弃。
            _ => {}
        }
    }

    Ok(out.trim_end().to_string() + "\n")
}

/// 段落 → 一行(或列表项)。空段落产出一个空行(保留排版节奏)。
fn push_paragraph(out: &mut String, p: &docx_rs::Paragraph) {
    let text = paragraph_inline(p);

    // 标题:样式 id 形如 "Heading1".."Heading6"(大小写不敏感)。
    if let Some(level) = heading_level(p) {
        if !text.trim().is_empty() {
            out.push_str(&"#".repeat(level));
            out.push(' ');
            out.push_str(text.trim());
            out.push_str("\n\n");
        }
        return;
    }

    // 列表项:有 numbering_property 即视为列表。有序/无序在 numbering.xml
    // 里,读侧不便区分 —— 查看场景统一降级为无序 `-`,按层级缩进。
    if let Some(level) = list_level(p) {
        if !text.trim().is_empty() {
            out.push_str(&"  ".repeat(level));
            out.push_str("- ");
            out.push_str(text.trim());
            out.push('\n');
        }
        return;
    }

    if text.trim().is_empty() {
        out.push('\n');
    } else {
        out.push_str(&text);
        out.push_str("\n\n");
    }
}

/// 段落内所有可见行内内容拼成一行(含粗斜体标记、软换行)。
fn paragraph_inline(p: &docx_rs::Paragraph) -> String {
    let mut s = String::new();
    for c in &p.children {
        match c {
            ParagraphChild::Run(r) => push_run(&mut s, r),
            // 修订:接受插入文本、丢弃删除文本(查看以"最终稿"为准)。
            ParagraphChild::Insert(ins) => {
                for c in &ins.children {
                    if let docx_rs::InsertChild::Run(r) = c {
                        push_run(&mut s, r);
                    }
                }
            }
            ParagraphChild::Delete(_) => {}
            // 超链接:仅锚点能稳定还原;其余降级为纯文本(见模块注释)。
            ParagraphChild::Hyperlink(h) => {
                let mut inner = String::new();
                for hc in &h.children {
                    if let ParagraphChild::Run(r) = hc {
                        push_run(&mut inner, r);
                    }
                }
                match &h.link {
                    HyperlinkData::Anchor { anchor } if !inner.is_empty() => {
                        s.push_str(&format!("[{inner}](#{anchor})"));
                    }
                    // External 的真实 URL 在 rid→relationship,读侧不便取,
                    // 降级为纯文本(查看足够,见模块注释)。
                    _ => s.push_str(&inner),
                }
            }
            _ => {}
        }
    }
    s
}

/// Run → 文本,按粗/斜体包裹。空文本 run 跳过(避免产出空 `****`)。
fn push_run(s: &mut String, r: &docx_rs::Run) {
    let mut t = String::new();
    for rc in &r.children {
        match rc {
            RunChild::Text(txt) => t.push_str(&txt.text),
            RunChild::Tab(_) => t.push('\t'),
            // 段内软换行 → markdown 硬换行(行尾两空格)。
            RunChild::Break(_) => t.push_str("  \n"),
            // DeleteText / 图片(Drawing)/ 公式等:丢弃。
            _ => {}
        }
    }
    if t.is_empty() {
        return;
    }
    let bold = r.run_property.bold.is_some();
    let italic = r.run_property.italic.is_some();
    let (pre, post) = match (bold, italic) {
        (true, true) => ("***", "***"),
        (true, false) => ("**", "**"),
        (false, true) => ("*", "*"),
        (false, false) => ("", ""),
    };
    s.push_str(pre);
    s.push_str(&t);
    s.push_str(post);
}

/// 标题级数:样式 id 末尾数字(Heading1→1)。"Title" 当作 1 级。
fn heading_level(p: &docx_rs::Paragraph) -> Option<usize> {
    let style = p.property.style.as_ref()?;
    let id = style.val.to_lowercase();
    if id == "title" {
        return Some(1);
    }
    if let Some(rest) = id.strip_prefix("heading") {
        if let Ok(n) = rest.trim().parse::<usize>() {
            return Some(n.clamp(1, 6));
        }
    }
    None
}

/// 列表缩进层级(无 numbering 返回 None)。
fn list_level(p: &docx_rs::Paragraph) -> Option<usize> {
    let np = p.property.numbering_property.as_ref()?;
    Some(np.level.as_ref().map(|l| l.val).unwrap_or(0))
}

/// 表格 → Markdown 管道表。首行作表头;单元格内换行压成空格。
fn push_table(out: &mut String, t: &Table) {
    let mut rows: Vec<Vec<String>> = Vec::new();
    for row in &t.rows {
        let TableChild::TableRow(tr) = row;
        let mut cells: Vec<String> = Vec::new();
        for cell in &tr.cells {
            let TableRowChild::TableCell(tc) = cell;
            let mut text = String::new();
            for content in &tc.children {
                if let TableCellContent::Paragraph(p) = content {
                    if !text.is_empty() {
                        text.push(' ');
                    }
                    text.push_str(paragraph_inline(p).trim());
                }
            }
            // 管道字符会破坏表格语义,转义。
            cells.push(text.replace('|', "\\|").replace('\n', " "));
        }
        if !cells.is_empty() {
            rows.push(cells);
        }
    }
    if rows.is_empty() {
        return;
    }
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let pad = |r: &Vec<String>| {
        let mut v = r.clone();
        v.resize(cols, String::new());
        format!("| {} |", v.join(" | "))
    };
    out.push_str(&pad(&rows[0]));
    out.push('\n');
    out.push_str(&format!("|{}\n", " --- |".repeat(cols)));
    for r in &rows[1..] {
        out.push_str(&pad(r));
        out.push('\n');
    }
    out.push('\n');
}

#[cfg(test)]
mod tests {
    use super::*;
    use docx_rs::*;

    /// 用 docx-rs 写一份含标题/粗体/段落/表格的真实 .docx,再用本模块
    /// 解析回 markdown,核对子集映射(对齐 tasks 4.2)。
    #[test]
    fn round_trips_subset() {
        let dir = std::env::temp_dir();
        let path = dir.join("mkn_docx_test.docx");
        let file = std::fs::File::create(&path).unwrap();

        Docx::new()
            .add_paragraph(
                Paragraph::new()
                    .style("Heading1")
                    .add_run(Run::new().add_text("标题")),
            )
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("普通 "))
                    .add_run(Run::new().bold().add_text("粗体")),
            )
            .add_table(Table::new(vec![
                TableRow::new(vec![
                    TableCell::new().add_paragraph(
                        Paragraph::new().add_run(Run::new().add_text("A")),
                    ),
                    TableCell::new().add_paragraph(
                        Paragraph::new().add_run(Run::new().add_text("B")),
                    ),
                ]),
                TableRow::new(vec![
                    TableCell::new().add_paragraph(
                        Paragraph::new().add_run(Run::new().add_text("1")),
                    ),
                    TableCell::new().add_paragraph(
                        Paragraph::new().add_run(Run::new().add_text("2")),
                    ),
                ]),
            ]))
            .build()
            .pack(file)
            .unwrap();

        let md = docx_to_markdown(&path).unwrap();
        assert!(md.contains("# 标题"), "标题未映射:{md}");
        assert!(md.contains("普通 **粗体**"), "粗体未映射:{md}");
        assert!(md.contains("| A | B |"), "表头未映射:{md}");
        assert!(md.contains("| 1 | 2 |"), "表体未映射:{md}");
        let _ = std::fs::remove_file(&path);
    }

    /// 损坏 / 非 .docx 字节 → 返回可读错误,不 panic(对齐 tasks 4.3)。
    #[test]
    fn corrupt_file_errors_gracefully() {
        let path = std::env::temp_dir().join("mkn_docx_bad.docx");
        std::fs::write(&path, b"this is not a zip / docx at all").unwrap();
        let err = docx_to_markdown(&path).unwrap_err();
        assert!(err.contains("无法解析为 .docx"), "错误信息不友好:{err}");
        let _ = std::fs::remove_file(&path);
    }
}
