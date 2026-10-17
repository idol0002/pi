# @earendil-works/pi-agent-core

带状态管理的 agent，支持工具执行和事件流。构建于 `@earendil-works/pi-ai` 之上。

## 安装

```bash
npm install @earendil-works/pi-agent-core
```

## 快速开始

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model,
  },
  streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // 只流式输出新的文本块
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello!");
```

## 核心概念

### AgentMessage 与 LLM Message

agent 处理的是 `AgentMessage`，这是一个灵活的类型，可以包含：
- 标准 LLM 消息（`user`、`assistant`、`toolResult`）
- 通过声明合并（declaration merging）添加的自定义应用级消息类型

LLM 只理解 `user`、`assistant` 和 `toolResult`。`convertToLlm` 函数弥合这一差距：在每次 LLM 调用前过滤并转换消息。

### 消息流

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    （可选）                              （必需）
```

1. **transformContext**：裁剪旧消息、注入外部上下文
2. **convertToLlm**：过滤掉仅供 UI 使用的消息，把自定义类型转换为 LLM 格式

## 事件流

agent 发出事件供 UI 更新。理解事件顺序有助于构建响应灵敏的界面。

### prompt() 事件序列

调用 `prompt("Hello")` 时：

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // 你的 prompt
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM 开始响应
├─ message_update  { message: partial... }       // 流式数据块
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // 完整响应
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### 带工具调用时

如果助手调用了工具，循环会继续：

