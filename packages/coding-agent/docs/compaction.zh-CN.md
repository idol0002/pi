# 压缩（Compaction）参考

本参考描述自动压缩、分支摘要、持久化条目和扩展钩子。用户工作流见[会话与上下文](sessions.zh-CN.md#manage-conversation-context)。

**源文件**（[pi](https://github.com/earendil-works/pi)）：
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) - 自动压缩逻辑
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) - 分支摘要
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts) - 共享工具（文件跟踪、序列化）
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts) - 条目类型（`CompactionEntry`、`BranchSummaryEntry`）
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) - 扩展事件类型

项目中的 TypeScript 定义请查看 `node_modules/@earendil-works/pi-coding-agent/dist/`。

## 概述

Pi 有两种摘要机制：

| 机制 | 触发方式 | 用途 |
|-----------|---------|---------|
| 压缩 | 上下文超过阈值，或 `/compact` | 摘要旧消息以释放上下文 |
| 分支摘要 | `/tree` 导航 | 切换分支时保留上下文 |

两者使用紧密相关的结构化格式，并累计跟踪文件操作。摘要请求会禁用提示词缓存写入，因为这类一次性提示词不太可能被复用。

## 压缩

### 触发时机

自动压缩在以下条件触发：

```
contextTokens > contextWindow - reserveTokens
```

默认 `reserveTokens` 为 16384 token（可在 `~/.pi/agent/settings.json` 或 `<project-dir>/.pi/settings.json` 配置）。它只决定压缩何时开始。摘要请求使用模型的输出上限，必要时调低以使输入和输出适配上下文窗口。

在多轮 agent 运行中，Pi 在工具完成且结果被追加之后、开始下一条助手响应之前，检查规范投影上下文。若越过阈值，Pi 在 `prepareNextTurn` 期间压缩，然后在 `turn_start` 之前执行既有的补偿性 steering 轮询。当完成的工具批次终止了运行且没有排队消息需要再次响应时，Pi 跳过这一轮间检查。Pi 还会在新用户提示词之前检查，并在底层运行结束后执行最终尝试的溢出恢复。

提供商上下文溢出错误或过早的最终 `stopReason: "length"` 可以选择一次"压缩后重试"的恢复尝试。带工具调用的 length 响应会保留其合成的失败工具结果，并走普通的工具/队列调度，而不是强制结束运行。

你也可以用 `/compact [instructions]` 手动触发，可选的 instructions 用于聚焦摘要内容。

### 工作方式

1. **找切点**：在已定稿的会话投影中向前回溯，累计 token 估算，直到达到 `keepRecentTokens`（默认 20k，可在 `~/.pi/agent/settings.json` 或 `<project-dir>/.pi/settings.json` 配置）
2. **提取消息**：收集从上一个保留边界（或会话开始）到切点之间的投影消息
3. **生成摘要**：调用 LLM 以结构化格式生成摘要，若有上一次摘要则作为迭代上下文传入
4. **追加条目**：保存带摘要和 `firstKeptEntryId` 的 `CompactionEntry`
5. **重建上下文**：会话为下一个请求重建上下文，使用摘要 + 从 `firstKeptEntryId` 起的消息

```
压缩前：

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

压缩后（追加了新条目）：

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 不发送给 LLM                    发送给 LLM
                                                         ↑
                                              从 firstKeptEntryId 开始

LLM 看到的内容：

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   来自 cmp          来自 firstKeptEntryId 的消息
```

重复压缩时，被摘要的范围从上一次压缩的保留边界（`firstKeptEntryId`）开始，而不是从压缩条目本身开始；若该保留条目在路径中找不到，则回退到上一次压缩条目之后的条目。不保留任何内容的压缩会把自己的 ID 记为 `firstKeptEntryId`；重复压缩从该条目之后开始。这样，上一次压缩后幸存的消息会再次包含在下一次摘要中。Pi 还会在写入新 `CompactionEntry` 之前，从重建后的、经上下文编辑的会话投影重新计算 `tokensBefore`，因此 token 计数反映被替换的真实压缩前上下文。被省略的原始条目仍会存储，但不影响切点选择、摘要、检查点或 token 估算。

### 溢出与长度恢复的顺序

恢复保持既有的生命周期和队列顺序。已完成的尝试对 `turn_end` 和 `agent_end` 仍然可见；运行后恢复在新重试之前修复持久化的模型上下文：

```text
持久化最终助手响应
→ 扩展/公开 turn_end
→ 扩展/公开 agent_end
→ 为所选尝试追加 context_edit 省略
→ 溢出/长度：运行 session_before_compact，成功则追加压缩
→ 以全新运行开始重试
```

若恢复压缩失败或被取消，Pi 保留省略编辑、不追加压缩，也不调度内部重试。已有的排队工作仍受普通 steering 和 follow-up 规则约束。`agent_before_settle` 看到的是恢复处理之后修复过的投影。原始转录历史、导出、计费总额和历史搜索扩展仍可检查被省略的尝试。

### 拆分的用户消息跨度

