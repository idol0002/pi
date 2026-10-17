---
description: 分析 GitHub issue（bug 或特性请求）
argument-hint: "<issue>"
---
分析 GitHub issue：$ARGUMENTS

对每个 issue：

1. 如果在 CI 环境下运行（`CI=true`），不加 `inprogress` 标签、不指派 issue。否则，在分析开始前通过 GitHub CLI 给 issue 加 `inprogress` 标签，并把 issue 指派给本地 `gh` 用户。任一操作失败时，明确报告并继续。
2. 完整阅读 issue，包括所有评论和关联的 issue/PR。使用 GitHub CLI 支持的字段，例如：
   ```sh
   gh issue view <issue> --json title,body,comments,labels,assignees,state,url,author,createdAt,updatedAt,closedByPullRequestsReferences
   ```
3. 不要轻信 issue 中写好的分析。独立验证行为，基于代码和执行路径得出自己的分析。

4. **对于 bug**：
   - 忽略 issue 中已有的根因分析（很可能是错的）
   - 完整阅读所有相关代码文件（不截断）
   - 追踪代码路径，找出真正的根因
   - 提出修复方案

5. **对于特性请求**：
   - 不要未经验证就轻信 issue 中的实现方案
   - 完整阅读所有相关代码文件（不截断）
   - 提出最简洁的实现方案
   - 列出受影响的文件和需要的变更

除非明确要求，不要动手实现。只做分析和提案。
