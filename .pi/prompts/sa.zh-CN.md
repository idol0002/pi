---
description: 更新 GitHub 安全公告以便发布
argument-hint: "<advisory-url-or-draft-path>"
---
更新 GitHub 安全公告以便发布：$ARGUMENTS

所有 GitHub 操作使用 `gh`。除非用户明确同意、或草稿 markdown 中明确写了 `request_cve: true`，否则不要发布公告、变更其状态或申请 CVE。

GitHub 没有通过公开的 REST OpenAPI schema 或公开 GraphQL schema 暴露仓库安全公告的评论/讨论。猜测的 API 端点如 `api.github.com/repos/.../security-advisories/<GHSA>/comments`、`.../timeline` 或 `.../events` 返回 404 是正常现象，其本身并不代表认证失败。不要使用浏览器会话、浏览器 cookie 或 cookie 提取来获取公告评论。相反，明确告诉用户未包含公告评论，如果希望将其纳入考量，可以自行粘贴相关评论。

## 输入处理

- 如果 `$ARGUMENTS` 是 GitHub 安全公告 URL，启动调查和起草工作流。
- 如果 `$ARGUMENTS` 是已有 markdown 草稿的路径，读取它并把草稿内容应用到公告。
- 在本 prompt 之后的后续消息中，如果用户说 "update"、"apply"、"looks good" 等类似的话，视为批准应用之前写好的临时 markdown 草稿。更新 GitHub 前要从磁盘重新读取该文件。
- 如果要应用草稿但没有已知的草稿路径，向用户询问 markdown 文件路径。

## 初次公告工作流

1. 把公告 URL 解析为 `owner`、`repo` 和 `GHSA` id。
2. 用以下命令获取公告：
   ```sh
   gh api repos/<owner>/<repo>/security-advisories/<GHSA>
   ```
   在提出修改之前，原样记录公告返回的原始严重级别、CVSS 向量和 CVSS 分数。
3. 除非用户把评论粘贴进对话，否则不要获取公告评论/讨论：
   - 检查公告 JSON 中的引用、致谢、关联 issue/PR 以及任何讨论字段。
   - 不要依赖臆造的 API 端点如 `/comments`、`/timeline` 或 `/events`；它们通常返回 404，因为 GitHub 不通过公开 API 暴露草稿公告的评论。
   - 不要使用浏览器会话、浏览器 cookie 或 cookie 提取来获取评论。
   - 明确告知用户：`Advisory comments were not included because GitHub does not expose them through the public API. Paste any relevant comments if you want them considered.`
   - 如果用户粘贴了评论，阅读并纳入考量。
   - 绝不假装已读取评论。
4. 独立调查：
   - 阅读公告文本、元数据、受影响的包、版本区间、CVSS、CWE、引用，以及关联的 issue/PR/commit。
   - 检查相关代码历史、发布版本、changelog、包元数据和标签。
   - 判断漏洞是否已被修复。
   - 如果已修复，确定已修补的版本和正确的受影响版本区间。
   - 不要未经核实就轻信报告者的分析。
5. 起草最终更新前，与用户讨论 CVSS：
   - 提出 CVSS 向量、分数和严重级别。
   - 简要解释有争议的指标。
   - 请用户确认或调整。
6. 询问是否需要为该公告向 GitHub 申请 CVE。
7. 在 `/tmp` 下起草一份可直接发布的公告 markdown 文件，例如 `/tmp/sa-<GHSA>.md`。同时包含公告的原始 CVSS 和提议/已确认的更新 CVSS。
8. 告诉用户：
   - 临时 markdown 文件的路径
   - 原始公告 URL
   - 他们可以编辑该文件，然后说 "update" 或提供路径

## 草稿 markdown 格式

草稿文件必须包含 YAML frontmatter，后接公告正文。包含更新 GitHub 和决定是否申请 CVE 所需的全部字段。