用户消息跨度以一条用户消息开始，包含直到下一条用户消息前的所有轮次。通常压缩在用户消息边界切割。

当单个用户消息跨度超过 `keepRecentTokens` 时，切点落在该跨度内某条助手消息上。这是一个拆分的用户消息跨度：

```
拆分的用户消息跨度（单跨度超出预算）：

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  （没有更早的用户消息跨度）
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

对于拆分的用户消息跨度，Pi 生成两个摘要并合并：
1. **历史摘要**：之前的上下文（如有）
2. **用户消息跨度前缀摘要**：拆分跨度的早期部分

### 切点规则

有效切点是：
- 用户消息
- 助手消息
- BashExecution 消息
- 自定义消息（custom_message、branch_summary）

绝不在工具结果处切割（它们必须与其工具调用保持在一起）。

仅当上下文不可见的后缀包含一条被省略的助手尝试、且没有未被省略的会产生上下文的条目时，准备工作才会把保留边界推进到该后缀中。恢复产生的 `context_edit` 省略满足此规则；本质上上下文不可见的元数据可与它们共存。仅有元数据、以及新追加的自定义消息不会移动切点。影响候选输入或被摘要前缀的替换编辑也会阻止推进，因为被省略的助手回答的是编辑前的输入；对最终被省略的后缀条目的替换仍是安全的。这使得超预算的恢复输入可以被摘要，同时保留让被放弃尝试保持省略的编辑，而不会让簿记逻辑改变新模型输入是否被原样保留。

### CompactionEntry 结构

定义于 [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)：

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;       // 生成摘要的 LLM 用量
  fromHook?: boolean;  // 由扩展提供时为 true（旧字段名）
  details?: T;         // 实现相关的数据
}

// 默认压缩用此结构作为 details（来自 compaction.ts）：
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

扩展可以在 `details` 中存储任何可 JSON 序列化的数据。默认压缩跟踪文件操作，自定义扩展实现可以使用自己的结构。生成的和扩展提供的摘要在可用时存储其 LLM `usage`，因此会话总额包含摘要工作。

实现见 [`prepareCompaction()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) 和 [`compact()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts)。直接编程式摘要时，`generateSummary()` 返回摘要文本，`generateSummaryWithUsage()` 返回 `{ text, usage }`。

## 分支摘要

### 触发时机

当你用 `/tree` 导航到另一个分支时，Pi 会提议摘要你即将离开的工作。这会把离开分支的上下文注入新分支。

### 工作方式

1. **找公共祖先**：新旧位置共享的最深节点
2. **收集条目**：从旧叶子回溯到公共祖先
3. **按预算准备**：按 token 预算（最新的优先）纳入消息
4. **生成摘要**：以结构化格式调用 LLM
5. **追加条目**：在导航点保存 `BranchSummaryEntry`

```
导航前的树：

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

公共祖先：A
待摘要条目：B, C, D

带摘要导航后：

         ┌─ B ─ C ─ D
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### 累计文件跟踪

默认压缩和分支摘要累计跟踪文件。两者都从被摘要消息中的工具调用提取文件操作。压缩还会携带上一次 Pi 生成的压缩中的文件列表。分支摘要会携带其被摘要条目中 Pi 生成的分支摘要的文件列表。

因此文件跟踪在多次默认压缩和嵌套的默认分支摘要之间累计。Pi 不会自动携带 `fromHook` 为 `true` 的扩展生成摘要的文件列表；扩展自行管理其 `details` 格式。

### BranchSummaryEntry 结构

定义于 [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)：

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  fromId: string;      // 导航出发的条目
  usage?: Usage;       // 生成摘要的 LLM 用量
  fromHook?: boolean;  // 由扩展提供时为 true（旧字段名）
  details?: T;         // 实现相关的数据
}

// 默认分支摘要用此结构作为 details（来自 branch-summarization.ts）：
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

与压缩相同，扩展可以在 `details` 中存储自定义数据。

实现见 [`collectEntriesForBranchSummary()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts)、[`prepareBranchEntries()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) 和 [`generateBranchSummary()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts)。

## 摘要格式

两种格式都包含 Goal、Constraints & Preferences、Progress、Key Decisions 和 Next Steps。压缩摘要还包含 Critical Context。分支摘要在 Next Steps 后结束。相关时 Pi 会在任一格式后附加文件列表。

压缩摘要使用此格式：

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### 消息序列化

摘要前，消息通过 [`serializeConversation()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts) 序列化为文本：

