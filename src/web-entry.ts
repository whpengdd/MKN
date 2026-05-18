import "./styles/theme-default.css";
import { undo, redo } from "@codemirror/commands";
import { createEditor, loadDoc } from "./core/editor";

/**
 * Phase 0 纯 Web 入口(无外壳)。
 * 提供一篇覆盖全部 Phase 0 元素的中文样例,便于立即试"隐现手感"
 * 与中文输入法;并支持打开本地 .md 验证真实文档。
 */

const SAMPLE = `# 复刻 Typora — Phase 0 内核探针

把光标移到下面任意位置,**语法符号会随光标隐现**。移开光标看渲染,移回去改原文。这就是 Typora 的灵魂。

## 行内排版

这是 **加粗**、*斜体*、\`行内代码\`、~~删除线~~,还有一个 [链接](https://example.com)。请把光标点到 \`**\` 旁边,看它如何露出。

## 中文输入法重点测试

请在这一行用中文输入法快速输入一段话,验证组合输入时不吞字、光标不乱跳:____

> 这是一段引用。Typora 的简洁,很大程度是默认主题的排版调出来的。
> 引用可以跨多行。

## 列表

- 无序列表项一
- 无序列表项二,带 **加粗**
- 无序列表项三

1. 有序列表项一
2. 有序列表项二

## 代码围栏(语法高亮)

\`\`\`typescript
function greet(name: string): string {
  // 光标进入围栏会露出原文
  return \`你好,\${name}\`;
}
\`\`\`

## 任务列表

- [x] Phase 0 内核探针(已验收)
- [ ] 表格可视化编辑
- [ ] 查找替换(按 ⌘F / Ctrl-F 打开)

回车会自动续列表项;在空列表项再回车结束列表。

## 行内图片

光标不在图片上时渲染图片本身,移上去露出 \`![]()\` 源码:

![一只猫](https://placecats.com/300/160)

## 表格(可视化编辑)

光标不在表格时显示渲染后的表格,**鼠标悬停表格上方浮出工具条**:增删行列、切换列对齐。点击单元格则露出 pipe 源码改文字。

| 功能 | Phase | 状态 |
| :--- | :---: | ---: |
| 无缝隐现 | 0 | 已验收 |
| 表格可视化编辑 | 1 | 进行中 |
| Electron 外壳 | 2 | 计划 |

---

Phase 1 验收:表格可视化增删行列、查找替换、列表续行、任务勾选都顺手即通过。
`;

const app = document.getElementById("app")!;
const view = createEditor(app, SAMPLE);

const fileInput = document.getElementById("file-input") as HTMLInputElement;
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  loadDoc(view, text);
  fileInput.value = "";
  view.focus();
});

// Phase 0/1 调试便利:暴露 view 与 undo/redo 供探针验证(外壳化后移除)
Object.assign(window as unknown as Record<string, unknown>, {
  __mknView: view,
  __mknUndo: () => undo(view),
  __mknRedo: () => redo(view),
});

view.focus();
