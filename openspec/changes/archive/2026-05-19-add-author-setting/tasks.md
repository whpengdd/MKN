## 1. 静态署名区块

- [x] 1.1 在 `src/ui/settings.ts` 的 `createSettings()` 中,所有分组之后向 `bodyEl` 追加 `mkn-settings-about` 区块
- [x] 1.2 区块内硬编码两行:`作者:彭大大`、`版本:2026.05`(版本用一处字符串常量)
- [x] 1.3 如需要,在 `src/ui/settings.css` 加 `.mkn-settings-about` 样式(参考 `mkn-settings-hint` 的弱化小字风格)

## 2. 验证

- [x] 2.1 打开设置面板,底部显示作者 `彭大大` 与版本 `2026.05`
- [x] 2.2 文本只读,无输入控件,刷新后保持不变