```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // 如果工具流式输出
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // 下一回合
├─ message_start      { assistantMessage }           // LLM 响应工具结果
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

工具执行模式可配置：

- `parallel`（默认）：按顺序预检工具调用，允许的工具并发执行，每个工具完成时立即发出 `tool_execution_end`，然后按助手源顺序发出 toolResult 消息和 `turn_end.toolResults`
- `sequential`：逐个执行工具调用，与历史行为一致

并行模式下，工具完成事件按工具完成顺序发出，但持久化的 toolResult 消息仍按助手源顺序排列。

模式可以通过 agent 配置中的 `toolExecution` 全局设置，也可以通过 `AgentTool` 上的 `executionMode` 按工具设置。如果批次中任何工具调用目标是 `executionMode: "sequential"` 的工具，整个批次都按顺序执行，无视全局设置。

`beforeToolCall` 钩子在 `tool_execution_start` 和参数校验之后运行。它可以阻止执行，并在被阻止的结果上附加 `terminate: true`。`afterToolCall` 钩子在工具执行完成之后、`tool_execution_end` 和最终工具结果消息事件发出之前运行。

工具、被阻止的 `beforeToolCall` 结果和 `afterToolCall` 覆盖可以返回 `terminate: true`，提示应跳过自动的后续 LLM 调用。只有当批次中每个已完成的工具结果都设置了 `terminate: true` 时，循环才会提前停止。混合批次会正常继续。

使用 `Agent` 类时，助手的 `message_end` 处理被视为屏障，在工具预检开始之前完成。这意味着 `beforeToolCall` 看到的 agent 状态已包含请求该工具调用的助手消息。

### 请求准备与回合收尾

`prepareRequest` 在每次对话式提供商请求之前立即运行，包括第一次。用它来在待处理输入发出之后安装规范的持久化上下文：

```typescript
agent.prepareRequest = async ({ context }) => ({
  context: { ...context, messages: await session.loadModelContext() },
});
```

`prepareRequest` 不轮询队列。它运行期间入队的 steering 消息会等到下一次正常的 steering 轮询。

`finishTurn` 在助手消息和所有工具结果完成后、`turn_end` 之前运行。正常、错误和中止的响应都会触发它：

```typescript
agent.finishTurn = async ({ message }) => {
  if (message.stopReason === "error" || message.stopReason === "aborted") return;
  if (shouldEndRun(message)) return { action: "end" };
  return needsAnotherResponse(message) ? { action: "continue" } : undefined;
};
```

返回 `undefined` 保持正常调度。`{ action: "end" }` 在 `turn_end` 之后立即停止，不轮询 steering 或 follow-up 队列，也不再准备下一个请求。正常响应时，`{ action: "continue" }` 确保有一次下一次提供商请求。如果工具结果、steering 或 follow-up 已经会触发该请求，它们就满足了这个决定，不会产生额外请求；否则循环会发起一次仅含上下文的请求。错误和中止的响应仍是硬退出，其决定会被忽略。`finishTurn` 在下一次请求后会再次运行，因此无条件返回 `{ action: "continue" }` 会造成死循环。

要从已移除的 `shouldStopAfterTurn` 迁移，返回 `{ action: "end" }`。对错误和中止响应加保护，以保持旧钩子只在正常响应时调用的行为，特别是当判断条件有副作用或假定响应成功时：

```typescript
finishTurn: async (turn, signal) => {
  if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
  return (await shouldStop(turn, signal)) ? { action: "end" } : undefined;
},
```

每个提供商回合遵循以下生命周期：

```text
选定的输入事件
→ prepareRequest
→ 提供商响应
→ 工具结果
→ finishTurn
→ turn_end
→ 既有的继续调度或 agent_end
```

### continue() 与排队输入

`continue()` 保留其既有的队列行为。空记录和仅含系统消息的记录会拒绝，不消耗队列。非助手结尾会从既有上下文继续：启动时轮询 steering，而 follow-up 输入等到响应自然停止后进入。

```typescript
agent.followUp({ role: "user", content: "After the retry", timestamp: Date.now() });
await agent.continue(); // 第一次请求重试既有的 user/toolResult 结尾。
```

助手结尾无法直接发送，因此 `continue()` 回退为一批排队的 steering，然后一批排队的 follow-up。队列模式仍控制选中的批次是单条消息还是全部消息：

```typescript
agent.steer({ role: "user", content: "Continue from here", timestamp: Date.now() });
await agent.continue(); // 因为结尾是 assistant，只使用排队的这条消息。
```

### 事件类型

| 事件 | 说明 |
|-------|-------------|
| `agent_start` | agent 开始处理 |
| `agent_end` | 本次运行的最终事件。该事件的 awaited 订阅者仍计入结算 |
| `turn_start` | 新回合开始（一次 LLM 调用 + 工具执行） |
| `turn_end` | 回合结束，带助手消息和工具结果 |
| `message_start` | 任何消息开始（user、assistant、toolResult） |
| `message_update` | **仅助手消息。**包含带增量数据的 `assistantMessageEvent` |
| `message_end` | 消息完成 |
| `tool_execution_start` | 工具开始 |
| `tool_execution_update` | 工具流式输出进度 |
| `tool_execution_end` | 工具完成 |

`Agent.subscribe()` 的监听器按注册顺序 await。`agent_end` 表示不会再发出循环事件，但 `await agent.waitForIdle()` 和 `await agent.prompt(...)` 要等到 awaited 的 `agent_end` 监听器完成后才会结算。

## Agent 选项

```typescript
const agent = new Agent({
  // 初始状态。除非 messages 已以系统消息开头，否则 systemPrompt 和 tools
  // 会成为开头的系统消息。
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // 把 AgentMessage[] 转换为 LLM Message[]（自定义消息类型时必需）
  convertToLlm: (messages) => messages.filter(...),

  // 在 convertToLlm 之前转换上下文（用于裁剪、压缩）
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // Steering 模式："one-at-a-time"（默认）或 "all"
  steeringMode: "one-at-a-time",

  // Follow-up 模式："one-at-a-time"（默认）或 "all"
  followUpMode: "one-at-a-time",

  // 必需的流式函数。接收 TranscriptContext：prompt 和 tools 在记录的系统消息中，
  // 不在 context 上。
  streamFn: models.streamSimple.bind(models),

  // 用于提供商缓存的会话 ID
  sessionId: "session-123",

  // 动态 API key 解析（用于会过期的 OAuth token）
  getApiKey: async (provider) => refreshToken(),

  // 工具执行模式："parallel"（默认）或 "sequential"
  toolExecution: "parallel",

  // 参数校验后预检每个工具调用。可以阻止执行。
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") {
      return { block: true, reason: "bash is disabled", terminate: true };
    }
  },

  // 在最终工具事件发出前对每个工具结果做后处理。
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    if (toolCall.name === "notify_done" && !isError) {
      return { terminate: true };
    }
    if (!isError) {
      return { details: { ...result.details, audited: true } };
    }
  },

  // 每次提供商请求前立即重建最终上下文。
  prepareRequest: async ({ context }, signal) => {
    return { context: { ...context, messages: await loadCanonicalMessages(signal) } };
  },

  // 在 turn_end 发出前收尾已完成的回合。
  // `continue` 确保有一次下一次请求；既有的工具/队列调度可以满足它。
  // `end` 在 turn_end 后结束本次运行，不轮询队列。
  finishTurn: async ({ message, toolResults }, signal) => {
    return shouldContinue(message, toolResults) ? { action: "continue" } : undefined;
  },

  // 基于 token 的提供商的自定义思考预算
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```

## Agent 状态

```typescript
interface AgentState {
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

通过 `agent.state` 访问状态。

给 `agent.state.tools = [...]` 或 `agent.state.messages = [...]` 赋值时，会在存储前复制顶层数组。修改返回的数组会直接修改当前 agent 状态。

记录拥有系统提示词和工具声明：开头的系统消息是提示词，后续系统消息对其打补丁（见 pi-ai 中的 `SystemMessage`）。`agent.state.systemPrompt` 是只读的，回放记录内容。`agent.state.tools` 是可执行的工具配置；每次请求前，循环会把它与记录声明的工具做对比，如果不同，就用一条系统消息宣布变更（存在待处理的系统消息时合并进去）。pi-ai 的 `getCurrentSystemMessage(messages)` 对任何消息数组（包括含自定义消息角色的 agent 记录）返回回放的开头系统消息，包括声明的工具。

要在对话中途更改提示词，追加一条带 `content`（新增指令）或 `sections`（具名替换）的系统消息：

```typescript
await agent.prompt([
  { role: "system", content: "", sections: { skills: "<skills>...</skills>" }, timestamp: Date.now() },
  { role: "user", content: "Continue", timestamp: Date.now() },
]);
```

流式输出期间，`agent.state.streamingMessage` 包含当前的部分助手消息。

`agent.state.isStreaming` 在运行完全结算之前保持 `true`，包括 awaited 的 `agent_end` 订阅者。

## 方法

### 提问

```typescript
// 文本 prompt
await agent.prompt("Hello");

// 带图片
await agent.prompt("What's in this image?", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

// 直接传 AgentMessage
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// 从既有的非助手输入继续；助手结尾可以用排队输入作为回退
await agent.continue();
```

### 状态管理

```typescript
agent.state.model = getModel("openai", "gpt-4o");
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.toolExecution = "sequential";
agent.beforeToolCall = async ({ toolCall }) => undefined;
agent.afterToolCall = async ({ toolCall, result }) => undefined;
agent.prepareRequest = async ({ context }) => ({
  context: { ...context, messages: await loadCanonicalMessages() },
});
agent.finishTurn = async () => undefined;
agent.state.messages = newMessages; // 顶层数组会被复制
agent.state.messages.push(message);
const nextQueuedMessages = agent.peekQueuedMessages(); // 遵循队列模式；不消耗
agent.reset();
```

### 会话与思考预算

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```

### 控制

```typescript
agent.abort();           // 取消当前操作
await agent.waitForIdle(); // 等待完成
```

### 事件

```typescript
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") {
    // 本次运行的最终屏障工作
    await flushSessionState(signal);
  }
});
unsubscribe();
```

## Steering 与 Follow-up

Steering 消息让你在工具运行期间打断 agent。Follow-up 消息让你在 agent 即将停止时排队后续工作。

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

// agent 正在运行工具时
agent.steer({
  role: "user",
  content: "Stop! Do this instead.",
  timestamp: Date.now(),
});

// agent 完成当前工作之后
agent.followUp({
  role: "user",
  content: "Also summarize the result.",
  timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

用 clearSteeringQueue、clearFollowUpQueue 或 clearAllQueues 丢弃排队的消息。

回合结束后检测到 steering 消息时：
1. 当前助手消息的所有工具调用已经完成
2. 注入 steering 消息
3. LLM 在下一回合响应

只有当没有更多工具调用且没有 steering 消息时，才检查 follow-up 消息。如果有排队的，就注入并再运行一个回合。

## 自定义消息类型

通过声明合并扩展 `AgentMessage`：

```typescript
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