```markdown
---
advisory_url: https://github.com/<owner>/<repo>/security/advisories/<GHSA>
owner: <owner>
repo: <repo>
ghsa_id: <GHSA>
summary: <简短的公告摘要>
original_severity: <low|medium|high|critical|null>
original_cvss_vector: <原始 CVSS:3.1/... 或 null>
original_cvss_score: <原始数字或 null>
severity: <提议/已确认的 low|medium|high|critical>
cvss_vector: <提议/已确认的 CVSS:3.1/...>
cvss_score: <提议/已确认的数字>
cwe_ids:
  - CWE-...
vulnerabilities:
  - package:
      ecosystem: npm
      name: <package-name>
    vulnerable_version_range: <区间>
    patched_versions: <区间或版本>
request_cve: false
---

# <公告标题>

<漏洞及漏洞行为的简明描述。>

## Info

<根因和受影响组件的技术说明。聚焦防御者和维护者需要的事实。不要包含 PoC 步骤、利用载荷或可直接复制的利用字符串。>

## Impact

<谁能利用它、前提条件、对机密性/完整性/可用性的影响，以及现实的部署假设。>

## Affected versions

- Affected: `<区间>`
- Patched: `<版本或区间>`

## The solution

<描述修复方式和已修补的发布版本。>

## Recommendations

<升级指南和运维层面的缓解措施。>

## Workarounds

<临时规避方法（如有）；否则完全省略本章节>

## Timeline

- YYYY-MM-DD: 收到报告
- YYYY-MM-DD: 修复提交
- YYYY-MM-DD: 修复版本发布
- YYYY-MM-DD: 公告发布

## Credits

<报告者/研究者署名（如合适），否则省略本章节。>

## References

- <发布版本、commit、公告、文档的链接>
```

以 curl 公告的风格为灵感：章节清晰、语言直接、受影响/已修复版本的事实、建议、时间线和致谢。不要包含 PoC。

## 把草稿应用到 GitHub

当用户以 "update" 或类似方式批准、或提供 markdown 路径时：

1. 从磁盘重新读取 markdown 文件。绝不依赖内存中之前生成的内容。
2. 解析 YAML frontmatter 和正文。
3. 在临时文件中构建 JSON 载荷。字段映射如下：
   - `summary` 来自 frontmatter
   - `description` 来自 frontmatter 之后的 markdown 正文
   - `severity` 来自 frontmatter（如存在）
   - `cvss_vector_string` 来自 `cvss_vector`
   - `cwe_ids` 来自 frontmatter
   - `vulnerabilities` 来自 frontmatter
   - 不要发送 `original_severity`、`original_cvss_vector` 或 `original_cvss_score`；这些字段仅保留作审计上下文。
4. 用以下命令更新公告：
   ```sh
   gh api -X PATCH repos/<owner>/<repo>/security-advisories/<GHSA> --input /tmp/<payload>.json
   ```
5. 当且仅当 markdown frontmatter 中有 `request_cve: true` 时，用以下命令申请 CVE：
   ```sh
   gh api -X POST repos/<owner>/<repo>/security-advisories/<GHSA>/cve
   ```
   把 "already requested" 或 "already assigned" 视为非致命情况并报告。
6. 报告更新了什么：
   - 公告 URL
   - 摘要
   - 受影响区间
   - 已修补版本
   - 原始 CVSS 向量/分数/严重级别
   - 更新后的 CVSS 向量/分数/严重级别
   - 是否申请了 CVE

## 安全规则

- 最终公告正文中不要包含 PoC 材料。
- 除非 markdown 文件中有 `request_cve: true`，否则不要申请 CVE。
- 除非用户明确要求，否则不要发布公告或变更其状态。
- 不要通过浏览器会话或 cookie 获取公告评论。说明未包含评论，并邀请用户粘贴相关评论以便纳入考量。
- 如果受影响区间、已修补版本、CVSS 或 CVE 申请状态存在不确定性，先询问用户再应用。
