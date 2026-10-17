# 会话文件格式

会话以 JSONL（JSON Lines）文件存储。每行是一个带 `type` 字段的 JSON 对象。会话条目通过 `id`/`parentId` 字段构成树结构，支持原地分支而不创建新文件。

编程式创建、持久化和树导航见 [`SessionManager` API](sdk.zh-CN.md#sessionmanager-api)。


## 文件位置

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
```

默认 `<session-id>` 是 UUID。调用者可以通过 SDK 或 `--session-id` 提供自定义 ID。对 `<path>`，Pi 去掉前导路径分隔符，并把 `/`、`\\` 和 `:` 替换为 `-`。

## 删除会话

删除 `~/.pi/agent/sessions/` 下的 `.jsonl` 文件即可移除会话。

Pi 也支持从 `/resume` 交互式删除会话（选择会话并按 `Ctrl+D`，然后确认）。可用时 pi 使用 `trash` CLI 避免永久删除。

## 会话版本

会话在头部有版本字段：

- **版本 1**：线性条目序列（旧版，加载时自动迁移）
- **版本 2**：带 `id`/`parentId` 链接的树结构
- **版本 3**：`hookMessage` 角色更名为 `custom`（扩展统一）

现有会话在加载时自动迁移到当前版本（v3）。

## 源文件

GitHub 源码（[pi](https://github.com/earendil-works/pi)）：
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts) - 会话条目类型和 SessionManager
- [消息类型](message-types.zh-CN.md) - 共享消息与内容块参考
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/messages.ts) - 扩展消息类型
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) - 基础消息与内容块类型
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts) - 可扩展的 `AgentMessage` 联合类型

项目中的 TypeScript 定义请查看 `node_modules/@earendil-works/pi-coding-agent/dist/` 和 `node_modules/@earendil-works/pi-ai/dist/`。

## 消息

`message` 条目存储一个 [`AgentMessage`](message-types.zh-CN.md)。消息内容块、角色、用量和消息时间戳定义在[消息类型](message-types.zh-CN.md)中。

会话条目时间戳是 ISO 8601 字符串。嵌套消息时间戳是毫秒级 Unix 时间戳。

## 条目基类

所有条目（除 `SessionHeader`）都扩展 `SessionEntryBase`：

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // 通常是 8 字符十六进制 ID；可能回退为完整 UUID
  parentId: string | null;  // 父条目 ID（根条目为 null）
  timestamp: string;    // ISO 时间戳
}
```

## 条目类型

### SessionHeader

文件第一行。仅元数据，不属于树（没有 `id`/`parentId`）。

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

有父会话的会话（通过 `/fork`、`/clone` 或 `newSession({ parentSession })` 创建）：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### SessionMessageEntry

对话中的一条消息。`message` 字段包含一个 `AgentMessage`。系统消息携带提示词和工具配置：会话的第一个请求持久化一条包含全部提示词段落和工具声明的系统消息，后续变更持久化为按名称修补 `sections`（`null` 表示移除某段）并列出 `toolsAdded`/`toolsRemoved` 的系统消息。按顺序回放它们即得到当前提示词和工具；没有单独的提示词状态条目。

```json
{"type":"message","id":"a0b1c2d3","parentId":null,"timestamp":"2024-12-03T14:00:00.000Z","message":{"role":"system","content":"","sections":{"preamble":"You are an expert coding assistant...","tools":"<tools>\n- read: ...\n</tools>","cwd":"/project"},"toolsAdded":[{"name":"read","description":"...","parameters":{}}],"timestamp":1733234400000}}
{"type":"message","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:04:00.000Z","message":{"role":"system","content":"","sections":{"skills":"<skills>...</skills>"},"toolsRemoved":[{"name":"write"}],"timestamp":1733234640000}}
```

系统消息出现之前创建的会话没有前导系统消息；第一个请求把当前提示词声明为后续的系统消息，回放方式相同。

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello","timestamp":1733234401000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop","timestamp":1733234402000}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false,"timestamp":1733234403000}}
```

助手消息标注生成它的模型。较新的消息还记录 `thinkingLevel`，即该响应请求的 Pi 思考级别。

### ModelChangeEntry

用户在会话中切换模型时产生。最新条目是所选模型，可能是[虚拟模型](virtual-models.zh-CN.md)；之后的助手消息标注实际回答的物理模型。

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

用户更改思考/推理级别时产生。

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### UsageEntry

记录归属到模型、但不是助手消息且不参与 LLM 上下文的用量。`kind` 是标识操作的任意字符串；例如缓存温热使用 `"cache_warm"`。

```json
{"type":"usage","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:08:00.000Z","kind":"cache_warm","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":0,"output":0,"cacheRead":50000,"cacheWrite":0,"totalTokens":50000,"cost":{"input":0,"output":0,"cacheRead":0.015,"cacheWrite":0,"total":0.015}}}
```

用量条目计入会话 token 和成本总额。Pi 在对话树中隐藏它们。消费者应把未知的 `kind` 值当作正常用量处理，而不是拒绝。

### CompactionEntry

上下文被压缩时创建。存储较早消息的摘要和完整的系统提示词/工具检查点。

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000,"systemMessage":{"role":"system","content":"You are a coding assistant.","toolsAdded":[],"timestamp":1733235000000}}
```

