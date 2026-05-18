import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";

/**
 * Markdown 语言层。
 *
 * - `base: markdownLanguage` 启用 GFM(表格 / 删除线 / 任务列表 / 自动链接),
 *   这是复刻 Typora 表格体验的前提。
 * - `codeLanguages: languages` 让代码围栏按语言惰性加载语法,
 *   语法高亮由 highlight style 自动着色,无需自研解析。
 *
 * 注意:文档在内存中始终是这段 Markdown 纯文本本身。Lezer 只提供
 * 语法树供 decoration 读取,从不改写文本 —— 这是"保存即原样写回、
 * 本地 .md 零损失往返"的根基。
 */
export function markdownLang(): Extension {
  return markdown({
    base: markdownLanguage,
    codeLanguages: languages,
    addKeymap: true,
  });
}
