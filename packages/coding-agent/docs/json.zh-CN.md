# JSON 事件流

JSON 模式为单次调用输出结构化进度：

```bash
pi --mode json "Review this repository"
```

Pi 写一条会话头，随后是会话事件，提供的提示词完成后退出。RPC 模式输出相同的会话事件结构，但没有会话头，因为它是双向长期协议。见 [RPC 模式](rpc.zh-CN.md)。

本页是 JSON 与 RPC 模式共享事件的权威参考。消息值使用[共享消息类型](message-types.zh-CN.md)。

## 帧格式与进程 I/O

流使用严格的 JSONL 帧。每条记录是一个以 LF（`\n`）结尾的 JSON 对象。只在 LF 处分割记录，并去掉可选的前导回车符。Unicode 行分隔符和段落分隔符在 JSON 字符串内是合法的，不构成记录边界。

Node.js 的 `readline` 不适合这个流，因为它也识别那些 Unicode 分隔符。使用字节或 UTF-8 流解码器并按 LF 分割。

持续读取 stdout。停止消费记录的读取器会在管道缓冲区填满时卡住 Pi。stdout 保留给 JSONL；诊断和应用程序日志写到 stderr。

## 会话头

JSON 模式的第一条记录是当前[会话头](session-format.zh-CN.md#sessionheader)：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path"}
```

RPC 模式不输出这条记录。用 [`get_state`](rpc-commands.zh-CN.md#get_state) 获取其当前会话 ID 和文件。

## 事件序列

一次基本运行产生如下记录：

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":"Review this repository","timestamp":1733234401000}}
{"type":"message_end","message":{"role":"user","content":"Review this repository","timestamp":1733234401000}}
{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending","...":"..."}}
{"type":"message_update","usage":{"...":"..."},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_end","message":{"role":"assistant","...":"..."}}
{"type":"turn_end","message":{"role":"assistant","...":"..."},"toolResults":[]}
{"type":"agent_end","messages":[{"...":"..."}],"willRetry":false}
{"type":"agent_settled","aborted":false}
```

`agent_end` 关闭一次底层 agent 运行。自动重试、溢出恢复、压缩重试、steering 或 follow-up 工作仍可能继续。`agent_settled` 表示 Pi 对该会话级运行没有剩余的自动工作。

## Agent 与轮次事件

| 事件 | 字段 | 含义 |
|---|---|---|
| `agent_start` | 无 | 一次底层 agent 运行开始。 |
| `agent_end` | `messages`、`willRetry` | 该底层运行结束。`messages` 包含该运行生成的消息。 |
| `agent_settled` | `aborted` | Pi 不会通过重试、压缩恢复或排队消息继续。运行因被中止而结束时 `aborted` 为 `true`。 |
| `turn_start` | 无 | 一条助手轮次开始。 |
| `turn_end` | `message`、`toolResults` | 一条助手响应及其产生的工具调用完成。 |

一轮是一条助手响应加上该响应产生的所有工具调用和工具结果。

## 消息事件

| 事件 | 字段 | 含义 |
|---|---|---|
| `message_start` | `message` | 一条消息开始。 |
| `message_update` | `usage`、`assistantMessageEvent` | 助手消息发出一次内容块更新。 |
| `message_end` | `message` | 一条消息完成。这是权威的最终消息。 |

### 重建流式消息

线上 `message_update` 记录只含增量。它们省略 SDK 事件的累计 `message` 字段和每个 `assistantMessageEvent.partial` 快照，使流大小保持线性。

嵌套事件是以下之一：

| 类型 | 除 `type` 外的字段 | 含义 |
|---|---|---|
| `start` | 无 | 提供商流开始；其累计 `partial` 字段在线上被移除。 |
| `text_start` | `contentIndex` | 文本块开始。 |
| `text_delta` | `contentIndex`、`delta` | 向块追加文本。 |
| `text_end` | `contentIndex`、`content` | 文本块以权威内容结束。 |
| `thinking_start` | `contentIndex` | 思考块开始。 |
| `thinking_delta` | `contentIndex`、`delta` | 向块追加思考文本。 |
| `thinking_end` | `contentIndex`、`content` | 思考块以权威内容结束。 |
| `toolcall_start` | `contentIndex`、`id`、`toolName` | 工具调用块开始。 |
| `toolcall_delta` | `contentIndex`、`delta` | 追加序列化的参数数据。 |
| `toolcall_end` | `contentIndex`、`toolCall` | 工具调用以完整 `ToolCall` 结束。 |
| `done` | `reason`、`message` | 提供商流成功完成。 |
| `error` | `reason`、`error` | 提供商流以错误或中止消息结束。 |

正常的 agent 循环把提供商级的 `start`、`done` 和 `error` 转换为 `message_start` 和 `message_end` 会话事件，而不是作为 `message_update` 发出。对于构造匹配会话事件的调用者，导出的 `JsonAgentSessionEvent` 转换仍然接受它们。

用 `contentIndex` 识别内容块。缓冲 `delta` 字段用于实时显示，但在 `text_end`、`thinking_end` 或 `toolcall_end` 中用完成的内容替换重建的数据。`message_end.message` 到达时用它替换整个部分消息。

顶层 `usage` 是该助手响应最新累计的提供商报告用量。当提供商流式传输期间不报告用量时，它在完成前可能保持为零。

```json
{"type":"message_update","usage":{"input":100,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":101,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello "}}
```

## 工具执行事件

| 事件 | 字段 | 含义 |
|---|---|---|
| `tool_execution_start` | `toolCallId`、`toolName`、`args` | 工具执行开始。 |
| `tool_execution_update` | `toolCallId`、`toolName`、`args`、`partialResult` | 工具报告了部分结果。 |
| `tool_execution_end` | `toolCallId`、`toolName`、`result`、`isError`、`durationMs` | 工具执行完成。`durationMs` 是工具的 `execute()` 耗时，用单调时钟测量；工具未运行时缺失。 |

用 `toolCallId` 关联生命周期。`partialResult` 是工具提供的最新部分结果。它替换还是扩展先前的更新取决于该工具的结果契约。

```json
{"type":"tool_execution_start","toolCallId":"call_abc123","toolName":"bash","args":{"command":"ls -la"}}
{"type":"tool_execution_update","toolCallId":"call_abc123","toolName":"bash","args":{"command":"ls -la"},"partialResult":{"content":[{"type":"text","text":"partial output"}],"details":{}}}
{"type":"tool_execution_end","toolCallId":"call_abc123","toolName":"bash","result":{"content":[{"type":"text","text":"complete output"}],"details":{}},"isError":false}
```

## 队列与状态事件

| 事件 | 字段 | 含义 |
|---|---|---|
| `queue_update` | `steering`、`followUp` | 待处理的 steering 或 follow-up 队列发生变化。两个字段都包含完整的当前队列。 |
| `entry_appended` | `entry` | 扩展通过 `pi.appendEntry()` 追加了自定义会话条目。 |
| `session_info_changed` | `name` | 会话显示名称改变。`name` 缺失表示被清除。 |
| `thinking_level_changed` | `level` | 活动思考级别改变。 |

`entry` 值使用持久化的[会话条目类型](session-format.zh-CN.md#entry-types)。

## 压缩事件

`compaction_start` 报告压缩开始的原因：

```json
{"type":"compaction_start","reason":"threshold"}
```

`reason` 是 `"manual"`、`"threshold"` 或 `"overflow"`。

`compaction_end` 在压缩成功时包含结果：

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {"...": "..."},
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}
```

压缩被中止时，`result` 缺失且 `aborted` 为 true。压缩失败时，`result` 缺失、`aborted` 为 false，`errorMessage` 描述失败。成功的溢出恢复会在 Pi 重试提示词前把 `willRetry` 设为 true。

结果语义见[压缩与分支摘要](compaction.zh-CN.md)。

## 重试事件

助手轮次重试发出：

```json
{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529 overloaded"}
{"type":"auto_retry_end","success":true,"attempt":2}
```

最终失败时，`auto_retry_end` 带有 `success: false` 和 `finalError` 字符串。

压缩和分支摘要重试发出：

```json
{"type":"summarization_retry_scheduled","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"terminated"}
{"type":"summarization_retry_attempt_start","source":"compaction","reason":"threshold"}
{"type":"summarization_retry_finished"}
```

分支摘要时 `source` 是 `"branchSummary"` 且 `reason` 缺失。压缩重试的 `reason` 是 `"manual"`、`"threshold"` 或 `"overflow"`。

## 仅 RPC 的事件

直接 RPC 的 [`bash`](rpc-commands.zh-CN.md#bash) 命令对每个输出块发出一条 `bash_execution_update`。其可选 `id` 匹配命令 ID。最终命令响应可能包含截断的输出，但这些事件流式输出全部输出：

```json
{"type":"bash_execution_update","id":"req-1","delta":"total 48\n"}
```

RPC 还在扩展处理器抛异常时增加 `extension_error`：

```json
{"type":"extension_error","extensionPath":"/path/to/extension.ts","event":"tool_call","error":"Error message"}
```

扩展 UI 记录是一个独立的 RPC 子协议，不是 `AgentSessionEvent` 值。见 [RPC 扩展 UI](rpc-extension-ui.zh-CN.md)。

## TypeScript 类型

SDK 的 `AgentSessionEvent` 为进程内消费者包含累计的流式快照。JSON 和 RPC 只转换 `message_update`：

```typescript
type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type JsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
  ? WithoutPartial<T> & { id: string; toolName: string }
  : WithoutPartial<T>;

type JsonAgentSessionEvent =
  | Exclude<AgentSessionEvent, { type: "message_update" }>
  | {
      type: "message_update";
      usage: Usage;
      assistantMessageEvent: JsonAssistantMessageEvent<AssistantMessageEvent>;
    };
```

使用从 `@earendil-works/pi-coding-agent` 导出的 `JsonAgentSessionEvent` 类型。其实现在 [`json-event.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/json-event.ts)。

## 示例

打印单次运行中完成的消息：

```bash
pi --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