`firstKeptEntryId` 是必需的。它标识压缩条目之前保留的第一个条目。重建上下文时，Pi 用压缩摘要替换更早的被摘要条目，并保留从该条目开始的范围。不保留任何内容的压缩把自己的 ID 存入该字段，因此不保留任何先前条目。

可选字段：
- `systemMessage`：压缩边界处回放的提示词段落和工具声明；它成为压缩后上下文的前导系统消息，保留条目中的系统消息被丢弃以让它优先。较旧的会话条目上没有该字段。
- `usage`：生成摘要的 LLM 用量；计入会话 token 和成本总额
- `details`：实现相关的数据（默认为 `{ readFiles: string[], modifiedFiles: string[] }`，扩展可用自定义数据）
- `fromHook`：由扩展生成时为 `true`，pi 生成为 `false`/`undefined`（旧字段名）

### ContextEditEntry

对较早的会产生上下文的条目的只追加编辑。它只改变未来的模型上下文；目标条目及其元数据在原始历史、UI、导出和会话核算中保持不变。

```json
{"type":"context_edit","id":"g6h7i8j9","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:11:00.000Z","targetId":"c3d4e5f6","replacement":null}
```

目标可以是用户、助手、工具结果或自定义消息条目。`replacement: null` 把目标从模型上下文中省略。非 null 的 `replacement` 只替换目标消息内容。助手和工具结果条目的字符串替换会规范化为一个文本块，因为这些角色要求内容数组。多个编辑指向同一目标时，活动分支上最新的编辑生效。编辑是分支相对的：导航到编辑之前的点会重新显示目标的原始贡献。

### BranchSummaryEntry

通过 `/tree` 切换分支时创建，包含对离开分支直到公共祖先的 LLM 生成摘要。捕获被放弃路径的上下文。

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

`parentId` 是新分支延续的条目。`fromId` 是其被放弃路径被摘要的前一个叶子。

可选字段：
- `usage`：生成摘要的 LLM 用量；计入会话 token 和成本总额
- `details`：文件跟踪数据（`{ readFiles: string[], modifiedFiles: string[] }`），扩展可用自定义数据
- `fromHook`：由扩展生成时为 `true`，pi 生成为 `false`/`undefined`（旧字段名）

### CustomEntry

扩展状态持久化。不参与 LLM 上下文。

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

用 `customType` 在重载时识别你扩展的条目。交互模式可以通过 `pi.registerEntryRenderer(customType, renderer)` 渲染自定义条目，但它们仍不参与 LLM 上下文。

Pi 把[虚拟模型](virtual-models.zh-CN.md)路由器状态存为 `customType` 为 `pi.virtual-model-state`、`data` 为 `{ provider, modelId, state }` 的自定义条目。

### CustomMessageEntry

扩展注入的、参与 LLM 上下文的消息。

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

字段：
- `content`：字符串或 `(TextContent | ImageContent)[]`（与 UserMessage 相同）
- `display`：`true` = 在 TUI 中以独特样式显示，`false` = 隐藏
- `details`：可选的扩展特定元数据（不发送给 LLM）

### LabelEntry

用户在条目上定义的书签/标记。

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

把 `label` 设为 `undefined` 可清除标签。

### SessionInfoEntry

会话元数据（如用户定义的显示名称）。通过 `/name`、`--name` / `-n` 或扩展中的 `pi.setSessionName()` 设置。

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

设置了会话名称时，会话选择器（`/resume`）中显示名称而非第一条消息。

## 树结构

条目通常构成一棵树，但导航 API 可以创建多个根：
- 根条目的 `parentId: null`；最初第一个条目是根
- 每个非根条目通过 `parentId` 指向其父条目
- 分支从较早的条目创建新的子节点
- "叶子"是树中的当前位置
- 调用 `resetLeaf()` 或 `branchWithSummary(null, ...)` 可以让后续条目成为另一个根

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## 上下文构建

`buildContextEntries()` 从当前叶子走到根，在遵守压缩的同时产出活动条目列表：

1. 收集路径上的所有条目
2. 若路径上有一个或多个 `CompactionEntry`，使用最新那个：
   - 先包含压缩条目
   - 包含从 `firstKeptEntryId` 到（不含）压缩条目之间的非系统条目
   - 包含压缩条目之后的条目
3. 保留所选范围内的非消息条目，供交互模式渲染

`buildSessionProjection()` 然后对每个所选目标应用最新的 `context_edit`。它返回模型可见的消息及其来源条目。被省略的目标不产生消息；替换保留来源条目的角色和元数据，只改变内容。原始所选条目不被修改。

`buildSessionContext()` 在该投影之上构建发给 LLM 的消息列表：

1. 从完整路径提取当前模型和思考级别设置
2. 把所选条目转换为消息：
   - `message` -> 存储的 `AgentMessage`
   - `compaction` -> 完整系统检查点，后跟 `compactionSummary`
   - `branch_summary` -> `branchSummary`
   - `custom_message` -> `CustomMessage`
   - `context_edit` -> 本身不产生上下文消息
   - `usage` 和 `custom` -> 不产生上下文消息

压缩摘要替换 `firstKeptEntryId` 之前的条目。压缩前的系统消息被折叠进完整检查点，而不是从保留范围回放。保留的非系统条目和压缩之后的全部条目对 LLM 保持可用。

## 解析示例

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "usage":
      console.log(`[${entry.id}] Usage (${entry.kind}): ${entry.usage.totalTokens} tokens`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```