```
[User]: What they said
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

这防止模型把它当作要继续的对话。

思考块（thinking blocks）被省略。提供商返回的是真实推理的摘要，且回放的思考通常不属于模型的实时上下文，包含它可能使摘要请求大于它所摘要的上下文。

工具结果在序列化时截断到 2000 字符。超出部分被替换为指示截断字符数的标记。这使摘要请求保持在合理的 token 预算内，因为工具结果（尤其来自 `read` 和 `bash`）通常是上下文大小的最大来源。

## 通过扩展自定义摘要

扩展可以拦截并自定义压缩和分支摘要。事件类型定义见 [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)。

### session_before_compact

在自动压缩或 `/compact` 之前触发。可以取消或提供自定义摘要。见类型文件中的 `SessionBeforeCompactEvent` 和 `CompactionPreparation`。

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // preparation.messagesToSummarize - 待摘要消息
  // preparation.turnPrefixMessages - 用户消息跨度前缀（isSplitTurn 时）
  // preparation.previousSummary - 上一次压缩摘要
  // preparation.fileOps - 提取的文件操作
  // preparation.tokensBefore - 压缩前的上下文 token 数
  // preparation.firstKeptEntryId - 保留消息的起始位置
  // preparation.settings - 应用模型覆盖后的生效设置

  // branchEntries - 当前分支上的所有条目（用于自定义状态）
  // reason - "manual" (/compact)、"threshold" 或 "overflow"
  // willRetry - 被中止的轮次是否会在压缩后重试（溢出恢复）
  // signal - AbortSignal（传给 LLM 调用）

  // 取消：
  return { cancel: true };

  // 自定义摘要：
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage, // 可选；计入会话总额
      details: { /* custom data */ },
    }
  };
});
```

#### 把消息转换为文本

要用你自己的模型生成摘要，用 `serializeConversation` 把消息转换为文本：

```typescript
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;

  // 把 AgentMessage[] 转为 Message[]，再序列化为文本
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // 返回：
  // [User]: message text
  // [Assistant]: response text
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: output text

  // 现在发送给你的模型做摘要
  const { summary, usage } = await myModel.summarize(conversationText);

  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage,
    }
  };
});
```

使用不同模型的完整示例见 [custom-compaction.ts](../examples/extensions/custom-compaction.ts)。

### session_compact_failed

在手动或自动压缩失败或被中止时触发。对需要把 `session_before_compact` 尝试与最终结果配对的遥测扩展有用。

```typescript
pi.on("session_compact_failed", async (event, ctx) => {
  const { reason, errorMessage, aborted, willRetry, fromExtension } = event;
  // reason - "manual" (/compact)、"threshold" 或 "overflow"
  // errorMessage - 非中止失败时存在
  // aborted - 取消/中止的压缩为 true
  // willRetry - 被中止的轮次本是否会在压缩后重试
  // fromExtension - 是否正在使用扩展提供的压缩内容
});
```

### session_before_tree

在 `/tree` 导航之前触发。无论用户是否选择摘要都会触发。可以取消导航或提供自定义摘要。

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - 导航目标
  // preparation.oldLeafId - 当前位置（将被放弃）
  // preparation.commonAncestorId - 共享祖先
  // preparation.entriesToSummarize - 将被摘要的条目
  // preparation.userWantsSummary - 用户是否选择摘要

  // 完全取消导航：
  return { cancel: true };

  // 提供自定义摘要（仅在 userWantsSummary 为 true 时使用）：
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        // usage: summaryResponse.usage, // 可选；计入会话总额
        details: { /* custom data */ },
      }
    };
  }
});
```

见类型文件中的 `SessionBeforeTreeEvent` 和 `TreePreparation`。

## 设置

在 `~/.pi/agent/settings.json` 或 `<project-dir>/.pi/settings.json` 中配置压缩：

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| 设置 | 默认值 | 描述 |
|---------|---------|-------------|
| `enabled` | `true` | 启用自动压缩 |
| `reserveTokens` | `16384` | 低于该空闲上下文 token 数时自动压缩启动 |
| `keepRecentTokens` | `20000` | 保留（不摘要）的近期 token 数 |

用 `"enabled": false` 禁用自动压缩。你仍可用 `/compact` 手动压缩。

### 按模型覆盖

用 `compaction.modelOverrides` 为不同模型调整 token 预算：

```json
{
  "compaction": {
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "some-provider/big-model": {
        "reserveTokens": 400000
      }
    }
  }
}
```

对 1M 上下文窗口的模型，此覆盖使压缩在 600K token 以上触发，并保留普通的 20000 近期 token。其他模型保留普通的 16384 token 预留。

键是精确、区分大小写的 `provider/modelId` 值，包括模型 ID 内部的斜杠。每个 `reserveTokens` 和 `keepRecentTokens` 值独立回退：从模型覆盖到普通设置再到内置默认。值必须是非负安全整数。匹配的模型覆盖中的非法值在读取时报错；只有省略的字段才回退到普通设置。模型覆盖条目必须是对象。普通 token 设置非法时读取即报错，即使当前模型有合法覆盖。只有省略的普通值才使用内置默认。`enabled` 保持全局，不按模型区分。

这些解析值用于手动压缩、所有自动阈值检查、溢出恢复以及扩展可见的 `preparation.settings`。切换模型影响后续检查和压缩，不改变普通设置。已在进行中的压缩使用该操作捕获的模型和设置。分支摘要设置不受影响。

覆盖在全局和项目设置中都可用。文件在查找前递归合并，因此全局的模型特定值优先于项目级回退；项目必须覆盖该模型条目才能改变它。详见[设置](settings.zh-CN.md#per-model-compaction-overrides)。
