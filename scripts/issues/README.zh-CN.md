# Issue 分诊

用于每日 issue 审查的本地工具。按以下顺序运行：

1. **同步。**用 `gh api` 把仓库的 issue 保留一份本地副本到 `data/corpus.json`。首次运行拉取最近 120 天；之后每 20 分钟同步一次，只拉取有变化的部分。
2. **分诊。**每个新 issue 都会有一个独立的 [pi-durable](../../packages/durable/README.md) agent 会话。该 agent：
   - 在本地副本中搜索重复和相关 issue（`search_issues`、`read_issue`）
   - 从 `categories/*.md` 中选择一个类别
   - 写一句话摘要和信号
   - 建议 p0、p1 或 none
3. **审查。**Web UI 列出收件箱：收件箱启动以来创建的每个 issue，按 agent 的建议分组。你设置 p0、p1 或 none，并在需要时修正类别。每个 issue 都链接到 GitHub。

决策只保存在本地。任何内容都不会写入 GitHub。

所有状态都在 `data/` 目录（已 gitignore）：

- `corpus.json`：issue 的本地副本
- `triage.sqlite`：pi-durable 存储，每个已分诊 issue 一个会话，包含分诊结果和你在 `triage.state` 文档中的决策
- `token`：UI 访问令牌

重启服务器会恢复进行中的分诊运行。

## 文件

- `categories/*.md`：每个类别一个文件。文件名即类别标签。frontmatter 中的 `owner` 是拥有该类别的 GitHub 用户。
- `prompt.md`：给 agent 的分诊流程和优先级指南。
- `main.ts`：同步循环和 HTTP 服务器。
- `triage.ts`：持久化分诊 agent。
- `github.ts`：issue 的本地副本和关键词搜索。
- `ui.html`：Web UI。
- `source-hooks.mjs`、`register.mjs`：直接从源码运行 workspace 包，无需构建。

## 运行

```bash
./scripts/issues/run.sh   # http://127.0.0.1:7788
```

打开一次 `http://127.0.0.1:7788/?t=<token>`，token 来自 `scripts/issues/data/token`。服务器随后会设置 cookie，之后的访问不再需要 token。

agent 通过 `~/.pi/agent/auth.json` 认证，与 pi 使用的凭据相同。

| 变量 | 默认值 | |
|---|---|---|
| `TRIAGE_MODEL` | `openai-codex/gpt-5.6-sol` | `provider/model`。支持的提供商：`openai-codex`、`anthropic`。 |
| `TRIAGE_THINKING` | `medium` | 思考级别 |
| `TRIAGE_CONCURRENCY` | `4` | 并行分诊运行数 |
| `TRIAGE_INBOX_DAYS` | `2` | 首次运行时，收件箱从多少天前开始 |
| `TRIAGE_CORPUS_DAYS` | `120` | 首次运行时，拉取最近多少天内更新的 issue |
| `TRIAGE_SYNC_MINUTES` | `20` | 同步间隔 |
| `TRIAGE_PORT` | `7788` | 本地端口 |
| `TRIAGE_SOCKET` | | 改为监听此 unix socket 而非端口，用于反向代理 |
| `TRIAGE_DATA` | `scripts/issues/data` | 状态目录 |

## UI 按键

- `j`/`k`：在 issue 之间移动
- `0`、`1`、`n`：设置 p0、p1、none
- `o`：在 GitHub 上打开该 issue
