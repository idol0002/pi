# 扩展

扩展是给 Pi 添加可执行行为的 TypeScript 模块。当工作流需要工具、命令、事件处理器、模型提供商、会话状态或终端 UI 而不仅是指令时使用它。

扩展在 Pi 进程内运行，拥有相同的操作系统权限。它可以查看提示词、工具调用、文件、凭据和会话历史，因此只从你信任的来源加载扩展。

典型扩展添加 agent 工具、保护路径、确认危险命令、响应会话事件、修改上下文、暴露命令或显示持久状态。

<a id="quick-start"></a>
<a id="writing-an-extension"></a>
<a id="create-an-extension"></a>

## 创建并加载扩展

扩展导出一个默认工厂，接收 `ExtensionAPI`。工厂为当前扩展运行时注册能力。

创建 `~/.pi/agent/extensions/hello.ts`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

启动 Pi 并运行 `/hello`。开发期间直接加载文件：

```bash
pi --extension ./hello.ts
```

Pi 使用 `jiti`，因此本地 TypeScript 扩展不需要单独的编译步骤。分布式扩展和依赖使用 [Pi 包](packages.zh-CN.md)。

<a id="extension-locations"></a>
<a id="available-imports"></a>
<a id="choose-where-it-loads"></a>

## 加入 Pi

把扩展放到你的用户或项目扩展目录。Pi 加载直接的 TypeScript 或 JavaScript 文件，以及包含 `index.ts` 或 `index.js` 入口的子目录。

