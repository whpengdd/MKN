## Context

实时预览用 Typora 式隐现:光标不在表格时整块替换成 `TableWidget`(`Decoration.replace({widget,block:true})`),光标进入则 reveal 出 pipe 源码。当前 `TableWidget.toDOM` 的 `wrap` mousedown 只做 `view.dispatch({selection:{anchor:this.pos}})`——无论点哪格,光标都跳到表格起点。用户被迫 reveal 后再点一次定位,而那一次点正好落在"源码刚插入 DOM、CodeMirror 尚未测量折行高度"的窗口:`EditorView.lineWrapping` 开启,长表格行折成多视觉行,未测量时按单行估算,高度图偏矮,`posAtCoords` 把屏幕 Y 解析到偏下文档位置,稳定向下偏一行。

同源结构缺陷:`TableWidget` / `BlockMathWidget` / `MermaidWidget` 三个跨多行块 widget 均未重写 `get estimatedHeight()`(默认 -1),块上方有未测量同类块时,落点整体下移。

`tableModel.ts` 已是纯函数层(parseTable/serializeTable/变换),有单测;`parseTable` 会 trim + 过滤空行,模型行索引与源码物理行不是一一对应,偏移映射必须基于**原始 source 字符串**单独计算。

## Goals / Non-Goals

**Goals:**
- 单次点击渲染表格单元格,光标精确落到该单元格对应的 pipe 源码偏移,不偏行。
- `tableModel` 暴露纯函数 `cellSourceOffset(source, rowIdx, colIdx)`,可单测。
- 三个跨多行块 widget 提供与所替换行数相称的 `estimatedHeight`,消除"块上方未测量→落点下移"。

**Non-Goals:**
- 不改 Markdown 解析、reveal 隐现判定语义、表格工具条逻辑。
- 不追求像素级列内字符定位(落到正确单元格内容起点即可,核心是"行不漂移")。
- 不重写 CodeMirror 高度测量机制。

## Decisions

### D1:点击在 widget 内解析被点单元格 → 直接定位(治本)

`wrap` mousedown 中,用 `(e.target as HTMLElement).closest("td,th")` 拿到被点单元格;由其 `cellIndex` 得列号 C,由所在 `<tr>` 判断表头还是第几数据行得行号 R(表头 R=-1)。调用 `cellSourceOffset(this.source, R, C)` 得到该单元格在 source 内的字符偏移,最终 `view.dispatch({selection:{anchor: this.pos + offset}})`。一次点击同时完成 reveal 与精确定位,彻底绕开"二次点击 + 失真高度图"窗口。

- 备选:reveal 后 `view.requestMeasure` 再校正光标——仍治标,且有可见跳动,弃。
- 行号判定不复用 `activeRow`(mouseenter 设置,快速点击可能未触发或滞后),直接从 DOM 结构(`thead`/`tbody` + rowIndex)即时算,确定性更强。

### D2:`cellSourceOffset` 放进 tableModel,基于原始 source 物理行

不能用 `parseTable` 的模型索引(它 trim + 滤空行)。函数自行:
1. `source.split("\n")` 保留原始行,前缀累加得每行起始偏移(每行 +1 还原 `\n`)。
2. 复用 `isDelimiterLine` 判定:第一条非空行=表头行;其后第一条非空且 `isDelimiterLine` 的行=分隔行;分隔行之后的非空行依次为数据行。
3. 目标行→物理行:R=-1→表头物理行;R=k→第 k 条数据物理行。越界则 clamp。
4. 行内列偏移:在该物理行内,跳过可选前导 `|`,按未转义 `|`(沿用 `splitCells` 的 `(?<!\\)\|` 规则)切分,数到第 C 段,跳过其前导空白,得列内容起点;列越界落到行首内容处。
5. 返回 `物理行起始偏移 + 列内偏移`,保证 `0 ≤ offset ≤ source.length`。

附带单测覆盖:表头/数据行/含 CJK 列宽/转义 `\|`/分隔行缺失的降级。

### D3:三个块 widget 提供 estimatedHeight(兜底)

`TableWidget`:`get estimatedHeight()` 返回 `行数 × 估算行高`(行数 = source 行数,行高取一个保守常量,如 22px,够 CM 在测量前不至于大幅低估)。`BlockMathWidget`:块级公式通常 1~3 行,返回一个合理块高常量。`MermaidWidget`:图较高,返回较大常量。这些只是"测量前估计值",CM 渲染后会用真实 DOM 高度覆盖,目的是缩小未测量窗口内的高度图误差,而非精确。

- 备选:统一基类抽象——当前三处独立 StateField/文件,过度抽象收益低,各自就地加 getter 即可。

## Risks / Trade-offs

- [D1 DOM 结构假设:依赖 `thead`+`tbody`+`<tr>`/`<td>` 与 `mkRow` 渲染一致] → 行号改为读 `tr.rowIndex`/单元格 `cellIndex`,与 `mkRow(model.header,true,-1)` / `rows.forEach((r,i)=>...)` 的产出严格对应;加注释锁定该耦合。
- [D2 与 splitCells 规则漂移:两处各自实现 `|` 切分易分叉] → 复用同一正则常量/抽出共享小工具,单测对拍。
- [estimatedHeight 仅为估计,极端长表格/慢渲染下仍可能短暂偏差] → D1 已让表格路径不依赖高度图;D3 仅作其它块兜底,残差可接受,不追求消灭。
- [回归风险:改动 `wrap` mousedown 影响工具条点击] → 保留原 `closest(".mkn-tbar")` 早返回与 `e.preventDefault()`;新增逻辑只在非工具条点击分支内。

## Migration Plan

无数据/接口迁移。改动局限 `src/core/livePreview/`。验证:`npm test`(tableModel.test.ts 不回归 + 新增偏移用例通过)+ 手测点击渲染表格各行/表头光标落位正确。回滚:单 commit revert。
