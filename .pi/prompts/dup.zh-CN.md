---
description: 查找 GitHub issue 的潜在重复项
argument-hint: "<issue-url>"
---
在 issue 所在的 GitHub 仓库中查找潜在重复项：$1

步骤：
1. 用 `gh issue view <url> --comments` 阅读 issue，理解问题。
2. 用 `gh search issues` / `gh issue list --search` / `gh pr list --search` 在同一仓库搜索打开和关闭的 issue 与 PR，使用多组关键词变体（错误信息、特性名称、受影响组件、症状）。
3. 阅读有希望的候选者，确认它们描述的是同一问题，而不只是用词相似。

重复项指报告同一问题或请求同一变更的内容：相同症状且可能原因相同，或一个 PR 恰好修复了该 issue。仅共享某个组件、某条错误信息或某个相关原因是不够的。

输出一条简短的 GitHub 评论草稿，附带 AI 生成声明。

如果没有找到，回复 "No duplicates found."

不要发布、打标签或关闭任何内容。
