## 1. tableModel:行列→源码偏移映射

- [x] 1.1 在 `src/core/livePreview/tableModel.ts` 抽出共享的未转义竖线切分规则(供 `splitCells` 与新函数复用,避免分叉)
- [x] 1.2 新增导出纯函数 `cellSourceOffset(source: string, rowIdx: number, colIdx: number): number`:基于原始 source 物理行(非 parseTable 模型索引),`rowIdx=-1` 表头、`>=0` 第 k 条数据行;返回该单元格内容起点在 source 内的字符偏移,结果 clamp 到 `[0, source.length]`
- [x] 1.3 处理降级与边界:分隔行缺失、行/列越界、含 CJK、含转义 `\|`

## 2. tableModel 单测

- [x] 2.1 在 `src/core/livePreview/tableModel.test.ts` 增加 `cellSourceOffset` 用例:表头某列、首/末数据行、含 CJK 列宽、含 `\|` 转义、分隔行缺失降级、行列越界 clamp
- [x] 2.2 `npm test` 全绿,既有用例不回归

## 3. TableWidget 单次点击精确定位

- [x] 3.1 `src/core/livePreview/widgets.ts` 改 `wrap` mousedown:保留 `.mkn-tbar` 早返回与 `e.preventDefault()`;非工具条分支用 `(e.target).closest("td,th")` 取被点单元格
- [x] 3.2 由单元格 `cellIndex` 得列号、由其 `<tr>` 是否在 `thead`/在 `tbody` 的 `rowIndex` 得行号(表头=-1),与 `mkRow` 渲染产出严格对应并加注释锁定耦合
- [x] 3.3 调用 `cellSourceOffset(this.source, R, C)`,`view.dispatch({selection:{anchor: this.pos + offset}})` 一次完成 reveal+定位;`closest` 落空时回退到 `this.pos`(不退化为崩溃)

## 4. 块级 widget 高度估算兜底

- [x] 4.1 `TableWidget` 增 `get estimatedHeight()`:按 source 行数 × 保守行高估算
- [x] 4.2 `src/core/livePreview/math.ts` `BlockMathWidget` 增 `get estimatedHeight()`(块级公式合理常量)
- [x] 4.3 `src/core/livePreview/mermaid.ts` `MermaidWidget` 增 `get estimatedHeight()`(图较高,较大常量)

## 5. 验证

- [x] 5.1 `npx tsc --noEmit`(或项目 typecheck)无报错
- [ ] 5.2 手测:点渲染态表格表头/首行/中间行/末行各单元格,reveal 后光标落在对应源码行,不向下偏一行
- [ ] 5.3 手测:工具条增删行列/对齐仍正常、`⌘Z` 可回退;块级公式/Mermaid 上下文点击不漂移
