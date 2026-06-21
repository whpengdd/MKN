## MODIFIED Requirements

### Requirement: 可选 Pandoc 导出

应用 SHALL 提供 Word 导出,并按可用性分层降级:检测到 `pandoc` 时优先用 pandoc 导出(markdown 经 stdin 喂入,保真优先),并可经同一通路提供 LaTeX / epub 导出;未检测到 pandoc(或 pandoc 运行期失败)时,Word 导出 SHALL 自动回落到内置 `.docx` 生成器(见 `word-export` 能力),MUST NOT 因缺少 pandoc 而使 Word 导出不可用。

#### Scenario: 有 pandoc 优先走 pandoc

- **WHEN** 系统已安装 pandoc 并触发"导出 Word"
- **THEN** 经 pandoc 把 markdown 转 `.docx` 落盘(保真优先)

#### Scenario: 无 pandoc 回落内置生成器

- **WHEN** 触发"导出 Word"但系统无 pandoc
- **THEN** 自动用内置生成器产出可正常打开的 `.docx`,不弹"需安装 pandoc"死路、不产生半截文件

#### Scenario: LaTeX / epub 仍依赖 pandoc

- **WHEN** 触发 LaTeX 或 epub 导出但系统无 pandoc
- **THEN** 提示这些格式需安装 pandoc,不产生半截文件
