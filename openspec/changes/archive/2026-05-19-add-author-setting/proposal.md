## Why

设置面板没有任何开发者/版权信息。希望在面板底部固定展示一段静态署名(作者、版本),作为开发者版权标识,不需要用户编辑。

## What Changes

- 在设置面板新增一个固定的"关于/版权"区块,**硬编码**展示:
  - 作者:彭大大
  - 版本:2026.05(以年月形式显示)
- 纯静态只读文本,不持久化、不可编辑、不接入导出

## Capabilities

### New Capabilities
<!-- 无新增独立能力 -->

### Modified Capabilities
- `export-and-appearance`: "设置面板"需求新增固定的开发者版权署名区块(静态展示)

## Impact

- `src/ui/settings.ts`:面板末尾新增一个静态署名区块(硬编码文本)
- `src/ui/settings.css`:署名区块样式(如需要)
- 无 localStorage、无导出、无新增对外接口
