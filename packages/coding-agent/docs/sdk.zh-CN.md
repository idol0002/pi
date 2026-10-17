# SDK

`@earendil-works/pi-coding-agent` 把 Pi 嵌入 Node.js 或 Bun 进程。它提供对命令行应用所用 agent、会话、工具、模型和资源的直接 TypeScript 访问。

进程内的 TypeScript 集成用 SDK。语言无关或隔离的子进程方案见 [CLI 集成](cli-integration.zh-CN.md)。

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

try {
  await session.prompt("What files are in the current directory?");
  console.log(session.getLastAssistantText());
} finally {
  session.dispose();
}
```

这会使用工作目录、发现的资源、保存的设置和配置的凭据。`prompt()` 在运行结束后 resolve。

[完整的最小示例](../examples/sdk/01-minimal.ts)还包含文本事件的流式输出。所有 [SDK 示例](../examples/sdk/)都与仓库一起做类型检查。

<a id="session-management"></a>

## 会话生命周期

`createAgentSession()` 创建一个 `AgentSession`。会话拥有一次对话、其模型和工具、排队消息、压缩状态和扩展运行时。

通过 `session.messages`、`session.model`、`session.thinkingLevel`、`session.systemPrompt` 和 `session.getActiveToolNames()` 读取当前状态。

`session.systemPrompt` 是只读的，返回当前生效的系统提示词，包括尚未发送给模型的变更。工具变更会在下一次请求前声明给模型。

<a id="sessionmanager-api"></a>

### 会话存储

会话默认持久化。`SessionManager` 拥有持久化或内存中的条目树，并跟踪其活动叶子（leaf）。分支操作改变该叶子，但不删除被放弃的分支。Pi 重建模型上下文时，管理器选择活动分支并应用压缩。

`SessionManager` 对最终确定的模型上下文是权威的。要恢复外部历史，就用包含那些条目的管理器来构造会话。给 `session.agent.state.messages` 赋值不会替换持久化上下文。

宿主不想要会话文件时，使用内存管理器：

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});
```

创建、打开、继续、列出和 fork 会话见受检查的[会话示例](../examples/sdk/11-sessions.ts)。[会话文件格式](session-format.zh-CN.md)定义持久化的 JSONL 契约，[消息类型](message-types.zh-CN.md)定义记录值。精确的方法和签名请使用导出的 TypeScript 声明或 [`session-manager.ts`](../src/core/session-manager.ts)。

`cwd` 选择用于项目资源发现、上下文文件、会话分组和内置工具路径的工作区。目标与 `process.cwd()` 不同时，显式传入。

`session.dispose()` 中止活动工作、使扩展上下文失效、断开与 agent 的连接，并移除事件监听器。会话不再需要时调用它。

`AgentSessionRuntime` 增加了 `newSession()`、`switchSession()`、`fork()` 和 `importFromJsonl()`。每个操作都会替换活动的 `AgentSession`，并为目标工作目录重建服务。

运行时替换之后，订阅属于旧的 `AgentSession`，必须重新绑定。见[会话运行时示例](../examples/sdk/13-session-runtime.ts)。

## 提问

`prompt()` 在普通用户消息进入 agent 之前处理扩展命令并展开基于文件的提示词模板。对被接受的 agent 运行，它在运行结束后（包括自动重试）resolve。

会话已在流式输出时发送的 prompt 必须指定它是 steering 当前运行还是跟随其后。不指定就调用 `prompt()` 会拒绝而不是猜测。

Steering 消息在当前助手回合及其工具调用之后进入。Follow-up 在当前运行完成其待办工作之后进入。`steer()` 和 `followUp()` 直接暴露这两种行为：输入被排队（包括扩展转换之后）返回 `"queued"`，扩展消费了输入则返回 `"handled"`。

`abort()` 停止活动操作并等待会话空闲。`waitForIdle()` 只等待而不中止。

## 订阅事件

宿主需要流式输出时，在提问之前订阅：

```typescript
const unsubscribe = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt("Explain this repository");
} finally {
  unsubscribe();
}
```

会话事件报告消息更新、工具执行、队列、压缩、重试和运行生命周期变化。

`message_end` 包含权威的已完成消息。`agent_end` 标记一次底层 agent 运行的结束，但自动恢复或排队工作仍可能随后发生。

宿主需要知道 Pi 不会自动继续时，使用 `agent_settled`。

## 配置会话

不提供覆盖时，工厂创建 `ModelRuntime`、基于文件的 `SettingsManager`、持久化 `SessionManager`、`DefaultResourceLoader` 和配置的默认工具。

每个边界都可以显式提供：

- `modelRuntime`、`model`、`thinkingLevel` 和 `scopedModels` 控制模型访问与选择。
- `settingsManager` 提供合并后的设置或内存配置。
- `sessionManager` 提供持久化或内存中的对话历史。
- `resourceLoader` 提供扩展、技能、提示词模板、主题和上下文文件。
- `tools`、`noTools`、`excludeTools` 和 `customTools` 控制活动工具集。

