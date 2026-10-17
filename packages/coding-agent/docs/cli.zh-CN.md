<a id="cli-and-modes-reference"></a>

# 命令行

本页记录 Pi 内置的命令行命令与选项。运行 `pi --help` 或在命令后附加 `--help` 可查看你所安装版本的确切接口。顶层帮助还包括由已加载扩展注册的选项。

```sh
pi [options] [--] [@files...] [messages...]
pi install <source> [options]
pi remove <source> [options]
pi uninstall <source> [options]
pi update [target] [options]
pi list
pi config [options]
pi auth <check|print-api-key|print-bearer-token> [options]
pi mcp <list|login|logout> [options]
```

<a id="modes"></a>

## 调用与输出

```sh
pi
pi --print "Summarize this repository"
git diff | pi --print "Review this change"
pi --mode json "Inspect this repository" > events.jsonl
```

当 stdin 和 stdout 都是终端时，除非 `--print`、`--mode json` 或 `--mode rpc` 选择了其他界面，Pi 会打开终端 UI。当任一流被重定向且未选择 JSON 或 RPC 模式时，Pi 使用 print 模式。关于在交互、print、JSON、RPC 和 SDK 集成之间做选择，见 [CLI 集成](cli-integration.zh-CN.md)。

| 输入 | 行为 |
|---|---|
| `message` | 提供初始提示词 |
| `@path` | 在第一条提示词中包含一个文本文件或图片 |
| 管道 stdin | 将其内容前置到第一条提示词 |
| `--` | 停止选项解析，使提示词可以以 `-` 开头 |

Pi 从当前工作目录解析 `@path`。工作目录还决定项目配置、资源发现和会话分组。

`--print` 控制 Pi 是否只运行一次就退出。`--mode` 选择输出界面。当 stdin 和 stdout 是终端时，`--mode text` 不会强制一次性执行；要那种行为请用 `--print`。

| 选项 | 行为 |
|---|---|
| `-p`, `--print` | 运行提供的提示词，把最终的助手文本写到 stdout，然后退出 |
| `--mode text` | 选择文本输出；当 stdin 和 stdout 是终端时仍打开终端 UI |
| `--mode json` | 运行提供的提示词，把 JSONL 事件写到 stdout，然后退出 |
| `--mode rpc` | 从 stdin 读取 JSONL 命令，把响应和事件写到 stdout，直到关闭 |
| `--export <input> [output]` | 把会话文件导出为 HTML 并退出；省略 `output` 时自动推导目标路径 |

RPC 模式拒绝 `@file` 参数。JSON 和 RPC 模式将 stdout 保留给协议记录。见 [JSON 事件流](json.zh-CN.md)和 [RPC 协议](rpc.zh-CN.md)。

<a id="model-options"></a>

## 模型

```sh
pi --model sonnet:high
```

模型选择见[选择模型](models.zh-CN.md)，凭据见[提供商](providers.zh-CN.md)。

- `--provider <name>`<br>
  将 `--model` 查找限制到单个提供商。需要同时提供 `--model`。
- `--model <pattern>`<br>
  按精确 ID 或模糊 ID/名称匹配选择。接受 `provider/id` 和可选的 `:<thinking>` 后缀。若多个提供商匹配，Pi 优先选择有凭据的那个，否则要求提供 `--provider`。
- `--api-key <key>`<br>
  使用非持久的 API 密钥覆盖。需要通过 `--model` 或 `--models` 选定模型。它不会在提供同一模型的多个提供商之间做选择。
- `--thinking <level>`<br>
  设置 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。它会覆盖 `--model` 的后缀，并被限制在该模型支持的能力范围内。
- `--models <patterns>`<br>
  设置逗号分隔的范围，用于启动和循环切换。接受精确 ID、模糊匹配、不区分大小写的 glob 以及可选的 `:<thinking>` 后缀。被多个提供商提供的模型会为每个提供商各添加一次，并给出警告。
- `--list-models [search]`<br>
  列出可用模型，可选按模糊搜索过滤，然后退出。

<a id="session-options"></a>

## 会话

```sh
pi --continue
```

恢复、分叉、命名和存储会话见[会话与上下文](sessions.zh-CN.md)。

- `-c`, `--continue`<br>
  继续当前项目最近的会话。
- `-r`, `--resume`<br>
  打开会话选择器。
- `--session <path|id>`<br>
  按文件路径、精确 ID 或部分 ID 打开。Pi 先搜索当前项目，对跨项目匹配提供分叉选项。
- `--session-id <id>`<br>
  打开精确的项目会话 ID，不存在则创建。ID 接受字母、数字、`.`、`_` 和 `-`。
