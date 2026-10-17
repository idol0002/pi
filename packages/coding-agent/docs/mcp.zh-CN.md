# MCP 服务器

Pi 通过 stdio 或 streamable HTTP 连接 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，并把它们的工具和资源提供给模型。

## 快速设置

添加本地 stdio 服务器，检查连接，然后启动 Pi：

```bash
pi mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
pi mcp list
pi
```

远程服务器：

```bash
pi mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
pi mcp list
```

这些命令默认添加用户级服务器。加 `--local` 或 `-l` 可写入项目配置：

```bash
pi mcp add -l tools --env API_KEY='${TOOLS_KEY}' -- uvx tools-mcp
```

在交互会话中使用 `/mcp` 检查连接、登录、重连、更改暴露方式、启用和禁用服务器。在会话之外添加、移除或修改服务器后运行 `/reload`。

## 配置服务器

Pi 从 `~/.pi/agent/mcp.json` 读取用户级服务器，从 `.pi/mcp.json` 读取项目服务器。项目配置只有在授予[项目信任](security.zh-CN.md#understand-project-trust)后才读取。同名时项目条目替换用户级条目。

不带 `command`、`url` 或 `type` 的项目条目只覆盖同名用户级服务器的 `enabled`、`exposure` 和 `toolExposure`，其余（包括 `env`、`headers` 和 `auth`）保持不变。例如，下面在一个项目中关闭用户级服务器：

```json
{
  "mcpServers": {
    "internal-tools": { "enabled": false }
  }
}
```

格式与其他 MCP 客户端一致：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

stdio 服务器使用 `command`、`args`、`env` 和 `cwd`。相对 `cwd` 相对会话目录解析。`command`、参数或 `cwd` 中的前导 `~/` 指向主目录。

HTTP 服务器使用 `url`、`headers` 和 `oauth`（见[用 OAuth 认证](#authenticate-with-oauth)）。不支持旧版 SSE 传输。

两种服务器都支持：

- `timeout`：每请求超时秒数（默认 60）。进度通知会重置它。
- `enabled: false`：保留条目但不连接。
- `exposure` 和 `toolExposure`：控制工具如何到达模型（见[控制工具暴露](#control-tool-exposure)）。
- `description`：一句话描述服务器提供什么。它把服务器列入系统提示词（见[控制工具暴露](#control-tool-exposure)），工具搜索按它对服务器工具排序，codemode 的 `describeNamespace()` 返回它。没有它时，服务器连接后使用服务器指令的第一行。

个人服务器和带凭据的服务器放在用户级文件。项目文件只用于项目所需的服务器，且只在受信任的项目中。

### 配置规则

- 服务器名只能包含字母、数字、`_` 和 `-`。工具命名为 `mcp__<server>__<tool>`，除字母、数字和 `_` 之外的字符都替换为 `_`；替换后名称冲突的服务器工具都会加哈希后缀。仅 `-` 和 `_` 不同的服务器名视为同一服务器：第二个会被拒绝，且 `mcp.json` 中的服务器覆盖已注册的。
- `type` 可选。`command` 选择 stdio，`url` 选择 streamable HTTP。存在时 `type` 必须是 `stdio`、`http` 或 `streamable-http`。
- `sse` 被拒绝。文档写明 SSE 端点的服务器通常也提供 streamable HTTP，通常在 `/mcp` 而不是 `/sse`。
- `command` 是单个可执行文件，`args` 包含其参数。它不是 shell 命令字符串。
- `env` 和 `headers` 值可以使用 `${GITHUB_TOKEN}` 这样的环境变量。也可以用 `!command` 运行命令，但命令必须构成整个值，例如 `"Authorization": "!echo Bearer $(gh auth token)"`。
- 无效条目会被报告并跳过，不阻止其他服务器连接。

`pi mcp add` 和 `pi mcp remove` 覆盖 shell 中的常见修改。选项见 [MCP 命令](cli.zh-CN.md#mcp-commands)。

### 检查或修改服务器

`/mcp` 列出已配置服务器及其状态、工具数、暴露方式和配置来源。需要注意的服务器排在前面。选择服务器可检查其工具和连接详情、重连、登录或登出、更改暴露方式、启用和禁用。

暴露方式和启用状态的更改保存到定义该服务器的文件，不替换无关内容。在受信任的项目中，"Enable in this project" 和 "Disable in this project" 为用户级服务器添加项目覆盖；之后对该服务器的更改保存到覆盖中。禁用的服务器仍会列出。交互 TUI 之外，`/mcp` 打印服务器状态；`/mcp login <server>`、`/mcp logout <server>` 和 `/mcp reconnect <server>` 直接执行这些操作。

shell 命令无需会话即可工作：`pi mcp add`、`pi mcp remove`、`pi mcp list`、`pi mcp login` 和 `pi mcp logout`。shell 命令不加载扩展。

### 诊断连接问题

运行 `pi mcp list` 连接每个启用的服务器并输出其状态、工具和错误。当条目无效或启用的服务器未连接时以状态 1 退出。`/mcp` 显示完整连接错误和失败 stdio 服务器的 stderr 尾部。

Pi 在启动后一次性报告配置错误、连接失败和所需的登录。服务器日志通知追加到 `~/.pi/agent/mcp.log`，格式为 `<time> [<server>] <level> <logger>: <message>`。文件超过 5 MB 后移到 `mcp.log.1`。

会话启动时 Pi 在后台连接每个启用的服务器。服务器连接后其工具才出现；`codemode` 描述不列出它们，因此服务器连接不改变它。第一条提示词最多只为带 `direct` 工具的服务器等待 10 秒，这些工具必须在其请求中声明。其他服务器在需要时等待：codemode 脚本等待它点名的服务器（`mcp__<server>`），当它调用 `searchTools()` 或读取 `ALL_TOOLS` 时等待全部；`tool_search` 和资源工具也等待全部。HTTP 网络错误和瞬态状态（408、429 和 5xx）重试两次。断开的连接显示为 disconnected，并在下次调用时重连。当服务器宣布工具列表变化时，新工具被添加，撤回的工具变得不可达。

停止 stdio 服务器会关闭其 stdin、发送 SIGTERM，然后对其进程组发送 SIGKILL。这也会停止通过 `npx` 或 `uvx` 等包装器启动的服务器。

## 从其他客户端迁移配置

把转换后的条目移到 `mcp.json` 的 `mcpServers` 下，然后运行 `pi mcp list` 验证。

| 客户端 | 转换方式 |
|---|---|
| Claude Desktop、Claude Code 或 Cursor | 复制现有 `mcpServers` 条目。 |
| VS Code | 把条目从顶层 `servers` 对象移出，并把 `${input:...}` 提示替换为 `${NAME}` 环境变量。 |
| Codex | 把 `[mcp_servers.<name>]` TOML 字段（如 `command`、`args`、`env`、`url`）转换为 JSON。 |
| OpenCode | 把 `"type": "local"` 转为 stdio 条目，把其 `command` 数组拆为 `command` 和 `args`，把 `environment` 改名为 `env`，把 `{env:NAME}` 替换为 `${NAME}`。把 `"type": "remote"` 转为 URL 条目。 |

## 用 OAuth 认证

使用 OAuth 的远程服务器（如 Sentry）不需要在 `mcp.json` 中放凭据：

```json
{
  "mcpServers": {
    "sentry": { "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

当服务器拒绝未认证连接时，`/mcp` 显示需要登录。选择 "Sign in"、运行 `/mcp login sentry` 或 `pi mcp login sentry`。Pi 打开授权页面并等待批准。如果浏览器在另一台机器上（如通过 SSH），把其重定向 URL 粘贴到登录界面。运行中的会话在下一轮使用新凭据。

Pi 向授权服务器注册自己，把令牌存入 `~/.pi/agent/mcp-auth.json`，并在令牌过期或服务器拒绝时刷新访问令牌。如果服务器之后请求额外 scope，Pi 会要求重新登录。登出会删除存储的凭据。

凭据属于服务器名和 URL。不同名称下相同 URL 的服务器（如每个账户一个）分别登录；不同 `mcp.json` 中相同名称和 URL 的服务器共享一次登录。

OAuth 适用于没有 `Authorization` 头的 HTTP 服务器。对不支持动态客户端注册的服务器，配置一个已注册的客户端：

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "clientId": "my-client", "clientSecret": "${EXAMPLE_SECRET}", "callbackPort": 8765 }
    }
  }
}
```

重定向 URI 必须与注册的 URI 匹配。`callbackPort` 使用 `http://127.0.0.1:<port>/callback`。要用其他 URI，设置 `callbackUrl`；它必须在 `localhost`、`127.0.0.1` 或 `[::1]` 上使用 HTTP。Pi 按原样发送。当 `callbackUrl` 省略端口时，Pi 使用 `callbackPort` 或空闲端口并将其加入 URI，正如 RFC 8252 对回环重定向所允许的。`clientSecret` 可选，可以使用环境变量或命令。

对不公布所需 scope 的服务器，把 `scope` 设为空格分隔的列表。否则 Pi 请求公布的 scope。之后的 scope 请求会附加到配置值上。

Pi 以 `pi` 注册。有些服务器只接受来自已知客户端的注册。设置 `clientName` 发送其他名称：

```json
{
  "mcpServers": {
    "figma": { "url": "https://mcp.figma.com/mcp", "oauth": { "clientName": "Claude Code" } }
  }
}
```

该名称只在 Pi 注册客户端时发送。要以新名称重新注册，先登出。

一些授权服务器通过 Client ID Metadata Document URL 接受客户端，而不是注册它们。设置 `clientRegistration` 为 `cimd` 可以以 pi.dev 上的 Pi 文档标识自己，而不是注册：

```json
{
  "mcpServers": {
    "example": { "url": "https://mcp.example.com/mcp", "oauth": { "clientRegistration": "cimd" } }
  }
}
```

客户端 ID 是 `https://pi.dev/oauth/client.json`，重定向 URI 是 `http://127.0.0.1:<port>/callback`。如果授权服务器在授权响应中不发送 `iss` 参数（RFC 9207），Pi 改用该 MCP 服务器专属的文档和重定向路径：`https://pi.dev/oauth/<id>/client.json` 和 `http://127.0.0.1:<port>/callback/<id>`。授权服务器必须公布 Client ID Metadata Document 支持和公共客户端，否则登录失败。`cimd` 不能与 `clientId` 或 `clientName` 组合，`callbackUrl` 必须使用 `localhost` 或 `127.0.0.1` 且路径为 `/callback`。

Pi 通过服务器的受保护资源元数据（RFC 9728）找到授权服务器，并检查授权服务器元数据是否指明预期的 issuer（RFC 8414）。有些服务器公布了错误的授权服务器或不公布，导致登录打开不存在的页面。把 `authServerMetadataUrl` 设为正确授权服务器的元数据文档：

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "authServerMetadataUrl": "https://example.okta.com/.well-known/openid-configuration" }
    }
  }
}
```

Pi 使用该文档而不是发现流程，并按配置信任它，因此只指向你信任的文档。URL 必须使用 HTTPS，`localhost`、`127.0.0.1` 或 `[::1]` 除外。

## 控制工具暴露

每个服务器工具注册为 `mcp__<server>__<tool>`。服务器的 `exposure` 决定模型如何访问它：

| 暴露方式 | 行为 | 典型用途 |
|---|---|---|
| `codemode`（默认） | 可从 [`codemode`](cli.zh-CN.md#tools) 脚本调用，但既不向模型声明，也不列在 codemode 描述中。脚本用 `searchTools()`、`describeTool()` 或 `ALL_TOOLS` 找工具。 | 通用 MCP 服务器，尤其当脚本应组合或过滤调用时。 |
| `deferred` | 在 [`tool_search`](cli.zh-CN.md#tools) 为下一次模型调用加载匹配之前不声明。 | 大型服务器，其工具应在发现后直接调用。 |
| `direct` | 像内置工具一样向模型声明，也可从 codemode 调用。 | 小型、频繁使用的工具集。 |
| `hidden` | 已注册但不可达。 | 应保持不可用的服务器或工具。 |

`codemode-deferred` 作为 `codemode` 的别名被接受。

带 `codemode` 或 `deferred` 工具的服务器列在系统提示词的 `mcp_servers` 部分，包含其工具的访问方式和配置 `description` 的一行（连接后则用服务器指令）。Pi 在提示词开始时、等待带 `direct` 工具的服务器之后更新该部分。当它发生变化时（例如服务器连接且其摘要可用），Pi 把新部分追加到对话中而不是更改工具声明，使较早的消息保持缓存。`describeNamespace()` 和 `searchTools()` 的 `namespace` 选项接受 `mcp__dev-radius`、`mcp__dev_radius`、`dev-radius` 或 `dev_radius`。

带 `codemode` 暴露方式的服务器连接时，Pi 激活 `codemode`。带 `deferred` 暴露方式的服务器则激活 `tool_search`。要让模型不搜索就看到工具，用 `toolExposure` 给它 `direct` 暴露方式。

`toolExposure` 为单个工具覆盖服务器暴露方式。键是精确的服务器工具名或模式，`*` 匹配任意字符。精确名优先于模式；模式之间第一个匹配生效。`hidden` 暴露方式的服务器只能暴露被选中的工具：

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "exposure": "deferred",
      "toolExposure": {
        "search_code": "direct",
        "get_*": "codemode",
        "delete_*": "hidden"
      }
    }
  }
}
```

`pi mcp list` 标记暴露方式与其服务器不同的工具。`/mcp` 的 Tools 视图也显示生效的暴露方式。

`codemode` 或 `deferred` 暴露方式的工具可以通过两种间接机制访问：codemode 脚本可以调用它们，`tool_search` 可以加载它们。Codemode 调用不依赖活动工具集，因此在 `/tree`、恢复和分叉后仍然可用。`tool_search` 加载的工具记录在转录中，在该分支上保持声明状态。

`--tools` 不会移除 MCP 工具，除非其条目以 `mcp__` 开头；`pi --tools read,codemode,'mcp__radius__*'` 只保留 `radius` 的工具。`--exclude-tools` 接受相同模式，`--no-mcp` 单次运行禁用 MCP（见[工具](cli.zh-CN.md#mcp-tools)）。

要在没有 MCP 服务器的情况下保持 `codemode` 激活，在[设置](settings.zh-CN.md#tools)中加 `"defaultTools": ["+codemode"]`。要阻止 codemode 自动激活，在 `mcpServers` 旁设置 `"autoEnableCodemode": false`。项目值覆盖用户级值。当 `codemode` 和 `tool_search` 都未激活且非 direct 工具无法调用时，Pi 警告一次。

超过 20 KB 的文本结果到达模型时，中间内容被移除，留下 `…N chars truncated…` 标记。全文保存到结果中指名的临时文件。Codemode 脚本收到完整结果，可以在向模型返回输出前缩减它。

Codemode 脚本收到完整的 MCP `CallToolResult`，包括 `content`、`structuredContent` 和 `isError`。`isError` 的结果在脚本内正常解析，但对直接调用会报告为错误。`image(result.content[0])` 转发图像块。服务器指令不属于任何工具描述；脚本用 `describeNamespace("mcp__<server>")` 读取它们，它同时返回服务器的工具名。

## 使用资源

当已连接的服务器提供[资源](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)时，Pi 添加 Codex 和 OpenCode 使用的资源工具：

- `list_mcp_resources` 以 JSON 列出资源：`{ server?, resources: [{ server, uri, name, ... }], nextCursor? }`。带 `server` 时列出一页；`cursor` 继续下一页。不带 `server` 时列出所有服务器的所有资源。
- `list_mcp_resource_templates` 列出服务器未直接列出的资源的 URI 模板。
- `read_mcp_resource` 按 `server` 和 `uri` 读取资源。文本以文本到达模型，图像以图像到达。其他二进制资源保存到临时文件，模型收到路径。脚本收到 `{ server, uri, contents }`。

这些工具到达每个启用、非隐藏且有资源的服务器。它们的暴露方式是这些服务器中最宽的：`direct`，其次 `codemode` 或 `deferred`。工具结果中的资源链接标识 `read_mcp_resource` 和服务器。

MCP Apps 的资源（以 `ui://` URI 或 `text/html;profile=mcp-app` 标识）被省略，因为 Pi 不渲染它们。资源图标也被省略。

读取和列出资源在瞬态 HTTP 错误（408、429 或 5xx）后重试一次。工具调用不重试，因为服务器可能已经执行了它们。

## 权限

每个 MCP 调用都经过 Pi 的工具管道。因此扩展的 `tool_call` 和 `tool_result` 处理器（包括权限门）适用于 MCP 工具。从 codemode 脚本发起的调用以 codemode 调用 ID 作为 `parentToolCallId`。

`pi.getAllTools()` 报告每个服务器声明的注解：`readOnlyHint`、`destructiveHint`、`idempotentHint` 和 `openWorldHint`。权限扩展可以用这些提示决定哪些调用需要确认（见[工具暴露](extensions.zh-CN.md#tool-exposure)）。资源工具被标记为只读。

## 扩展与 SDK

### 从扩展添加服务器

扩展可以用 `pi.registerMcpServer(name, config)` 为当前会话添加服务器，形状与 `mcpServers` 条目相同（见[扩展中的 MCP 服务器](extensions.zh-CN.md#mcp-servers)）。已注册服务器像已配置服务器一样连接，并在 `/mcp` 中以扩展为来源显示。

启用状态或暴露方式的更改只作用于当前会话。同名文件配置的服务器优先，`/mcp` 列出被覆盖的注册。`pi mcp` shell 命令不加载扩展，只看到文件配置的服务器。

### 替换内置 MCP 支持

注册了 `/mcp` 的已安装扩展（如 `pi-mcp-adapter`）会替换会话的内置 MCP 支持。此后 Pi 不读取 `mcp.json`，也不在会话中连接其服务器，`/mcp` 属于该扩展。移除该扩展可恢复内置行为。要在没有替代的情况下禁用内置 MCP 支持，在 `pi config` 的 Built-in 下禁用 `mcp`，或在[设置](settings.zh-CN.md#resources)中设置 `"extensions": ["-builtin:mcp"]`。`--no-mcp` 单次运行禁用它。

注册 `codemode` 或 `tool_search` 的扩展同样以同名替换内置工具。只有当替换者声明了 [`reachesTools`](extensions.zh-CN.md#tool-exposure) 时，Pi 才为 MCP 服务器激活替换者，并等待其调用所需的服务器。shell 级 `pi mcp` 命令始终使用内置实现。

### 从 SDK 使用 MCP

SDK 会话不加载内置扩展。把 MCP 扩展、`codemode` 服务器的 codemode 扩展和 `deferred` 服务器的工具搜索扩展加入资源加载器。见 [Codemode 与 MCP](sdk.zh-CN.md#codemode-mcp)。
