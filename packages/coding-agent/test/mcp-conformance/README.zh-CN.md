# MCP 客户端一致性

对 pi 的 MCP 客户端运行官方的 [MCP 一致性套件](https://github.com/modelcontextprotocol/conformance)，并把结果与已提交的基线比较。

```bash
npm run test:mcp-conformance
```

CI 在 `.github/workflows/ci.yml` 的 `mcp-conformance` 任务中运行它。第一次运行需要网络访问，以便用 `npx` 拉取固定的套件（`@modelcontextprotocol/conformance@0.2.0-alpha.11`）。安装脚本被禁用。需要 POSIX shell。

## 工作方式

对 pi 协商的每个协议版本（`2025-03-26`、`2025-06-18`、`2025-11-25`），`run.ts` 列出套件的客户端场景并逐个运行。套件启动一个场景服务器，并对它运行 `client.ts`。

`client.ts` 使用 pi 在 `mcp.json` 中对 HTTP 服务器运行的代码：`McpServerConnection` 负责连接和调用工具，`signInMcpServer` 运行 `/mcp` 启动的 OAuth 登录。一个模拟浏览器获取授权 URL 并把重定向交给 pi 的回环回调服务器。当服务器再次要求登录（例如需要更多 scope）时，模拟用户再次登录，最多三次。

套件报告的每一项检查都与 `baseline.json` 比较。额外的 `pi-client` 检查记录 `client.ts` 是否完成了场景。有些场景期望客户端放弃（`auth/scope-retry-limit`），所以它也像其他检查一样进入基线。

以下情况运行失败：

- 基线中通过的检查失败或缺失，
- 基线未列为失败的检查失败，
- 基线中的场景没有运行。

开始通过的检查会被报告；更新基线以锁定它们。

## 选项

```bash
node packages/coding-agent/test/mcp-conformance/run.ts --mode 2025-11-25 --scenario auth/scope-step-up --verbose
node packages/coding-agent/test/mcp-conformance/run.ts --update-baseline
```

- `--mode`、`--scenario`：运行子集（可重复）。
- `--verbose`：打印套件的输出，包括每项检查和客户端日志。
- `--keep-results`：保留套件的 `checks.json` 和客户端输出。
- `--update-baseline`：把一次完整运行的结果写入 `baseline.json`。审阅 diff；不要为了掩盖回归而重新生成。

## 已知失败

- `elicitation-sep1034-client-defaults`：pi 不支持 elicitation。
- `auth/basic-cimd`：pi 动态注册客户端，而不是使用 Client ID Metadata Document。
- `auth/scope-retry-limit`：`pi-client` 按设计失败；服务器从不接受所授予的 scope。

2026-07-28 未覆盖：它是一个 pi 未实现的无状态协议。
