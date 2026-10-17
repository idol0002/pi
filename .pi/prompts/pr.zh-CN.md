---
description: 按 URL 审查 PR，结合结构化的 issue 与代码分析
argument-hint: "<PR-URL>"
---
给你一个或多个 GitHub PR 链接：$@

对每个 PR 链接，按顺序执行以下操作：
1. 在分析开始前，通过 GitHub CLI 给 PR 加 `inprogress` 标签。加标签失败时，明确报告并继续。
2. 完整阅读 PR 页面。包括描述、所有评论、所有 commit 和所有变更文件。
3. 找出 PR 正文、评论、commit 信息或交叉链接中引用的关联 issue。完整阅读每个 issue，包括所有评论。
4. 在不检出或切换到 PR 分支的前提下分析 PR diff。使用 `gh pr diff`、`gh pr view`、`gh api` 和本地 main 分支文件；如果需要 PR 中的文件内容，用已拉取的 ref 配合 `git show <ref>:<path>` 或临时文件。完整阅读所有相关代码文件（不截断），并与 diff 对比。除非文件在 main 上不存在、或 diff 上下文不足，否则不要拉取 PR 文件 blob。要包含不在 diff 中、但验证行为所必需的相关代码路径。
5. 不要检查 changelog 条目。按 CONTRIBUTING.md 的规定，贡献者的 PR 不得编辑 `CHANGELOG.md`——条目由维护者在合并时添加。
6. 检查 packages/coding-agent/README.md、packages/coding-agent/docs/*.md、packages/coding-agent/examples/**/*.md 是否需要修改。当已有特性被更改或新特性被添加时，通常需要。
7. 按以下章节给出结构化评审：
   - What it does：一小段话描述变更及其意图。
   - Good：扎实的选择或改进。
   - Bad：具体的问题、回归、缺失的测试或风险。
   - Ugly：隐蔽的或高影响的问题。
   - Tests：覆盖了什么、缺什么、现有测试是否充分。
   - Open questions for you：只列阻塞合并决策、需要用户输入的事项。没有就完全省略该章节。

每个 PR 的输出格式：
PR: <url>
What it does:
- ...
Good:
- ...
Bad:
- ...
Ugly:
- ...
Tests:
- ...
Open questions for you:
- ...

如果没有发现问题，在 Bad 和 Ugly 下明确说明。