// 现在合法
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

在 `convertToLlm` 中处理自定义类型：

```typescript
const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return []; // 过滤掉
    return [m];
  }),
});
```

## 工具

用 `AgentTool` 定义工具：

```typescript
import { Type } from "typebox";

const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",  // 用于 UI 显示
  description: "Read a file's contents",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  // 覆盖此工具的执行模式（可选）。
  // "sequential" 强制整个批次逐个运行。
  // "parallel" 允许与其他工具调用并发执行。
  // 省略时应用全局 toolExecution 配置。
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    // 可选：流式输出进度
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

    // 可选：当批次中每个已完成的工具结果都如此时，
    // 在这里返回 `terminate: true` 可跳过自动的后续 LLM 调用。
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

agent.state.tools = [readFileTool];
```

### 错误处理

工具失败时**抛出错误**。不要把错误信息当作内容返回。

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }
  // 只在成功时返回内容
  return { content: [{ type: "text", text: "..." }] };
}
```

抛出的错误会被 agent 捕获，以 `isError: true` 的工具错误形式报告给 LLM。

从 `execute()`、被阻止的 `beforeToolCall` 或 `afterToolCall` 返回 `terminate: true`，提示 agent 在当前工具批次后停止。只有当批次中每个已完成的工具结果都是终止性的时候才生效。该提示只作用于运行时；发出的 `toolResult` 记录消息仍是标准的 LLM 工具结果。

### MCP 与 Codemode

`@earendil-works/pi-mcp` 连接 MCP 服务器，`@earendil-works/pi-codemode` 运行模型编写的、调用工具的 JavaScript。[examples/mcp-codemode](examples/mcp-codemode) 把两者都包装成 `AgentTool`：每个 MCP 工具一个工具，以及一个 `codemode` 工具，其脚本通过 `runToolCall()` 调用 agent 的工具，因此 `beforeToolCall` 和 `afterToolCall` 同样作用于这些调用。

## 代理（Proxy）用法

对于通过后端代理的浏览器应用：

```typescript
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

## 底层 API

需要不经 Agent 类的直接控制时：

```typescript
import { agentLoop, agentLoopContinue } from "@earendil-works/pi-agent-core";

const context: AgentContext = {
  messages: [{ role: "system", content: "You are helpful.", timestamp: Date.now() }],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel("openai", "gpt-4o"),
  convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
  toolExecution: "parallel",  // 若设置了按工具的 executionMode 则被其覆盖
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

const streamFn = models.streamSimple.bind(models);
for await (const event of agentLoop([userMessage], context, config, undefined, streamFn)) {
  console.log(event.type);
}

// 从既有上下文继续
for await (const event of agentLoopContinue(context, config, undefined, streamFn)) {
  console.log(event.type);
}
```

这些底层流是观察性的。它们保持事件顺序，但不会等待你的异步事件处理完成才继续后续的生产阶段。如果需要消息处理在工具预检之前充当屏障，请使用 `Agent` 类，而不是原始的 `agentLoop()` 或 `agentLoopContinue()`。

## 许可证

MIT