- `--fork <path|id>`<br>
  把现有会话分叉为当前项目的新会话。
- `--session-dir <dir>`<br>
  覆盖存储与查找目录。优先级高于 `PI_CODING_AGENT_SESSION_DIR` 和 `sessionDir` 设置。
- `--no-session`<br>
  使用不持久化的内存会话。
- `-n`, `--name <name>`<br>
  设置会话显示名称。

约束：

- 会话 ID 必须以字母或数字开头和结尾。
- `--fork` 不能与 `--session`、`--continue`、`--resume` 或 `--no-session` 组合。
- `--session-id` 不能与 `--session`、`--continue` 或 `--resume` 组合。与 `--fork` 组合可指定新 ID。

<a id="tool-options"></a>

## 工具

```sh
pi --tools read,grep,find,ls --print "Review this project"
```

配置默认工具选择见[设置](settings.zh-CN.md#tools)。

- `-t`, `--tools <list>`<br>
  用逗号分隔的内置、扩展或自定义工具白名单替换默认选择。条目是工具名或模式，`*` 匹配任意字符。除非某条目以 `mcp__` 开头，MCP 工具会保留（见 [MCP 工具](#mcp-tools)）。仅包含 `+name` 和 `-name` 条目的列表不是白名单；它会修改默认选择。
- `-xt`, `--exclude-tools <list>`<br>
  在所有其他选择选项之后禁用逗号分隔的工具名或模式，包括 MCP 工具。
- `-nbt`, `--no-builtin-tools`<br>
  禁用默认内置工具，同时保留扩展和自定义工具。
- `-nt`, `--no-tools`<br>
  启动时禁用所有内置、扩展、自定义和 MCP 工具。

默认启用的工具是 `read`、`bash`、`edit` 和 `write`，除非 `defaultTools` 改变了它们。`--tools` 使用普通名称时会替换整个选择，所以要写出你想要的每个工具。与 `defaultTools` 一样，它也接受仅含 `+name` 和 `-name` 条目的列表，向默认选择添加或移除工具：`pi --tools +codemode,-write` 保留其他默认工具、启用 `codemode`、禁用 `write`。这些条目使用精确工具名，不接受 `*` 模式；按模式禁用工具请用 `--exclude-tools`。普通名称与 `+name`/`-name` 条目不能混用。`/reload` 会启用新加入 `defaultTools` 的工具，但用 `-name` 移除的工具保持移除状态。

<a id="mcp-tools"></a>

`--tools` 选择向模型声明的工具。它不会移除 MCP 工具，MCP 工具的可用范围由其[暴露方式](mcp.zh-CN.md#control-tool-exposure)决定：`pi --tools read,codemode` 仍保持所有 MCP 工具可从 codemode 脚本调用。没有被任何条目命名或匹配到的 MCP 工具，无论其暴露方式如何，都不会被直接声明；只有 `tool_search`（如果列在清单中）可以加载它。一旦某条目以 `mcp__` 开头，`--tools` 也会过滤 MCP 工具，因此下面这条只保留 `radius` 服务器的工具：

```sh
pi --tools read,bash,codemode,'mcp__radius__*'
```

MCP 资源工具（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）也算作 MCP 工具。要移除 MCP 工具，使用 `--exclude-tools 'mcp__*'` 或 [`--no-mcp`](#resource-options)。

| 内置工具 | 用途 |
|---|---|
| `read` | 读取文本文件和受支持的图片 |
| `bash` | 运行 shell 命令 |
| `powershell` | 在 Windows 上运行 PowerShell 命令 |
| `edit` | 对现有文件应用精确文本替换 |
| `write` | 创建或覆盖文件 |
| `grep` | 搜索文件内容 |
| `find` | 用 glob 模式查找路径 |
| `ls` | 列出目录内容 |

内置扩展额外提供两个工具。它们默认关闭；当 MCP 服务器需要时，MCP 扩展会打开它们（见 [MCP](mcp.zh-CN.md#exposure)）。要自己启用，在 `--tools` 或 `defaultTools` 中写明名称。

| 内置扩展 | 用途 |
|---|---|
| `codemode` | 运行调用其他工具的 JavaScript，例如用 `Promise.allSettled` 并行调用；只有脚本的输出会到达模型 |
| `tool_search` | 搜索未向模型声明的工具（`codemode` 和 `deferred` 暴露方式，例如 MCP 工具），并为下一次调用声明匹配结果 |

### 启用 codemode

要在每个会话中启用 `codemode`，把它加入 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json` 的默认工具：

```json
{
  "defaultTools": ["+codemode"]
}
```

这会保留 `read`、`bash`、`edit` 和 `write`，并添加 `codemode`。单次调用可用 `--tools` 添加：

```sh
pi --tools +codemode
```

没有 MCP 时 codemode 也很有用：脚本可以并行运行多个工具调用，在输出到达模型前过滤大输出，通过 `models.classify()` 调用分类器模型（如 TypeSafe 的 Jev，见[分类器模型](models.zh-CN.md#use-classifier-models)），以及通过 `models.generateImages()` 生成图片（见[图像模型](models.zh-CN.md#use-image-models)）。

### codemode 的工作方式

脚本在 QuickJS 沙箱中运行，通过 `tools.<name>(args)` 调用其他工具。[Codemode](codemode.zh-CN.md) 描述了脚本 API、工具的列出与查找方式、`store()` 和 `models` 全局对象以及限制。

### 工具搜索

`tool_search` 默认关闭；用 `"defaultTools": ["+tool_search"]` 或 `--tools` 启用。它对尚未声明的工具使用与 `searchTools()` 相同的排序，并为下一次模型调用声明匹配结果。已加载的工具会像其他工具变更一样记录在会话中，因此在该分支上保持已声明状态。

<a id="resource-options"></a>

## 资源

```sh
pi --extension ./review.ts
```

常规目录与项目信任见[配置](configuration.zh-CN.md)，配置的路径见[设置](settings.zh-CN.md#resources)，包来源见 [Pi 包](packages.zh-CN.md)。

- `-e`, `--extension <path>`<br>
  加载扩展文件或目录，或内置扩展如 `builtin:mcp`，可重复使用。
- `-ne`, `--no-extensions`<br>
  禁用发现的、配置的和内置的扩展。显式 `-e` 路径仍会加载，因此 `pi -ne -e builtin:mcp` 只保留内置 MCP 支持。
- `--no-mcp`<br>
  本次运行禁用内置 MCP 支持：不连接任何服务器，没有 MCP 工具和 `/mcp`。它不影响替换了内置 MCP 支持的扩展。
- `--skill <path>`<br>
  加载技能文件或目录，可重复使用。
- `-ns`, `--no-skills`<br>
  禁用发现的和配置的技能。显式 `--skill` 路径仍会加载。
- `--prompt-template <path>`<br>
  加载提示词模板文件或目录，可重复使用。
- `-np`, `--no-prompt-templates`<br>
  禁用发现的和配置的模板。显式 `--prompt-template` 路径仍会加载。
- `--theme <path>`<br>
  加载主题文件或目录，可重复使用。
- `--use-theme <name[/name]>`<br>
  为本次运行选择初始交互主题。
- `--no-themes`<br>
  禁用发现的和配置的主题。显式 `--theme` 路径仍会加载。
- `-nc`, `--no-context-files`<br>
  禁用 `AGENTS.md` 和 `CLAUDE.md` 发现。

资源路径只作用于当前进程。相对路径从当前工作目录解析。

<a id="prompt-and-display-options"></a>

## 提示词与进程

```sh
pi --append-system-prompt ./instructions.md
```

保存的配置见[配置](configuration.zh-CN.md)，项目信任见[安全](security.zh-CN.md#understand-project-trust)，进程控制见[环境变量](environment-variables.zh-CN.md)。

- `--system-prompt <text|path>`<br>
  用文本或现有文件的内容替换默认系统提示词。
- `--append-system-prompt <text|path>`<br>
  把文本或现有文件追加到系统提示词，可重复使用。
- `--tui-mode <mode>`<br>
  使用 `fullscreen`（默认）或 `regular` 终端模式。
- `--verbose`<br>
  显示详细的交互式启动信息，覆盖 `quietStartup`。
- `-a`, `--approve`<br>
  对本进程信任项目本地配置和资源。
- `-na`, `--no-approve`<br>
  对本进程忽略受信任门控的项目本地配置和资源。
- `--offline`<br>
  禁用自动网络活动，包括模型目录刷新。等价于 `PI_OFFLINE=1`。
- `-h`, `--help`<br>
  显示帮助（包括已加载扩展注册的标志），然后退出。
- `-v`, `--version`<br>
  显示 Pi 版本，然后退出。

扩展可以注册额外的长选项。未知的短选项会被拒绝。

## 包命令

```sh
pi install npm:@scope/package
```

来源格式、过滤、安装和项目范围见 [Pi 包](packages.zh-CN.md)。

### 常见任务

| 任务 | 命令 |
|---|---|
| 安装包 | `pi install <source>` |
| 列出已配置的包 | `pi list` |
| 移除包及其设置条目 | `pi remove <source>` |
| 配置加载哪些包资源 | `pi config` |

给 `install`、`remove`、`uninstall` 或 `config` 加 `--local` 或 `-l` 可使用项目设置而非全局设置。

### 更新 Pi 或包

不带目标运行 `pi update` 会更新 Pi 本身。

| 任务 | 命令 |
|---|---|
| 更新 Pi | `pi update` |
| 更新所有已安装的包 | `pi update --extensions` |
| 更新一个已安装的包 | `pi update <source>` |
| 刷新模型目录 | `pi update --models` |
| 更新 Pi 和所有已安装的包 | `pi update --all` |

当所选更新包含 Pi 时，加 `--force` 可重装 Pi。

当 Pi 由其他包管理器提供（如 Nix）时，`pi update` 无法更新 Pi。请用该包管理器更新，例如 `nix profile upgrade pi`。包和模型目录的更新仍然可用。

### 别名与命令选项

- `pi uninstall <source>` 是 `pi remove <source>` 的别名。
- `pi update --self`、`pi update self` 和 `pi update pi` 是 `pi update` 的别名。
- `pi update --extension <source>` 是 `pi update <source>` 的别名。
- `-a`, `--approve` 对单条命令信任项目本地文件。`-na`, `--no-approve` 忽略受信任门控的项目本地文件。
- 在命令后附加 `-h` 或 `--help` 可查看其确切用法和选项约束。

## 凭据命令

```sh
pi auth check --provider openai --json
```

认证命令需要 `--provider <provider>` 或 `--model <model>`。支持的方法见[提供商](providers.zh-CN.md)。

| 命令 | 描述 |
|---|---|
| `pi auth check` | 输出 `ready`、`not_ready` 或 `invalid`；分别以状态 `0`、`1` 或 `2` 退出 |
| `pi auth print-api-key` | 输出解析后的 API 密钥 |
| `pi auth print-bearer-token` | 输出解析后的 OAuth bearer 令牌 |

| 选项 | 适用于 | 描述 |
|---|---|---|
| `--provider <provider>` | 全部 | 为某个提供商解析凭据 |
| `--model <model>` | 全部 | 从某个模型解析凭据；可与 `--provider` 组合 |
| `--json` | `auth check` | 以 JSON 输出结构化结果 |
| `--credentials` | `auth check` | 就绪时输出解析后的凭据 |
| `--no-refresh` | `auth check` | 不刷新过期的 OAuth 凭据；默认会刷新 |
| `--min-expiry <duration>` | `print-bearer-token` | 用 `ms`、`s`、`m` 或 `h` 要求剩余令牌有效期，如 `30m` |

凭据打印命令会把密钥写到 stdout。

## MCP 命令

这些命令在会话之外工作，因此 agent 可以通过 `bash` 运行它们。见 [MCP 服务器](mcp.zh-CN.md)。

| 命令 | 描述 |
|---|---|
| `pi mcp add <server> [options] -- <command> [args...]` | 在 `mcp.json` 中添加或替换 stdio 服务器；`--env KEY=VALUE`（可重复）和 `--cwd <dir>` 设置其环境和工作目录。命令之后的参数会传给它 |
| `pi mcp add <server> [options] --url <url>` | 添加或替换 streamable HTTP 服务器；`--header KEY=VALUE`（可重复）、`--bearer-token-env-var <NAME>`（发送 `Authorization: Bearer ${NAME}`）、`--oauth-client-id`、`--oauth-client-secret`、`--oauth-callback-port` 和 `--oauth-client-name` 配置认证 |
| `pi mcp remove <server>` | 从 `mcp.json` 移除服务器；已存储的 OAuth 凭据会保留 |
| `pi mcp list [--json]` | 连接每个启用的服务器并输出其状态、工具和错误；当配置条目无效或启用的服务器未连接时以 `1` 退出 |
| `pi mcp login <server> [--timeout <seconds>]` | 登录 OAuth 服务器：打开授权页面并等待浏览器；终端也接受粘贴的重定向 URL。`--timeout` 限制整个登录过程，包括对授权服务器的请求（默认 300 秒） |
| `pi mcp logout <server>` | 删除服务器已存储的 OAuth 凭据 |

`add` 和 `remove` 修改 `~/.pi/agent/mcp.json`，使用 `--local`（`-l`）时修改当前目录的 `.pi/mcp.json`。`add` 还接受 `--exposure <mode>`（见[暴露方式](mcp.zh-CN.md#exposure)）和 `--description <text>`，且不会连接；运行 `pi mcp list` 检查服务器。

项目的 `.pi/mcp.json` 只对已受信任的项目读取。
