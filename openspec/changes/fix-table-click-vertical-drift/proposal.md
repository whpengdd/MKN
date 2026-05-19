## Why

点渲染态表格的某个单元格后，reveal 出源码时光标/选区竖直向下偏一行——用户点"上面那行"，结果选中"下面那行"。根因是 `TableWidget` 点击只把光标跳到表格起点（不区分点中哪格），逼用户 reveal 后再点一次定位；而那"第二次点"踩进"源码刚插入、CodeMirror 尚未测量折行行高"的高度图失真窗口（`EditorView.lineWrapping` 开启，长表格行折成多视觉行，未测量时被按单行估算），`posAtCoords` 把屏幕 Y 解析到偏下文档位置。该缺陷直接破坏"无缝隐现"体感，必须修。

## What Changes

- 点渲染态表格单元格时，按被点中的行/列直接把光标精确落到该单元格对应的源码偏移，一次点击完成定位（不再统一跳表格起点、不再需要点第二次）。
- `tableModel` 暴露"逻辑行/列 → pipe 源码字节偏移"的纯函数映射，供点击定位使用，并保持可单测。
- 给三个跨多行块级 widget（`TableWidget`、`BlockMathWidget`、`MermaidWidget`）提供合理的 `estimatedHeight`，缓解块上方未测量导致下方落点整体下移（公式/Mermaid 同源缺陷一并兜底）。
- 不改 Markdown 解析、不改 reveal 隐现判定语义、不改表格工具条行为。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `seamless-editor`: 「表格可视化编辑」要求扩展——点击渲染表格的单元格 SHALL 把光标精确定位到该单元格对应的源码位置；新增「块级渲染高度估算」要求——跨多行块 widget SHALL 提供高度估算，使其上方/自身的点击坐标映射不产生竖直行漂移。

## Impact

- 代码：`src/core/livePreview/widgets.ts`（`TableWidget` 点击定位、`estimatedHeight`）、`src/core/livePreview/tableModel.ts`（行列→偏移映射）、`src/core/livePreview/math.ts`（`BlockMathWidget.estimatedHeight`）、`src/core/livePreview/mermaid.ts`（`MermaidWidget.estimatedHeight`）。
- 测试：扩展 `src/core/livePreview/tableModel.test.ts` 覆盖偏移映射。
- 无新增依赖；无破坏性变更；不影响导出/外壳/会话缓存。