想要标准发现加选定覆盖时，用 `DefaultResourceLoader`。宿主完全拥有资源存储和发现时，提供自定义 `ResourceLoader`。

<a id="inlineextension"></a>

内联扩展工厂可以通过 `DefaultResourceLoader` 提供。只有当它需要在诊断和启动输出中有稳定名称时，才给内联扩展起 `InlineExtension` 名。具名的内联扩展设置 `replaceable: true` 后，如果另一个扩展在加载期间注册了同名工具、命令或标志，它会被跳过而不是双双加载并冲突。CLI 内置的 codemode、tool search 和 MCP 扩展是可替换的。带 `builtin: true` 的具名条目不是内联扩展：它提供 `builtin:<name>` 扩展的代码，像配置的扩展文件一样加载。它默认加载、出现在 `pi config` 中，可通过 `extensions` 设置中的 `-builtin:<name>` 或 `noExtensions` 禁用；`additionalExtensionPaths: ["builtin:<name>"]` 显式加载它。它在项目信任解析之后加载，因此无法处理 `project_trust`。CLI 的内置扩展使用该机制。

<a id="codemode-mcp"></a>

CLI 把 `codemode`、`tool_search` 和 MCP 作为内置扩展加载。SDK 会话不会；把 `createCodemodeExtension()`、`createToolSearchExtension()` 和 `createMcpExtension()` 加到 `DefaultResourceLoader` 的 `extensionFactories`。`codemode` 和 `tool_search` 注册为未激活：通过 `defaultTools` 设置启用（`["+codemode", "+tool_search"]` 保留其他默认工具），或让 MCP 扩展激活它们：暴露 `codemode` 的服务器启用 `codemode`，暴露 `deferred` 的服务器启用 `tool_search`。MCP 扩展在 `session_start` 时连接其服务器，因此要调用 `session.bindExtensions()`。见 [Codemode 与 MCP](../examples/sdk/14-codemode-mcp.ts)。

模型、工具、扩展和完全控制的专门示例见 [models](../examples/sdk/02-custom-model.ts)、[tools](../examples/sdk/05-tools.ts)、[extensions](../examples/sdk/06-extensions.ts)、[full control](../examples/sdk/12-full-control.ts)。

## 示例

| 示例 | 用途 |
|---|---|
| [Minimal](../examples/sdk/01-minimal.ts) | 创建、提问、观察并销毁会话 |
| [Custom model](../examples/sdk/02-custom-model.ts) | 选择模型和思考级别 |
| [System prompt](../examples/sdk/03-custom-prompt.ts) | 替换或追加系统提示词 |
| [Skills](../examples/sdk/04-skills.ts) | 发现、过滤和添加技能 |
| [Tools](../examples/sdk/05-tools.ts) | 选择内置工具及其工作目录 |
| [Extensions](../examples/sdk/06-extensions.ts) | 加载基于文件的和内联扩展 |
| [Context files](../examples/sdk/07-context-files.ts) | 添加或替换项目指令 |
| [Prompt templates](../examples/sdk/08-prompt-templates.ts) | 添加文件式提示词模板 |
| [Credentials](../examples/sdk/09-api-keys-and-oauth.ts) | 配置凭据和模型存储 |
| [Settings](../examples/sdk/10-settings.ts) | 提供基于文件或内存的设置 |
| [Sessions](../examples/sdk/11-sessions.ts) | 控制会话持久化与恢复 |
| [Full control](../examples/sdk/12-full-control.ts) | 替换默认发现和状态服务 |
| [Session runtime](../examples/sdk/13-session-runtime.ts) | 安全地替换活动会话 |
| [Codemode and MCP](../examples/sdk/14-codemode-mcp.ts) | 添加 `codemode`、`tool_search` 和 MCP 扩展 |

<a id="exports"></a>

## 资源

- [选择模型](models.zh-CN.md)覆盖模型选择和兼容端点；[提供商](providers.zh-CN.md)覆盖凭据和提供商专属设置。
- [配置](configuration.zh-CN.md)解释常规发现和设置；[设置](settings.zh-CN.md)列出每个设置项。
- [会话与上下文](sessions.zh-CN.md)解释会话行为；[会话格式](session-format.zh-CN.md)定义持久化条目；[消息类型](message-types.zh-CN.md)定义共享的记录值。
- [扩展](extensions.zh-CN.md)、[技能](skills.zh-CN.md)和[提示词模板](prompt-templates.zh-CN.md)记录通过 `ResourceLoader` 提供的资源。
- [CLI 集成](cli-integration.zh-CN.md)覆盖进程内 SDK 集成之外的打印、JSON 和 RPC 替代方案。
