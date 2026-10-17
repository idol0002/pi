---
name: github-work
description: 处理本仓库的 GitHub issue 和 pull request。当被要求调查、分析、修复或审查某个 issue 或 PR，以及被要求收尾这类工作（changelog、评论、提交、推送、关闭）时使用。
---

# 处理 GitHub issue 和 PR

仓库在 `.pi/prompts/`（本技能上两级目录）中的提示词模板定义了工作流。完整阅读匹配的模板并遵循它。模板中的 `$ARGUMENTS` 或 `$@` 替换为请求中的 issue 或 PR 编号/URL，以及用户给出的任何附加指令。

| 请求 | 模板 |
|---|---|
| 调查、分析或修复 issue | `.pi/prompts/is.md` |
| 审查 pull request | `.pi/prompts/pr.md` |
| 收尾 issue 或 PR 工作：changelog、最终评论、提交、推送、关闭 | `.pi/prompts/wr.md` |

规则：

- `is.md` 只做分析和提案。只有用户要求时才实现，且实现时要继续遵守 AGENTS.md（检查、测试、changelog 规则）。
- `pr.md` 绝不检出或切换到 PR 分支。
- 只有用户要求收尾、提交或推送时才运行 `wr.md`。每个会话最多发布一条最终 GitHub 评论，且以其规定的精确免责声明行结尾。
- 当请求跨越多个步骤时，例如 "修复 issue X 并收尾"，开始前要阅读所有涉及的模板。
