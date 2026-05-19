# docx-import

## Purpose

允许用户直接打开 Word `.docx` 文件,将其有损转换为受支持的 Markdown 子集,并作为未命名草稿载入编辑器,期间不触碰原 `.docx` 文件。

## Requirements

### Requirement: 选择并打开 .docx 文件

打开文件对话框 SHALL 在原有 Markdown/文本类型基础上,放行 `.docx` 扩展名,使用户能够直接选中 Word 文件。

#### Scenario: 对话框可见 .docx
- **WHEN** 用户触发「打开文件」
- **THEN** 文件对话框的类型 filter 包含 `.docx`,用户可选中 `.docx` 文件而非被过滤隐藏

### Requirement: .docx 有损转换为 Markdown 子集

系统 SHALL 将选中的 `.docx` 解析为 Markdown,只映射以下结构:标题、段落、粗体、斜体、有序/无序列表、表格、超链接、换行;其余内容(批注、修订、页眉页脚、字体颜色、公式、图片、嵌入对象)SHALL 被丢弃,不得导致失败。

#### Scenario: 结构化内容被映射
- **WHEN** 一个含标题、粗斜体、列表、表格、超链接的 `.docx` 被打开
- **THEN** 编辑器载入对应的 Markdown(`#` 标题、`**粗**`、`*斜*`、`-`/`1.` 列表、管道表格、`[文本](url)` 链接)

#### Scenario: 不支持的内容被静默丢弃
- **WHEN** `.docx` 含批注、修订标记、页眉页脚、公式或图片
- **THEN** 这些内容被丢弃,转换仍成功完成,不报错、不阻断

### Requirement: 导入结果作为未命名草稿载入且不回写原文件

转换得到的 Markdown SHALL 以未命名草稿(`path = null`)载入编辑器;系统 MUST NOT 自动保存或以任何方式回写原 `.docx` 文件。

#### Scenario: 原 .docx 不被触碰
- **WHEN** 用户打开并查看由 `.docx` 导入的内容,期间发生自动保存计时
- **THEN** 因 `path = null`,自动保存不触发,原 `.docx` 文件内容保持不变

#### Scenario: 显式另存为 Markdown
- **WHEN** 用户对导入内容执行「保存 / 另存为」
- **THEN** 系统提示存为新的 `.md` 文件,不覆盖原 `.docx`

### Requirement: 无法解析的文件不致命

当所选文件不是合法 `.docx`(损坏、加密、实为旧版 `.doc` 二进制)或读取失败时,系统 SHALL 返回明确错误,MUST NOT panic 或崩溃。

#### Scenario: 损坏或非法 docx
- **WHEN** 用户选中一个损坏的、加密的或扩展名为 `.docx` 实为 `.doc` 的文件
- **THEN** 命令返回可读错误信息,应用保持运行,不崩溃