小型扩展用单个文件，多文件实现用目录。npm 依赖放在附近的 `package.json` 中。常规位置见[配置](configuration.zh-CN.md)，额外路径见[设置](settings.zh-CN.md#resources)。

重载会替换扩展运行时，因此 `await ctx.reload()` 之后的代码不得复用旧运行时的状态。只有个人扩展和显式命令行扩展可以参与在项目扩展加载之前运行的 `project_trust` 事件。

<a id="understand-the-lifecycle"></a>

## 遵守运行时生命周期

工厂可以是同步或异步的。Pi 会等待异步工厂完成后再继续启动，允许它获取启动所需的配置或注册提供商。

不要在工厂中启动进程、套接字、监视器或定时器，因为有些调用加载扩展但不启动会话。
从 `session_start` 或需要它们的命令或工具启动长期资源。
在幂等的 `session_shutdown` 处理器中关闭会话级资源。

一次运行从输入和 `before_agent_start` 开始，经过模型、消息和工具事件，到 `agent_end`。
Pi 在运行启动期间（包括压缩检查和 `before_agent_start`）视为忙碌，因此期间发送的消息进入正在启动的运行。
自动重试、恢复、压缩或排队工作可以在之后继续。
<a id="agent_start--agent_end--agent_before_settle--agent_settled"></a>

`agent_before_settle` 是最后的可操作边界：它可以追加条目并请求一次继续。
`agent_settled` 是最终且仅通知的；当集成需要知道 Pi 不会自动继续时使用它。

<a id="extensionapi-methods"></a>

## 选择集成点

| 能力 | 主要 API |
|---|---|
| 观察或修改生命周期行为 | `pi.on()` |
| 添加模型可调用的操作 | `pi.registerTool()` |
| 添加 `/` 命令 | `pi.registerCommand()` |
| 添加快捷键或 CLI 标志 | `pi.registerShortcut()` 或 `pi.registerFlag()` |
| 发送用户或自定义消息 | `pi.sendUserMessage()` 或 `pi.sendMessage()` |
| 持久化非上下文会话数据 | `pi.appendEntry()` |
| 更改活动工具、模型或思考级别 | `pi` 上的会话控制方法 |
| 添加模型提供商 | `pi.registerProvider()` |
| 添加 MCP 服务器 | `pi.registerMcpServer()` |
| 把每个请求路由到模型 | [`pi.registerVirtualModel()`](virtual-models.zh-CN.md) |
| 添加终端渲染 | 渲染器注册和 `ctx.ui` |
| 与另一个扩展通信 | `pi.events` |

精确的事件、上下文、工具和结果类型见 [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) 中导出的声明。

## 遵守扩展契约

<a id="events"></a>
<a id="work-with-events"></a>

### 事件与并发

处理器按扩展加载和注册顺序运行。`pi.on()` 返回取消该注册的函数；更改不影响已在进行的分发。
有些事件只通知；其他事件转换数据、替换结果或取消操作。
使用每个事件声明的结果类型，不要假设每个返回值都有作用。

事件覆盖资源发现、会话、agent 和消息生命周期、提供商、工具和原始输入。

`before_agent_start` 同时暴露当前提示词及其结构化的 `systemPromptOptions`。`event.messageType` 说明是什么启动了运行：`"user"` 表示提示词或 `pi.sendUserMessage()`，带 `prompt` 和 `images`；`"custom"` 表示 `pi.sendMessage(..., { triggerTurn: true })`，带起始 `message` 且无 `prompt`。返回的 `message` 会加入任一种运行；检查 `messageType` 以跳过由自定义消息启动的运行。优先更改提示词段落、所选工具或指南，这样 Pi 可以追加转录增量。返回 `systemPrompt` 或设置 `forceSystemPrompt` 会替换该次运行的整个提示词，而转录继续记录结构化段落。提供商收到强制文本作为其前导系统提示词。

`message_end` 可以在保留角色的同时替换已定稿的消息。`tool_call` 可以修改输入或阻止执行。`tool_result` 处理器可以组合，每个处理器都能看到先前的更改。

<a id="provider_stream_event"></a>

`provider_stream_event` 在 Pi 规范化之前对每个解析出的提供商流事件触发。事件标识提供商、API 和模型；`event.data` 是 Pi 可获得的最早结构化值，不一定是原始 HTTP 字节或 SSE 帧。把它当作只读，因为修改可能影响规范化。该事件仅通知，不持久化。

处理器按流顺序 await，因此慢处理器会延迟流消费。处理器错误被报告但不改变提供商响应。可选的原始事件查看器见 [`debug-provider.ts`](../examples/extensions/debug-provider.ts)，它按助手消息分组原始事件。

<a id="context_with_system"></a>

`context` 在转换对话消息时不包含提示词和工具系统消息；Pi 事后恢复该状态。只有当请求局部的转换必须拥有完整转录时才使用 `context_with_system`，并保持系统消息在索引零。

`turn_end` 和 `agent_before_settle` 是可操作边界。它们的处理器可以串联提议的 `custom`、`custom_message`、`context_edit` 或 `compaction` 条目，并返回 `continue: true` 以进行一次下一个模型请求。给继续条件加防护，因为无条件的继续会循环。完整的验证和排序契约见导出的事件声明。

<a id="cache_warming_decision"></a>

`cache_warming_decision` 可以用 `{ action: "warm" }` 或 `{ action: "stop" }` 覆盖空闲提示词缓存刷新。最后一个返回 action 的处理器生效。

一条助手消息的工具调用可以并行运行。
当另一个工具事件运行时，不要假设兄弟调用或结果存在。
对活动轮次拥有的嵌套工作使用 `ctx.signal`；命令和空闲会话事件通常没有操作 signal。

返回 `undefined` 的 `user_bash` 处理器把命令传给下一个处理器，若没有处理器处理则传给本地执行。返回 `operations` 或 `result` 会停止传播。处理器失败会阻止命令，而不是落到本地执行。

<a id="custom-tools"></a>
<a id="register-tools"></a>

### 工具

自定义工具定义名称、面向模型的描述、TypeBox 参数 schema 和 `execute()` 函数。
其结果需要面向模型的 `content` 和用于渲染或状态重建的 `details` 字段。
没有结构化详情时用 `details: undefined`。如果工具发起嵌套模型调用，把它们的 `usage` 包含在结果中，使会话总额保持准确。

从 `execute()` 抛出异常以产生失败的工具结果。
返回对象不会把它标记为错误。
仅当该批次中每个已完成的工具都同意终止时，才返回 `terminate: true`，让 agent 跳过其自动 follow-up。

工具共享可变内存状态时使用顺序执行。
改文件的工具应该用 `withFileMutationQueue()` 包裹完整的读-改-写操作。
截断面向模型的大结果，并告诉模型去哪里读完整输出。

结果是数据时，声明 `outputSchema` 并返回匹配的 `structuredContent`。模型仍收到 `content`；程序化调用者（如 codemode 脚本）收到 `structuredContent` 而不是文本。没有 `outputSchema` 的工具以文本内容传给脚本。要报告仍携带数据的失败，返回带 `isError: true` 的结果而不是抛出：模型看到错误，脚本仍收到 `structuredContent`。

工具可以用 `ctx.executeTool(name, args, { signal, onUpdate })` 运行其他工具。嵌套调用与模型发起的调用一样经过参数校验和 `tool_call`、`tool_result` 处理器，并发出 `tool_execution_start`、`tool_execution_update` 和 `tool_execution_end`；这些事件都带 `parentToolCallId`，其 `toolCallId` 由 pi 分配为 `<parent id>/<n>`。这些 id 不会作为工具调用或工具结果出现在转录中。嵌套调用不添加转录条目：其结果只到达调用工具，由它自行报告，例如通过 `onUpdate` 和 `details`。会话为它们保留有界记录（名称、参数、状态、时长、错误；绝不含结果），作为调用工具结果消息上的 `nestedCalls`。它用于压缩文件列表并显示在 HTML 导出中。每次调用超过 8 KiB 或每个工具结果超过 32 KiB 的参数被省略，最多保留 256 次调用，`complete: false` 标记丢失了内容的记录。嵌套结果的 `usage`（每一层）都加到调用工具的结果 `usage` 中，因此工具只报告自己的用量，不含它调用的工具的用量。`ctx.tools` 列出 `ctx.executeTool()` 可调用的工具。对 `content` 做脱敏的 `tool_result` 处理器也应替换 `structuredContent`；只替换 `content` 会把它丢掉。

见 [`hello.ts`](../examples/extensions/hello.ts)、[`todo.ts`](../examples/extensions/todo.ts)、[`dynamic-tools.ts`](../examples/extensions/dynamic-tools.ts) 和 [`truncated-tool.ts`](../examples/extensions/truncated-tool.ts)。

### 工具暴露

`exposure` 控制模型如何访问工具。"可调用"指其他工具可以通过 `ctx.executeTool()`（`ctx.tools`）调用它，就像 `codemode` 工具的脚本那样：

- `direct`（默认）：激活时向模型声明，激活时可调用。
- `model-only`：激活时向模型声明，永不可调用。用于编排其他工具或询问用户的工具。
- `codemode`：注册后随时可调用，并由 `codemode` 工具列出。除非显式激活，不向模型声明。
- `deferred`：类似 `codemode`，但 codemode 工具不列出它；`tool_search` 可以找到并激活它。
- `hidden`：已注册但不可达。用 `exposure: "hidden"` 重新注册工具即可撤回它，因为工具无法注销。

`namespace: { name, aliases, description, instructions }` 把相关工具分组，就像 MCP 服务器那样。Codemode 工具把命名空间列在一个标题下并带其 `description`。`instructions` 存放更长的使用指南；它不被列出，codemode 脚本用 `describeNamespace(name)` 读取。`aliases` 是脚本查找命名空间可用的其他名称，例如 `mcp__docs` 的服务器名 `docs`；名称和作为脚本标识符的相同名称（`my-docs`、`my_docs`）匹配方式相同。

注册 `direct` 或 `model-only` 工具会激活它；其他暴露方式注册时不激活。活动集（`pi.getActiveTools()`、`pi.setActiveTools()`）是向模型声明的工具集。`pi.getAllTools()` 报告每个工具的 `exposure`、`namespace`、`annotations` 和 `reachesTools`。

`annotations` 是关于工具行为的提示，含义与 MCP 工具注解相同：`readOnlyHint`、`destructiveHint`、`idempotentHint` 和 `openWorldHint`。MCP 工具携带其服务器声明的提示。缺失的提示取 MCP 默认值：工具不是只读的，可能具有破坏性且可访问开放世界。提示未经核实，但权限扩展可以用它们决定确认哪些调用。下面的例子确认 Codex 会请求批准的调用：

```typescript
pi.on("tool_call", async (event, ctx) => {
  const hints = pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations;
  const needsApproval =
    hints?.destructiveHint === true ||
    (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
  if (needsApproval && !(await ctx.ui.confirm("Allow tool call?", event.toolName))) {
    return { block: true, reason: `${event.toolName} was not approved` };
  }
});
```

编排其他工具的工具可以在其活跃期间用 `prepareLoadout(loadout)` 调整模型看到的内容。它在活动工具变化时运行，接收已声明的工具、可调用的工具，以及每个已注册工具及其暴露方式、命名空间和提示词指南。它返回已声明工具（包括它自己）的替换 `descriptions` 和 `hiddenDeclarations`：请求的声明中被略去但仍保持活跃和可调用的活动工具。默认系统提示词把隐藏工具排除在其工具列表和规则之外，且当文件读取器被隐藏时在技能提示中不点名任何工具，因此编排工具应自己呈现它们的指南。`codemode` 只使用这个钩子、`exposure`、`reachesTools` 和 `ctx.executeTool()`，因此另一个工具可以用不同名称实现相同行为。

触达其他工具的工具用 `reachesTools(input)` 声明一次调用可能触达哪些工具：`"all"`，或输入中可能指名它们的词，一个词指名称包含它的每个工具或命名空间。`codemode` 对搜索或列出工具的脚本返回 `"all"`，否则返回脚本的词；`tool_search` 总是返回 `"all"`。延迟注册工具的扩展在 `tool_call` 处理器中使用它，在调用运行前完成注册该调用所需的工具，正如 MCP 扩展对仍在连接的服务器所做的。只有当同名工具声明了 `reachesTools` 时，MCP 扩展才会为 MCP 工具激活 `codemode` 或 `tool_search`。

### 动态激活工具

先注册每个工具，保持可选工具不活跃，然后从加载器工具用 `pi.setActiveTools()` 选择所需的活动工具。名称必须已注册；未知名称被忽略。

Pi 把初始提示词和工具集记录在转录的第一个系统消息中，然后在下一个模型请求前追加工具和提示词变更。无法表示该转换的提供商收到完整转录检查点，这可能使缓存前缀失效。

### 工具渲染

工具的 `renderCall` 和 `renderResult` 在交互转录和 HTML 导出中绘制其调用。`pi.registerToolRenderer((toolName, next) => renderers)` 为任何工具的调用选择渲染器，包括尚未注册的工具，例如恢复会话中其服务器尚未连接的 MCP 工具。`next()` 返回其余解析器（按扩展加载顺序）然后是已注册工具会使用的结果，因此 `next() ?? mine` 只做补位。

### MCP 服务器

`pi.registerMcpServer(name, config)` 为当前会话添加 MCP 服务器。`config` 的形状与 [`mcp.json`](mcp.zh-CN.md) 的 `mcpServers` 条目相同：stdio 服务器用 `command`、`args`、`env` 和 `cwd`，HTTP 服务器用 `url`、`headers` 和 `oauth`，另有 `exposure`、`toolExposure`、`description`、`enabled` 和 `timeout`。

```typescript
pi.registerMcpServer("jira", { url: "https://mcp.example.com/jira", exposure: "codemode" });
pi.unregisterMcpServer("jira");
```

扩展加载时注册的服务器在会话启动时随 `mcp.json` 服务器一起连接；之后注册的服务器立即连接，`pi.unregisterMcpServer()` 关闭连接并使该服务器的工具不可达。注册不会被保存：每次加载时重新注册，例如基于扩展自己的设置。`mcp.json` 中同名的服务器优先，`/mcp` 显示覆盖情况。再次注册同名会替换该扩展先前的注册；另一个扩展注册的名称、非法名称和非法配置会抛出异常。

内置 MCP 支持连接已注册的服务器。当没有东西连接它们时（因为另一个扩展替换了内置支持，见 [MCP](mcp.zh-CN.md#other-mcp-extensions)），每个注册都会报告为扩展错误。其他 MCP 扩展也可以连接已注册的服务器：在 `session_start` 用 `pi.getMcpServers()` 读取它们，并处理 `mcp_servers_change` 事件以响应后续变化。

<a id="extensioncontext"></a>
<a id="extensioncommandcontext"></a>
<a id="use-extension-context"></a>

### 上下文与会话变更

`ExtensionContext` 提供工作目录、模式、UI、会话管理器、模型运行时、abort signal、上下文用量，以及压缩和关闭的控制。
用 `ctx.modelRegistry.streamSimple()` 做提供商中立的嵌套模型调用。

命令处理器接收 `ExtensionCommandContext`，它额外提供等待空闲、重载、树导航和会话替换的操作。
这些操作仅限命令使用，因为从生命周期处理器调用它们会使运行时死锁。

会话替换使旧上下文失效。切换前只捕获纯数据，然后使用 `withSession` 提供的新上下文做会话绑定的工作。

<a id="state-management"></a>
<a id="persist-state"></a>

### 状态

按状态如何参与对话选择存储：

| 状态 | 存储 |
|---|---|
| 跟随活动分支的工具状态 | 工具结果 `details` |
| 排除在模型上下文之外的持久数据 | `pi.appendEntry()` |
| 存储并发送给模型的自定义内容 | `pi.sendMessage()` |
| 单个会话之外的数据 | 外部存储 |

在 `session_start` 期间从 `ctx.sessionManager.getBranch()` 重建分支敏感的状态。
不要从每个文件条目重建它，因为被放弃的分支代表备选历史。
当自定义存储内容应出现在转录中时，注册条目或消息渲染器。

<a id="custom-ui"></a>
<a id="mode-behavior"></a>
<a id="interact-with-the-user"></a>
<a id="account-for-each-mode"></a>

### UI 与模式

`ctx.ui` 提供对话框、通知、状态文本、部件、标题、编辑器访问和自定义组件。
只有当交互需要自己的渲染和输入时才用 `ctx.ui.custom()`。
组件、焦点、覆盖层、主题和性能指南见[终端 UI](tui.zh-CN.md)。

扩展在交互、RPC、JSON 和 print 模式下加载。
交互模式提供完整的终端 UI。
RPC 可以通过 [RPC 扩展 UI 协议](rpc-extension-ui.zh-CN.md)转发受支持的对话框和通知，但不支持自定义终端组件；JSON 和 print 模式没有 UI。
用 `ctx.mode === "tui"` 保护仅终端的行为，用 `ctx.hasUI` 判断交互式和 RPC 客户端支持的交互。

保持工具和事件行为独立于渲染，使非交互模式保持可用。

<a id="error-handling"></a>
<a id="handle-errors-and-shutdown"></a>

### 错误与清理

Pi 报告处理器错误并尽可能继续。`tool_call` 处理器失败会作为保险措施阻止该工具；工具执行失败成为模型的错误结果。

即使正常操作已尝试清理，也要在 `session_shutdown` 中释放资源。
保持清理幂等，因为取消、重载、会话替换和进程退出可能汇聚到同一路径。
用 `ctx.shutdown()` 请求有序的进程关闭。

<a id="examples-reference"></a>
<a id="use-examples-as-the-implementation-reference"></a>

## 示例与参考

受检查的[扩展示例](../examples/extensions/)覆盖工具、生命周期事件、命令、标志、快捷键、状态、渲染、提供商、OAuth、远程执行和终端组件。
从匹配你集成点的最小示例开始。

模型服务集成见[自定义提供商](custom-provider.zh-CN.md)，自定义组件见[终端 UI](tui.zh-CN.md)，与其他资源一起安装或分发扩展见 [Pi 包](packages.zh-CN.md)。
