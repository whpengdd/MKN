## Context

设置面板在 `src/ui/settings.ts`,`createSettings()` 按分组(主题/字号/模式/导出)用 `el()` 构建 DOM 追加到 `bodyEl`。本次只在面板末尾追加一个静态署名区块,不涉及任何状态/持久化。

## Goals / Non-Goals

**Goals:**
- 设置面板底部固定展示:作者 彭大大、版本 2026.05
- 纯硬编码静态文本,样式与现有 `mkn-settings-hint` 风格协调

**Non-Goals:**
- 不做可编辑输入、不持久化、不接导出
- 不引入版本号自动生成机制(就是字符串 `2026.05`)
- 不改动冻结主题文件与 `src/core`

## Decisions

- 在 `createSettings()` 所有分组之后,向 `bodyEl` 追加一个 `mkn-settings-about` 区块,内含两行硬编码文本:`作者:彭大大`、`版本:2026.05`。
- 版本以字符串常量硬编码,集中一处便于后续手动更新。
- 样式复用/接近 `mkn-settings-hint`(弱化、小字),如需独立样式加 `.mkn-settings-about` 到 `settings.css`。

## Risks / Trade-offs

- 版本号需手动维护:可接受,符合"固定硬编码"诉求。
