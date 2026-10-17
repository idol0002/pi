# Durable 规格说明

`@earendil-works/pi-durable` 是一个持久化、可扩展的 agent 运行时框架（harness）。本文档是规范性文档。它按如下方式使用现有包的类型：

```ts
import type {
  AttachedReplicatedState,
  Context,
  Draft,
  JsonRepresentation,
  JsonValue,
  ReplicatedState,
} from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type {
  AssistantMessage,
  CacheRetention,
  DeferredHandle,
  Message,
  Models,
  ModelThinkingLevel,
  TextContent,
  Tool,
  ToolCall,
  ToolReference,
  ToolResultMessage,
  Transport,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

type JsonObject = { [key: string]: JsonValue };
type TaskOutcomeError = { message: string; detail?: JsonValue };
```

Durable 面向 pi-ai PR [#9548](https://github.com/earendil-works/pi/pull/9548) 的 transcript `SystemMessage` 契约。该 PR 合入后，`Message` 即包含该类型。

核心规则是：

> 一个 Session 原子性地提交不可变条目（entry）、完整任务记录以及由 Chord 跟踪的文档。只有已提交的状态才是可观察的。

## 1. 术语与不变量

- 一个 **Session**（会话集）拥有一条变更线（mutation line）、多个会话、条目、任务、提交和文档。
- 一个 **conversation**（会话）是一个 transcript 作用域。它可以分叉（fork）另一个会话。
- 一个 **entry**（条目）是一条不可变的 transcript 记录。
- 一个 **task**（任务）是附着在某个会话上的持久化状态机。
- 一个 **document**（文档）是可变的 JSON 状态，由 Chord 操作和偶尔的完整基线（base）表示。
- 一个 **definition**（定义）是描述一个文档或一类文档的类型化令牌。
- 一个 **source**（源）向 Chord 暴露已提交的文档变更，但不暴露可变对象。
- 一个 **turn**（回合）是一次助手响应及其发起的工具调用。一次 **run**（运行）是从一条被接纳的输入到最终答案之间的回合序列；回合边界（第 6 节）位于它的各回合之间。当一次运行处于活动状态时，会话是忙碌的。

必须满足的不变量：

1. 一次 Session 提交对所有记录写入和文档写入是原子的。
2. 文档更新只有在其存储提交成功之后才会发布。
3. 所有可见的进展都是持久的。不存在易失性的发布路径。
4. 外部副作用不在 Session 的变更事务内运行。
5. 条目和 ID 在提交写入后不可变，且永不复用。
6. 文档草稿（draft）在其事务回调落定（settle）时被完全撤销：Session 会在此刻同步地准备（prepare）或中止（abort）每一个打开的变更。赋值进草稿的值按值复制，且必须是严格 JSON。
7. 变更线在存储落定和已提交状态采纳（adoption）期间始终保持持有。提交/关闭观察者只在捕获不可变状态时同步运行；文档状态和 watch 用户回调稍后在变更线之外运行。
8. 存储错误对打开的 Session 是致命的（第 10.1 节）。它不发布任何内容，必须重新打开。准备（preparation）与检查点（checkpoint）失败发生在存储接纳之前，并正常回滚。

## 2. 核心记录

具体的 JSON 表示可以添加簿记字段，但必须保留以下契约。

```ts
declare const idBrand: unique symbol;
type Id<Kind extends string, Type = unknown> = number & {
  readonly [idBrand]: {
    readonly kind: Kind;
    readonly type: Type;
  };
};
type ConversationId = Id<"conversation">;
type EntryId = Id<"entry">;
type TaskId<Result = unknown> = Id<"task", Result>;
type SubmissionId = Id<"submission">;
type DocumentId = Id<"document">;

declare const seqBrand: unique symbol;
/** 在两次提交之间严格递增；允许出现间隔。 */
type Seq = number & { readonly [seqBrand]: "sequence" };
const ROOT_CONVERSATION_ID = 1 as ConversationId;

type ConversationOwnership =
  | { readonly kind: "ownerless" }
  | { readonly kind: "task"; readonly taskId: TaskId };

type ConversationRecord = {
  readonly id: ConversationId;
  readonly parent?: {
    readonly conversationId: ConversationId;
    readonly at: EntryId;
  };
  readonly owner?: {
    readonly conversationId: ConversationId;
    readonly taskId: TaskId;
  };
};
```
所引用的 pi-ai 成员是：

```ts
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
  timestamp: number;
}
```

在 pi-ai 中，`content` 在首条消息上是基础提示词，在后续消息上是附加的指令文本。`sections` 是有序的命名补丁：字符串表示添加或替换一个节（section），`null` 表示移除它。在同一条消息内，`toolsRemoved` 先于 `toolsAdded` 应用。按 transcript 顺序重放每条系统消息，即得到生效的提示词和工具集。

Durable 总是写入 `content: ""`。每个提示词部分，包括前言（preamble），都是一个从会话的 agent 解析出来的命名节（第 7.4 节）。

```ts
type ContextEdit = {
  readonly target: EntryId;
} & (
  | { readonly action: "omit"; readonly messages?: never }
  | { readonly action: "replace"; readonly messages: readonly Message[] }
);

type EntryRecord = {
  readonly id: EntryId;
  readonly conversationId: ConversationId;
  readonly kind: string;
  readonly model?: readonly Message[];
  readonly data?: JsonValue;
  readonly head?: EntryId;
  readonly edits?: readonly ContextEdit[];
  readonly byTaskId?: TaskId;
};

type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
  readonly head?: EntryId | "self";
};

type SubmissionRecordBase = {
  readonly id: SubmissionId;
  readonly conversationId: ConversationId;
  readonly requestId?: string;
};

type SubmissionRecord =
  | (SubmissionRecordBase & {
      readonly type: "input";
    } & (
      | {
          readonly status: "queued";
          readonly entry?: never;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "placed";
          readonly entry: EntryId;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "done";
          readonly entry: EntryId;
          readonly answer: EntryId;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "unanswered";
          readonly entry?: EntryId;
          readonly answer?: never;
          readonly reason: string;
          readonly detail?: JsonValue;
        }
    ))
  | (SubmissionRecordBase & {
      readonly type: "write";
    } & (
      | {
          readonly status: "queued";
          readonly entry?: never;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "done";
          readonly entry: EntryId;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "unanswered";
          readonly entry?: never;
          readonly answer?: never;
          readonly reason: string;
          readonly detail?: JsonValue;
        }
    ));

type SubmissionSettlement =
  | { readonly status: "done"; readonly answer: EntryId }
  | { readonly status: "unanswered"; readonly reason: string; readonly detail?: JsonValue };

type SubmissionCreate = SubmissionRecord extends infer Record
  ? Record extends SubmissionRecord
    ? Omit<Record, "id">
    : never
  : never;
```

ID 品牌（brand）只存在于编译期。ID 和序列号在内存、JSON、JSONL 和 SQLite 中仍是普通数字。代码只在受信任的创建或解码边界上施加品牌。独立的序列号品牌防止实体 ID 被当作文档提交点使用。

会话的谱系父子关系（parent）与任务归属（owner）是分开的：

- `parent` 控制继承的条目和历史文档。
- `owner` 记录任务归属，并为子树中止和空闲遍历连接作用域。它不是访问控制能力。
- 创建时总是显式提供 `ConversationOwnership`。Session 从具名任务推导出被持久化的 owner 所属的会话；调用者从不构造持久化的 owner 对。

拥有任务变为终态后，会话的 owner 仍保持记录。

### 2.1 条目与上下文

条目 ID 是 Session 全局且有序的。`parent.at` 是父历史中子会话可见的一个条目。

活动 transcript 是从最新生效的 `head` 到末尾（tail）之间的原始条目范围。条目上的 head 改变其后的上下文；它不会把更早的条目从存储中移除。分叉遍历是先子条目，再经每个 `parent.at` 截断点回溯父条目。

上下文推导：

1. 找到截止点之前（含）最新的、带 `head` 的可见条目 `H`。
2. 令 `from = H.head`；若 `H` 不存在，则从 transcript 开头开始。
3. 从 `from` 扫描到截止点的可见条目。
4. 对每个编辑目标，该范围内最新的编辑生效。`omit` 不贡献任何模型消息；`replace` 用其 `messages` 替代目标的消息。
5. 若 `H` 存在，上下文条目是 `H` 加上该范围内不带 head 的条目；否则就是该范围本身。
6. 保留每条位置性系统消息及其工具/节变更。
7. 把每个助手消息的工具结果（在下一个助手消息之前找到的那些）按工具调用顺序直接移到它后面，置于任何插在中间的用户或系统消息之前。提供方协议要求结果紧跟其调用。
8. 为每个没有结果补上合成的错误结果，例如分叉截断之后或中断的末尾。丢弃没有前置调用的工具结果。
9. 把无模型条目，以及停止原因为 `aborted`、`error` 或 `deferred` 的助手消息，排除在后续提供方请求之外。
10. 当系统消息前面只有用户消息，或它属于基线（baseline）时，把第一条系统消息移到最前面：即 `H` 之后的第一条 `pi.system` 条目，除非有编辑以它为目标。Generation 会在压缩（compaction）或重置（reset）后的第一个请求之前，写入包含当时全部生效节和工具的系统消息，并省略被保留的 `pi.system` 条目。没有 `H` 时，第一条 `pi.system` 条目就是基线，除非更早的条目携带了系统消息——无论是在其消息里还是在某次编辑的替换内容里，即使该消息后来被某次编辑 omit 掉也算：只有在这种情况下，generation 才是带着全部生效的节和工具写入它的，或是在第一个请求之前、或是在原本没有任何 agent 的会话获得一个 agent 之后。一次运行的输入会在 generation 渲染系统提示词之前提交，所以除此之外上下文会以该输入开头，或以保留的历史开头（包括助手消息）。提供方只把最前面的系统消息当作初始提示词和工具集；没有它，后面的工具变更会重写请求的工具列表，并使整个提示词缓存失效。只有第一条系统消息会移动，因此重放得到相同的节和工具。任何前面已有助手消息的其他系统消息都留在原地，因为移动它会改变其含义；因此，若基线之前还有另一类的保留系统消息，基线就无法居于最前。存储条目和 `contributions` 保持已提交的顺序。

视图（View）携带原始的活动条目。UI 归约和模型上下文归约是两个独立的消费者。更早的存储历史可通过所属 `Conversation` 对象基于游标的 `entries()` 扫描获取。

### 2.2 公开的 Harness 表面

这是 v1 的宿主侧 API。

```ts
type ModelRef = {
  readonly provider: string;
  readonly modelId: string;
};

type UserInput = UserMessage["content"];

type SubmissionDraft = {
  readonly requestId?: string;
} & (
  | {
      readonly type: "input";
      readonly content: UserInput;
      readonly whenBusy?: "steer" | "followUp" | "reject";
      readonly entry?: never;
    }
  | {
      readonly type: "write";
      readonly entry: EntryDraft;
      readonly content?: never;
      readonly whenBusy?: never;
    }
);

type InputSubmissionDraft = Extract<SubmissionDraft, { readonly type: "input" }>;

/** 在创建提交内运行，位于创建钩子和 `agent` 变更之后。 */
type ConversationInit = (tx: Tx, conversationId: ConversationId) => void | Promise<void>;

type ConversationCreateOptions = {
  readonly ownership: ConversationOwnership;
  /** 在创建提交内应用，位于创建钩子的复制之后、`init` 之前。 */
  readonly agent?: AgentChange;
  readonly init?: ConversationInit;
};

type AnyTask = {
  readonly definition: {
    readonly name: string;
    readonly version: number;
    readonly initial: unknown;
    readonly phases: Readonly<Record<string, unknown>>;
    readonly abort: unknown;
    readonly migrate?: unknown;
    readonly hooks?: object;
  };
};

type HarnessOptions<Tool extends ToolRegistration = ToolRegistration> = {
  /** pi-ai 的 Models 接口，或返回当前接口的函数；每次使用时调用。 */
  readonly models: Models | (() => Models);
  readonly registry: RegistryReader<Tool>; // 见 7.1 节
  /** 运行设置，或返回当前设置的函数；无论哪种都在每次使用时读取。 */
  readonly settings?: HarnessSettings | (() => HarnessSettings | undefined);
  /** 构建会话的环境。绝不在 Session 线上调用；可以是异步的。 */
  readonly env?: (
    target: { readonly conversationId: ConversationId; readonly cwd?: string; readonly read: DocumentReader },
    context: Context,
  ) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
  /** 在每个创建或分叉会话的提交中运行，位于内置创建钩子（见下）之后。 */
  readonly conversationCreated?: (tx: Tx, conversation: ConversationRecord) => void | Promise<void>;
  /** 用于睡眠、重试、消息时间戳和任务生命周期时间的墙上时钟。默认 `Date.now`。 */
  readonly now?: () => number;
  /** 不使调用操作失败的失败，以及 Session 自身的失败；各通知一次（第 10.1 节）。 */
  readonly onReport?: (error: unknown) => void;
};

/** 精选的 pi-ai 请求选项；缺席字段使用 pi-ai 默认值。 */
type ConversationStreamOptions = {
  transport?: Transport;
  timeoutMs?: number;
  /** 单次请求尝试内提供方/SDK 的重试。 */
  maxRetries?: number;
  maxRetryDelayMs?: number;
  headers?: Record<string, string>;
  metadata?: JsonObject;
  cacheRetention?: CacheRetention;
  deferred?: boolean | { window?: "15m" | "1h" | "24h" };
};

/** Durable 的 generation 尝试重试；即 pi-ai `RetryPolicy` 的 JSON 形状。 */
type ConversationRetryPolicy = {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxAgentDelayMs?: number;
};

/** 自动压缩阈值（第 8.7 节）；手动压缩忽略 `enabled`。 */
type CompactionPolicy = {
  /** 阈值压缩与溢出压缩。 */
  enabled: boolean;
  /** 为答案保留的空余空间：超过 `contextWindow - reserveTokens` 时 generation 阻塞以压缩。 */
  reserveTokens: number;
  /** 摘要逐字保留的近期上下文的近似大小。 */
  keepRecentTokens: number;
  /** 后台压缩在阻塞阈值之下 `backgroundTokens` 处启动；`0` 表示禁用。 */
  backgroundTokens: number;
};

/**
 * `modelOverrides` 以精确的 `"provider/modelId"` 为键；它设置的每个字段都会替换该模型在 harness 范围内的对应值。
 * 读取者为它所服务的模型解析策略（见下方读取者表）。
 */
type CompactionSettings = Partial<CompactionPolicy> & {
  readonly modelOverrides?: Readonly<Record<string, Partial<CompactionPolicy>>>;
};

type ToolExecutionMode = "parallel" | "sequential";

/** 一个边界为同一模式选取多少个排队项（第 6 节）。 */
type QueueMode = "all" | "one-at-a-time";

/** 每次解析时读取，从不复制；用 getter 也可以。是同步的：一些读取者在 Session 线上运行。 */
type HarnessSettings = {
  /** 默认扩展选择；缺席时为全部已安装扩展，按安装顺序。 */
  readonly extensions?: readonly Extension[];
  readonly stream?: ConversationStreamOptions;
  readonly retry?: Partial<ConversationRetryPolicy>;
  readonly compaction?: CompactionSettings;
  readonly toolExecution?: ToolExecutionMode;
  readonly steeringMode?: QueueMode;
  readonly followUpMode?: QueueMode;
  /** 空闲会话把最后一次上下文读取在内存中保留多久；忙碌的会话总是保留。 */
  readonly contextRetentionMs?: number;
  /** 已加载且无 watch 或文档状态观察的文档，在最后一次使用后在内存中保留多久（第 4 节）。 */
  readonly documentRetentionMs?: number;
};

/** 已解析：每个字段都覆盖其内置默认值，对象字段做合并。 */
type Settings = {
  readonly extensions?: readonly Extension[]; // 默认：全部已安装扩展，按安装顺序
  readonly stream: ConversationStreamOptions; // 默认 {}
  readonly retry: ConversationRetryPolicy; // { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 }
  readonly compaction: CompactionPolicy & Pick<CompactionSettings, "modelOverrides">; // { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 }
  readonly toolExecution: ToolExecutionMode; // "parallel"
  readonly steeringMode: QueueMode; // "one-at-a-time"
  readonly followUpMode: QueueMode; // "one-at-a-time"
  readonly contextRetentionMs: number; // 600000
  readonly documentRetentionMs: number; // 600000
};

/** 某个会话存储的选择；是名字，不是对象。未设置的字段跟随宿主。 */
type AgentState = {
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  /** 数组表示恰好选择这些扩展，按此顺序。对象表示编辑宿主默认选择。 */
  extensions?: string[] | { add?: string[]; remove?: string[] };
  /** 过滤所选扩展的工具：即启用（enabled）的工具。数组表示恰好启用这些，按此顺序。 */
  tools?: string[] | { remove: string[] };
  /**
   * 过滤模型可调用的启用工具：即提供给（offered）模型的工具。未设置：除延迟（deferred）工具外的全部。数组：恰好这些，按此顺序，延迟工具也包括。对象：除延迟工具和 `remove` 中的之外的全部，按注册表顺序，后接 `add` 中不在 `remove` 里的延迟工具，按 `add` 顺序。
   */
  modelTools?: string[] | { remove?: string[]; add?: string[] };
  /** 在每个扩展节之后渲染，作为 `instructions` 节。 */
  instructions?: string;
  /** 环境文件系统中的目录，传给 `HarnessOptions.env`。 */
  cwd?: string;
};

/** 内置的可回退（rewindable）agent 文档；见下文。 */
declare const AgentDoc: RewindableConversationDocToken<AgentState>;

/** 对象是其名字的句柄。 */
type AgentChange = {
  readonly model?: ModelRef | null;
  readonly thinkingLevel?: ModelThinkingLevel | null;
  readonly extensions?:
    | readonly Extension[]
    | { readonly add?: readonly Extension[]; readonly remove?: readonly Extension[] }
    | null;
  readonly tools?: readonly ToolRegistration[] | { readonly remove: readonly ToolRegistration[] } | null;
  readonly modelTools?:
    | readonly ToolRegistration[]
    | { readonly remove?: readonly ToolRegistration[]; readonly add?: readonly ToolRegistration[] }
    | null;
  readonly instructions?: string | null;
  readonly cwd?: string | null;
};

/** 任意提交中的一个变更。给定字段替换存储值；`null` 清除；`undefined` 不改变。 */
function configure(tx: Tx, conversationId: ConversationId, change: AgentChange): Promise<void>;

/** 会话的 agent，对注册表快照和设置解析后的结果（第 7.1 节）。 */
type Agent<Tool extends ToolRegistration = ToolRegistration> = {
  readonly model?: ModelRef;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly extensions: readonly Extension<Tool>[];
  /** 提供给模型：已启用，`callers` 包含 `model`，且被 `modelTools` 选中。 */
  readonly tools: readonly Tool[];
  /** 嵌套调用在其中解析：已启用，且 `callers` 包含 `tools`。 */
  readonly callable: readonly Tool[];
  /** 已启用、模型可调用但尚未被提供的延迟工具，按注册表顺序。 */
  readonly deferred: readonly Tool[];
  /** 扩展节，然后是已设置的 `instructions`。 */
  readonly sections: readonly PromptSection<Tool>[];
  readonly instructions?: string;
  readonly cwd?: string;
};

/** `data` 类型为 `D` 的条目；`never` 表示该 kind 不携带数据。 */
type TypedEntry<D extends JsonValue> = Omit<EntryRecord, "data"> &
  ([D] extends [never] ? { readonly data?: never } : { readonly data: D });

type TypedEntryDraft<D extends JsonValue> = Omit<EntryDraft, "kind" | "data"> &
  ([D] extends [never] ? { readonly data?: never } : { readonly data: D });

interface Entry<D extends JsonValue = never> {
  readonly kind: string;
  is(entry: EntryRecord | undefined): entry is TypedEntry<D>;
}

function defineEntry<D extends JsonValue = never>(kind: string): Entry<D>;

type ContextView = {
  readonly head: EntryRecord | undefined;
  readonly entries: readonly EntryRecord[];
  /** `entries` 的每个条目，经编辑和规则 9 之后、规则 7 和 8 之前的模型消息。 */
  readonly contributions: readonly (readonly Message[])[];
  readonly messages: readonly Message[];
};

type SettledSubmissionRecord = SubmissionRecord & {
  readonly status: "done" | "unanswered";
};

interface Submission {
  readonly id: SubmissionId;
  status(context: Context): Promise<SubmissionRecord>;
  wait(context: Context): Promise<SettledSubmissionRecord>;
  abort(context: Context): Promise<"aborted" | "already_placed" | "settled">;
}

type SettledTask<R> = TaskRecord<JsonValue, JsonValue, R> & {
  readonly state: Extract<TaskState<JsonValue, R>, { status: "terminal" }>;
};

type TaskInspection = {
  readonly record: TaskRecord<JsonValue, JsonValue, JsonValue>;
  readonly state:
    | { readonly kind: "running" }
    | { readonly kind: "ready"; readonly migrates: boolean }
    | { readonly kind: "waiting"; readonly on: readonly TaskId[] }
    /** 结果被保持，直到其普通拥有的工作排空（第 5.5 节）。 */
    | { readonly kind: "completing" }
    | {
        readonly kind: "blocked";
        readonly reason: "missing_task" | "task_too_old" | "migration_failed";
        readonly error?: unknown;
      };
};

type HarnessInspection = {
  readonly scheduling: "paused" | "running" | "closing";
  readonly tasks: readonly TaskInspection[];
  /** 按 ID 顺序排列的已排队和已放置提交。 */
  readonly submissions: readonly SubmissionRecord[];
};

type ConversationWatch = WatchHandle<ConversationView>;

type HooksOf<K> = K extends Task<infer _I, infer _S, infer _R, infer H>
  ? H
  : never;

interface Conversation {
  readonly id: ConversationId;
  submit(submission: SubmissionDraft, context: Context): Promise<Submission>;
  /** 用当前注册表快照和设置解析。 */
  agent(context: Context): Promise<Agent>;
  /** 在其自身的提交中执行 `configure()`。 */
  configure(change: AgentChange, context: Context): Promise<void>;

  commit<T>(
    change: (tx: Tx) => T | Promise<T>,
    context: Context,
  ): Promise<T>;
  /** 带 `at` 时，返回该可见条目时刻的上下文，如同 `fork(at)` 会以它为起点。 */
  context(context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
  entries(
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<EntryRecord, Cursor>>;
  fork(
    at: EntryId,
    options: ConversationCreateOptions,
    context: Context,
  ): Promise<Conversation>;
  compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>>;
  reset(handoff: string | undefined, context: Context): Promise<void>;
  /** `{ background: true }` 还会中止该会话下的后台工作（第 5.4 节）。 */
  abort(context: Context, options?: { readonly background?: boolean }): Promise<void>;
  waitForIdle(context: Context): Promise<void>;
  viewState(context: Context): Promise<AttachedReplicatedState<ConversationView>>;
  watch(context: Context): Promise<ConversationWatch>;
}

interface Harness extends Session {
  resume(): void;

  root(
    context: Context,
    options?: { readonly agent?: AgentChange; readonly init?: ConversationInit },
  ): Promise<Conversation>;
  conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
  createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation>;

  getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
  inspect(context: Context): Promise<HarnessInspection>;
  submission(id: SubmissionId, context: Context): Promise<Submission | undefined>;
  abortSubmission(
    id: SubmissionId,
    context: Context,
    conversationId?: ConversationId,
  ): Promise<"aborted" | "already_placed" | "settled" | "not_found">;
  abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal">;
  waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
  waitForIdle(context: Context): Promise<void>;
  /** 每个会话的 `pi.usage` 之和的 Session 总计（第 8.6 节）。 */
  usage(context: Context): Promise<UsageState>;
  /** 以结构化视图表示的活跃任务（第 9.5 节）。 */
  taskGraph(context: Context): Promise<AttachedReplicatedState<TaskGraph>>;
  watchTaskGraph(context: Context): Promise<TaskGraphWatch>;
}

declare const Harness: {
  open<Tool extends ToolRegistration>(
    storage: Storage,
    options: HarnessOptions<Tool>,
    context: Context,
  ): Promise<Harness>;
};
```

类型化文档和结构化会话 watch 就是状态表面；没有固定的 rewindable 或 sticky 访问器、命名空间路由器、语义视图事件，也没有手动的 Chord 视图桥。`submit()` 持久化地接纳一条用户输入或一次被动条目写入，并返回一个跟踪其落定过程的 `Submission`。

`Harness.open()` 把 Session 绑定到一个应用拥有的注册表（第 7.1 节）。`createRegistry()` 总是包含内置任务定义（第 8 节），open 会拒绝快照缺少其中任何一个的注册表。
Open 把 `running` 任务中存活下来的改为 `pending`，让 `waiting` 任务保持等待，并对 `completing` 和 `waiting` 任务重新评估终结（finalization）和 `failFast`（第 5.5 节）。它不会因为某个任务的定义缺失或无法迁移而迁移或终止该任务。这样的任务保持 `pending` 或 `waiting` 并处于 **blocked**（受阻）状态：调度器跳过它，并在注册表变化时重新考虑它（第 5.4 节）。恢复所触及的任何内置文档都通过其普通的类型化访问路径迁移。Open 不扫描也不迁移其他文档。open 期间不派发任何处理程序。应用应在 open 之前安装扩展，让恢复的工作能立即继续；open 之后再安装也能解除阻塞。

根会话总是保留 ID `ROOT_CONVERSATION_ID`（`1`）。`root(context, { agent, init })` 惰性创建它：当根不存在时，Session 线上的一次提交创建无主的根会话，运行创建钩子（见下），用 `configure()` 应用 `agent`，并运行 `init(tx, rootId)`。当根已存在时，忽略 `agent` 和 `init`，不发生任何写入。重新打开时按保留 ID 找到同一个根。agent 没有模型的会话会产生持久的 `no_model` generation 失败。

`resume()` 在运行中是幂等的，只用于启用调度。它不重复 open 时的对账（reconciliation），并在 close 之后抛出。必须在任何任务运行之前完成的工作，例如安装扩展或播种（seeding），应在 `resume()` 之前进行。请求进展的调用也会启用调度，所以它们绝不在暂停的 Harness 上等待：`Conversation.submit()`、`Conversation.compact()`、`Conversation.abort()`、`Submission.wait()`、`Harness.waitForTask()`、`Harness.waitForIdle()` 和 `Conversation.waitForIdle()`。恢复的工作随它们启动。只读的观察者绝不启用调度：`inspect()`、`getTask()`、`submission()`、`Submission.status()`、`usage()`、文档读取、所有会话读取、状态和 watch，以及任务图。

`createConversation({ ownership, agent, init })` 和 `fork(at, { ownership, agent, init })` 原子地提交：会话、其显式选择的归属、创建钩子的文档、`agent` 变更，以及 `init` 做出的每一次写入。
第一条输入是之后一次普通的 `submit()`。请求 ID 使对同一会话重试的 `submit()` 恰好一次生效；必须在两次调用之间崩溃后存活的宿主，先重新找到它的会话，例如通过 `init` 写入的一个键。宿主调用者必须选择无主或任务归属；Harness 和会话句柄都不会从调用上下文推断归属。

每一个创建或分叉会话的 Harness 提交都会在同一提交中运行内置创建钩子，无论是通过便捷方法还是通过原始的 `tx.createConversation()` 和 `tx.forkConversation()`，例如在工具提交内部。它在 `tx.createConversation()` 和 `tx.forkConversation()` 内部、在它们返回之前运行，所以同一回调中靠后的 `configure()` 会覆盖它的复制。它创建空的 `pi.live`、`pi.inbox` 和 `pi.usage`，用全新的面向提供方的 UUIDv7 创建 `pi.provider`，并处理 `pi.agent`：

- 分叉保留父会话 `pi.agent` 的 `asOf` 副本（第 3.7 节），无论其归属是什么。
- 新的任务归属会话获得 owner 任务的会话所存储 `pi.agent` 的副本，包括每个字段，含 `instructions`。之后对 owner 的变更不会到达子会话。owner 未设置的字段保持未设置并跟随宿主。
- 新的无主会话得到空的 `pi.agent`，即 `{}`。

若提供了 `HarnessOptions.conversationCreated`，它随后在同一提交中带着新记录运行，覆盖每一条创建路径，宿主由此可以在每个会话中创建其应用需要的文档；记录的 `parent` 和 `owner` 可区分分叉和任务归属会话。表读取在那里抛出 `ReadAfterWrite`，与 `init` 中一样；抛出会使创建提交失败。便捷方法随后应用其 `agent` 变更并运行 `init`。扩展没有创建钩子，它们的钩子和节把自己的缺失文档当作默认值。由纯 Session 创建的会话没有任何内置文档。

```ts
// In a tool's commit. The child starts as a copy of this conversation's agent: model, extensions, tools, cwd.
const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
// A cheaper model, only the read tool, and its own worktree; everything else stays as copied.
await configure(tx, child.id, { model: haiku, tools: [readTool], cwd: worktree });
```

`init` 在会话创建（一次表写入）之后运行，所以它内部的表读取会抛出 `ReadAfterWrite`（第 4 节）。文档访问仍然可用。

内置 agent 文档在版本 1 定稿：

| 字段 | 值 |
|---|---|
| kind | `pi.agent` |
| version | `1`（无迁移） |
| scope/history/fork | conversation、`rewindable`、`asOf` |
| schema | `AgentState` |
| `initial()` | `{}` |
| checkpoint | 每次变更都写完整基线 |
| view mount | `docs["pi.agent"]` |
它只存储有人为该会话做出的选择：扩展和工具的名字，绝不是代码，除 `instructions` 外也没有提示词文本。代码在 agent 被解析时（第 7.1 节）按名字来自注册表。
`configure(tx, id, change)` 在任意提交中编辑它，包括创建或分叉会话的那次提交；`Conversation.configure()` 在它自己的提交中做这件事。`Conversation.agent()` 用当前注册表快照和设置解析它，把缺失文档读作 `{}`；它从不写入。

`configure()` 整字段替换：给定的字段替换存储值，`null` 清除，`undefined` 保持不变。扩展和工具对象代表其名字，所以重新安装的扩展的旧对象仍然能选中它。

```ts
await root.configure({ tools: { remove: [editTool] } }, context);
await root.configure({ tools: { remove: [bashTool] } }, context); // edit 被再次提供
await root.configure({ tools: null }, context); // 所选扩展的全部工具被再次提供
```

因此 UI 开关读取当前值并写入新值。`extensions` 对象 `{ add, remove }` 总是编辑宿主默认选择（第 7.1 节），绝不编辑复制的选择——无论那是一个数组还是一个 `{ add, remove }` 对象；要编辑复制的选择，就写入一个从已解析 agent 的 `extensions` 计算出的数组。

没有任何检查确认存储的扩展或工具名已安装。文档记录选择；注册表记录本进程现在能执行什么。因此一个存储的名字可能未安装，例如扩展重载期间、重启后安装之前，或由缺少某扩展的进程打开的分叉中。解析会跳过它，文档绝不因注册表变动而重写，且当它再次被安装时该名字重新生效。

变更既不启动 generation 也不追加系统条目。请求准备稍后把期望的提示词和工具与 transcript 历史比较，并追加所需的位置性系统基线或增量（第 7.4 节）。

内置 provider 文档在版本 1 定稿：

| 字段 | 值 |
|---|---|
| kind | `pi.provider` |
| version | `1`（无迁移） |
| scope/history/fork | conversation、`latest`、`initial` |
| schema | `{ sessionId: string }` |
| `initial()` | `{ sessionId: uuidv7() }` |
| checkpoint | 每次变更都写完整基线 |
| view mount | `docs["pi.provider"]` |

这个 UUID 是面向提供方的会话身份，既不是数字的 Durable `ConversationId`，也不是外层应用的 Session ID。每个新建、任务归属、原始创建和分叉的会话都在其创建提交中收到自己的 UUID；分叉绝不复制父会话的 UUID。Generation 请求和压缩摘要把它作为 `options.sessionId` 传给 pi-ai。重置、压缩、模型变更和重新打开都不改变它。没有该文档的遗留会话，会在其第一次 generation 或压缩的提供方请求之前，在 Session 线上创建并持久化它。并发调用者因此观察到唯一赢家。提供方行为仍然适用：例如当 `cacheRetention` 为 `"none"` 时，Codex 会抑制缓存/会话身份。

缺失的工具实现绝不会使请求失败。请求准备只提供 agent 已解析的工具。如果重放出的工具状态仍提供某个已无法解析的工具，追加的系统增量会在 `toolsRemoved` 中列出它；当它再次可解析时，后续增量加入其当前声明。当模型调用了其请求未提供的工具，或其实现工具任务运行时无法解析（第 7.3 节），会产生一个带 `tool_unavailable` 错误诊断（第 7.3 节）的错误工具结果，说明该工具不可用，运行继续进行以便模型做出反应（第 8.3 节）。

`HarnessOptions.settings` 保存 Harness 范围的运行策略：默认扩展选择、请求选项、重试、压缩阈值、工具执行和队列模式。没有任何东西复制或存储它。每个读取者都把它重新解析为 `Settings`，每个缺席字段取其内置默认值，对象字段按键合并，并把该值用于一次决策（第 7.1 节列出读取者）。带 getter 的设置对象或 `settings` 函数因此无需 Session 写入即可跟随用户偏好。`models` 同理：函数在每次使用时调用（generation 与压缩请求、`runtime.models`、钩子和工具的 `api.models` 每次访问），所以宿主可以不重开 Harness 就替换其模型配置。设置是同步的，因为队列模式在 Session 线上读取。`stream` 转发给 generation 请求；`stream.maxRetries` 是单次请求内的提供方重试，而 `retry` 治理持久的 generation 尝试（第 8.3 节）。设置变更不做提交也不发出事件。

```ts
// The user's settings, read live through getters.
class UserSettings implements HarnessSettings {
  readonly manager: SettingsManager;
  constructor(manager: SettingsManager) {
    this.manager = manager;
  }
  get stream() {
    return { timeoutMs: this.manager.get("timeoutMs") };
  }
  get compaction() {
    return { enabled: this.manager.get("autoCompact") };
  }
}
manager.set("autoCompact", false); // no Session write; every conversation follows at its next threshold check
```

`HarnessOptions.env` 从会话 ID、其 agent 的 `cwd` 和一个针对已提交文档的 `DocumentReader` 构建会话的执行环境。Harness 绝不在 Session 线上调用它，并在每次使用时调用：

- 工具任务为每次执行调用它，并把结果作为 `api.env` 传递（第 7.3 节）。恢复后的重运行会得到当时的会话环境，包括其当前 `cwd`。抛出会变成该调用的一次普通错误结果。
- Generation 的 `prepare` 为节渲染器调用它一次（`input.env`，第 7.4 节）。抛出会被上报，各节以 `env: undefined` 渲染。
- `runtime.env(context)` 为自定义任务调用它，并以错误拒绝。

没有 `env` 选项或它返回 `undefined` 时，就没有环境。宿主缓存昂贵的东西，例如每个目录一个环境。扩展读取已构建的环境，如 `env.cwd`，绝不读描述符。需要每会话多于一个目录信息的应用，把它保存在自己的文档里，并通过 `target.read` 读取：

```ts
// Absent: the conversation runs locally. Only conversations with this document run in a container.
// Subagents do not copy it: their creator writes it too when they should run in the container.
const ContainerDoc = defineDoc<{ image: string }>({
  kind: "app.container", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ image: "node:22" }),
});
const harness = await Harness.open(storage, {
  models,
  registry,
  env: async ({ conversationId, cwd, read }, context) => {
    const container = await read.snapshot(ContainerDoc, conversationId, context);
    return container !== undefined
      ? containers.env(container.image, cwd ?? "/work", context)
      : localEnv(cwd ?? process.cwd()); // cached NodeExecutionEnv per directory
  },
}, context);
```

Agent 和设置的变更在其读取者解析它们时生效（第 7.1 节）。Generation 准备对每个请求解析一次 agent，并固定该回合的提示词、提供的工具、模型和请求选项。回合运行期间做出的变更在下次准备时生效。模型已调用的工具在其工具任务运行时解析；当其名字不再属于 agent 的工具时——因为过滤器、选择或注册表变了——该调用产生 `tool_unavailable`（第 7.3 节）。重试策略在 generation 对一次尝试的结果分类时读取，因为它治理下一次尝试（第 8.3 节）。

`Conversation.commit()` 是绑定到该会话的 Session 提交。`tx.createTask()` 把 `TaskOptions.conversationId` 默认为绑定的会话。`Conversation.entries()` 把查询绑定到该会话并对其感知分叉的存储历史分页；调用者不能替换为另一个会话 ID。通用的 Session 范围文档操作仍可直接在 `Harness` 上使用，因为 `Harness extends Session`。

`fork()` 需要一个具体的可见父条目和显式归属，然后应用第 3.7 节。
`compact()` 在一次提交中接纳一个手动压缩任务并返回其 ID，而不是其未来的摘要条目。该任务是会话拥有的且不是后台的，所以 `Conversation.abort()` 能取消它，空闲等待也包含它。它不取得运行控制权，所以不会使会话忙碌：会话在它摘要期间继续工作，其摘要通过一次写提交放置——空闲时立刻，忙碌时在下一个边界（第 8.7 节）。`reset()` 持久化地接纳一次写提交，写入一条 `pi.reset` 条目（第 8.1 节），带 `head: "self"`，若给出交接（handoff）文本则作为用户消息携带，然后返回；忙碌时，放置遵循第 6 节，可能稍后发生。通过会话 watch 观察其放置。空闲等待不保证队列中的被动写入被放置。

`abortTask()` 提交 `abortRequested`，然后发信号并加入活跃运行；随后调度器启动中止调用，并把前台拥有的
子树在其下一次对账提交中标记为终态（第 5.4 节）。`Conversation.abort()` 撤回队列中的输入提交，把普通归属遍历选中的非后台任务标记出来，向它们发信号，并且只在该作用域普通空闲之后才返回。被动写入和后台子树存活。会话空闲指没有从该会话选中的活跃非后台任务。Harness 空闲对每个无主会话根应用同样的遍历。等待中的、被截止时间阻塞的、以及 `completing` 的工作仍然活跃，因此不算空闲。取消一次空闲等待只取消那个等待者。

会话句柄是无状态的；用 `id` 比较它们。宿主通过查找和扫描发现会话。没有创建监听器；任务图视图（第 9.5 节）、`inspect()` 和空闲等待报告活跃工作。

`submit()` 在持久接纳之后返回，而非落定之后。输入提交在放置时创建一条带 Harness 时钟时间戳的用户消息——立刻放置时就是接纳时刻；`whenBusy` 默认为 `followUp`。写提交走第 6 节的有序被动路径，绝不启动 generation。`Submission.wait()` 对输入只在答案或终态失败之后落定；对写入在条目被放置或写入变得终态不可放置时落定。取消 `wait()` 只取消那次等待。它不撤回提交；`Submission.abort()` 才是显式的排队撤回操作。`Harness.submission()` 在重新打开后重新获取提交；记录在落定后仍可查询。

`abortTask()` 持久化请求取消，并在标记被提交且任何活跃运行调用已加入之后返回 `marked`，或在一个没有活跃普通拥有工作的受阻任务已被落定为 `orphaned` 之后返回（第 5.4 节）。中止调用在该任务的普通拥有工作不再活跃时启动；`completing` 任务只被标记，其最终记录保持持有的结果并带 `abortRequested: true`（第 5.5 节）。它不等待终态落定。`waitForTask()` 观察终态回执。中止已终态的任务返回 `terminal`；未知 ID 拒绝。显式任务中止包括后台任务。取消任务或空闲等待不会中止工作。

`inspect()` 在 Session 线上的某一点返回活跃工作，用于 open 后的恢复决策、观察者和诊断。它不写入、不启用调度、不运行任务代码。每个活跃任务在当前注册表下携带其状态：`running` 表示有活跃调用；`completing` 表示持有结果；`waiting` 表示它仍在等待的活跃任务，即其 `on` 的活跃部分，或在被中止标记时其活跃的普通拥有工作（第 5.5 节）；`ready` 表示下一次调度通过会预留它，当其定义更新且带 `migrate` 时带 `migrates`；或 `blocked`（第 5.4 节）。迁移只有在调度器尝试过之后、或较新定义没有 `migrate` 时才显示为失败；检查绝不为了查明而运行迁移。受阻原因（blocked reasons）是推导出来的，绝不存储。已排队和已放置的提交补全该视图。完成的任务、已落定的提交、transcript 和文档使用各自的 API。

`Conversation.viewState()` 返回其当前结构化挂载，作为一次性的只读 Chord 状态。`Conversation.watch()` 原子地捕获那个不可变修订版，并注册以接收后续精确的完整提交帧。其 `WatchHandle` 使用与第 9.2 节 `watchDoc()` 相同的串行化异步、有界缓冲契约。两者都不携带语义事件，也不拥有第二持久化权威。

`close()` 封锁变更接纳和任务预留，向调用发信号，并在该封锁点结束每个文档状态、视图状态和 watch：在 close 期间落定的提交不向它们发布任何内容，状态保持其最后的值。在 Session 线之外，它让已接纳的存储提交落定，加入任务、工具和钩子调用（包括忽略其信号的代码），然后关闭 Storage。一旦 `close()` 返回，本 Harness 的任何调用代码都不再运行，也没有处理程序持有 Storage，因此新的 Harness 可以打开同一个 Storage。已在运行的 watch 回调仍归调用者所有，可以独立完成。Close 不写任务结果。取消一次 `close()` 调用只取消那次等待；关停继续进行，之后每次 `close()` 都等待同一次关停。

句柄属于那次打开的 Harness，重新打开后必须重新获取。一旦 close 开始，每个新的 Harness、会话和提交操作都拒绝，`resume()` 抛出。在封锁点已排在 Session 线上的操作中，提交落定（第 4 节），读取完成。等待、状态和 watch 拒绝，只有两个不需要后续提交的例外：已落定提交的 `Submission.wait()` 返回，对缺失文档的获取返回 `undefined`。其中的 `inspect()` 报告 `scheduling: "closing"`。

## 3. 文档

### 3.1 定义

作用域（scope）直接决定文档的归属和生命周期。只有会话文档声明历史和分叉行为。

```ts
type LatestConversationSemantics = {
  readonly scope: "conversation";
  readonly history: "latest";
  readonly fork: "current" | "initial";
};

type RewindableConversationSemantics = {
  readonly scope: "conversation";
  readonly history: "rewindable";
  readonly fork: "asOf" | "current" | "initial";
};

type DocumentSemantics =
  | { readonly scope: "session" }
  | LatestConversationSemantics
  | RewindableConversationSemantics
  | { readonly scope: "task" };

type CheckpointInfo = {
  /** 最新基线之后已存储的增量数，不含本次变更。 */
  readonly deltasSinceBase: number;
};

type CommonDocDefinition<T extends JsonObject> = {
  readonly kind: string;
  readonly version: number;
  initial(): T;
  migrate?(value: JsonObject, fromVersion: number): T;
  checkpointWhen?(value: Readonly<T>, ops: readonly Op[], info: CheckpointInfo): boolean;
};

type DocDefinition<T extends JsonObject> =
  CommonDocDefinition<T> & DocumentSemantics;

type DocFamilyDefinition<T extends JsonObject, I extends JsonValue> =
  Omit<CommonDocDefinition<T>, "initial"> & DocumentSemantics & {
    readonly family: true;
    initial(seed: I): T;
  };

declare const docType: unique symbol;
interface DocToken<T extends JsonObject, D extends DocDefinition<T>> {
  readonly definition: D;
  readonly [docType]?: T;
}
interface DocFamilyToken<
  T extends JsonObject,
  I extends JsonValue,
  D extends DocFamilyDefinition<T, I>,
> {
  readonly definition: D;
  readonly [docType]?: T;
}

type SessionDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & { readonly scope: "session" }
>;
type ConversationDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
type RewindableConversationDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & RewindableConversationSemantics
>;
type TaskDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & { readonly scope: "task" }
>;

type SessionDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & { readonly scope: "session" }
>;
type ConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
type RewindableConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & RewindableConversationSemantics
>;
type TaskDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & { readonly scope: "task" }
>;

function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & { readonly scope: "session" },
): SessionDocToken<T>;
function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & LatestConversationSemantics,
): ConversationDocToken<T>;
function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & RewindableConversationSemantics,
): RewindableConversationDocToken<T>;
function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & { readonly scope: "task" },
): TaskDocToken<T>;

function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & {
    readonly family: true;
    readonly scope: "session";
    initial(seed: I): T;
  },
): SessionDocFamilyToken<T, I>;
function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & LatestConversationSemantics & {
    readonly family: true;
    initial(seed: I): T;
  },
): ConversationDocFamilyToken<T, I>;
function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & RewindableConversationSemantics & {
    readonly family: true;
    initial(seed: I): T;
  },
): RewindableConversationDocFamilyToken<T, I>;
function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & {
    readonly family: true;
    readonly scope: "task";
    initial(seed: I): T;
  },
): TaskDocFamilyToken<T, I>;
```

校验规则：

- 版本必须是正整数。
- 当令牌（token）的作用域或会话 history/fork 策略与持久化的化身（incarnation）不一致时，类型化访问拒绝。迁移不能重新解释这些生命周期语义。
- Session 文档只有当前值，属于 Session。关闭并重新打开 Session 不会使其退役（retire）。
- 会话文档声明 `history` 和 `fork`；`fork: "asOf"` 要求 `history: "rewindable"`。
- 任务文档只有当前值，绝不被会话分叉复制，并在其任务变为终态时原子退役。
- `initial()` 和 `migrate()` 返回 JSON 对象。

`checkpointWhen()` 只用于选择完整的存储基线以限制重放长度。它不改变作用域、生命周期、历史或分叉语义。

具体内置文档的分组和语义在实现内置定义时声明。通用文档机制不为模型、工具、收件箱或展示状态做特殊处理。

### 3.2 记录与生命周期

一个持久化的文档实例有一个 `DocumentRecord`：

```ts
type DocumentRecord = {
  readonly id: DocumentId;      // 唯一化身
  readonly kind: string;        // 稳定的定义 kind
  readonly key?: string;        // 仅文档族（family）使用
  readonly createdAt: Seq;      // 由提交的存储打戳
  readonly retiredAt?: Seq;
} & (
  | { readonly scope: { readonly kind: "session" } }
  | ({ readonly scope: { readonly kind: "conversation"; readonly conversationId: ConversationId } } & (
      | { readonly history: "latest"; readonly fork: "current" | "initial" }
      | {
          readonly history: "rewindable";
          readonly fork: "asOf" | "current" | "initial";
        }
    ))
  | { readonly scope: { readonly kind: "task"; readonly taskId: TaskId } }
);

type DocumentCreate = DocumentRecord extends infer Record
  ? Record extends DocumentRecord
    ? Omit<Record, "createdAt" | "retiredAt">
    : never
  : never;
```

`id` 永不复用。退役再重建同一逻辑 kind、作用域和族键会创建新的化身。成员资格是半开区间 `createdAt <= at < retiredAt`；未退役的化身没有上界。在同一提交中即被退役的创建，其生命周期为空。

单例（singleton）在逻辑上由 kind 和作用域标识。文档族（family）在逻辑上由 kind、作用域和 `key` 标识。记录保留作用域和会话 history/fork 语义，这样即使扩展代码不可用，已有数据也不会消失。定义版本属于存储的基线和增量，因为一个化身可能包含由多个定义版本写入的记录。`DocumentCreate` 不是另一条持久化记录；它是去掉存储分配的生命周期字段后的同一作用域联合类型。

### 3.3 访问与创建

没有可变的 `session.document()` API。

```ts
type SessionEnd = { readonly reason: "closed" } | { readonly reason: "failed"; readonly error: unknown };

interface Session extends DocumentObserver {
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
  close(context: Context): Promise<void>;
  /** 关闭后落定一次，包括 Storage：`{ reason: "closed" }` 或 `{ reason: "failed", error }`（第 10.1 节）。 */
  readonly closed: Promise<SessionEnd>;
  subscribeCommits(listener: (publication: CommitPublication, context: Context) => void): () => void;
  subscribeClose(listener: () => void): () => void;

  snapshot<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, context: Context): Promise<Readonly<T> | undefined>;

  snapshotAsOf<T extends JsonObject>(token: RewindableConversationDocToken<T>, conversationId: ConversationId, at: EntryId, context: Context): Promise<Readonly<T> | undefined>;
  snapshotAsOf<T extends JsonObject, I extends JsonValue>(token: RewindableConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, at: EntryId, context: Context): Promise<Readonly<T> | undefined>;

  documentState<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, context: Context): Promise<DocumentState<T> | undefined>;
}

interface Tx {
  conversation(id: ConversationId): Promise<ConversationRecord | undefined>;
  entry(id: EntryId): Promise<EntryRecord | undefined>;
  /** 条目缺失或属于其他 kind 时为 undefined。 */
  entry<D extends JsonValue>(token: Entry<D>, id: EntryId): Promise<TypedEntry<D> | undefined>;
  task(id: TaskId): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
  scanConversations(query: ConversationQuery, limit: number, cursor?: Cursor): Promise<Page<ConversationRecord, Cursor>>;
  scanEntries(query: EntryQuery, limit: number, cursor?: Cursor): Promise<Page<EntryRecord, Cursor>>;
  scanTasks(query: TaskQuery, limit: number, cursor?: Cursor): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;
  submissionByRequest(conversationId: ConversationId, requestId: string): Promise<SubmissionRecord | undefined>;

  createConversation(options: { readonly ownership: ConversationOwnership }): Promise<ConversationRecord>;
  forkConversation(
    parentConversationId: ConversationId,
    at: EntryId,
    options: { readonly ownership: ConversationOwnership },
  ): Promise<ConversationRecord>;
  appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord>;
  /** 令牌提供 `kind` 并为 `data` 定型。 */
  appendEntry<D extends JsonValue>(
    token: Entry<D>, conversationId: ConversationId, value: TypedEntryDraft<D>,
  ): Promise<TypedEntry<D>>;
  createTask<I, S extends { phase: string }, R, H extends object>(
    task: Task<I, S, R, H>, input: I, options: TaskOptions,
  ): Promise<TaskId<R>>;
  /** 原始提交记录；无接纳规则（忙碌检查、收件箱、放置）。宿主使用 `Conversation.submit()`。 */
  createSubmission(create: SubmissionCreate): Promise<SubmissionRecord>;
  /** 落定一个已排队或已放置的提交；只有已放置的输入可以被回答。已落定的保持不变。 */
  settleSubmission(id: SubmissionId, settlement: SubmissionSettlement): void;
  /** 会话中携带 `head` 的最新可见条目。 */
  latestHeadMarker(conversationId: ConversationId): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;
  /** 在 `entry` 处记录一个已排队提交的放置：输入变为 `placed`，写入变为 `done`（第 6 节）。调用者负责追加条目并编辑 `pi.inbox` 和 `pi.live`。 */
  placeSubmission(id: SubmissionId, entry: EntryId): void;

  doc<T extends JsonObject>(token: SessionDocToken<T>): Promise<Draft<T>>;
  doc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<Draft<T>>;
  doc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, seed: I): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, seed: I): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, seed: I): Promise<Draft<T>>;

  retireDoc<T extends JsonObject>(token: SessionDocToken<T>): Promise<void>;
  retireDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<void>;
  retireDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string): Promise<void>;
}
```

创建 ID 的事务方法之所以是异步的，是因为远程存储可能需要持久地分配全局唯一的数字 ID。会话创建总是要求显式归属；没有事务包装器注入执行中的任务。对于任务归属，调用者只提供一个类型化的任务 ID。Session 从任务的最终候选记录推导出被持久化的 owner 会话。

owner 任务可以在同一事务中更早处被提交或暂存（staged）。在 Storage 接纳之前，Session 拒绝缺失的、`completing` 的、终态的或被中止标记的新任务或会话的 owner，判定依据是该事务中 owner 的最终候选记录。因此任务不能在结束自己的那次提交中创建被拥有的工作。显式 `conversationId` 与其 owner 会话不同的子任务，以及 `background: true` 的子任务，以同样方式被拒绝。已有的 owner 边在其 owner 之后完成时仍然有效。会话创建返回一个惰性记录，绝不是可操作句柄。
`forkConversation()` 额外校验一个可见条目并应用第 3.7 节。只有公开的类型化 `tx.doc()` 是取或建（get-or-create）。内部分叉复制可以直接从存储值创建新化身而不需要定义。`tx.doc()` 接收定义令牌，后者提供其静态类型、初始化器、迁移和检查点策略。保留作用域的令牌重载只要求调用者提供具体的会话/任务 ID，对文档族还要提供键和创建种子。普通定义不在 open 时注册，普通文档也不在 open 时扫描。

- 已存在的实例按第 3.6 节惰性重建并迁移。通过 `tx.doc()` 到达的迁移被暂存进其外层事务。
- 缺失的单例调用令牌的 `initial()`。缺失的族成员调用 `initial(seed)`。创建会存储一个初始基线。
- 同一逻辑地址的第一次获取在 await 之前即被记忆（memoize）。该事务中后续的获取返回同一个草稿；对缺失的文档族，第一次调用的分离种子生效，后续种子被忽略。
- `snapshot()`、`snapshotAsOf()`、`documentState()` 和 `watchDoc()` 绝不创建或持久化迁移。当请求的化身不存在时它们返回 `undefined`，且只在内存中迁移重建出的值。
- 任务作用域的 `tx.doc()` 对事务的最新候选任务记录校验，回退到已提交状态。这一内部校验不是调用者的表读取，不触发 `ReadAfterWrite`。其会话从任务记录推导。
- `retireDoc()` 解析逻辑地址但不创建它。对已获取草稿的退役会在退役前持久化其最终内容。同一事务中随后对该地址的 `tx.doc()` 会创建带新草稿和新 ID 的新化身。
- 终态候选拒绝其后的任务文档访问。终态落定同时退役已存在的任务文档和同一事务中更早创建的任务文档。
- `snapshot()` 返回当前可共享的不可变修订版。对它或任何保留的后代的变更不受支持；需要可变所有权的调用者必须先复制。
- `documentState()` 返回绑定到一个已提交化身的、一次性的只读 Chord 状态。
- `tx.doc()` 为该事务返回一个可撤销的 Astra 覆盖层 `Draft<T>`。
- 历史读取绝不在过去创建文档。

`snapshotAsOf()` 只对 rewindable 会话文档可用。它校验 `at` 经由请求会话的祖先链可见，选出拥有该条目的祖先会话，然后找到其创建/退役区间包含该条目提交的逻辑单例/族化身。它绝不从今天的化身出发，也绝不创建实例。当不存在这样的实例时返回 `undefined`。

在 `B` 于条目 `E` 处分叉 `A` 之后，请求 `B` 在继承的 `E` 处的状态会读取 `A` 的历史实例；`B` 的复制化身创建得更晚。如果实例被退役并重建，历史查找选择在目标提交时存活的化身。

### 3.4 变更所有权

Durable 直接使用 Chord Delta 的不可变事务形状：

```ts
interface Prepared<T extends object> {
  readonly base: T;
  readonly value: T;
  readonly ops: readonly Op[];
  readonly baseRevision: number;
  abort(): void;
}
interface Change<T extends object> {
  readonly state: Draft<T>;
  prepare(): Prepared<T>;
  abort(): void;
}
interface Tracker<T extends object> {
  readonly value: T;
  readonly revision: number;
  beginChange(): Change<T>;
  prepareReplace(value: T): Prepared<T>;
  adopt(prepared: Prepared<T>): void;
}
```

每个已加载的文档拥有一个跟踪器（tracker），其 `value` 是当前的不可变修订版。不可变性是一个受信任的所有权契约，不是运行时冻结：修订版及其后代在移交给跟踪器之后绝不可被变更。`prepare()` 撤销草稿，发出分离的自包含操作，并在 Storage 接纳之前用优化过的不可变应用器计算 `value`。未变化的子树与 `base` 结构共享。操作的放置载荷也可以与 `value` 共享；变更已准备的操作或不可变修订版都不受支持。Astra 为它证明是空操作（no-op）的变更保留空操作批次，但 Durable 不为非空结构批次做额外的整值相等性检查。

`abort()` 是幂等的。`adopt()` 只接受来自该跟踪器在其当前修订版上准备的结果，然后只执行一次同步指针交换到已计算好的不可变 `value`。它不做差异比较、应用、分配或回调。Session 线上每个跟踪器最多允许一个打开的变更，并确保在准备、Storage 落定和采纳之间没有结果变陈旧。

第一次 `tx.doc()` 获取调用 `tracker.beginChange()`，并为这个可能异步的 Session 回调的剩余部分记忆该变更的草稿。

事务行为：

```text
begin transaction
  acquire and memoize document changes by logical address
  mutate revocable Astra overlay drafts
callback settles
  seal Tx; synchronously prepare or abort every open change, revoking every draft
  if any acquisition is pending: abort open changes, reject, then drain and abort it
callback fails with no pending acquisition
  abort every open change; persist and publish nothing
callback succeeds with no pending acquisition
  prepare every open change -> immutable next revision + self-contained Chord Op[]
  Session evaluates each required/ordinary document write exactly once
  Storage.commit persists the atomic batch while the Session line remains held
storage succeeds
  adopt every prepared change by pointer swap and enqueue immutable revision/ops publication
  commit listeners, including conversation view mounts (section 9.3), capture it synchronously
  release the line; invoke listeners later
storage fails
  abort every prepared change, fail the Session (section 10.1), and publish nothing
```

在封锁之后才完成的挂起获取绝不暴露草稿；其变更被中止，其 promise 拒绝。Session 在释放变更线之前观察每一个这样的落定。初始化器、迁移和替换根来自调用者代码：Session 把每一个复制进独占的内核所有权，拒绝任何不是严格 JSON 的值，然后才让它成为不可变跟踪器修订版。已加载的和分叉复制的根已经是来自 Storage 的分离严格 JSON，直接进入跟踪器而无需再复制。Chord 的 `track()` 和 `prepareReplace()` 以 O(1) 取得所有权而不做遍历，所以它们收到的每个根必须来自上述来源之一。迁移回调绝不收到活的跟踪器修订版。

准备、校验或检查点失败发生在 Storage 接纳之前并正常回滚。Session 不对已准备的操作或选中的基线做严格 JSON 遍历：根在进入时被检查，Chord 检查每一次草稿放置，所以每个修订版、操作载荷和基线在构造上都是严格 JSON。跟踪器品牌（branding）和 `baseRevision` 强制所有权与陈旧性；Session 绝不替换调用者创建的已准备值。已准备的不可变候选本身成为被采纳并发布的值。只有当 Session 选中基线时，Storage 才收到完整值；否则只收到已准备的操作批次。已存在的当前版本文档携带空批次时不写入也不发布。最终值与基线深度相等的非空结构批次仍是有效的持久变更和发布。创建和必需的版本转换在其准备批次为空时仍然写基线；值相等的版本基线不发出 watch 更新。

赋值进草稿的值立即按值复制。重复放置相互独立。Chord 在复制时检查每次放置，当值不是严格 JSON 时——`undefined` 数组元素或嵌套对象值、非有限数、函数、symbol、bigint、访问器、symbol 键、稀疏数组，或原型既不是 `Object.prototype` 也不是 `null` 的对象——在草稿改变之前于出错赋值处抛出。直接给对象属性赋 `undefined` 会删除该属性。回调落定之后，草稿读取、草稿写入和所有 `Tx` 操作都拒绝。已准备的不可变值仍可被 Session 拥有的检查点和 Storage 准备读取。

```ts
let escaped: Draft<LiveState> | undefined;
await session.commit(async tx => {
  escaped = await tx.doc(LiveDoc, conversationId);
}, context);
escaped!.generation = undefined; // throws: the draft was revoked
```

在 owner 回调落定之前变更草稿的即发即忘（fire-and-forget）工作可能悄悄进入该事务，不受支持。

### 3.5 基线与检查点

创建总是存储完整基线。

对普通的后续变更，仅由定义决定存储记录是否为基线：

```ts
const useBase = definition.checkpointWhen?.(candidateValue, ops, { deltasSinceBase }) ?? false;
```

Session 在跟踪器准备之后恰好求值该谓词一次。`deltasSinceBase` 统计该化身最新基线之后已存储的增量数，不含正在求值的变更。Storage 在物化当前值时报告它；Session 在每次被采纳的写入后推进它，并在每次基线后重置，因此求值不执行 Storage 读取。创建和版本转换要求基线，不调用它。Session 随后只把选中的表示交给 Storage：

```text
required or predicate true -> base with complete value
otherwise                  -> delta with the prepared Chord operation batch
```

Chord 的根替换操作仍是增量，除非定义选中了检查点；它不授权回收。谓词抛出会在 Storage 接纳之前中止已准备的事务。Storage 不执行定义代码，且当选中增量时绝不收到未被使用的完整候选。

- 对 Session、任务和 latest 会话文档，已提交的基线允许对更早记录的物理回收。
- 对 rewindable 会话文档，基线限制重放长度，但绝不允许移除可寻址的历史。
- 从不做检查点的定义可能造成无界的重放尾部。那是定义的缺陷，不是后端的启发式。
- Storage 不统计编码字节数、不与 `initial()` 比较、也不自行发明检查点。

定义可以直接限制重放长度：

```ts
checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31
```

高变更率的活跃文档可以在变空时做检查点：

```ts
checkpointWhen: (value, _ops) =>
  value.generation === undefined &&
  value.tools === undefined
```

### 3.6 版本与迁移

一个迁移回调处理所有受支持的旧版本。

```text
stored == token -> use value
stored < token  -> call migrate(value, storedVersion)
stored > token  -> reject typed access
no migrate      -> reject older stored version
```

`migrate()` 是纯函数并返回完整的当前版本值。迁移是访问驱动的：`tx.doc()`、`snapshot()`、`snapshotAsOf()`、`documentState()` 和 `watchDoc()` 通过提供给该次调用的令牌重建并迁移。Harness open 不清扫普通文档。

- 只读访问只在内存中迁移，绝不写入。它可以把一个跟踪器缓存到该迁移后的不可变修订版上，并连同较旧的存储版本标记；下一次成功的 `tx.doc()` 访问仍会写入必需的当前版本基线。缓存的跟踪器只服务于其值被物化时所用版本的令牌。用任何其他版本的访问——例如来自重载扩展代码的令牌——会丢弃它并重新加载存储值，所以每个令牌要么从存储版本迁移，要么拒绝更新的版本。迁移总是从分离的存储值出发。`tx.doc()` 把迁移暂存进其外层事务；回调失败不持久化任何内容，后续草稿编辑合并为一次最终的必需基线。
- Rewindable 历史不被重写。当前和历史的重建值在重放之后迁移。
- 任何存储版本迁移之后的第一次 `tx.doc()` 事务写入必需的当前版本基线，即使迁移后的 JSON 深度相等。
- 分叉从 Storage 获取选中的存储值/版本，而不是类型化迁移跟踪器缓存。子会话复制那个存储对，并在后续类型化访问时迁移。
- 未被访问的文档和定义不可用的文档保留其存储的实例、版本和字节。

### 3.7 分叉

会话分叉指向一个具体的可见条目 `E`。

子 transcript 包含直到 `E` 的条目，即使同一提交还追加了更晚的条目。`E` 处的文档状态是包含 `E` 的提交的最终状态。不同的文档状态需要分开的提交。

每个会话文档遵循其记录中持久化的 history/fork 策略。
`DocumentRecord`：

| 会话设置 | 子会话的值 |
|---|---|
| `fork: "asOf"` | `E` 的提交时父会话的值 |
| `fork: "current"` | 分叉提交运行时选中的已提交父值 |
| `fork: "initial"` | 不复制实例；子会话首次访问时由初始化器创建 |

`current` 和 `asOf` 复制逻辑上存在的会话单例和族实例，保留未知定义及其存储版本。复制出的值成为独立的子实例，带新 ID 和初始基线。`initial` 不复制实例；子会话中的首次访问用提供的定义创建它。任务文档和任务绝不被复制。Session 文档保持共享且不可回退。

分叉复制读取已提交的存储值，而不是类型化跟踪器缓存。因此，创建分叉的事务如果同时写父会话的某个 `fork: "current"` 文档就会被拒绝；先提交父变更，让分叉有唯一明确的存储源修订版。

分叉暂存后端侧的 `document.copy` 命令，携带子创建记录和精确的源化身/点。Storage 物化每个源并将其存储值/版本持久化为子会话的独立初始基线；远程 Storage 在服务端执行此操作。每次复制读取的已提交批前源状态与写入数组顺序无关。被选中的源不得在同一批次中被创建、变更或退役。复制仍与会话、覆盖、注册表写入和其他变更保持原子。

未被访问的副本在 Session 内存中只保留其描述符。创建事务内的类型化访问惰性读取分离的源，在需要时迁移，并用一个包含最终准备值的普通子创建替换该副本。无定义的副本发布显式的 `document.copy` 元数据而不是值。该元数据宣告由 Storage 支撑的初始状态，绝不被解释为文档值。文档状态、watch 和挂载视图通过在 Session 线上原子地捕获其基线和订阅来水合：一个已存在的后续提交成为基线，而注册之后提交的一个被投递。发布和 watch 是收敛机制，不是审计流。挂载的聚合必须在一次 Session 线操作中获取其全部文档基线并提交订阅，这样它才不会暴露来自同一提交的混合状态。

## 4. 事务与存储所有权

Session 把它加载或创建的文档保存在内存中，作为 Chord 跟踪器，因此读取和变更无需访问 Storage。缓存以使用为界，不以历史为界：一个没有 watch 或文档状态观察的文档，在 `documentRetentionMs`（默认十分钟；`0` 表示用后立即丢弃）内未被读写后就离开缓存，下次访问时从 Storage 加载。被观察的文档绝不离开。驱逐在变更线上运行，在每次提交之后、以及下一个到期的无引用定时器触发时（最旧的空闲文档的定时器；缩短保留时间则更早触发），因此事务绝不会丢失它持有的跟踪器。不是毫秒数、不是 `0` 或更大的保留值意味着使用默认值；`Infinity` 保留文档。观察者钉住（pin）它观察的化身，并在该化身退役时释放。在无法使用无引用定时器的地方，例如 Cloudflare Workers，只有提交会触发驱逐。被反复使用的文档每个粒度（granule，保留时间的十分之一，上限一秒）至多向后移动一次驱逐顺序。任务文档也随其任务退役（第 5.5 节）。`createSession(storage, { documentRetentionMs })` 为纯 Session 设置它；Harness 在每次使用时读取其设置。

Session 提交回调可以是异步的。它通过回调执行、准备、存储落定、已提交基线采纳和发布入队拥有 Session 变更线。提交观察者在变更线上运行；文档状态和 watch 用户回调稍后运行。外部的模型、进程、工具、网络和人为效果在它之外运行。`subscribeCommits()` 在采纳之后于变更线上同步观察完整的不可变发布。`subscribeClose()` 在 close 开始时同步观察——在接纳被封锁之后，失败关闭 Session 时也是；Harness 在那里结束等待、watch 和流，并在每个 close 监听器都运行完之后才向任务调用发信号，这样任务持有的东西以 Session 的原因结束，而不是以取消结束。两者都返回幂等的 disposer；它们的监听器不得阻塞或调用 Session API，抛出的那个被上报而不影响其他监听器（第 10.1 节）。文档状态订阅者和 watch 监听器仍在变更线之外稍后运行。

```ts
await session.commit(async tx => {
  const conversation = await tx.conversation(conversationId); // table read
  const live = await tx.doc(LiveDoc, conversationId);

  await tx.appendEntry(conversationId, message);     // first table write
  delete live.generation;                            // document mutation remains valid
  await tx.createTask(Follow, {}, { ownership: { kind: "conversation" }, conversationId }); // further table writes are fine
}, context);
```

变更接纳发生在提交回调开始之前的 Session 线上。关闭会封锁变更接纳和任务预留。已接纳的提交在存储关闭之前落定。一旦提交被接纳，调用者取消不会中断存储落定也不会撤销提交。取消 close 等待不会重新打开接纳。

表规则：

- 表是会话、条目、任务和提交。
- 第一次表写入之前允许表读取。
- 第一次表写入之后的任何表读取抛出 `ReadAfterWrite`。
- 表写入之后文档访问和读己之写（read-your-writes）仍然可用。
- 创建方法返回创建的 ID/记录；调用者不回读它。

存储所有权：

- 提交参数被借用，直到 `Storage.commit()` 落定。
- 落定之后保留的任何东西都先被分离。
- 内存存储递归复制保留的 JSON 容器。
- JSONL 和 SQLite 通过序列化和解码索引分离。
- 每次存储读取返回分离的 JSON 值。
- 不可变字符串可以共享；可变数组和对象不可以。

## 5. 任务

### 5.1 定义

```ts
type TaskOutcome<R> =
  | { readonly status: "completed"; readonly result: R }
  | { readonly status: "failed"; readonly error: TaskOutcomeError; readonly result?: R }
  | { readonly status: "aborted"; readonly reason?: string; readonly result?: R }
  | { readonly status: "orphaned"; readonly reason: string }
  | { readonly status: "faulted"; readonly error: TaskOutcomeError };

type JoinPolicy = "failFast" | "allSettled";

type TaskState<S, R> =
  | { readonly status: "pending"; readonly checkpoint: S }
  | { readonly status: "running"; readonly checkpoint: S }
  /** 在 `on` 中每个任务都终态之前停驻且无调用；之后在 `checkpoint` 处恢复（第 5.5 节）。 */
  | {
      readonly status: "waiting";
      readonly checkpoint: S;
      readonly on: readonly TaskId[];
      readonly policy: JoinPolicy;
    }
  /** 结果已决定；一旦下方没有活跃的普通拥有工作即为终态（第 5.5 节）。不再运行代码。 */
  | { readonly status: "completing"; readonly outcome: TaskOutcome<R> }
  | { readonly status: "terminal"; readonly outcome: TaskOutcome<R> };

/** 谁拥有任务：它的会话（顶层任务）或同一会话的另一个任务。 */
type TaskOwnership = { readonly kind: "conversation" } | { readonly kind: "task"; readonly taskId: TaskId };

type TaskRecord<I, S, R> = {
  readonly id: TaskId<R>;
  readonly conversationId: ConversationId;
  readonly kind: string;
  readonly version: number;
  readonly input: I;
  /** 拥有任务；会话拥有的任务没有此字段。不可变。 */
  readonly owner?: TaskId;
  readonly background: boolean;
  readonly abortRequested: boolean;
  /** `restart` 表示该标记在重启后弃置任务，而不是中止请求（第 5.4 节）。 */
  readonly abortReason?: "restart";
  /** 来自 `TaskOptions.abandonOnRestart`。不可变。 */
  readonly abandonOnRestart?: true;
  /** 首次变为 `running` 时的墙上时钟；在等待和恢复期间保留。 */
  readonly startedAt?: number;
  /** 变为 `terminal` 时的墙上时钟。 */
  readonly endedAt?: number;
} & (
  | {
      readonly state: Extract<TaskState<S, R>, { status: "pending" | "running" | "waiting" }>;
      readonly memos?: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly state: Extract<TaskState<S, R>, { status: "completing" | "terminal" }>;
      readonly memos?: never;
    }
);

type RunningTask<I, S, R> = TaskRecord<I, S, R> & {
  readonly state: Extract<TaskState<S, R>, { status: "running" }>;
};

/**
 * 任务为自己提交的状态：替换检查点、一次等待、或其结果。返回的 `terminal` 状态在下方普通拥有工作仍活跃时变为 `completing`（第 5.5 节）。
 */
type NextTaskState<S, R> = Extract<TaskState<S, R>, { status: "running" | "waiting" | "terminal" }>;

interface HookRunner<H extends object> {
  each<K extends keyof H>(name: K, invoke: (handler: NonNullable<H[K]>) => void | Promise<void>): Promise<void>;
}

type PhaseHandler<I, P, S, R, H extends object> = (
  task: RunningTask<I, P, R>,
  runtime: TaskRuntime<I, S, R, H>,
  context: Context,
) => Promise<void>;

interface TaskRuntime<I, S, R, H extends object> extends DocumentObserver, DocumentReader {
  readonly taskId: TaskId<R>;
  readonly conversationId: ConversationId;
  readonly signal: AbortSignal;
  /** 当前阶段的注册表快照；在每个阶段边界刷新。 */
  readonly registry: RegistrySnapshot;
  /** 任务的会话的 agent，为该阶段解析一次（第 7.1 节）。 */
  agent(context: Context): Promise<Agent>;
  /** `HarnessOptions.settings`，每次访问时解析。 */
  readonly settings: Settings;
  /** `HarnessOptions.models`，每次访问时解析。 */
  readonly models: Models;
  readonly hooks: HookRunner<H>;
  /** 为任务的会话调用 `HarnessOptions.env`；以错误拒绝。 */
  env(context: Context): Promise<ExecutionEnv | undefined>;

  commit(
    change: (
      tx: Tx,
      current: RunningTask<I, S, R>,
    ) => NextTaskState<S, R> | undefined | Promise<NextTaskState<S, R> | undefined>,
    context: Context,
  ): Promise<void>;

  memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
  memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
  conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
  /** 已提交的任务记录。 */
  getTask<T>(id: TaskId<T>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, T> | undefined>;
  /** 终态回执；调用结束时拒绝。 */
  waitForTask<T>(id: TaskId<T>, context: Context): Promise<SettledTask<T>>;
  /** 本任务拥有的任务的 `abortTask()`，在其终态时返回；对他人拥有的任务拒绝。 */
  abortOwned(id: TaskId, context: Context): Promise<void>;
/** 本任务直接拥有的活跃任务，按 ID 顺序，无论哪个调用创建的；不含其会话中的任务。 */
  ownedTasks(context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]>;
  /** 终态任务的结果，按顺序；有非终态时拒绝。在等待之后使用（第 5.5 节）。 */
  outcomes<T>(ids: readonly TaskId<T>[], context: Context): Promise<TaskOutcome<T>[]>;
  /** 从任务的会话可见的已提交条目。 */
  entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
  entry<D extends JsonValue>(token: Entry<D>, id: EntryId, context: Context): Promise<TypedEntry<D> | undefined>;
  /** 已提交的原始活动 transcript 和模型上下文，可选在 `at` 处截断。 */
  context(conversationId: ConversationId, context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
  /** Harness 时钟。 */
  now(): number;
  /** 把非致命失败转发给 `HarnessOptions.onReport`。 */
  report(error: unknown): void;
  sleep(until: number, context: Context): Promise<void>;
}

type TaskDefinition<I, S extends { phase: string }, R, H extends object> = {
  readonly name: string;
  readonly version: number;
  initial(input: I): S;
  readonly phases: {
    [P in S["phase"]]: PhaseHandler<I, Extract<S, { phase: P }>, S, R, H>;
  };
  abort(task: RunningTask<I, S, R>, runtime: TaskRuntime<I, S, R, H>, context: Context): Promise<void>;
  migrate?(input: JsonValue, checkpoint: JsonValue, fromVersion: number): {
    input: I;
    checkpoint: S;
  };
  readonly hooks?: H;
};

interface Task<I, S extends { phase: string }, R, H extends object> {
  readonly definition: TaskDefinition<I, S, R, H>;
}

type TaskOptions = {
  /** 必需：任务总是指名其 owner（第 5.5 节）。 */
  readonly ownership: TaskOwnership;
  /** 默认：owner 任务的会话，或事务绑定的会话。 */
  readonly conversationId?: ConversationId;
  /** 仅会话拥有的任务：排除在会话中止、空闲和级联之外。 */
  readonly background?: boolean;
  /** 其创建者只在内存中等待它，重启后不恢复（第 5.4 节）。 */
  readonly abandonOnRestart?: boolean;
};

function defineTask<I, S extends { phase: string }, R, H extends object = {}>(
  definition: TaskDefinition<I, S, R, H>,
): Task<I, S, R, H>;
```

`TaskId<R>` 就是数字任务 ID 本身，带一个被擦除的结果类型品牌。它取代了单独的任务引用包装器：`createTask()` 返回 `TaskId<R>`，类型化等待从该 ID 推断 `R`，与结果无关的操作接受 `TaskId<unknown>`。任务的 `conversationId` 在创建后不可变；把已有任务移到另一会话的替换在 Storage 接纳之前被拒绝，这样持久化的会话-owner 边不会变陈旧。

阶段映射是穷尽的且按阶段收窄。处理程序可以在一个效果周围执行多次提交，但每个持久检查点都是完整替换。`TaskRuntime.commit()` 在调用其回调之前在 Session 线上重读并门控当前持久任务。它在以下情况拒绝：调用已结束、Harness 正在关闭、任务已终态、或运行调用的任务带有中止标记。其 `tx.createTask()` 默认为任务的会话，它追加的每个条目都把该任务记为 `byTaskId`。当回调返回一个状态时，运行时在同一提交中替换任务的状态，因此检查点或结果与回调的条目、文档和子任务保持原子，并针对任务的检查点和结果类型做类型检查。不返回任何东西则状态不变。终态或 completing 状态丢弃 memos。`waiting` 状态即使检查点不变也会结束调用；当 `on` 指名缺失任务或形成等待环（第 5.5 节，环上没有任何任务能先完成）时拒绝，空的 `on` 在下一次调度通过时恢复。`pending` 永不返回；只有对账和交接写它。

`Tx` 没有任务替换操作。任务只通过其运行时改变自己的状态。调度器拥有预留、对账、交接、故障和孤儿化；`abortTask()` 拥有中止标记。其他代码用 `abortTask()` 停止任务，用 `waitForTask()` 读取其结果。

```ts
// Intent, effect, outcome.
prepare: async (task, runtime, context) => {
  await runtime.commit(() => ({ status: "running", checkpoint: { phase: "charge", key: newKey() } }), context);
},
charge: async (task, runtime, context) => {
  const receipt = await payments.charge(task.state.checkpoint.key); // idempotent by key
  await runtime.commit(async (tx, current) => {
    const entry = await tx.appendEntry(current.conversationId, receiptEntry(receipt));
    return { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
  }, context);
},
// The abort handler decides the outcome; returning without one faults the task.
abort: async (task, runtime, context) => {
  await payments.cancel(task.state.checkpoint);
  await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "user" } }), context);
},
```
`memo(name, candidate)` 是一次门控提交；`memo(name)` 读取已提交记录。`sleep(until)` 与 Harness 的 `now` 时钟比较，并在调用被发信号或其上下文被取消时拒绝。通过运行时获取的 watch 在调用结束时停止。`snapshot()`/`snapshotAsOf()` 读取已提交文档，例如为 `PromptInput.read` 提供数据（第 7.4 节）。`getTask()` 和 `entry()` 各用一次查找读取已提交记录；`waitForTask()` 等待终态回执，例如工具创建的子任务。
`context()` 在 Session 线上捕获其边界，并在变更线之外从不可变条目推导视图，与 `Conversation.context()` 相同。调度器把每个会话的最后范围和视图保存在内存中：其任何任务稍后用同一 head 标记读取时，只扫描并推导该范围末尾之后的条目。会话在忙碌期间以及空闲后 `contextRetentionMs` 内保留它们。过期在任务变化时和由一个无引用定时器检查，该定时器绝不维持进程存活；在无法使用无引用定时器的地方，如 Cloudflare Workers，只有任务变化会检查。保留的条目被冻结，每次读取返回自己的视图数组。像所有运行时操作一样，这些在调用结束后拒绝。

预留把 `pending`、或已可恢复的 `waiting`，持久地变为 `running`。一次调用按顺序运行阶段处理程序；检查点提交保持 `running`。在每个阶段之前（包括第一个），调度器在 Session 线上运行一个步骤（step）回调。它读取已提交的任务，并同步地对刚返回的阶段应用下面第一条匹配的规则。它在同一提交中写入任何故障或交接，连同调度器所写结果的 Harness 清理（第 5.4 节），并可在该回调内 await 文档访问。规则让它停止时，它就在那里结束调用。因此调用早先排队的运行时提交要么在步骤之前落地并被计入，要么在它之后到达变更线并被拒绝。第一个阶段之前只有规则 1–3 适用：

1. 终态、`completing` 或 `waiting`：停止。
2. Session 正在关闭：停止；为重新打开保留检查点和任何中止标记。
3. 运行模式带持久中止标记：结束并加入运行调用；在该任务的普通拥有工作不再活跃后启动新的中止调用（第 5.5 节）。
4. 未捕获错误：写入终态 `faulted`。
5. 检查点变化，包括同一阶段内的进展：刷新注册表快照，然后交接（第 5.4 节）或在同一任务调用中调用阶段处理程序。
6. 检查点未变：写入终态 `faulted`，因为没有取得持久进展。

中止调用只运行一次其中止处理程序。它落定后，步骤应用规则 1、2 和 4；不带回终态结果就返回的处理程序使任务故障。当 Storage 拒绝某步骤的故障或交接写入时，调用仍然结束；任务保持 `running`，下次预留再次运行它。

Open 时，运行任务的对账把存活下来的 `running` 任务改回 `pending`，保留其检查点和中止标记；`waiting` 任务保持等待，`completing` 和 `waiting` 任务被重新评估（第 5.5 节）。任务迁移在预留时运行，与 `pending` 或 `waiting` -> `running` 原子。一个回调处理所有受支持的旧版本。定义缺失、比存储版本旧、或迁移失败的任务保持 `pending` 或 `waiting` 并受阻，直到安装了合适的定义或任务被中止（第 5.4 节）。
`close()` 把运行时标记为关闭，封锁接纳和预留，向调用发信号，并结束状态和 watch。在 Session 线之外，它先让已接纳的提交落定并加入调用，然后关闭存储。已在运行的 watch 回调仍归调用者所有。后续运行时提交拒绝，close 不写任务结果。关闭不启动新的阶段或中止调用。它不设置中止标记、不终止任务、不退役任务文档、也不发布文档退役。宿主层在关闭 Harness 之前停止向客户端暴露 Harness 状态，例如关闭为它提供对象的 Chord host；重新连接到重开的 Session 会水合最后提交的状态并从其持久检查点恢复。

### 5.2 效果三明治

```text
commit intent phase
perform external effect
commit outcome or next phase
```

在意图阶段重开意味着效果可能已发生。阶段处理程序安全地重试、轮询外部句柄、或记录中断。延迟提供方（deferred provider）由一个持久阶段表示，包含其句柄和下次轮询时间。

运行时拥有的 memos 是存在活跃任务信封中的小的先写者胜出的值。候选插入和读取胜者是一次 Session 提交，所以并发候选返回同一个持久胜者。Memos 跨检查点存活，并在终态替换中消失。批量进展应放在文档里。

### 5.3 终态任务

终态任务记录是持久的回执。其结果可以直接包含一个小值或引用一个条目：

```ts
{ status: "completed", result: { entryId: toolResultId } }
```

终态转换原子地：

1. 写入终态任务记录。
2. 追加任何结果条目。
3. 退役所有属于该任务作用域的文档。
4. 解析由该任务落定的提交。

普通拥有工作仍活跃的任务会在 `completing` 保持点拆分这一过程（第 5.5 节，规则 4）：任务所写结果自身的写入在保持点落地，第 1、3 项及其等待者在最终提交中跟进。

执行检查点和 memos 从终态表示中消失。终态记录仍可被等待、等待者、检查和重开查询。

Session 用它打开时的时钟（Harness 为 `HarnessOptions.now`，默认 `Date.now`）在任务记录上打生命周期时间戳：首次变为 `running` 时打 `startedAt`，变为 `terminal` 时打 `endedAt`。一旦设置，各自从被替换的记录延续，所以 `startedAt` 跨等待、`completing` 保持和重开存活，两者之间的跨度也包含这些。从未运行过的任务——例如在首次预留前就被孤儿化的——只有 `endedAt`；更早版本写的记录两者都没有，跨升级存活的任务在其下次运行时获得 `startedAt`。`inspect()` 在每个活跃任务的记录上显示它们。它们是生命周期时间，不是执行时间：工具的执行时间是其结果的 `durationMs`（第 7.3 节）。
没有独立的任务依赖：顺序来自一个任务等待其他任务（第 5.5 节）。中止标记让待处理工作到达其中止处理程序，或在其定义不可用时到达其 `orphaned` 落定。

### 5.4 调度器、中止与归属

调度器串行地预留合格任务，然后在 Session 线之外运行处理程序。一个内存中的 `TaskInvocation` 包含模式、中止控制器和完成 promise。

中止协议：

```text
commit abortRequested
signal and join active run invocation
wait until ordinary owned work is no longer live (section 5.5)
start a fresh abort invocation
abort handler commits terminal outcome
```

运行调用在其持久中止标记出现后不得再提交。其拥有调用结束后每个运行时操作都拒绝，即使 Session 仍打开；调用因任何原因结束时，其信号和处理程序上下文中止。调用只在其最后一个处理程序返回后才结束，所以这只取消分离的残留物，例如未被 await 的 `waitForTask()` 或以处理程序上下文发起的 fetch；它们已无法再写任何东西。从一个阶段处理程序返回不结束继续进入另一阶段的调用。调用模式是易失的，重开时从持久标记推导。取消一个调用者的 `Context` 只取消该次调用或等待；它不会持久中止共享工作，除非被调用的 API 提交了中止标记。

任务可以创建拥有的会话和拥有的任务（第 5.5 节）。会话是持久作用域；任务是被空闲计数的活跃工作单元，并被中止所标记。历史父关系与归属遍历无关。

普通遍历从一个显式寻址的会话出发，访问其会话拥有的任务，跟随每个非后台任务拥有的任务，并跟随每个非后台任务拥有的会话。它在 owner 变为终态之后仍跟随 owner 边，但后台任务是一个边界：普通遍历跳过该任务及其整个拥有的子树。
直接会话操作从该会话内部开始，无论其 owner。直接中止一个活跃的后台任务包括该任务并跟随
其普通拥有子树；嵌套的后台 owner 仍是边界。
`close()` 停止每一次调用，前台和后台，不写结果，所以工作在重开时恢复。必须持久取消一切的宿主，逐个中止 `inspect()` 列出的每个活跃任务。

`Conversation.abort()` 撤回排队的输入，并标记普通遍历选中的活跃非后台任务。带 `{ background: true }` 时它跨越后台边界：它标记在操作被接纳时忽略后台标志的遍历能到达的每个活跃任务，并撤回它到达的每个会话的排队输入。然后它等待它标记的每个任务都终态且会话普通空闲；之后创建的后台工作既不被标记也不被等待。`Conversation.waitForIdle()` 等待该遍历不含活跃的非后台任务。Harness 空闲从每个无主会话根执行同样的遍历，而不是全局计数任务，所以后台 owner 之下的普通工作不阻塞它。显式 `waitForTask()` 等待其引用的任务，无论该任务的后台标志。

中止标记幂等地级联到前台拥有的工作。持久的取消意图是活跃 owner 自己的记录：其中止标记，或一个非 `completed` 的持有 `completing` 结果（第 5.5 节）。终态 owner 绝不级联：它只在普通拥有工作排空后才变为终态，所以其意图已应用，而后来在它拥有的会话中开始的工作——例如用户向已完成的子代理提问——正常运行，并能从上方被普通遍历到达。其拥有会话中排队的输入保持排队，如同一次失败的运行之后（第 6 节）。调度器在其后的一次对账提交中推导标记，并在 open 时再次推导，所以中间的崩溃不丢失任何东西；已排在 Session 线上的工作可以先多提交一次。每个活跃的非后台任务，其 owner 链——沿拥有任务和拥有会话向上走——到达一个被取消的活跃 owner，且中途未穿过一个自身没有取消意图的后台任务，都会得到中止标记，包括级联之后在那里创建的工作。在独立的提交中推导标记使其不进入 owner 的提交，后者可能已写入了涉及的任务。级联到达的每个会话都按 `Conversation.abort()` 对待：其排队的输入提交变为 `unanswered`、原因为 `aborted`，并离开其收件箱；排队的写入保留。级联从被取消任务的下方开始，所以该任务自己的会话保留其队列。持有的结果 `failed`、`faulted`、`orphaned` 和 `aborted` 记录与中止标记相同的持久取消意图；`completed` 不是。会话记录和 owner 边绝不随任务退役。活跃调用在提交之后收到信号。终态回执保证该任务的普通拥有工作已排空；其下方的后台工作可以继续。

每次运行调用启动都按 `TaskRecord.kind` 从调度器当前注册表快照解析任务的定义：

```text
definition missing                 -> stay pending, blocked: missing_task
stored version newer than it       -> stay pending, blocked: task_too_old
stored version older than it       -> migrate(input, checkpoint, storedVersion)
  failure                           -> stay pending, blocked: migration_failed
  success                           -> commit migrated record + running atomically
equal version                       -> commit running
```

中止调用以同样方式解析定义。当定义能接手该任务时，运行其中止处理程序；否则按下面所述把任务孤儿化。

失败的迁移经 `onReport` 上报一次，只在注册表为该任务的 kind 解析出不同的定义对象后才重试。

Harness 绝不只因注册表代码缺失或不兼容而终止任务，open 时和之后都不。没有中止标记的受阻任务保持其持久记录不变，保持活跃，仍阻塞普通空闲等待，并在注册表每次变化时被重新考虑。受阻原因是推导的运行时状态，不是持久化的任务状态。文档迁移仍是访问驱动的。

中止受阻任务无法运行其中止处理程序，因为那段代码缺失或不能接手任务。因此 Harness 把它落定为终态 `orphaned` 而非 `aborted`：`aborted` 意味着任务自己的中止处理程序运行过并决定了结果，而 `orphaned` 意味着没有任何任务代码运行过，任务启动的外部效果可能未被清理。孤儿化的 `reason` 是受阻原因（`missing_task`、`task_too_old` 或 `migration_failed`）。当 `abortTask()` 发现没有活跃调用、没有活跃的普通拥有工作、且当前快照不能接手任务时，标记提交直接落定它；否则调度器在将要预留中止调用时落定它，即在拥有工作排空之后（第 5.5 节），所以孤儿化结果从不保持。只有中止（直接、经会话、或经级联）会孤儿化任务；缺失定义本身绝不会，`restart` 标记（见下）也不会——其任务等待自己的定义，因此其中止处理程序仍可清理。

以 `abandonOnRestart` 创建的任务只被其创建者在内存中等待，创建者重启后不恢复，就像重放不安全的工具一样。当这样的任务在另一个 Harness 开始调度后（`resume()`，或第一次提交或等待）仍活跃时，它已无意义：第一次预留通过设置其中止标记并带 `abortReason: "restart"`，且不预留任何东西，下一次通过看到这些标记。仅 open 不标记任何任务，所以只做检查的 open 不标记任务。级联把 `restart` 原因传递给下方普通拥有的工作；其他取消意图不带原因标记，并替换其下方的 `restart` 标记。请求（`abortTask()`、会话中止）也替换 `restart` 标记，因此等待自己定义的带 restart 标记的任务随后被孤儿化；owner 通过 `runtime.abortOwned()` 做的自身清理保留该标记。中止处理程序在任务记录上看到原因，能区分弃置与请求。

在带取消意图的 owner 之下，没有任何任务启动运行阶段，即使级联尚未标记它：预留跳过它，运行中的调用在其下一阶段前结束，两者都会再次调度级联。这样的工作只运行其中止处理程序。失败的对账或预留提交使 Session 失败（第 10.1 节）。

孤儿化提交执行任务代码无法执行的清理：受影响的输入提交变为带原因的 unanswered，任何匹配的活跃运行控制被清除，任务作用域的文档退役。终态任务记录和 unanswered 提交携带原因；写入的唯一 transcript 条目是已提交 generation 部分结果的转换（见下）。使运行任务故障执行同样的控制/提交清理，结果为 `faulted`；普通拥有工作活跃时的故障保持，其清理在最终提交中运行（第 5.5 节，规则 4）。

调度器对运行和任务种类一无所知。拥有提交、运行控制和内置任务的 Harness 给它一个钩子，调度器在使它自己写的结果（`faulted` 和 `orphaned`）终态的那次提交中调用该钩子，即保持之后的最终提交。钩子忽略 kind 不是内置 run、tool 或 compaction 的任务，所以它绝不在别处创建 `pi.live`。当 `pi.live.run` 指名该任务时（第 8 节）它结算运行：已提交的 generation 部分结果变为中止的 `pi.assistant` 条目，与 generation 中止处理程序的转换完全相同，因此 transcript 保留模型产出的内容，`pi.usage` 计入其花费（调度器的提交没有任务作用域，所以条目没有 `byTaskId`）；其输入变为 `unanswered`，原因为 `faulted`（细节：错误消息）或受阻原因；并移除 `run`、`generation` 和 `tools`。故障来自任务缺陷或畸形的提供方数据，例如响应中的非 JSON 值。存储失败使 Session 失败且不写结果（第 10.1 节）。对 `pi.tool` 任务，它把任务的工具槽标记为 `done` 而不带条目；运行继续，上下文推导合成缺失的结果（第 2.1 节）。对 `pi.compaction` 任务，它移除任务的压缩状态（第 8.7 节）。任务自己提交的结果自己结算。Harness 还提供 `runtime.hooks` 和 `runtime.agent()` 背后的每阶段 agent 解析（第 7.1 节）；调度器只把每个阶段的注册表快照传给它。

在每个正常的阶段边界（第 5.1 节，规则 5），步骤刷新调用的注册表快照。如果按名字解析的任务定义是与调用开始时不同的对象，且新定义能预留该任务（同版本，或带 `migrate` 的更高版本），调用就交接：步骤把任务连同其检查点、memos 和中止标记提交回 `pending`，结束调用，下一次预留在新定义下启动新的调用，应用上面的预留规则。当定义缺失或不能预留任务时，调用在旧定义下继续运行，对每个解析出的定义经 `onReport` 上报一次，并在其下一个边界重新考虑。从不落定的处理程序从不交接。

### 5.5 结构化并发

任务和会话构成一棵归属树。每个任务在创建时指名其 owner，`tx.createTask(task, input, { ownership })` 带必需的 `TaskOwnership`：其会话（`{ kind: "conversation" }`，顶层任务）或一个任务（`{ kind: "task", taskId }`，子任务）。每个会话要么无主，要么由任务拥有（第 2.2 节）。子任务总是活在其 owner 的会话中；只有被拥有的会话跨越会话边界。Owner 边不可变。

任务 `T` 的**普通拥有工作**是普通遍历在 `T` 之下能到达的每个任务：`T` 拥有的任务、`T` 拥有的会话中的任务，以及传递地，其中每个非后台任务的同样内容。后台任务及其下方的一切被排除。会话拥有的任务
可以是后台的；子任务不行。

从这棵树可以得出两条规则。

**中止向下流动**（第 5.4 节）。活跃 owner 的取消意图（其 abort 标记，或持有的非 `completed` 结果）标记其普通拥有工作。后台任务是边界，除非被直接中止或被 `Conversation.abort(context, { background: true })` 中止。

**拥有的工作不比 owner 的完成更长寿。** 任务只在其普通拥有工作排空之后才完成：

1. 任务提交的终态，或调度器写入的终态结果（`faulted`、`orphaned`），在该任务的普通拥有工作仍活跃时，被存储为 `{ status: "completing", outcome }`。调度器在稍后的提交中写入最终 `terminal` 记录，条件是没有普通拥有工作活跃，在每次提交之后求值，包括保持之后创建的工作。工作是否活跃按提交的候选记录判定，所以完成提交自己创建的工作——例如该任务拥有的会话中的任务——会保持它。Open 时重新评估每个 `completing` 任务。
2. 持有的结果是最终的：不再运行阶段、运行时提交或中止处理程序，不需要定义，任务绝不被预留或迁移，对它的 `abortTask()` 只标记它并返回 `marked`，这会取消下方的工作。最终记录保留持有的结果和标记。
3. 持有的非 `completed` 结果是取消意图，所以下方的工作被中止、排空，然后任务变为终态。持有的 `completed` 结果等待工作正常完成。
4. 写入在保持点拆分。任务所写的终态提交把它的所有其他写入——例如工具的结果条目和槽——在保持点落地。只有记录的终态、任务文档退役和任务等待者被推迟到最终提交。调度器所写的结果在保持点只写记录；其 Harness 清理（第 5.4 节）在最终提交中运行，所以故障的运行任务在其工具排空之前保持 `pi.live.run`。
5. 等待者、空闲等待、检查和普通遍历把 `completing` 任务视为活跃，直到其最终提交。

新的拥有工作需要活跃的 owner：带任务归属的 `createTask` 和带任务归属的 `createConversation` 在提交的最终候选中拒绝 `completing`、`terminal` 或带中止标记的 owner（第 3.3 节）。会话在其 owner 完成后仍然可用：在那里开始的新运行——例如向已完成的子代理提问——是该会话的普通工作，从上方被遍历到达，不属于任何完成过程。

**等待。** 阶段可以提交 `{ status: "waiting", checkpoint, on, policy }`。任务在没有调用的情况下停止，并在 `on` 中每个任务都终态后在 `checkpoint` 处恢复。`on` 可以指名任何任务，包括已终态的；等待任务不拥有的任务——其 `owner` 不是等待任务——要求 `policy: "allSettled"`。`on` 不得指名缺失任务，也不得在等待图中闭环（第 5.1 节），图的边从每个任务指向它等待的任务和它的活跃普通拥有工作（后者把它保持为 `completing`）。等待自身的任务、或等待保持它的 owner 的任务，构成最短这样的环；后台任务可以等待其会话的 owner，它不保持该 owner。检查从 `on` 中的任务沿两类边走，每个任务只访问一次，拒绝时指名该环。只有持久等待是边：只在内存中持有的等待——例如 `runtime.waitForTask()` 或嵌套调用的——不被检查。带中止标记的任务只等待其拥有的工作，所以其 `on` 不是边。
带 `failFast` 时，`on` 中第一个持有或以非 `completed` 结果结束的任务，会在调度器的下一次对账提交中给 `on` 中其他每个活跃任务一个中止标记。等待任务本身不被标记：它在 `on` 全部终态后恢复，并用 `runtime.outcomes()` 读取它们的结果。任务可以在等待之前创建子任务并继续运行阶段，也可以按顺序等待其子任务的任何子集。

**中止顺序自底向上。** 任务的 abort 调用只在其普通拥有工作不再活跃之后启动，所以中止处理程序看到下方最终的结果。等待任务上的中止标记让它按同一规则提前离开等待进入其中止处理程序；其 `on` 中它不拥有的任务不被等待。顺序按已提交记录判定：子任务在其终态提交之后运行的代码不在顺序内。abort 处理程序不得返回 `waiting`，也不能创建拥有的子任务，因为其任务带中止标记（第 3.3 节）：它内联补偿，或创建后台会话拥有的任务（级联到不了它们），并用 `runtime.waitForTask()` 等待它们——这会保持其调用。

示例 `Checkout` 任务的级联，它以 `failFast` 等待四个 `Payment` 子任务：一张过期卡使其支付失败；三个活跃支付得到中止标记并在各自的中止处理程序中退款；四个都终态后，`Checkout` 恢复，经 `outcomes()` 读到 `[aborted, failed, aborted, aborted]`，并决定自己的结果。`abortTask(Checkout)` 则标记 `Checkout`，级联标记活跃的支付，它们的中止处理程序先运行，然后 `Checkout.abort` 运行并看到它们的最终结果。

## 6. 提交与收件箱

提交记录支撑可 await 的宿主对象。接纳是 Harness 内部的；边界用 `tx.placeSubmission()` 放置排队的提交，运行任务用 `tx.settleSubmission()` 落定它们回答的输入。排队的提交在内置收件箱文档中等待，一个带标签项的有序列表：

```ts
type InboxItem =
  /** `entry` 是输入的 `InputEntry`（`kind` 和可选 `data`），给出时存在。 */
  | { readonly id: SubmissionId; readonly mode: "steer" | "followUp"; readonly content: UserInput; readonly entry?: InputEntry }
  /** `entry` 是写入的 `EntryDraft`，以普通 JSON 存储。 */
  | { readonly id: SubmissionId; readonly mode: "write"; readonly entry: JsonObject };

type InboxState = { items: InboxItem[] };
```

| 字段 | 值 |
|---|---|
| kind | `pi.inbox` |
| version | `1` |
| scope/history/fork | conversation、`latest`、`initial` |
| `initial()` | `{ items: [] }` |
| checkpoint | `items` 为空时写完整基线 |
| view mount | `docs["pi.inbox"]` |
| created | 随每个 Harness 会话创建（第 2.2 节） |

项按 ID 顺序。排队的输入存储其内容及其条目的 kind 和 data；其条目在放置时获得 Harness 时钟的时间戳。

输入作为一条 `model` 为其 `content` 的用户消息的条目放置：一条 `pi.user` 条目，或带 `entry: { kind, data }` 时，一条携带该数据的该 kind 条目。只从 `entry` 取 `kind` 和 `data`；接纳拒绝不是非空字符串或以 `pi.` 开头的 kind。Harness 中没有任何东西按 kind 读取输入条目；上下文、压缩、事件和运行记账都按 `model` 和提交记录进行。

只有 `kind` 和 `data`、没有 `model`、`head` 或 `edits`（存在即算，即使为空）的写入是仅展示（display-only）的：它不改变模型上下文，所以接纳在同一提交中追加它并落定为 `done`，无论忙碌或空闲，且排在仍排队的更早提交之前。在工具调用与其结果之间它不改变任何东西，因为结果按消息排序。唯一的例外是排队的重置：若追加在它之前，该条目会落在重置所开始的上下文之外，所以仅展示写入排在排队的重置之后，并在同一边界上在其之后放置。排队的提交属于其会话，所以分叉以空收件箱开始。

运行控制位于内置活跃文档 `pi.live`（第 8 节）。其可选的 `run` 值指名当前负责该运行的任务及其已放置的输入提交 ID。`run !== undefined` 定义 `busy`；空闲文档的 get-or-create 不算。该值在 generation、工具之间互相移交工作时保持：`taskId` 指名落定这些输入的 generation，包括其工具轮运行期间，然后是下一个 generation。工具任务绝不拥有运行；当前轮的工具任务列在 `pi.live.tools` 中。ID 列表是可变状态，因为边界把已放置的转向（steering）输入加入活跃运行；每条终态路径恰好落定列出的那些输入。

接纳与终态转换：

| 动作 | 提交状态 | 其他写入 |
|---|---|---|
| 输入，空闲且收件箱为空 | `placed`，带用户条目 | 创建运行和 generation |
| 仅展示写入，无排队重置 | `done`，带条目 | 追加条目；无运行 |
| 写入，空闲且收件箱为空 | `done`，带条目 | 追加条目；无运行 |
| 输入或其他写入，忙碌或收件箱非空 | `queued` | 追加收件箱项 |
| 边界放置用户项 | `placed`，带条目 | 把 ID 加入当前或后继运行 |
| 边界放置写入 | `done`，带条目 | 追加条目 |
| 运行作答 | 输入 `done`，带必需的答案条目 | 移除 `run`，或移交给后继 |
| 运行失败或其任务中止 | 输入 `unanswered`，带原因 | 移除 `run`；收件箱不变 |
| 撤回排队项 | `unanswered`，原因 `aborted` | 移除收件箱项 |
| 过期 head 写入 | `unanswered`，原因 `stale` | 移除收件箱项 |

`requestId` 在任何写入之前于一个会话内去重；把同一个用于另一种提交类型会被拒绝。忙碌时 `whenBusy: "reject"` 的输入不写记录并报告 `ConversationBusy`。空闲输入以模式
`steer`，`whenBusy` 为 `steer` 时；否则为 `followUp`。

收件箱非空的空闲会话——例如一次失败的运行之后——把每个新输入和每个非仅展示的写入排在等待项之后，并在同一提交中运行一次最终边界。仅展示写入不经过边界直接追加，所以一条聊天消息绝不会重启失败的工作。顺序保留：失败之前排队的 follow-up 在新输入之前被选中。

`Submission` 等待到 `done` 或 `unanswered`；中止只撤回仍在排队的提交，对已放置的输入报告 `already_placed`，对任何终态提交报告 `settled`。会话中止撤回排队的 steer/follow-up 提交，但保留写入以便之后放置。

边界选择按项 ID 确定性进行，使用设置的 `steeringMode` 和 `followUpMode`（第 2.2 节），在每次边界时于 Session 线上读取：`one-at-a-time` 选该模式的第一项，`all` 选该模式的每一项。

| 边界 | 写入 | steer | follow-up |
|---|---|---|---|
| `postTools` | 全部 | 按模式选第一项/全部 | 无 |
| `final` | 全部 | 按模式选第一项/全部 | 按模式选第一项/全部 |

边界先放置其选中的写入（按 ID 顺序），然后放置其选中的用户项（按 ID 顺序）。因此排在重置或压缩摘要之前的用户项在它们之后落地，并在新上下文中运行。排队的用户项绝不因 head 而过期。

一个 head 写入——排队的或立刻放置的——其目标早于活跃范围起点（最新 head 标记的 `head`）时是过期（stale）的：放置它会把该 head 砍掉的历史带回来。同一边界中更早放置的 head 也算：在排队的重置之后，一个针对更早条目的排队摘要是过期的。`head: "self"` 的写入从不过期。

压缩摘要是 head 写入（第 8.7 节），所以仅这条规则就按截断位置排序压缩：无论何时被选中，截断在活跃范围起点之前的摘要是过期的，截断在其上或之后的被放置。示例：后台压缩 B 在尾 100 处选中并在 70 处截断。它摘要期间，阻塞压缩 A 在 150 处截断并追加其摘要。B 的摘要随后落定为 `stale`，因为 70 早于 150。若 A 改为在 60 处截断，B 会在其后被放置：B 摘要的是其选中时的上下文——当时最新的摘要加上 70 之前的条目——覆盖了 A 的摘要覆盖的一切。这在 head 只有压缩摘要和重置时成立，它们使更早的截断过期；压缩摘要期间放置的应用编辑会丢失，应用 head 也可能被撤销（第 12 节）。

选中 `head: "self"` 写入（重置）的 `postTools` 边界按 `final` 行为：它也选中 follow-up，当前运行以其输入 `unanswered`、原因 `reset` 结束，因为其上下文在答案之前被截断。在 `final` 边界放置的重置跟在答案之后，所以输入已是 `done`。

普通的 `postTools` 边界即使没有排队触发也继续 generation；选中的 steer ID 加入该延续。终止或交接的工具轮（第 8.5 节）改用 final 行为。在 `final`，当前运行已放置的输入提交先落定，除非 `onYield` 延续保持它们打开（见下）；选中的用户 ID 启动一个后继 generation，以这些 ID 作为新运行的输入。写入绝不自己触发 generation。没有用户触发的最终边界让会话空闲，除非有 `onYield` 延续（第 8.3 节），它只在边界未选中任何用户项且无重置时适用。

只有成功的运行结束应用最终边界：答案、`terminate` 或 `handoff`。失败、运行任务的中止处理程序、故障和孤儿化把运行的输入落定为 `unanswered` 且不动收件箱（`Conversation.abort()` 另行撤回排队的用户项）；排队项在 `pi.inbox` 中保持可见，直到下一个输入或排队写入运行一次边界，或它们被撤回。

选中和过期的项按位置移除，同时保留项的顺序。Chord 的 Astra 操作生成器必须能在不携带保留值的情况下表达分散的移除；不得用 ID 替代位置性的收件箱语义。

## 7. 扩展、钩子、工具与系统提示词

### 7.1 扩展、注册表与 agent 解析

扩展代码通过一个应用拥有的扩展注册表进入 Harness。扩展是一个具名的捆绑包：工具、提示词节、钩子、工具和节的包装器，以及任务定义。注册表是进程本地的，可以比 Harness 活得久，且不被持久化；持久状态保存在会话、条目、任务和文档中。会话在其 `pi.agent` 文档中按名字选择扩展（第 2.2 节）。

```ts
type DocumentReader = Pick<Session, "snapshot" | "snapshotAsOf">;

type PromptInput<Tool extends ToolRegistration = ToolRegistration> = {
  readonly conversationId: ConversationId;
  /** 该请求的解析；`agent.tools` 是本请求提供的工具。 */
  readonly agent: Agent<Tool>;
  /** 由 `HarnessOptions.env` 为本次准备构建（第 2.2 节）。 */
  readonly env: ExecutionEnv | undefined;
  /** 重放活动 transcript 后已生效的节。 */
  readonly shown: Readonly<Record<string, string>>;
  /** 已提交文档读取。 */
  readonly read: DocumentReader;
};

type PromptSection<Tool extends ToolRegistration = ToolRegistration> = {
  readonly key: string;
  render(input: PromptInput<Tool>, context: Context): string | undefined | Promise<string | undefined>;
  /** 默认 true：把文本包成 `<key>\n...\n</key>`。 */
  readonly tag?: boolean;
};

/** 由 `hook()` 构建；按名字匹配任务。 */
type HookRegistration = { readonly task: string; readonly handlers: object };

/** 由 `wrapTool()` 和 `wrapSection()` 构建；以工具名或节 key 为目标。 */
type Wrap<Tool extends ToolRegistration = ToolRegistration> =
  | { readonly tool: string; wrap(tool: Tool): Tool }
  | { readonly section: string; wrap(section: PromptSection<Tool>): PromptSection<Tool> };

interface Extension<Tool extends ToolRegistration = ToolRegistration> {
  readonly name: string;
  readonly tools?: readonly Tool[];
  readonly sections?: readonly PromptSection<Tool>[];
  readonly hooks?: readonly HookRegistration[];
  /** 在本扩展被选中之处按顺序应用。 */
  readonly wraps?: readonly Wrap<Tool>[];
  /** 为每个任务按名字解析，无论哪个会话选择了本扩展。 */
  readonly tasks?: readonly AnyTask[];
}

function defineExtension<Tool extends ToolRegistration = ToolRegistration>(extension: Extension<Tool>): Extension<Tool>;
function section<Tool extends ToolRegistration = ToolRegistration>(
  key: string,
  render: PromptSection<Tool>["render"],
  options?: { readonly tag?: boolean },
): PromptSection<Tool>;
function hook<K extends AnyTask>(task: K, handlers: Partial<HooksOf<K>>): HookRegistration;
function wrapTool<Tool extends ToolRegistration>(tool: Tool, wrapper: (tool: Tool) => Tool): Wrap<Tool>;
function wrapSection<Tool extends ToolRegistration = ToolRegistration>(
  key: string,
  wrapper: (section: PromptSection<Tool>) => PromptSection<Tool>,
): Wrap<Tool>;

interface RegistryReader<Tool extends ToolRegistration = ToolRegistration> {
  /** 整个当前注册表的不可变视图。 */
  snapshot(): RegistrySnapshot<Tool>;
  /** 每次发布之后同步调用；唤醒调度器重新考虑受阻任务。 */
  subscribe(listener: () => void): () => void;
}

interface RegistrySnapshot<Tool extends ToolRegistration = ToolRegistration> {
  installed(): readonly Extension<Tool>[];
  extension(name: string): Extension<Tool> | undefined;
  /** 每个已安装工具及其扩展，按安装顺序。名字可以跨扩展重复。 */
  tools(): readonly { readonly extension: Extension<Tool>; readonly tool: Tool }[];
  sections(): readonly { readonly extension: Extension<Tool>; readonly section: PromptSection<Tool> }[];
  /** 内置和已安装的任务定义。 */
  tasks(): readonly AnyTask[];
  task(name: string): AnyTask | undefined;
}

interface Registry<Tool extends ToolRegistration = ToolRegistration> extends RegistryReader<Tool> {
  /** 安装 `extension`，或原地替换同名已安装扩展。立即发布。 */
  install(extension: Extension<Tool>): void;
  /** 移除名为 `extension.name` 的已安装扩展，无论它是哪个对象。之后的安装会追加。 */
  uninstall(extension: Extension): void;
}

function createRegistry<Tool extends ToolRegistration = ToolRegistration>(): Registry<Tool>;
```

`Tool` 参数让应用把元数据（例如提示词片段）附着到其工具上，并在其节渲染器中以类型化方式读取。Harness 只依赖 `ToolRegistration`；它自己的表面（如 `runtime.agent()`）使用默认类型。元数据字段必须是可选的：注册表不检查它们，且默认类型的扩展可能被安装。从工具派生的 pi-ai 声明只保留 pi-ai `Tool` 字段（`toToolDeclaration`），所以应用元数据绝不进入 transcript。

```ts
type CodingAgentTool = ToolRegistration & { readonly promptSnippet?: string };
// The renderer sees CodingAgentTool: no cast needed to read promptSnippet.
export const ToolList = defineExtension<CodingAgentTool>({
  name: "tool-list",
  sections: [section("tools", ({ agent }) => agent.tools.map((tool) => `- ${tool.name}: ${tool.promptSnippet ?? tool.description}`).join("\n") || undefined)],
});
const registry = createRegistry<CodingAgentTool>();
```

规则：

- 第 8 节的内置任务始终存在且不是扩展：`tasks()` 包含它们，没有任何东西卸载或替换它们。任何扩展都可对它们注册钩子。
- 工具名和节 key 在一个扩展内唯一；跨扩展可以重复。节 key 匹配 `^[a-z][a-z0-9_-]*$`，key `instructions` 保留给 agent 的指令（见下）。
- 任务名在内置任务和每个已安装扩展之间唯一。`install()` 按替换之后的注册表校验，包括上述规则，无效时抛出且不发布任何内容。`defineExtension()` 和 `section()` 不做检查。
- 发布是同步的，不调用任何扩展回调，并通知订阅者。没有批处理：扩展是重载的单位，再次安装它会在其安装位置用一次发布替换其工具、节、钩子、包装器和任务。
- 扩展、工具和任务定义不可变，包装器是纯的：包装器返回新对象，绝不修改其输入。
- 作为选择或包装目标传入的扩展或工具对象代表其名字：`settings.extensions` 中保存的旧 `Skills` 对象解析为已安装的 `skills` 扩展。

快照是普通的不可变值；不释放任何东西。调度器为每次阶段处理程序调用取一个并经运行时传递；处理程序和钩子读取那个快照，绝不自取。在每个正常阶段边界，调度器取新的一个，任务定义按第 5.4 节交接。不同阶段可能观察到不同的注册表状态；没有任何东西要求一次运行在其 generation 和工具任务之间看到单一注册表状态。

```ts
export const ContextFiles = defineExtension({ name: "context-files", sections: [section("agents-md", renderAgentsMd)] });
export const Skills = defineExtension({ name: "skills", sections: [section("skills", renderSkills)] });
export const Coding = defineExtension({
  name: "coding",
  sections: [
    section("preamble", () => "You are an expert coding assistant.", { tag: false }),
    // The environment the host built for this conversation, in the conversation's directory.
    section("cwd", (input) => input.env && `Working directory: ${input.env.cwd}`),
  ],
});
export const Permissions = defineExtension({
  name: "permissions",
  hooks: [hook(ToolTask, { beforeTool: async (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined) })],
});
// A role and a review loop, for conversations that select it.
export const Reviewer = defineExtension({
  name: "reviewer",
  sections: [section("role", () => "You review diffs. Report problems as a list. Never edit files.")],
  hooks: [hook(GenerationTask, { onYield: requestSecondPass })],
});

const registry = createRegistry();
for (const extension of [CodingTools, Coding, ContextFiles, Skills, Permissions, Reviewer]) registry.install(extension);
const harness = await Harness.open(storage, {
  models,
  registry,
  // Reviewer is installed but not selected by default: only conversations that select it get its role and hooks.
  settings: { extensions: [CodingTools, Coding, ContextFiles, Skills, Permissions] },
  env: ({ cwd }) => localEnv(cwd ?? process.cwd()), // cached NodeExecutionEnv per directory
}, context);
// The conversation remembers its model and directory; a restart elsewhere keeps both.
const root = await harness.root(context, { agent: { model: sonnet, cwd: process.cwd() } });
```

注册表不跟踪哪些运行中的工作仍在使用被替换或卸载的扩展。已经开始的工作继续使用它取到的代码，所以一个在 `uninstall()` 之后立即释放资源的扩展可以让仍在运行的调用以普通错误结果失败。需要优雅处置的扩展自己管理其资源的生命周期，例如按引用计数。

**解析。** 会话的 `Agent` 从其存储的 `pi.agent`（缺失：每个字段未设置）、一个注册表快照和已解析的设置解析：

```text
extensions  base = settings.extensions ?? every installed extension; in that order
            array: exactly these, in array order; { add, remove }: base, then add appended, minus remove
            duplicates keep their first position; names not installed are skipped
tools       the selected extensions' tools in extension order; a later same-name tool replaces an earlier one in place
            then every selected extension's tool wrappers, in extension order, then in each extension's order
            then the `tools` filter, which yields the enabled tools: an array keeps exactly these names in its order,
            a repeated name at its first position; { remove } drops these names
            `tools`: the enabled tools whose `callers` include "model" (default both), through the `modelTools`
            filter, the same way; `callable`: the enabled tools whose `callers` include "tools"
sections    the selected extensions' sections, same-key replacement in place, then their section wrappers,
            then `instructions` when set
hooks       the selected extensions' hooks for the task's name, in extension order
model       stored, else none: the request fails no_model
thinking    stored, else "off"
cwd         stored, else undefined
```

抛出、或返回不同名字的工具或节的包装器，会在该次解析中丢弃其目标：该工具不被提供，对它的调用产生 `tool_unavailable`；失败经 `onReport` 上报。找不到目标的包装器什么也不做，所以下文的 `Timing` 可以在没有 `bash` 之处被选中。设置 `instructions` 时，`Agent.sections` 以带标签的节 `instructions` 结尾，渲染该文本；包装器不作用于它。

后装扩展的同名工具为同时选择两者的会话覆盖先装的，包装器作用于胜出的那个工具：

```ts
export const Timing = defineExtension({
  name: "timing",
  wraps: [wrapTool(bashTool, (tool) => ({
    ...tool,
    execute: async (args, api, context) => {
      const start = Date.now();
      try {
        return await tool.execute(args, api, context);
      } finally {
        metrics.record("bash", Date.now() - start);
      }
    },
  }))],
});
// A bash inside a Python virtualenv for one conversation: it replaces CodingTools' bash in place,
// and Timing, if selected, wraps it.
export const Venv = defineExtension({
  name: "venv",
  tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })],
});
registry.install(Venv); // installed, but not in the default selection
await conversation.configure({ extensions: { add: [Venv] } }, context);
```

**谁解析什么，何时。** 每个读取者为每次决策解析一次：

| 读取者 | 解析 | 时机 |
|---|---|---|
| generation `prepare` | agent（工具、节、模型、思考级别）、stream 选项、该模型的压缩阈值 | 每请求一次；模型、stream 选项和提供的工具固定在请求检查点中（第 8.3 节） |
| 每个任务阶段 | 钩子的扩展选择；`runtime.agent()` | 每个阶段处理程序至多一次，在其第一次钩子派发或 `agent()` 调用时，从该阶段的快照和已提交的 `pi.agent`，在 Session 线之外，用调用的上下文；在该阶段剩余时间内固定 |
| 工具任务 | 被接受的调用的实现 | 在 `call` 和 `execute`：名字在阶段 agent 的 `tools` 中，即 tools 过滤器之后的当前选择；没有这样的工具——例如准备之后被移除的——`tool_unavailable`。重开时的重放策略用同一查找（第 7.3 节） |
| generation，工具轮开始时 | 工具执行模式 | 每轮一次（第 8.3 节） |
| generation，压缩 | 重试策略 | 在每次尝试的分类时 |
| generation，上下文溢出时 | 请求模型的压缩策略 | 在分类时 |
| 压缩 `select` | 模型、思考级别、stream 选项、该模型的压缩阈值 | 一次；摘要请求在其重试期间保持固定（第 8.7 节） |
| 边界和空闲接纳，在 Session 线上 | 队列模式 | 每边界一次（第 6 节） |
| 工具任务、`prepare`、`runtime.env()` | 环境 | 每次调用（第 2.2 节） |

注册表安装和设置变更不做提交，所以不发出任何东西（第 9.4 节）。默认选择上的会话在设置或已安装扩展变化时变化；其下一次准备追加系统增量（第 7.4 节）。展示已解析工具或已解析模型的 UI 通过 `Conversation.agent()` 重新解析。

### 7.2 钩子

钩子是任务在提交决策之前提出的一个类型化问题。钩子由任务定义声明，随扩展提供，由 `hook(task, handlers)` 构建（第 7.1 节）。任务询问其会话所选择扩展的钩子。`hook()` 由任务令牌定型，但派发按任务的名字匹配，所以钩子在其任务重载后存活；让钩子签名跨任务版本保持兼容是任务作者的责任。钩子在变更线之外按扩展顺序运行；在消费提交之前的崩溃可能重跑它们。中止错误总是传播。

| 钩子 | 组合方式 | 普通抛出 |
|---|---|---|
| `beforeRequest` | 替换链 | 上报，继续 |
| `afterResponse` | 全体观察者 | 上报，继续 |
| `onYield` | 第一个延续获胜 | 上报，继续 |
| `beforeTool` | 参数替换链；第一个 block 获胜 | 以错误文本阻止工具 |
| `afterTool` | 结果替换链 | 上报，继续 |
| `afterTools` | 全体观察者 | 上报，继续 |
| `beforeCompact` | 第一个决策获胜 | 上报，继续 |

钩子用任务 memos 做持久的先写者胜出决策。没有公开的语义事件通道；当前 UI 状态就是文档状态。

```ts
type HookResult<T> = T | undefined | Promise<T | undefined>;

/** 钩子可用的东西：已提交读取和发起任务的 memos。 */
interface HookApi extends DocumentReader {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  /** `HarnessOptions.models`。 */
  /** 当前的 `HarnessOptions.models`，每次访问时读取。 */
  readonly models: Models;
  memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
  memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
}

interface GenerationHooks {
  /** 每次请求尝试之前，包括恢复；结果只用于该请求。 */
  beforeRequest(
    request: { readonly messages: readonly Message[] },
    api: HookApi,
    context: Context,
  ): HookResult<{ readonly messages: readonly Message[] }>;
  /** 每条终态提供方消息，分类之前。 */
  afterResponse(message: AssistantMessage, api: HookApi, context: Context): void | Promise<void>;
  /** 一个最终答案；`continue` 追加一条用户消息并继续运行。 */
  onYield(answer: AssistantMessage, api: HookApi, context: Context): HookResult<{ readonly continue: UserInput }>;
  /** 该轮每个工具都终态之后；`results` 是按调用顺序的该轮结果条目。 */
  afterTools(assistant: EntryId, results: readonly EntryId[], api: HookApi, context: Context): void | Promise<void>;
}

/** `parent` 为嵌套调用设置（第 7.3 节）。 */
type ToolHookCall = ToolCall & { readonly parent?: { readonly taskId: TaskId; readonly callId: string } };

interface ToolHooks {
  /** 意图之前；替换参数或以错误文本阻止调用。 */
  beforeTool(
    call: ToolHookCall,
    api: HookApi,
    context: Context,
  ): HookResult<{ readonly arguments?: JsonObject; readonly block?: string }>;
  /** 执行之后、结果提交之前；替换结果。 */
  afterTool(
    call: ToolHookCall,
    result: ToolExecutionResult,
    api: HookApi,
    context: Context,
  ): HookResult<ToolExecutionResult>;
}

interface CompactionHooks {
  /**
   * 范围选择之后、摘要之前；第一个决策获胜。`entries` 是摘要所替代的活动条目，head 标记在最前，`messages` 是其模型上下文，即摘要器的源；`firstKept` 是逐字保留的第一个条目。
   */
  beforeCompact(
    compaction: {
      readonly reason: CompactionReason;
      readonly entries: readonly EntryRecord[];
      readonly messages: readonly Message[];
      readonly firstKept: EntryId;
      readonly instructions?: string;
    },
    api: HookApi,
    context: Context,
  ): HookResult<{ readonly decline: true } | { readonly summary: string }>;
}
```

`GenerationTask`、`ToolTask` 和 `CompactionTask` 是导出的内置任务令牌，其 `H` 参数就是这些接口。`runtime.hooks.each(name, invoke)` 对该阶段已解析钩子中 `name` 下的每个处理程序调用 `invoke`：即任务的会话所选择扩展的、针对该任务名字的钩子，按扩展顺序（第 7.1 节）。`invoke` 的普通抛出经 `onReport` 上报，`each` 继续下一个处理程序；一旦调用收到信号，错误传播。以不同方式组合的任务——例如 `beforeTool` 把抛出变成阻止——或在一个决策后停止的任务，在其自己的 `invoke` 内部这样做。钩子把任务的运行时作为其 `HookApi` 接收；钩子 memos 和任务自己的 memos 共享一个命名空间，所以钩子作者给 memo 名加前缀。

选择决定会话拥有哪种行为；扩展自己的文档保存该行为的状态：

```ts
const PlanModeDoc = defineDoc<{ enabled: boolean }>({
  kind: "app.plan-mode", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ enabled: false }),
});
export const PlanMode = defineExtension({
  name: "plan-mode",
  hooks: [hook(ToolTask, {
    // An absent document means plan mode is off.
    beforeTool: async (call, api, context) =>
      (await api.snapshot(PlanModeDoc, api.conversationId, context))?.enabled && writes(call)
        ? { block: "Plan mode: read-only" }
        : undefined,
  })],
});
// PlanMode is in the default selection; /plan toggles this conversation's state.
await root.commit(async (tx) => {
  (await tx.doc(PlanModeDoc, root.id)).enabled = true;
}, context);
```

### 7.3 工具

```ts
type ToolControl = {
  readonly addTools?: readonly string[];
  readonly terminate?: true;
  readonly handoff?: string;
};

/** 面向模型和 UI 的关于一次调用的备注；绝不是工具数据的一部分。 */
type ToolDiagnostic = {
  readonly severity: "info" | "warn" | "error";
  readonly message: string;
  readonly code?: string;
};

/** 三个通道：`output` 给模型，`structuredOutput` 给调用工具的程序，`details` 给 UI。 */
type ToolExecutionResult<TDetails extends JsonValue = JsonValue> = {
  readonly output?: ToolResultMessage["content"];
  readonly structuredOutput?: JsonValue;
  readonly isError?: boolean;
  readonly details?: TDetails;
  readonly diagnostics?: readonly ToolDiagnostic[];
  /** 执行本身的花费，例如一次模型调用；存储在结果上并计入 `pi.usage.tools`。 */
  readonly usage?: Usage;
  readonly control?: ToolControl;
};

interface ConversationHandle {
  readonly id: ConversationId;
  submit(submission: InputSubmissionDraft, context: Context): Promise<Submission>;
  abort(context: Context): Promise<void>;
  waitForIdle(context: Context): Promise<void>;
}

interface ToolExecutionApi<TDetails extends JsonValue = JsonValue> extends DocumentObserver, DocumentReader {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly callId: string;
  /** 工具任务的阶段快照。 */
  readonly registry: RegistrySnapshot;
  /** 发起调用的会话的 agent，按工具任务的阶段所解析的。 */
  agent(context: Context): Promise<Agent>;
  /** `HarnessOptions.models`：generation 所用的目录、凭据和请求变换。 */
  /** 当前的 `HarnessOptions.models`，每次访问时读取。 */
  readonly models: Models;
  /** 由 `HarnessOptions.env` 为本次调用构建。 */
  readonly env: ExecutionEnv | undefined;
  output(chunk: string | Uint8Array): void;
  /** 到目前为止保留的输出，按模型将看到的样子，以及更早的输出是否被丢弃。 */
  retainedOutput(): { readonly text: string; readonly truncated: boolean };
  diagnostic(diagnostic: ToolDiagnostic): void;
  details(value: TDetails, context: Context): Promise<void>;
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
  memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
  memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
  createTask<I, S extends { phase: string }, R, H extends object>(
    task: Task<I, S, R, H>,
    input: I,
    options: Omit<TaskOptions, "conversationId">,
    context: Context,
  ): Promise<TaskId<R>>;
  getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
  waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
  conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
  /** 把另一个工具作为本工具的嵌套调用运行（见下）并等待其结果。 */
  executeTool(
    name: string,
    args: JsonObject,
    context: Context,
    options?: { readonly key?: string; readonly progress?: boolean },
  ): Promise<NestedToolExecutionResult>;
}

/** 嵌套调用的结果，面向程序：无给模型的 output，`control` 不适用。 */
type NestedToolExecutionResult = {
  /** 嵌套调用的工具任务。 */
  readonly taskId: TaskId;
  /** 工具自身的值：schema 工具经校验的 `structuredOutput`（错误结果没有它时缺席，其文本是 `tool_error` 诊断）；无 schema 工具的有界输出，折叠后（见下）。 */
  readonly structuredOutput?: JsonValue;
  readonly isError: boolean;
  readonly details?: JsonValue;
  readonly diagnostics: readonly ToolDiagnostic[];
  readonly usage?: Usage;
  readonly durationMs?: number;
};

type ToolRegistration<TParameters extends TSchema = TSchema, TDetails extends JsonValue = JsonValue> =
  Tool<TParameters> & {
  readonly replay?: "safe" | "unsafe";
  readonly executionMode?: ToolExecutionMode;
  /** 对常见畸形参数的纯修复；在验证之前运行，验证仍检查其结果。 */
  prepareArguments?(args: unknown): Static<TParameters>;
  /** `structuredOutput` 的 schema；省略时程序得到有界输出，折叠后（第 7.3 节）。 */
  readonly structuredOutputSchema?: TSchema;
  /** 谁可以调用该工具；默认两者。 */
  readonly callers?: readonly ("model" | "tools")[];
  readonly outputLimits?: {
    readonly maxBytes?: number;
    readonly maxLines?: number;
    readonly retain?: "head" | "tail";
  };
  execute(
    args: Static<TParameters>,
    api: ToolExecutionApi<TDetails>,
    context: Context,
  ): Promise<ToolExecutionResult<TDetails>>;
};

/** 恒等函数，从 `parameters` 推断 `TParameters`，从报告的 details 推断 `TDetails`。 */
function defineTool<TParameters extends TSchema, TDetails extends JsonValue = JsonValue>(
  tool: ToolRegistration<TParameters, TDetails>,
): ToolRegistration<TParameters, TDetails>;
```

`execute()` 收到按 `parameters` 定型的 `args`：Harness 在运行之前针对该 schema 校验调用的参数。`defineTool()` 让内联工具字面量推断其类型，如 `tools: [defineTool({ ... })]`。`execute` 是方法，所以不同类型的工具共享一个 `tools` 数组。

省略 `replay` 为 `unsafe`。省略 `outputLimits` 为 50 KiB、2000 行、`retain: "head"`。省略 `executionMode` 跟随设置的 `toolExecution`；一个 `sequential` 调用使其整轮变为顺序（第 8.3 节）。

运行中的工具用 `api.executeTool()` 调用另一个工具，如 codemode 脚本或 MCP 桥那样。嵌套调用是它自己的 `pi.tool` 任务，由调用工具的任务拥有，因此它有自己的任务 ID 用于幂等和归属，运行完整的工具管线（第 8.4 节）包括 `ToolTask` 钩子（它们看到 `call.parent`），并在 `pi.live.nestedTools` 中报告进展（第 8.2 节）。其结果以 `NestedToolExecutionResult` 返回给调用者，绝不进入 transcript；模型只看到调用者放进自己结果里的东西。其工具在 agent 的 `callable` 工具中解析：`callers` 包含 `tools` 的启用工具（第 7.1 节）。不可用、无效、被阻止、抛出、被中断或被中止的调用返回 `isError` 结果；被调度器故障或孤儿化的嵌套任务返回合成的结果。

嵌套调用的键在其调用者内命名它；嵌套调用 ID 是 `<callId>/<key>`。默认键是该调用在调用的嵌套调用中的位置，`1`、`2`……显式 `key` 必须非空、不含 `/`、不是 `__proto__`、也不是正整数，这样调用 ID 永不冲突。一次提交创建嵌套任务、其槽、及其在 `NestedCallDoc`（`pi.tool.nested-call`）中的成员——一个按调用键为键的调用者任务作用域文档族，保存 `{ taskId }`；它随调用者退役。每次调用一个文档，所以接纳一个调用不重写其他调用的。非重放安全的调用者创建其嵌套调用，以及它通过 `api.createTask()` 创建的子任务（除非选项另有说明），都带 `abandonOnRestart`（第 5.4 节）：它重启后从不恢复，它们也是。带 `progress: false` 时，嵌套调用只向其槽提交状态，没有运行输出、details 或诊断；其结果仍携带其 details 和诊断，以及无 schema 工具的输出作为 `structuredOutput`，但被中断或中止的调用——其结果由其槽构建——就没有这些。程序绝不得到被中断或中止调用的部分输出。没有任何东西限制调用嵌套的深度；`callers` 让工具完全不被工具调用。

嵌套调用的结果不进入其回执，回执保持 `{ kind: "nested" }`。其终态提交把结果作为 `result` 写入其 `NestedCallDoc` 成员，并设置其槽的 `summary`（`isError`、`durationMs`、`usage`、有界错误文本）。存储的结果正是 `executeTool()` 返回的：它不保留 `output`——只有模型读它——所以每个结果（一张图片或一段 `bash` 尾部）只存储一次。调用者在其拥有的嵌套调用之前绝不终态，所以写入总能找到打开的文档；指名其他任务的成员抛出。调用者在等待之后读取结果，且每个嵌套结果在其调用者终态后从存储中消失。被调度器故障或孤儿化的嵌套调用没有存储结果；调用者得到合成的 `isError` 结果。

稍后用已用过的键调用 `executeTool()`——来自同一调用，或来自恢复后按相同顺序调用或传递相同 `key` 的重放安全重运行——会再次等待那个任务，无论已完成或仍在运行，而不是创建另一个；不同的工具名或结构上不相等的参数抛出。所以重放安全的调用者对每个嵌套调用恰好接纳一次并复用其已提交结果。这不是恰好一次执行：在结果提交之前被崩溃中断的嵌套调用遵循自己的重放策略，安全时重运行，否则返回 `interrupted`，因此
有外部效果的重放安全工具仍需要自己的幂等性。嵌套调用在被发起时启动，无论其 `executionMode`；调用者通过它 await 什么来决定什么立即运行。嵌套结果的 `usage` 在其落定时计入其工具（第 8.6 节）；在自己的结果中传递它的调用者会再计一次。

调用者在落定之前——无论经哪条路径——让它调用启动的嵌套调用接纳提交落地，然后一次性中止它拥有的每个活跃嵌套调用（用 `runtime.ownedTasks()` 找到，因此也包括早前尝试创建而重运行未再创建的那个），用 `runtime.abortOwned()`，并等待它们，让它们在调用者的落定移除它们之前落定进各自的槽。`execute()` 返回之后 `executeTool()` 抛出；调用者被中止或 Harness 关闭时拒绝；取消其 `context` 只停止等待。在此清理期间到达的中止仍会中止调用者，其已完成的结果随后被 `aborted` 结果替换。调用者的结果消息不列出其嵌套调用（没有 pi-ai `nestedCalls`）：它们的任务记录保留每个调用及其参数，想要在结果中列出它们的工具——如 code mode 那样——把列表写进自己的 `details`。调用者返回与其结果提交之间的崩溃使其停留在 `execute`：重放安全的调用者再次运行并按键找到其嵌套调用；任何其他调用者落定为 `interrupted`，其嵌套调用在能运行之前已被弃置。

调用工具的程序得到其 `structuredOutput`。声明了 `structuredOutputSchema` 的工具必须返回匹配它的 `structuredOutput`，错误结果除外——那里可以省略；Harness 在 `afterTool` 链之后校验它，如同参数。没有 schema 的工具不得返回它；程序得到其有界输出——模型看到的内容去掉渲染的诊断——成功和错误都一样：一个文本项作为其字符串，一个图像作为其 `ImageContent`，没有项作为 `""`，其他任何情况作为内容列表。`structuredOutput` 总是工具自己的值，绝不是 Harness 造的文本：schema 工具的错误结果保留它返回的值，没有 schema 的不给程序任何 `structuredOutput`；其输出的文本变成嵌套结果的 `tool_error` 诊断，除非已有错误诊断说明了问题，这样程序得到它，例如 `"permission denied: /etc"`。抛出错误的消息也在其 `tool_error` 诊断中。所以遮蔽（redact）无 schema 工具输出的钩子也遮蔽了程序得到的东西。Harness 自己写的错误结果（不可用、无效参数、被阻止、被中断、被中止、被弃置、或调度器故障）没有 `structuredOutput`；其诊断说明问题。抛出的错误变成带其消息的 `tool_error` 诊断。结果违反此规则的嵌套调用得到带 `invalid_structured_output` 诊断的错误结果，不含损坏的值：schema 工具的随后没有 `structuredOutput`，无 schema 工具的没有其输出；模型发起的调用——模型从看不到其 `structuredOutput`——只失去它，且该问题经 `HarnessOptions.onReport` 上报。`structuredOutput` 没有大小限制；保持小是工具的职责，正如 `bash` 保留其尾部和溢出路径而非整个输出。模型发起调用的结果条目不存储它，Harness 也不为它构建无 schema 的；嵌套调用的结果存储它，直到其调用者落定。在 `structuredOutput` 中返回其流式文本的工具用 `api.retainedOutput()` 读取它——结果省略 `output` 时模型看到的有界文本。

`callers` 说明谁可以调用工具：模型、经 `executeTool()` 的其他工具、或两者（默认）。code mode 工具是 `["model"]`，所以脚本不能启动脚本；code mode 背后的工具——如 MCP 工具——可以是 `["tools"]`，这样模型绝不被提供它们。会话的 `modelTools` 收窄模型被提供哪些模型可调用工具，例如只有 code mode 工具，其他仍可被工具调用。两者都不能扩大 `tools` 启用的范围。

`deferred` 工具在加载之前不提供给模型：`modelTools` 必须指名它，在其数组或其 `add` 中。其他工具任何时候都能调用它。工具用 `control.addTools` 加载延迟工具，它把名字写入 `modelTools`（第 8.5 节）；由于 `pi.agent` 是 rewindable 且按分叉条目分叉的，已加载工具按分支区分，head 标记之后的基线声明它们，从已解析工具构建。已加载工具在加载顺序上跟随其他工具，所以一次加载向 transcript 追加声明而缓存前缀保持。`@earendil-works/pi-durable/tool-search` 提供 coding agent 的 `tool_search`（`createToolSearchExtension()`）：它用 BM25 对工具的名字、描述、参数名和参数描述对 `Agent.deferred` 排名并加载匹配项。`codemode` 节不列出延迟工具；脚本用 `searchTools()` 找到它们。

工具只通过 `api.env` 到达文件和进程，绝不通过构建工具时捕获的环境。工具任务为每次调用用 `HarnessOptions.env` 从会话 ID 和 `cwd` 构建它（第 2.2 节），所以会话的目录或沙箱不需要包装器。`env` 的抛出变成该调用的一次普通错误结果。恢复后的重运行得到当时的会话环境。`api` 是普通对象，包装器可以展开它。需要环境却没收到的工具抛出，产生普通错误结果。

运行中的工具向 UI 报告输出和 details——镜像其最终结果的两半——外加诊断（见下）：

- `output(chunk)` 追加运行中的文本输出，如 stdout。若 `execute()` 省略 `output`，最终保留的输出变成一个文本内容项；没有输出变成空内容列表。保留的输出是流的整行的精确切片（`head` 取前几行，`tail` 取后几行），含结尾换行；单行超过 `maxBytes` 时在字符边界按字节限制截断。保留文本中制表符和换行之外的控制字符被移除；接受一个块不做逐块净化。
- `details(value)` 用完整 JSON 值替换运行中的 details；不合并键。若 `execute()` 省略 `details`，最后一个值成为最终 `details`，所以渲染器从第一次更新到最终结果处理同一种 details 形状。

工具运行期间两者都不发给模型。`output()` 同步地把 UTF-8 输出接受进该调用拥有的有界缓冲，并在调用结束后抛出。节流提交在 `pi.live.tools` 槽中发布保留的输出、丢弃的字节/行数，以及当前的 details 和诊断。节流是自适应的，像环境的 shell 输出捕获：空闲期之后的第一次变更立即提交；之后每次提交把下一次至少延迟 `settings.progress.outputIntervalMs`（默认 100 毫秒）加上其写入大小按 100 KiB/s 折算的量，所以大的重写买到成比例更长的停顿。延迟期间做出的变更合并进下一次提交。节流是 Harness 策略，不属于 `outputLimits`——后者只限制保留什么。显式结果内容中的显式文本在 transcript 持久化之前受同样限制；非文本内容按其 pi-ai 类型声明的保留。限制丢弃文本时，Harness 加一条 `warn` 诊断，代码 `truncated`，说明丢弃的行数和字节数。

诊断是一个通道，不是文本。关于调用的备注——如截断的输出、溢出路径、修正的路径、磁盘上变化的文件、或被截断的搜索——走 `api.diagnostic()` 或 `ToolExecutionResult.diagnostics`，绝不进入模型当作工具数据读取的内容。Harness 加它拥有的那些，工具只加只有它知道的。每条诊断模型可见；只给 UI 的信息属于 `details`。`diagnostic()` 同步地把诊断记录进工具的槽，随下一次节流提交，调用结束后抛出。落定时，结果的诊断是：经 `api` 记录的，然后结果中的，然后 Harness 的。有诊断时，结果内容以一个文本项结尾：

```text
<harness>
[warn] output truncated: 51,204 lines, 2,301,112 bytes dropped
</harness>
```

每条诊断一行 `[severity] message`，且 `pi.tool-result` 条目把结构化列表（可能为空）存为 `data: { diagnostics }`（第 8.1 节）。存储的消息正是模型看到的，而 UI 和代码读列表。`warn` 诊断不设置 `isError`。

`output()` 绝不把完整输出溢写（spill）到文件，因为溢写需要文件系统，而它可能是远程的或不可用。必须保留完整输出的工具经它被给予的 `ExecutionEnv` 或 `FileSystem` 溢写，并在诊断中报告得到的路径，渲染器需要时也在 details 中报告。环境的 shell 流式输出原始块，并在越过字节或行阈值时把完整输出溢写到文件；它自己不保有有界视图，所以 `output()` 是输出被限制、净化和节流的唯一位置。`bash` 工具把这些块送入 `output()`，把溢写路径作为诊断报告，返回 `structuredOutput: { output, truncated, fullOutputPath?, exitCode }` 附带保留的输出，用带 `exit_code` 诊断的错误结果回答非零退出码，超时时抛出；两种错误结果仍携带保留的输出和诊断。

经慢链路移动输出的环境——例如在另一台主机上的——不必移动全部。`api.outputWindow` 指名 tail 保留调用保有的尾部和其进展提交的节奏；`bash` 工具把它作为 `ShellExecOptions.window` 传递。环境于是可以省略输出，并在其后的块上以 `info.skipped` 报告该省略：解码的字节数、换行数、以及被省略的文本是否以换行结束。它只能省略后面跟着超过窗口（至少多一字节或一行）的输出，并在同一块中交付全部那些后续输出，所以被省略的文本绝不可能是保留尾部的一部分，也没有任何进展提交看到
缺口。`output(chunk, skipped)` 把该省略加入丢弃计数，所以保留的尾部、丢弃的计数和 `truncated` 诊断与每个字节都到达时相同；只有进展被采样的时刻不同。环境交付不应快于该节奏，因为进展提交采样不会更快。head 保留调用没有窗口。替换 `output` 来变换文本的包装器把 `outputWindow` 设为 `undefined`，这样没有省略文本绕过其变换。

`exec` 接受字符串或 argv 数组。字符串经环境的 shell 运行。数组直接运行其第一个元素，其余作为参数，不经 shell，所以从数据（例如文件名）构建命令的宿主绝不为特定 shell 做引号转义。每个 `onOutput` 块指名其来源流；`bash` 工具忽略它，而需要分开 stdout 和 stderr 的宿主分别收集、自行限界、并在足够时中止调用。`openBinaryReader` 为位置读取打开一个常规文件，宿主因此读取有界范围而非整个文件，且每次读取看到的都是它打开的那个文件，即使路径被重命名；`noFollow` 拒绝符号链接作为最终路径组件。其 `scanLines` 在环境内对文件做一遍扫描，报告换行数、一段行的字节范围、以及该段及其首行的解码大小，调用者因此可以不移动文件就统计和定位行。`openDirReader` 按文件系统顺序对目录分页，只为其返回的条目读取元数据，并跳过其间被移除的条目。可选的 `listFiles` 列出整棵树，供文件补全等索引使用：文件、目录和符号链接（不跟随）、带 `/` 分隔符的相对路径、按名字字节序深度优先，不含 `.git`，且在 git 工作树内不含 git 忽略的；`maxEntries`、`maxBytes` 和 `timeoutMs` 使其以 `truncated` 提前结束。当前无法列表的环境以 `not_supported` 失败，调用者回退到自己的遍历。所有操作在其上下文被中止时停止，且只停止该调用的工作：超时或中止只杀该命令的进程。`cleanup()` 杀掉环境仍在运行的每个命令，属于其 owner 的关停，绝不属于单个请求。`watch` 为从环境加载资源（如 instructions 或 skills）的宿主报告文件和目录变化；Durable 自己从不调用它。目标可以缺失，创建它是变更；递归目标覆盖其子树，除被排除的条目，不跟随其下方的符号链接。`watch` 返回时覆盖已建立，所以在加载之前 watch 的宿主不会丢失加载期间发生的变更。变更以报告的路径到达（各覆盖其子树；调用可能是虚假的），或当覆盖一段时间不确定、必须全部重扫时以 `overflow` 到达，或作为最终的 `error`。`native` 观察者在约两秒内报告变更；`polling` 观察者比较快照，因为其文件系统——例如网络或 FUSE 文件系统——不报告别处做的变更，且可能漏掉两次快照之间被撤销的变更。`NodeExecutionEnv` 只用事件触发重扫并报告快照之间的差异，所以被替换的文件、被重命名的父目录、连同内容一起创建的目录，无论平台发什么事件都会被报告。环境是受信任的，不是隔离边界：打开前检查规范路径并不能阻止并发的重命名或符号链接交换，所以限制路径的调用者是出于卫生而非安全。

`details()` promise 在对应或合并的文档提交之后返回。正常落定期间，工具任务停止其节流并等待在途提交；追加结果条目的终态提交是最后一次冲刷，落定任何仍未决的 `details()` promise。中止和关闭遵守调用与 Session 接纳门：未提交的缓冲更新可被丢弃，已接纳的提交落定。取消、回调、跟踪器准备和检查点失败发生在 Storage 接纳之前，不使 Session 失败。Storage 失败遵循致命的 Session 规则（第 10.1 节）。

工具随扩展提供（第 7.1 节），具有名字、描述、JSON schema、重放策略和执行函数。`wrapTool(tool, wrapper)` 装饰工具而不替换它。每次解析把该名字的胜出工具与所选扩展的包装器组合（第 7.1 节）；包装器绝不捕获基座，所以重载基座保留其包装器。组合体提供声明、参数校验、重放策略和执行。

工具调用只有在其请求提供了该工具时才被接受。Generation 对照从已提交模型上下文经请求的 `cutoff` 重放出的工具集检查这一点；`beforeRequest` 替换不改变它。它用第 2.2 节描述的 `tool_unavailable` 结果回答对未提供工具的调用，不创建工具任务。准备之后的 agent 变更不影响此检查（第 2.2 节）。工具任务在阶段 agent 解析的 `tools` 中——应用 tools 过滤器之后——解析被调用的名字。它使用那个实现直到执行落定：一个阶段处理程序解析、校验、运行 `beforeTool`、记录意图、执行并提交结果，所以没有阶段边界把解析与落定分开。不解析的名字——例如其扩展被卸载或取消选择，或 tools 过滤器在请求准备之后丢弃了它——产生 `tool_unavailable`。
实现的 `prepareArguments`（若有）先修复调用的参数，例如以 JSON 字符串发送的 `edits`；存储的调用保留模型发送的内容。参数在 `beforeTool` 之前和之后都针对已解析实现的 schema 校验；失败或抛出的修复产生 `invalid_arguments` 错误结果。

钩子和校验之后，工具任务在执行之前持久记录最终参数和已解析的重放策略。恢复不重跑 `beforeTool`，并把同样的存储参数传给 `execute()`。重放安全的工具可以在该变换是纯函数时从这些参数重建一个提交。必须保持稳定的随机值、时间戳、可变文档/配置读取或其他派生输入，先被捕获进持久的 memo、检查点或任务输入。后台报告者任务在自己的持久输入中接收最终消息，以便独立完成。恢复不让已变化的注册表声明改变存储的重放策略。

工具获得的会话句柄只接受输入提交；工具用普通事务写入做被动条目。

工具在持久任务中执行。它可以：

- 向其 `pi.live.tools` 槽发布有界的运行输出和 details；
- 提交 memos；
- 创建并等待任务；
- 通过 `commit()` 原子地创建或分叉显式归属的会话；
- 观察它有令牌/引用的文档；
- 通过 `commit()` 变更被授权的文档；
- 返回有界的模型内容和分离的诊断 details。

工具操作使用发起任务的接纳和调用生命周期门。任务创建默认为该任务的会话。受信任的文档和会话访问遵循第 3.3 和 9.2 节；没有额外的子树授权层。在受信任代码中持有 Session 全局的类型化 ID 即足够。

工具没有会话创建便捷方法。它们在 `commit()` 内创建或分叉会话，显式声明归属，原子地暂存相关的文档/任务写入，并只收到惰性记录。该提交落定后，`conversation(id)` 获取绑定调用的操作句柄，用于提交、显式中止和空闲等待，而不改变归属。提交回调不得调用 `conversation()` 或使用先前获取的句柄：变更线被持有期间禁止嵌套 Session 操作和外部效果。句柄的操作在调用结束后拒绝。其 `submit()` 返回的 `Submission` 同样绑定调用；这些方法拒绝之后，被接纳的提交仍然持久。调用拥有的文档 watch 在调用结束时停止。

前台子代理会话被其工具任务显式拥有。一个事务创建或分叉子会话；owner 边是它的持久记录，所以重放安全的重运行在创建之前用 `scanConversations({ ownerTaskId })` 找到子会话。落定后，工具重新获取子会话，以从其任务 ID 派生的请求 ID 提交——重运行保持该 ID——并等待该提交的结果。提供方调用 ID 在一个 Session 内不唯一，绝不能当请求 ID 用。中止或异常终态化工具任务会级联穿过拥有的作用域。工具在其运行 details 中报告子会话，例如 `api.details({ conversationId })`，看到调用的 UI 可以附着到子会话的视图或事件。

```ts
export const Subagent = defineExtension({
  name: "subagent",
  tools: [defineTool({
    name: "subagent",
    description: "Delegate a self-contained task to a subagent and get its answer back.",
    parameters: Type.Object({ task: Type.String() }),
    replay: "safe",
    execute: async (args, api, context) => {
      const { task } = args;
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing !== undefined) return existing.id;
        // Starts as a copy of this conversation's agent: model, thinking level, cwd, extensions, tools.
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        // Without this extension, the child is not offered this tool.
        await configure(tx, created.id, { extensions: { remove: [Subagent] } });
        return created.id;
      }, context);
      await api.details({ conversationId: child }, context);
      const handle = (await api.conversation(child, context))!;
      const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
      const settled = await (await handle.submit(request, context)).wait(context);
      if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent failed: ${settled.status}`);
      return { output: [{ type: "text", text: await answerText(api, settled.answer, context) }] };
    },
  })],
});
```

`{ remove: [Subagent] }` 编辑宿主默认选择（第 2.2 节）。这里的主会话保持其选择未设置，所以那也是它的选择。有任何存储选择的父会话——数组或 `{ add, remove }` 对象——则在提交之前改从 `(await api.agent(context)).extensions` 计算子会话的数组。

持久的后台子代理比父会话的回合活得更久，之后可以被发消息、转向、停止和列出。一个事务——在应用注册表文档中按子代理名去重之后——在父会话中创建后台会话拥有的锚点（anchor）任务 `A`、由 `A` 拥有的子会话 `C`，以及从名字到 `C` 的注册表映射。`A` 立即完成；当 `C` 有普通工作时它保持 `completing`（第 5.5 节），然后保持终态。其记录保留 `background`，所以父会话的普通中止和空闲遍历在它处停止，而 `Conversation.abort(context, { background: true })` 仍经它到达 `C` 的工作，且 `Harness.waitForIdle()` 不等待它。`C` 中后来的运行是 `C` 的普通工作；终态 owner 绝不级联。

发给子代理的每条消息由父会话中一个后台会话拥有的报告者（reporter）任务投递，在工具的事务中创建，并以工具任务 ID 在其中为键，所以该调用的重运行不会创建另一个。报告者以从其自身任务 ID 派生的请求 ID 提交到 `C`，等待该提交的落定，并把答案作为输入以 `whenBusy: "followUp"` 发回父会话，用另一个从其任务 ID 派生的请求 ID。任一接纳之前的崩溃会重试它；之后的崩溃返回已有的 `Submission`，所以子会话恰好收到一次消息，父会话恰好收到一次答案。因此报告者不需要事务级接纳；`tx.createSubmission()` 写入不带接纳规则的原始记录。应用的名字文档用 `fork: "initial"`，所以父会话的分叉不继承它。UI 从该文档列出子代理；子会话在其 `pi.live.run` 被设置时正在工作。只有 owner 边驱动中止和空闲遍历。锚点和报告者任务定义随子代理扩展提供，所以挂起的报告者在重启后一旦宿主再次安装该扩展就恢复：

```ts
export const SubagentTools = defineExtension({ name: "subagent-tools", tasks: [Anchor, Reporter], tools: [subagentTool] });

// In subagentTool's spawn commit, after the name checks:
const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
// Owned by a task of the parent: starts as a copy of the parent's agent.
const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
await configure(tx, child.id, {
  extensions: { remove: [SubagentTools] },
  instructions: `You are the subagent "${name}". Answer the main agent's requests.`,
});
```

工具结果可以请求 `addTools`、`terminate` 或 `handoff`。generation 的 `tools` 阶段（第 8.5 节）把指名的工具加入会话存储的 tools 过滤器；它们在下次准备时生效。只有该轮的每个结果都请求 `terminate` 时该轮才终止，与 pi agent 循环相同；`tools` 阶段随后使用最终边界。轮中的任何 `handoff`——多个请求时按调用顺序的最后一个——以同样方式结束运行：先追加一条带 `head: "self"` 的 `pi.reset` 条目、以用户消息携带交接文本（第 8.1 节），正是 `reset(handoff)` 写入的东西。

结果的 `usage` 存储在工具结果消息上，并在结果提交中计入会话的 `pi.usage.tools[toolName]`（第 8.6 节）。运行被拥有会话的工具不得再次报告该会话的花费：子会话自己的 `pi.usage` 已经计入它（第 12 节）。

重开时，工具只有在其存储的意图策略和当前声明——按 `call` 时解析的——都说 `safe` 时才重运行。当前的 `unsafe` 声明可以否决存储的 safe 重放；当前 safe 的声明绝不把存储的 unsafe 升级。不再解析的工具被视为 `unsafe`。其他每个孤儿化的效果产生包含持久部分输出的 interrupted 结果。已完成、已失败和已中止的工具终态结果为其 generation 的 `tools` 阶段保留其工具结果条目 ID。

Harness 自己写的错误结果设置 `isError`，并携带一条 `error` 诊断，代码为 `tool_unavailable`、`invalid_arguments`、`blocked`、`interrupted`、`aborted` 或 `tool_error`（`execute()` 的抛出）之一，以错误文本为消息。其内容是持久的部分输出（若有），`details` 是工具最后报告的值（若有）。

`@earendil-works/pi-durable/tools` 提供 `read`、`write`、`edit` 和 `bash` 工厂（从 agent harness 工具移植）、包含全部四个的 `CodingTools` 扩展，以及 `createCodingTools({ images })`——同样的东西，为 `read` 带一个图像处理器。它们只用 `api.env`；没有任何东西自动安装它们。

`read` 把图像文件（按内容检测）作为一个图像块返回，带一条 `info` 诊断（代码 `image`）说明其类型和所做处理，所以程序得到裸 `ImageContent`。图像必须整体读取：与文本不同，读取期间增长的图像会被再读一次。限制是会话模型的 `inputLimits.images.resize`，每个缺席项取 `DEFAULT_IMAGE_LIMITS`（2000x2000 像素，4.5 MiB base64）。没有 `ImageProcessor` 时，`read` 在文件大小使其 base64 在字节限制内（读文件前检查）且其头声明的尺寸在限制内时，原样传递 PNG、JPEG、GIF 和 WebP 不解码；否则，以及 BMP，返回错误结果（代码 `unsupported_image`）。有处理器时，`await processor.prepare(bytes, mimeType, limits)` 返回适配限制的图像，或对错误结果返回 `undefined`；诊断说明其格式何时改变或被缩放，并给出把坐标映射回去的因子。Photon 处理器解码每张图像，当它是正向、内联且在限制内时原样返回，否则重新编码为 PNG 或 JPEG（JPEG 源优先 JPEG）。`@earendil-works/pi-durable/images` 提供 `createPhotonImages(wasm)`，基于 Photon 的 WebAssembly，接受其模块或字节；`/images/node` 从已安装包读取 wasm 并在工作线程中准备图像，该线程 30 秒无图像后退出（`{ worker: false }` 内联准备）；`/images/cloudflare` 把它作为 Workers 模块导入并内联准备。两者都不被导入就不加载。模型不接收图像的会话仍得到图像；pi-ai 在请求中用占位符替换它，诊断会说明。

对文本，`read` 经 `openBinaryReader` 读文件：图像检测读头部（以及 PNG 的 chunk 头），`scanLines` 统计并定位所选行，只读取并解码显示的头部，所以其成本和传输受输出限制加上环境内对文件的一遍扫描所限。其结果与解码整个文件、按行切分、截断所选的结果完全相同。读取期间变化的文件被再读一次，然后失败。`edit` 和 `write` 在进程内串行化其对单个文件的读-改-写，以环境的 `FileSystem.id`（相同 id 在相同路径看到相同文件）和规范路径为键，所以对同一文件系统用全新环境对象的两次调用仍会排队，而其他文件和文件系统绝不等待。它不是针对 `bash` 或其他进程的锁。

### 7.4 系统提示词与动态工具

Durable 没有持久的提示词节。会话已解析的 agent 为每个请求产出期望的节；transcript 的 `pi.system` 条目是模型所见内容的唯一持久记录。Durable 把提示词和工具变更直接存储为 PR #9548 的 `SystemMessage` 值，位于其 transcript 位置，`content` 总为空：

```ts
type SystemEntry = EntryRecord & {
  readonly kind: "pi.system";
  readonly model: readonly [SystemMessage];
};

const baseline: SystemMessage = {
  role: "system",
  content: "",
  sections: { preamble: renderedPreamble, cwd: renderedCwd },
  toolsAdded: allEffectiveTools,
  timestamp: now,
};

const delta: SystemMessage = {
  role: "system",
  content: "",
  sections: { cwd: nextRenderedCwd, legacy: null },
  toolsRemoved: [{ name: "read" }],
  toolsAdded: [nextRead],
  timestamp: now,
};
```

Generation 准备针对其阶段快照执行以下步骤：

1. 解析会话的 agent（第 7.1 节），并把活动 transcript 的系统消息重放进已显示的节和已提供的工具。
2. 期望的工具是 agent 的 `tools`，按顺序。
3. 用 `HarnessOptions.env`（第 2.2 节）构建环境，并按顺序用 `PromptInput` 渲染 agent 的 `sections`：会话、agent、环境、已显示的节，以及针对已提交文档的 `DocumentReader`（任务运行时）。结果就是期望的节。
4. 把期望的节和工具声明与重放状态比较，不同时追加一条位置性 `pi.system` 条目。

准备在追加之前不复查 transcript：只有 Harness 向忙碌会话写入模型上下文——通过提交、运行任务、边界和一次阻塞压缩（它只在其 generation 等待它时追加，第 8.7 节）——所以它读到的上下文仍然是最新的（第 12 节）。仅展示写入（第 6 节）可能在此期间落地；它们不贡献消息，而系统条目规划、压缩阈值和请求截止只依赖 contributions 和最新条目 ID。

模型和思考级别是请求选项，不是提示词状态。

所选扩展的节和 agent 的 `instructions` 是提示词文本的唯一来源；没有单独的构建器。`section(key, render, { tag })` 构建节，`wrapSection(key, wrapper)` 装饰节，像工具包装器一样按解析组合。节按 agent 的顺序渲染：扩展顺序，后装扩展的同 key 节原地替换先装的，`instructions` 最后（第 7.1 节）。`render` 返回 `undefined` 的节被省略。`tag` 省略或为 true 时，文本被包成 `<key>\n...\n</key>`。抛出的节保留其已显示文本（若有）并被上报；请求仍然发送。generation 调用被取消之后抛出的错误传播；节自己的中止错误——例如其 fetch 超时——是普通失败。没有节时，期望的节集合为空。

最小提示词是一个不带标签的节：

```ts
const Chat = defineExtension({
  name: "chat",
  sections: [section("preamble", () => "You are a helpful assistant.", { tag: false })],
});
registry.install(Chat);
```

会话的提示词随其扩展选择、其 `instructions`、`input.env` 和 `input.read` 而变化。不应看到 skills 的子代理不选择 skills 扩展，cwd 节渲染 `input.env.cwd`；没有节检查自己是否运行在子代理中。渲染器对相等输入必须确定：渲染文本的任何变化——例如内嵌时间戳——都会追加系统增量并使提供方提示词缓存失效。

重放按 transcript 顺序应用消息。非空 `content` 追加指令。节字符串添加或替换那个名字而不移动已有节；`null` 移除它，之后的重新添加把它追加到有序节映射。在一条消息内，工具移除先于添加，所以同名替换得到新声明和新位置。

准备比较值和顺序。若值可以在不改变顺序的情况下打补丁，它发出最小补丁。若已显示与期望的节顺序不同，一次提交追加两条 `pi.system` 条目：第一条用 `null` 移除每个已显示节，第二条按期望顺序重新添加每个期望节。这使仅顺序的变化和请求之间的删除/重加能够精确重放；仅仅重述相等的值是不够的。

PR #9548 的 `SystemMessage` 总是补丁，不是重置：它不能移除之前的 `content`，也不能仅靠重述当前值恢复节顺序。因此，当一个 head 移除了之前请求可见的基线——即活动上下文有 head 标记且该标记之后没有追加过 `pi.system` 条目（ID 更高）——新的 `pi.system` 条目为截断之后仍保留的每个更早 `pi.system` 条目添加 `ContextEdit` omit。它自己的消息随后是完整基线，按顺序包含每个期望节和每个生效的工具声明。模型上下文重放看到新基线而不是被省略的保留增量。即使重述重放值，准备也写这个基线，这样每个后续准备都能在标记之后找到 `pi.system` 条目。Head 重定基线优先于普通的顺序/值打补丁。没有 head 截断时，顺序不匹配用上面的两条件移除/重加序列；只有顺序已匹配时，准备才发出最小变化的值和 `null` 移除。

工具变更单独规划，搭载在最后一条规划条目上，或节未变时搭载在一条自己的条目上。声明用 pi-ai 的 `declarationsEqual()` 比较并用 `toToolDeclaration()` 写入，所以应用元数据绝不进入 transcript。变化的声明在同一条消息中被移除并重新添加。重放把保留的工具留在原位并追加新增；当那样得不到期望顺序时，消息移除每个已提供工具并按顺序重新添加期望的工具。Head 重定基线添加每个期望工具。

历史 `SystemMessage.sections` 中存储的渲染字符串保持权威，即使当前渲染器变了。pi-ai 决定是把消息按位置发给有能力的提供方，还是折叠成一条前导系统消息；Durable 不为提供方兼容性重写其存储的 transcript。

### 7.5 扩展重载

扩展代码在进程内经注册表重载。宿主以已安装的名字安装新扩展对象，用一次发布原地替换旧的。Harness 继续运行；不需要 close 或重开。

```ts
registry.install(SkillsV2); // same name: conversations selecting skills render v2 at their next request
registry.uninstall(Skills); // selecting conversations get a system delta removing its section; nothing is rewritten
// Restart: the host installs its extensions again; stored names resolve against them.
```

- 新的阶段调用和工具任务立即使用新扩展；运行中的调用在其下一个阶段边界看到它。
- 已经运行的工作保持其快照直到其阶段处理程序落定，被固定的工具保持其实现直到其执行落定。替换绝不向它发信号或中断它。旧代码使用的资源是扩展的责任（第 7.1 节）。
- 被替换的任务定义在其下一个正常阶段边界交接（第 5.4 节）。任务定义在持久输入或检查点状态的含义变化时必须提升版本并迁移受支持的旧状态；迁移失败阻塞任务而不是终止它。
- 被替换的扩展保留其安装位置，所以重载不移动其钩子、工具和节相对于其他扩展的位置；扩展内部，新对象的顺序生效。把任务定义从一个扩展移到另一个，会在两次安装之间留下空隙，期间其挂起任务受阻。
- 文档定义被显式传给类型化访问，不需要注册；变化的令牌在其下次访问时生效。

如果旧扩展代码忽略取消且永不落定，新工作已经在使用替换品。Harness close 仍会加入每个调用。安全地强制终止任意不配合的 JavaScript 需要 worker/进程隔离；那种宿主终止进程并从持久状态重开 Session。新旧 Harness 实例绝不同时拥有同一 Session：在旧的 `close()` 返回之后——其调用代码不再运行任何东西（第 2.2 节）——打开新的。

### 7.6 Code mode

`@earendil-works/pi-durable/codemode` 提供 `codemode` 工具（`createCodemodeExtension({ sandbox })`）：
`callers: ["model"]`、`replay: "safe"`。其参数是一个脚本，用 pi-codemode 确定性的 `sandbox.start()` 运行。脚本以 `tools.<name>(args)` 调用 agent 的 `callable` 工具；每次调用是键为 `c<id>` 的嵌套调用，`c<id>` 是 VM 为该调用自计数号。与 coding agent 中一样，声明了 `structuredOutputSchema` 的工具以其 `structuredOutput` 解析，携带它的错误结果也是如此（非零退出的 `bash` 以 `{ output, exitCode, ... }` 解析，脚本会检查），无 schema 工具以其文本输出解析——图像被排除——如其声明（`Promise<string>`）所述。其他每个错误都拒绝：无 schema 工具的文本非空时作为消息，否则是错误诊断的消息，值（若有）作为 `error.structuredOutput`。哪些工具声明了 schema 记录在启动数据中，所以恢复的脚本按开始时的方式映射结果。

工具的描述是固定的：脚本环境及其全局量。扩展的 `codemode` 提示词节把 agent 的 `callable` 工具列为 TypeScript 声明，按 `namespaces` 分组（工具属于名字前缀最长匹配的那个），内联预算 3000 估算 token：每个命名空间先放置其最便宜的工具，然后任何命名空间才放置第二个，放不下的会说明并用 `searchTools()` 找到。脚本用 `ALL_TOOLS`、`searchTools(query, { limit?, namespace? })`（BM25）、`describeTool(name)` 和 `describeNamespace(name)` 找工具，答案来自启动
数据和日志（journal）像其他全局量一样。结果的内容是 `Script completed`/`Script failed` 头部，带自 `startedAt` 起的墙上时间、文本项（多项时 `==> text N/M <==`）、一个 `<console_output>` 块中的 `console` 行、返回值，失败时还有错误和已完成的调用。超过 `max_output_tokens`（默认 10000）的文本保留首尾，完整文本写入文件（`details.fullOutputPath`）；图像存为文件，路径列在其旁。Harness 对超过工具 `outputLimits`（4 MiB、100,000 行）的结果做截断且不生成这样的文件，所以文本超过 1 Mi 字符或行数限制时也会被截断，无论 `max_output_tokens` 说什么。文件写入运行创建一次并记录在其运行文档（`outputDir`）中的环境临时目录，使用固定名字（`output.txt`、`image-<n>.<ext>`）：崩溃后的重运行覆盖它们而不是新增。

带 `models`（默认开启）时，脚本得到模型目录（`models.getModelsOfType`、`getAvailableOfType`、`getModelOfType`；日志化全局量，去掉配置的 `headers`）和 `models.classify()`、`models.generateImages()`。后两者是付费效果，所以各自作为扩展的内部工具运行：`pi.codemode.models.classify` 和 `pi.codemode.models.generateImages`（`callers: ["tools"]`）：code mode 工具把脚本对全局量的调用变成该工具的嵌套调用，后者于是有自己的任务、活跃行、中止、用量记账和重放策略。名为 `pi.codemode.*` 的工具在启动数据中记为 `hidden`：绝不出现在节、`tools`、`ALL_TOOLS` 或工具搜索中。它们声明 schema，所以像任何这类工具一样，无论其 `stopReason` 如何都以模型的结果解析——脚本会检查；其行把失败的显示为错误。一个脚本的这类调用至多四个同时运行，脚本已结束后等待槽位的调用不会被启动。收到生成图像却一张都没展示的脚本，其结果中会有一条说明。工具的声明携带脚本源的 Lark 文法作为 `constrainedSampling`，pi-ai 对支持它的模型应用。

结果的 `details` 按调用顺序列出脚本的工具调用（`CodemodeToolDetails`：id、name、截断的参数、状态 `ok`/`error`/`cancelled`、时长、截断的错误），随结果一次写入；脚本结束时仍在运行或尚未启动的调用为 `cancelled`。脚本运行期间，UI 从 `pi.live.nestedTools` 显示其嵌套调用。

三个文档，其中两个作用域为 code mode 调用的任务：

- `pi.codemode.run`：`start`，在 VM 启动前写一次（模块版本、`startedAt`、种子、VM 报告后的一次性指纹、来自 `timeout_ms` 的截止时间、脚本看到的工具和全局量、store 快照）；`result`，结果，写一次。
- `pi.codemode.journal`：`entries`，每个投递给 VM 的结果一条，按投递顺序：调用的 ID、时钟值、`issuedAfter`（VM 处理它之后已发起的调用，来自其确认），以及对全局量的其名字、参数和结果；`firstIssued`，脚本首次运行后 VM 已发起的调用。
- `pi.codemode.store`：会话作用域，`history: "rewindable"`，`fork: "asOf"`；成功脚本的 `store()` 写入在写其 `result` 的那次事务中按键应用。

活跃时，已完成调用的结果被追加到日志，然后作为结果号 `entry index + 1` 投递，时钟取条目时刻；一次只有一个日志提交在途，更晚的结果加入下一个。确认计数随下一次日志提交记录，或在 VM 已处理全部投递内容时立刻记录。调用只有在制造它的那次排空的计数被提交后才启动，所以一次尝试接纳的每个键至多是它最后一次记录的计数。

沙箱以 `aborted` 结束而调用并未请求的运行（例如宿主在关闭 Harness 之前关闭了沙箱）不做决定：调用不存储结果并随其调用结束，之后的尝试重放脚本。

重运行（恢复后的 `execute()`）在模块版本不同或截止时间已过时，返回存储的 `result` 而不启动 VM，否则以存储的错误结果结束调用，不接纳新的嵌套调用；它从 `start` 启动 VM，并在 VM 报告的指纹不同时同样处理——在投递或重新附着任何东西之前。然后它按顺序投递日志，每个条目在 VM 已发起其调用后投递；工具的结果按键来自其嵌套调用，全局量的结果在比较名字和参数后来自日志。日志没有的调用被保持，直到最后一个已日志化的结果被确认。分歧使调用以存储的错误结果结束，然后以脚本无法捕获的错误停止 VM：与记录的 `issuedAfter` 不同的计数、未发起下一条目调用却等待的 VM、以别的名字或参数调用的键或全局量、或在处理 `issuedAfter` 已记录的条目时（或首次运行且日志非空时）结束的脚本，或在发起一个稍后条目所回答的调用之前结束的脚本。早前尝试以别的工具或其他参数接纳某键的活跃调用，以同样方式分歧。每个记录的计数——含 `firstIssued`——必须等于重放的。重运行时，活跃调用被保持，直到最后一个已日志化结果被确认，或日志为空时直到首次运行；到那时计数已匹配，所以脚本已做出早前尝试可能接纳的每个调用。每个被保持调用的键对照其存储的嵌套调用检查，无论调用的目标是什么，只有没有差异时才启动；更晚的调用是新的。运行有其结果之后不再接纳或投递任何东西。未用完每个条目就结束的脚本没有问题：活跃运行也在那里结束了。重放确认而日志缺少的计数随第一次活跃提交记录。重启前接纳的嵌套调用无论重运行如何决定都可自行恢复；调用的清理中止它们。

## 8. 内置任务

初始实现提供：

| kind | 职责 |
|---|---|
| `pi.generation` | 准备系统提示词和工具，请求或轮询模型，重试，分类响应 |
| `pi.tool` | 校验、钩子、执行、持久化输出和 details、追加结果 |
| `pi.compaction` | 选择 transcript 范围，摘要，放置带 head 的摘要 |

Generation 使用 `HarnessOptions.models`，没有 Durable 专用的模型适配器。它解析 `models.getModel(ref.provider, ref.modelId)`，从准备好的提示词/消息/工具构建 pi-ai `Context`，并带任务调用的中止信号、agent 的思考级别和设置的 stream 选项调用 `models.streamSimple()`。延迟延续用同一模型和信号调用 `models.fetchDeferred()` 和 `models.cancelDeferred()`。缺失模型和同步/流式 pi-ai 错误被分类为下文的持久 generation 结果。

Generation 和工具进展是节流的持久文档提交。崩溃只可能丢失未提交的节流窗口。恢复把已提交的部分结果转换为正常的 interrupted/aborted transcript 条目，清除展示状态，然后按任务阶段重试或终止。重试截止、尝试次数、压缩和工具进展对晚加入者是当前文档状态；已完成尝试的用量/记账是条目或终态 details。截断和溢写路径是工具诊断（第 7.3 节）。

压缩通过追加带 head 的摘要条目改变模型上下文。它不删除 transcript 历史。

### 8.1 内置条目

内置条目 kind 不携带 `data`，除了 `pi.tool-result`——其令牌是 `Entry<{ diagnostics: ToolDiagnostic[] }>`，每个工具结果都携带 `data`，无诊断时为空列表（第 7.3 节）——以及 `pi.compaction`，其令牌为 `Entry<{ reason: CompactionReason }>`。每个 kind 都导出为 `Entry` 令牌。

| kind | `model` | 写入者 |
|---|---|---|
| `pi.user` | `[UserMessage]`，时间戳取接纳或放置时的 Harness 时钟 | 提交、`onYield` 延续 |
| `pi.assistant` | `[AssistantMessage]`，任意停止原因 | generation |
| `pi.system` | `[SystemMessage]`，`content: ""`（第 7.4 节） | generation 准备 |
| `pi.tool-result` | `[ToolResultMessage]` | 工具任务；generation 对其请求未提供工具的调用 |
| `pi.reset` | 缺席，或带交接文本的 `[UserMessage]`；总是 `head: "self"` | `reset()`、generation `tools` 阶段的 `handoff` |
| `pi.compaction` | 带包装摘要的 `[UserMessage]`；`head` 是第一个保留条目 | 压缩任务（第 8.7 节） |

每个 generation 响应都变成 `pi.assistant` 条目：答案、带错误文本和用量的失败尝试、以及停止原因 `aborted` 的转换部分结果。上下文推导（第 2.1 节，规则 9）把失败和中止的消息排除在后续请求之外，所以不存在单独的用量或通知 kind。

### 8.2 活跃文档

```ts
type LiveState = {
  /** 运行控制（第 6 节）；恰好在其会话忙碌时存在。 */
  run?: { taskId: TaskId; inputs: SubmissionId[] };
  /** 当前 generation 尝试的展示。 */
  generation?: {
    attempt: number;
    /** 在途响应的已提交节流部分。 */
    message?: JsonRepresentation<AssistantMessage>;
    /** 下次尝试前的持久退避。 */
    retry?: { at: number; error: string };
    /** 正在轮询的提供方侧延迟响应。 */
    deferred?: { pollAt: number };
  };
  /**
   * 运行中工具调用的嵌套调用（第 7.3 节），按创建顺序，所以父在子之前、任务 ID 递增。
   */
  nestedTools?: {
    /** `<parentCallId>/<key>`：工具事件中该调用的 ID，唯一，因为键不含 `/`。 */
    callId: string;
    parentCallId: string;
    /** 发起调用的工具任务，模型发起或嵌套；Harness 按任务 ID 关联槽。 */
    parentTaskId: TaskId;
    taskId: TaskId;
    name: string;
    /** 调用的参数，无界；执行后为修复、钩子和强制转换之后它实际运行的参数。 */
    arguments: JsonObject;
    status: "pending" | "running" | "done";
    output?: string;
    droppedBytes?: number;
    droppedLines?: number;
    details?: JsonValue;
    diagnostics?: ToolDiagnostic[];
    /** 完成后：调用如何结束，错误文本至多 500 字符；结果不在这里（第 7.3 节）。 */
    summary?: { isError: boolean; durationMs?: number; usage?: Usage; error?: string };
  }[];
  /** 当前工具轮，按调用顺序，从工具调用答案直到 generation 的 `tools` 阶段结束它。 */
  tools?: {
    callId: string;
    name: string;
    /**
     * 尚未开始的调用（顺序轮，`pending`）和其请求未提供的调用缺席，后者以 generation 写的 `entry` 直接开始 `done`。
     */
    taskId?: TaskId;
    status: "pending" | "running" | "done";
    /** 保留的运行输出和边界丢弃的部分。 */
    output?: string;
    droppedBytes?: number;
    droppedLines?: number;
    /** 最后一次 `details()` 值。 */
    details?: JsonValue;
    /** 经 `api.diagnostic()` 记录的诊断。 */
    diagnostics?: ToolDiagnostic[];
    /** 完成后的结果条目；工具任务故障或被孤儿化时缺席。 */
    entry?: EntryId;
  }[];
  /** 活跃压缩任务，按任务 ID 顺序；没有时缺席（第 8.7 节）。 */
  compactions?: CompactionStatus[];
  /**
   * 自上次压缩产出摘要以来最新的压缩失败（第 8.7 节），客户端可在任务结束后展示它。
   */
  compactionFailure?: CompactionFailure;
};

type CompactionFailure = {
  taskId: TaskId<CompactionResult>;
  reason: CompactionReason;
  /** 失败或故障结果的错误消息，或调度器孤儿化任务的原因。 */
  error: string;
};

type CompactionStatus = {
  taskId: TaskId<CompactionResult>;
  reason: CompactionReason;
  /** 是否有 generation 在等它：generation 拥有的压缩。 */
  blocking: boolean;
  attempt: number;
  /** 下次摘要尝试前的持久退避。 */
  retry?: { at: number; error: string };
};
```

| 字段 | 值 |
|---|---|
| kind | `pi.live` |
| version | `1` |
| scope/history/fork | conversation、`latest`、`initial` |
| `initial()` | `{}` |
| checkpoint | 无任何东西运行时写完整基线：无 `generation` 且没有 `running` 的工具或嵌套槽 |
| view mount | `docs["pi.live"]` |
| created | 随每个 Harness 会话创建（第 2.2 节） |

空闲时、最终边界时、generation 移交给其工具轮的那次提交中（每个槽仍是 `pending` 或 `done`）、顺序轮的工具之间、以及并行轮没有任何工具 `running` 时，都没有东西运行。槽只在 `running` 时持有输出，所以每个基线都小，存储的增量链至多跨一个 generation——含其重试和延迟轮询——或一轮工具的重叠执行。保留的 head 输出以 Chord 字符串追加增长。滑动尾部通常成为前端修剪加追加；当 Chord 的有界重叠搜索找不到共享部分时——如高度重复的输出或大于其 64 KiB 扫描的窗口——提交把保留窗口作为一次集合写入。两种情况下每次提交至多写一个窗口，节流限制速率。

Generation 在追加工具调用答案的提交中创建 `tools`，每个调用一个 `pending` 槽；其请求未提供的调用以其结果条目直接开始 `done`。工具任务在其意图提交中把其槽设为 `running`，向它发布节流的输出和 details，并在其终态提交中设为 `done` 和 `entry`，移除 `output`、`droppedBytes`、`droppedLines`、`details` 和 `diagnostics`——结果条目现在携带它们（第 7.3 节）。generation 的 `tools` 阶段移除 `tools`。槽更新只在带该任务 `taskId` 的槽存在时应用；没有时，持久的部分输出、details 和诊断为空。

嵌套槽在其任务被创建的提交中被推入 `nestedTools`，带调用者传的参数，像工具槽一样运行，在其意图提交中获得实际执行的参数（当它们不同时；模型发起调用的参数在其 assistant 条目中），并在其终态提交变为 `done`，其进展像工具槽一样被移除，并设置 `summary`——足够状态行用；其结果在调用者的 `NestedCallDoc`，绝不在 `pi.live`（第 7.3 节）。任何调用落定时，其终态提交移除其下方的嵌套槽，按 `parentTaskId` 传递；其仍在运行的嵌套调用先被中止。`endRun` 和 generation 的 `tools` 阶段随 `tools` 一起移除 `nestedTools`。

压缩的状态在创建任务的提交中加入，在决定其结果的提交中移除：任务自己的结果提交——即使该结果保持为 `completing`（第 5.5 节）——或调度器的清理（第 5.4 节）。
它保持小：摘要文本活在任务的放置中，绝不在这里。部分结果在赋值前被规范化为严格 JSON。运行任务的每条终态路径都在落定运行输入的提交中移除 `run`、`generation` 和 `tools`。`tx.settleSubmission()` 在组装期间暂存每个输入的新状态并解析事务的最新候选提交记录，回退到已提交状态，像任务文档校验一样（第 3.3 节），所以它不是调用者的表读取，且在提交的第一次表写入之后也能工作。

### 8.3 Generation

```ts
type GenerationInput = {};
type GenerationCheckpoint =
  | {
      phase: "prepare";
      attempt: number;
      /** 本 generation 等待的阻塞压缩；它不启动其他压缩。 */
      compacted?: TaskId<CompactionResult>;
      /** 启动 `compacted` 的溢出的错误文本；`prepare` 恢复时检查一次。 */
      overflow?: string;
      /** 阻塞阈值启动了 `compacted` 时设置；其结果在 `prepare` 恢复时检查一次。 */
      threshold?: true;
    }
  | {
      phase: "request";
      attempt: number;
      compacted?: TaskId<CompactionResult>;
      model: ModelRef;
      thinkingLevel: ModelThinkingLevel;
      streamOptions: ConversationStreamOptions;
      /** 请求包含的最新条目。 */
      cutoff: EntryId;
    }
  | { phase: "retry"; attempt: number; compacted?: TaskId<CompactionResult>; until: number }
  | {
      phase: "poll";
      attempt: number;
      compacted?: TaskId<CompactionResult>;
      model: ModelRef;
      cutoff: EntryId;
      handle: DeferredHandle;
      pollAt: number;
    }
  | {
      /** 等待该轮的工具任务；`waiting` 保存该检查点（第 8.5 节）。 */
      phase: "tools";
      assistant: EntryId;
      tools: TaskId<ToolTaskResult>[];
      /** 顺序轮中尚未开始的调用，按调用顺序。 */
      pending: string[];
    };
type GenerationResult = { entryId: EntryId };
```

`pi.generation` 是版本 1，从 `{ phase: "prepare", attempt: 1 }` 开始。运行的输入在 `pi.live.run`，不在任务输入中。

- `prepare` 用该阶段的 agent 解析运行第 7.4 节，并解析设置一次。当 agent 没有模型或 `models.getModel()` 不认识它时，任务以 `no_model` 失败。当它带 `overflow` 恢复而其压缩没有以 `entryId` 完成时，运行以 `model_error` 失败，细节为溢出文本。否则一次提交追加规划好的 `pi.system` 条目，并以新尾部为 `cutoff`、agent 的模型和思考级别、设置的 stream 选项进入 `request`。这些在该次请求尝试中保持固定；重试会再次准备。`compacted` 延续到 `request`、`retry`、`poll` 和下一个 `prepare`。
- 在那次提交之前，当设置的压缩策略启用、模型的 `contextWindow` 为正、且 `compacted` 缺席时，`prepare` 检查压缩阈值（第 8.7 节）。估算从已提交模型上下文中最新的 assistant 消息开始——其条目在 head 标记之后追加（没有标记时全部符合）且其 usage 非零：其 usage 的 pi-ai `calculateContextTokens()`，加上其后每条上下文消息和规划的系统消息的 pi-ai `estimateMessageTokens()`。其请求包含了标记，因为 head 只在没有请求在途时放置。没有这样的消息时，每条消息都被估算。两个阈值都只在范围选择找到截断点时适用。
  - 超过 `contextWindow - reserveTokens`，即阻塞阈值：不追加，而是一次提交创建一个 generation 拥有的压缩，原因为 `threshold`，加入其状态，并以 `allSettled` 和检查点 `{ phase: "prepare", attempt, compacted, threshold: true }` 提交对它的 `waiting`。`prepare` 恢复时读取压缩的结果一次。若压缩完成——有无摘要皆可（无可压缩，或被拒绝）——`prepare` 继续并发送请求。若它失败、故障、被孤儿化或被直接中止，generation 以 `model_error` 失败且不发请求，其输入落定 `unanswered`、细节为 `Compaction failed: <error>`（中止为 `Compaction was aborted`）。失败的压缩留下高于阻塞阈值的上下文，此时请求至多给答案不留空间。
  - 超过 `contextWindow - reserveTokens - backgroundTokens` 且 `backgroundTokens > 0`、`pi.live` 中无压缩状态时：进入 `request` 的提交还创建一个会话拥有的后台压缩，原因为 `threshold`，并加入其状态。generation 不等待它。设置的 retry 策略在尝试结果被分类时读取，因为它治理下一次尝试（第 7.1 节）。
- `request` 和 `poll` 经 `models.getModel()` 解析检查点中的模型；未知模型以 `no_model` 使任务失败，与 `prepare` 相同。`request` 在解析模型之前转换残留的部分结果（见下）。
- `request` 先把上次被中断尝试留在 `pi.live` 的已提交部分结果转换为中止的 `pi.assistant` 条目。然后它经 `cutoff` 流式传输模型上下文，带调用信号、作为 `reasoning` 的思考级别（`off` 时省略）、会话持久化的提供方 `sessionId`，和固定的 `streamOptions`，至多每 `settings.progress.partialIntervalMs`（默认 100 毫秒）提交节流的部分结果。流式之前，`beforeRequest` 链可以只为本次请求替换消息。恢复用同样的已提交消息、同样的固定模型、思考级别和 stream 选项重发，并重跑 `beforeRequest`。
- `afterResponse` 在分类之前观察来自 `request` 或 `poll` 的每条终态消息；仍在延迟的结果不是终态。
- 分类之前，处理程序停止部分结果节流并等待在途的部分提交，所以结果之后不会有陈旧的部分落地。终态消息在同时清除部分结果的一次提交中被分类：
  - `stop`/`length`：提交之前运行 `onYield` 链；第一个 `{ continue }` 获胜。提交追加答案并应用最终边界（第 6 节）。有延续且没有选中的用户项或重置时，它追加一条带延续内容的 `pi.user` 条目，创建后继 generation，并把 `pi.live.run` 移交给它，保持输入打开。否则它把运行的输入落定 `done`，移除 `run` 和 `generation`，并为选中的用户项（若有）启动后继运行；被丢弃的延续不重试。两者都以 `{ entryId }` 完成。
  - 带至少一个工具调用的 `toolUse`：提交追加 assistant 条目并启动下述工具轮，进入 `tools` 阶段的 `waiting`。没有调用的 `toolUse` 消息按 `stop` 分类。
  - pi-ai `isContextOverflow()` 识别的 `error`，且设置的压缩策略启用、`compacted` 缺席、范围选择找到截断点时：提交追加错误条目，移除 `generation`，创建 generation 拥有的压缩，原因为 `overflow`，加入其状态，并以 `allSettled` 和检查点 `{ phase: "prepare", attempt, compacted, overflow }` 提交对它的 `waiting`；恢复请求不计入重试策略。任何其他溢出——包括第二次——绝不重试，按下面的不可重试错误失败。`stop` 或 `length` 响应绝不被分类为溢出；下一次阈值检查处理静默溢出。
  - `isRetryableAssistantError()` 接受且设置的 retry 策略允许再试的 `error`（`enabled` 且 `attempt <= maxRetries`，所以 `maxRetries` 计第一次尝试之后的重试）：追加错误条目并以 `until = now + retryDelayMs(policy, attempt)` 进入 `retry`。
  - 任何其他 `error`，或没有中止标记的 `aborted`：追加错误条目，把输入落定 `unanswered`、`model_error`，移除 `run` 和 `generation`，并失败。
  - `deferred`：以 `pollAt = now + (handle.pollAfterMs ?? 5000)` 进入 `poll`。
- `retry` 睡到 `until`，然后以下一次尝试返回 `prepare`，所以退避期间做出的 agent 和设置变更生效。
- `poll` 睡到 `pollAt` 并调用 `models.fetchDeferred()`。仍在延迟的结果把 `pollAt` 严格推后；任何其他结果按上面分类。
- abort 处理程序在模型已知时（失败被上报）在 `poll` 中调用 `models.cancelDeferred()`，转换已提交的部分结果，把输入落定 `unanswered`、`aborted`，移除 `run` 和 `generation`，并以 `aborted` 结束。

工具轮在追加工具调用答案的提交中开始：

1. 提供的工具经 pi-ai `getCurrentTools()` 从已提交模型上下文按 `cutoff` 重放：`request` 已持有它，`poll` 再推导一次。对未提供工具的调用在此得到其 `tool_unavailable` 结果条目，不创建任务。
2. 其他每个调用得到一个 generation 拥有的 `pi.tool` 任务，输入 `{ assistant, callId }`。当轮开始时读取的设置的 `toolExecution` 为 `sequential`，或任何被调用工具——按工具任务解析它的方式从阶段 agent 解析（第 7.3 节）——有 `executionMode: "sequential"` 时，轮是顺序的：此时只有第一个调用现在得到任务，其余在 `pending` 中等待。否则每个调用立刻得到任务并并行运行。检查点的 `tools` 列出至今创建的任务，每个开始的顺序调用增加一个，`pending` 相应缩短。
3. generation 以 `allSettled` 和 `tools` 检查点提交对其工具任务的 `waiting`（第 8.5 节）；`pi.live.run` 保持在它那里。
4. `pi.live.tools` 收到该轮的槽（第 8.2 节），`generation` 被移除。

输入提交以以下原因之一落定 `unanswered`：`no_model`、`model_error`（细节：提供方错误文本）、`aborted`、`faulted`（细节：错误消息）、或孤儿化受阻原因（第 5.4 节）。故障和孤儿落定把已提交的部分结果转换为中止的 `pi.assistant` 条目，与 abort 处理程序相同。

### 8.4 工具

```ts
type ToolTaskInput =
  | { kind: "model"; assistant: EntryId; callId: string }
  | { kind: "nested"; parent: TaskId; parentCallId: string; key: string; call: ToolCall; progress?: false };
type ToolTaskCheckpoint =
  | { phase: "call" }
  | { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe" };
type ToolTaskResult = { kind: "model"; entryId: EntryId; control?: ToolControl } | { kind: "nested" };
```

`pi.tool` 是版本 2，从 `{ phase: "call" }` 开始；`migrate` 给版本 1 输入 `kind: "model"`，读取者把没有 `kind` 的终态结果当作模型发起调用的。模型发起调用的输入保持小，因为终态记录保留它；调用从 assistant 条目读取。嵌套调用（第 7.3 节）携带其调用，因为没有条目持有它，落定方式不同：其结果提交记录结果的 `usage`（第 8.6 节），把面向程序的结果写入调用者的 `NestedCallDoc`（第 7.3 节），把其嵌套槽标记 `done` 并设 summary，不追加条目，以 `{ kind: "nested" }` 结束；`control` 不适用。
下文中，`{ entryId }` 是模型发起调用的结果。

- `call` 用 `runtime.entry()` 读取调用，在阶段 agent 的 `tools`（第 7.3 节）中解析工具，用 pi-ai `validateToolArguments()` 校验参数，运行 `beforeTool` 链，并再次校验（第 7.3 节）。然后一次提交记录意图：以最终参数和工具的重放策略进入 `execute`，并把槽设为 `running`。同一处理程序执行工具、运行 `afterTool` 链并提交结果；它在执行之前用 `HarnessOptions.env` 构建 `api.env`（第 2.2 节）。不解析的工具、无效参数或阻止改为提交相应错误结果，不带意图。
- `execute` 只被恢复到达。当存储的和当前的策略——按 `call` 中的方式解析——都是 `safe` 时，它用存储的参数再次执行，不带 `beforeTool`，并像 `call` 一样落定。否则它从槽的持久部分输出、details 和诊断提交 `interrupted` 错误结果，并以 `{ entryId }` 结束 `failed`。
- 结果提交限制内容、追加诊断块（第 7.3 节）、追加一条 `pi.tool-result` 条目，`model: [{ role: "toolResult", toolCallId, toolName, content, details, isError, durationMs, timestamp }]`、`data: { diagnostics }`，把槽标记 `done`，并以 `{ entryId, control }` 完成。`isError` 结果仍然完成。`durationMs` 是本次尝试中 `execute()` 花了多久，用单调时钟测量，包括它抛出时；未执行的调用、`interrupted` 或 `aborted` 的结果没有它。
- `execute()` 或构建其环境的 `HarnessOptions.env` 的抛出变成 `tool_error` 结果，任务以 `{ entryId }` 结束 `failed`；调用一旦收到信号则改为传播。以 `failed` 结束与 `aborted` 一样记录取消意图（第 5.4 节），所以该调用拥有的、不再被任何东西监督的会话被中止。返回的 `isError` 结果仍然完成，其调用拥有的工作存活。无论哪种，运行都带着结果条目继续。其拥有的会话在其提交结果时仍有普通工作的工具任务，以已写入的结果条目保持 `completing`（第 5.5 节）；generation 只在工具任务终态后恢复。
- abort 处理程序从槽的持久部分输出、details 和诊断提交 `aborted` 错误结果，并以 `{ entryId }` 结束 `aborted`。

### 8.5 工具轮

generation 在其等待的每个工具任务都终态后在 `tools` 阶段恢复。顺序轮中 `pending` 还有调用时，一次提交创建下一个调用拥有的工具任务，并以更短的 `pending` 再次等待。否则它用 `runtime.getTask()` 读取工具记录、从 `pi.live.tools` 槽读取该轮的结果条目，运行 `afterTools` 观察者，然后提交一次：

- 它为每个 `addTools` 名字编辑会话存储的 `pi.agent` 的 `tools` 和 `modelTools`：数组追加该名字（除非已持有），`{ remove }` 失去该名字。未设置的 `tools` 已启用每个工具，不为它写任何东西。未设置或对象的 `modelTools` 也把名字追加到其 `add`，这会加载延迟工具，对其他工具无效果。写入名字不查注册表，所以现在未注册的工具在再次注册后被提供。下次准备在该工具解析且模型可调用时提供它。
- 当该轮每个结果都请求 `terminate`，或任何结果请求 `handoff` 时，它追加交接的 `pi.reset` 条目（若有），以工具调用答案把运行的输入落定 `done`，移除 `run` 和 `tools`，并应用最终边界。
- 否则它移除 `tools` 并应用 `postTools` 边界。当该边界放置了重置，运行的输入落定 `unanswered`、`reset`，选中的用户项启动后继运行（第 6 节）。否则选中的 steer ID 加入 `pi.live.run`，它创建下一个 generation——会话拥有——并把运行移交给它。

它以工具调用答案的 `{ entryId }` 完成。其中止处理程序只在其工具任务都终态后运行（第 5.5 节）。对仍在 `pending`、从未开始的每个调用，它追加 `aborted` 错误结果；已开始但其任务故障或被孤儿化的调用保留其无条目的 `done` 槽（第 8.2 节）。然后它把输入落定 `unanswered`、`aborted`，移除 `run`、`generation` 和 `tools`，并以 `aborted` 结束。因此对 generation 的 `abortTask()` 会中止其整轮。

### 8.6 用量

```ts
type UsageState = {
  /** assistant 条目和压缩摘要尝试，以 `provider/modelId` 为键。 */
  models: Record<string, Usage>;
  /** 工具结果，以工具名为键；其 usage 没有模型身份。 */
  tools: Record<string, Usage>;
};
```

| 字段 | 值 |
|---|---|
| kind | `pi.usage` |
| version | `1` |
| scope/history/fork | conversation、`latest`、`initial` |
| `initial()` | `{ models: {}, tools: {} }` |
| checkpoint | 每次变更都写完整基线 |
| view mount | `docs["pi.usage"]` |
| created | 随每个 Harness 会话创建（第 2.2 节） |

`pi.usage` 是会话自身花费的账本。`pi.assistant` 条目的每个内置写入者把其消息的 `usage` 按消息自己的 `provider/model` 计入 `models`，带 `usage` 的 `pi.tool-result` 条目的每个写入者把它计入 `tools`，在同一提交中；带 `usage` 的嵌套调用（第 7.3 节）结果提交同样。压缩任务的每次摘要尝试在分类它的提交中把其响应的 `usage` 计入 `models`（第 8.7 节）；该花费没有条目，无论摘要是被放置、失败还是过期结束。失败和中止的尝试也计入。分叉从零开始，所以没有花费被计两次。`Harness.usage()` 把每个会话的文档求和为 Session 总计；其他总计——例如一个归属子树——是应用对 `scanConversations()` 的求和。没有任何东西跨会话存储总计。

### 8.7 压缩

```ts
type CompactionReason = "manual" | "threshold" | "overflow";
type CompactionInput = { reason: CompactionReason; instructions?: string };
/** 固定的摘要请求。 */
type SummaryRequest = {
  attempt: number;
  model: ModelRef;
  thinkingLevel: ModelThinkingLevel;
  streamOptions: ConversationStreamOptions;
  maxTokens: number;
  /** 范围被选出时上下文的最新条目。 */
  tail: EntryId;
  /** 逐字保留的第一个条目；摘要的 `head`。 */
  firstKept: EntryId;
};
type CompactionCheckpoint =
  | { phase: "select" }
  | ({ phase: "summarize" } & SummaryRequest)
  | ({ phase: "retry"; until: number } & SummaryRequest);
/**
 * 阻塞压缩摘要的 `entryId`，或会话拥有的压缩摘要写入的 `submissionId`；无可压缩时两者都缺席。
 */
type CompactionResult = { entryId?: EntryId; submissionId?: SubmissionId };
```

`pi.compaction` 是版本 1，从 `{ phase: "select" }` 开始。压缩用一条 `head` 为第一个保留条目的摘要条目替换模型上下文的旧前缀（第 2.1 节）。原始历史留在存储中。有三种启动方式；任务是同一个，只是归属和放置不同：

| 启动者 | owner | background | generation 等待 | 放置 |
|---|---|---|---|---|
| `Conversation.compact()` | 会话 | 否 | 否 | 写提交 |
| 超过后台阈值的 generation | 会话 | 是 | 否 | 写提交 |
| 超过阻塞阈值的 generation，或溢出时 | 该 generation | 否 | 是 | 直接追加 |

只有阻塞压缩在会话的运行等待它时运行。其他绝不取得运行控制：会话在它们摘要期间继续工作，其摘要像任何被动写入一样放置。压缩彼此不协调；多个可同时运行，第 6 节决定其摘要之间的取舍。

**范围选择**是 `ContextView` 的纯函数，其 `contributions` 给出范围内每个活动条目经所有编辑后的模型消息（第 2.1 节，规则 4 和 9），包括范围内较旧标记携带的编辑，以及设置的 `keepRecentTokens`。

1. 截断候选是 contribution 以用户或助手消息开头的非标记条目。工具结果和系统条目绝不是候选，所以被保留的 assistant 消息保有其工具结果。当前面 assistant 的某个调用的结果
   跟在它后面、在下一个 assistant 之前（第 2.1 节，规则 7）时，该用户条目也不是候选。
2. 从最新到最旧遍历非标记条目，累加每个 contribution 的 pi-ai `estimateMessageTokens()`。在总和达到 `keepRecentTokens` 的第一个条目处，截断点是 transcript 顺序中该条目或之后的第一个候选，没有更晚候选时取最新候选。
3. 当总和从未达到 `keepRecentTokens`，或截断点之前没有非标记条目贡献模型消息时，无可压缩。

被摘要的条目是 head 标记（若有），加上截断点之前的非标记条目。其消息是它们的 contributions，按第 2.1 节规则 7 和 8 排序，所以较旧的摘要与其后的历史一起被再次摘要。上下文小于 `keepRecentTokens` 时什么都不压缩，所以在 `contextWindow - reserveTokens` 低于它的窗口中，溢出可能先于任何阈值压缩发生。

```text
1 user   2 assistant (read)   3 tool result, 30k tokens   4 assistant   5 user   6 assistant
keepRecentTokens 20k: the walk from 6 reaches 20k at 3; the first candidate at or after 3 is 4.
The summary covers 1-3; the model context becomes [summary, 4, 5, 6].
```

阶段：

- `select` 取该阶段的 agent 解析，解析设置一次，并捕获已提交上下文。当 agent 没有模型或 `models.getModel()` 不认识它时，任务以 `no_model` 失败。无可压缩时以 `{}` 完成。否则 `beforeCompact` 钩子（第 7.2 节）带着被摘要的条目和消息运行；第一个决策获胜。`{ decline: true }` 以 `{}` 完成，`{ summary }` 按下文在同一提交中放置。没有决策时，一次提交以尝试 1、agent 的模型和思考级别、设置的 stream 选项、`maxTokens` = `min(floor(0.8 * reserveTokens), model.maxTokens)`（模型值仅在其为正时使用）、捕获的尾部、以及截断点作为 `firstKept` 进入 `summarize`。
- `summarize` 再次从 `tail` 处的上下文（不可变）推导被摘要的消息，并把它们序列化为文本：`[User]: ...`、`[Assistant]: ...`、`[Assistant tool calls]: name(key=json, ...)`、`[Tool result]: ...` 截断到 2000 字符；系统消息和思考被省略（重放的思考通常不是活跃上下文的一部分，否则它可能使请求大于它所摘要的上下文）。请求没有工具，只有两条消息：一条带内置摘要系统提示词的系统消息，和一条用户消息——`<conversation>` 标签中的序列化文本后接内置摘要提示词，输入有 instructions 时再加 `Additional focus: <instructions>`。它以固定的思考级别作为 `reasoning`、会话持久化的提供方 `sessionId`、不带 `deferred` 的固定 stream 选项、`cacheRetention: "none"` 和固定的 `maxTokens` 运行。Codex 之类的提供方在禁用缓存时可能抑制该身份。恢复重发同一请求。响应在把其 usage 加入 `pi.usage`（第 8.6 节）的一次提交中被分类：
  - 带非空文本、无工具调用的 `stop`：文本即摘要，按下文放置。
  - `isRetryableAssistantError()` 接受、且分类时读取的设置的 retry 策略允许再试的 `error`：以 `until = now + retryDelayMs(policy, attempt)` 进入 `retry`，并设置状态的 `attempt` 和 `retry`。
  - 其他任何情况——包括使摘要不完整的 `length` 停止——以 `model_error` 失败。
- `retry` 睡到 `until`，然后以下一次尝试和同样的固定请求返回 `summarize`。

内置提示词是 coding agent 的结构化检查点格式。提示词还要求模型在会话开头承接较早的摘要。

**放置。** 摘要条目是

```ts
{
  kind: "pi.compaction",
  head: firstKept,
  model: [{ role: "user", content: [{ type: "text", text: wrapped }], timestamp: now }],
  data: { reason },
}
```

其中 `wrapped` 是 `"The conversation history before this point was compacted
into the following summary:\n\n<summary>\n"`、摘要、和 `"\n</summary>"`。放置它的提交还移除任务的状态、移除 `pi.live.compactionFailure`，并提交任务的 `completed` 结果：

- 阻塞压缩直接追加条目并以 `{ entryId }` 完成。其 generation 持有运行并等待，所以没有别的东西写该会话。
- 会话拥有的压缩以请求 ID `compaction:<taskId>` 把条目接纳为写提交，完全遵循第 6 节：在收件箱为空的空闲会话中立刻追加或落定 `stale`；在有排队项的空闲会话中排队并运行一次最终边界；在忙碌会话中排队等待下一个边界。它以 `{ submissionId }` 完成且绝不等待排队的放置；`Harness.submission()` 观察放置。

下一个 generation 的准备找到没有更晚 `pi.system` 条目的 head 标记，并写入完整系统基线（第 7.4 节）。

**取消。** abort 处理程序移除任务的状态并以 `aborted` 结束；它不写条目。被中止或崩溃截断的尝试没有已提交的响应，所以其 usage 不计入。手动压缩是其会话的普通工作：`Conversation.abort()` 中止它。后台压缩在它之下存活，只经 `abortTask()` 或 `Conversation.abort(context, { background: true })` 停止。阻塞压缩随其 generation 被中止，在 generation 的 abort 处理程序运行之前（第 5.5 节）。已排队的摘要是写提交：会话中止保留它，`Submission.abort()` 撤回它。

**失败。** 使压缩失败的提交（`model_error`、`no_model`）移除其状态，并把 `pi.live.compactionFailure` 设为其任务、原因和错误消息，替换更旧的失败；Harness 清理对被调度器故障或孤儿化的压缩做同样的事，用故障的消息或孤儿原因。只有产出摘要的压缩移除它；被中止或发现无可压缩的压缩保留它。

当阻塞压缩以无 `entryId` 结束时，溢出 generation 以 `model_error` 失败。阈值 generation 在压缩完成时（无可压缩或被拒绝）照常发送其请求，在它失败、故障、被孤儿化或被直接中止时以 `model_error` 失败（第 8.3 节）。


## 9. 文档观察与 Chord

### 9.1 文档状态

Chord 既有的复制状态层暴露这个源采纳契约：

```ts
interface ReplicatedStateSourceFrame<T> {
  readonly cursor: number;
  readonly value: T;
  readonly ops: readonly Op[];
  readonly context: Context;
}

interface ReplicatedStateSourceAttachment<T> {
  /** 在原子附着边界捕获的固定不可变快照。 */
  readonly snapshot: { readonly value: T; readonly cursor: number };
  /** 安装唯一监听器并同步排空每个缓冲帧。 */
  activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void;
  dispose(): void;
}

interface ReplicatedStateSource<T> {
  /** 原子地捕获快照并开始缓冲之后每次提交。 */
  attach(): ReplicatedStateSourceAttachment<T>;
}

interface ReplicatedStateSourceOptions {
  readonly onError?: (error: Error) => void;
}

interface AttachedReplicatedState<T> extends ReplicatedState<T> {
  readonly value: T;
  dispose(): void;
}

function replicatedState<T>(
  source: ReplicatedStateSource<T>,
  options?: ReplicatedStateSourceOptions,
): AttachedReplicatedState<T>;
type DocumentState<T extends JsonObject> =
  AttachedReplicatedState<Readonly<T> | null>;

type WatchEnd =
  | { readonly reason: "stopped" | "cancelled" | "session_closed" | "retired" }
  | { readonly reason: "listener_error"; readonly error: Error }
  /** Session 失败；`error` 是使其失败的东西，通常是存储错误（第 10.1 节）。 */
  | { readonly reason: "session_failed"; readonly error: unknown };

interface WatchHandle<T> {
  /** 启动前是获取时的修订版；之后是最新投递的不可变修订版。 */
  readonly value: T;
  /** 安装唯一的串行化异步监听器。 */
  start(listener: (value: T, ops: readonly Op[], context: Context) => Promise<void>): void;
  /** 幂等地停止后续回调并返回本 watch 的终态结果。 */
  stop(): Promise<WatchEnd>;
  /** watch 终止时落定；已在运行的回调仍归调用者所有。 */
  readonly closed: Promise<WatchEnd>;
}

type DocumentWatch<T extends JsonObject> = WatchHandle<Readonly<T> | null>;

interface DocumentObserver {
  watchDoc<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
}
```

`documentState()` 在返回之前把 Durable 的已提交文档流附着到 Chord。返回的状态已经用精确的可共享不可变修订版水合，没有变更方法，并发布之后每个精确的已提交修订版和操作批次，无需另一个跟踪器、值复制或重新差分。处置（dispose）它只注销该观察；Durable 仍是唯一的文档变更者。

状态和 watch 获取从不创建；缺失的查找返回 `undefined`。成功的获取绑定一个具体化身。退役发布 JSON `null` 根替换并结束该化身的流。如果状态仍被暴露，消费者看到 `null`，绝不是陈旧状态。之后的重建需要获取新的状态或 watch。

Session close 在其封锁点结束每个状态：状态保持其最后的值，不收到 close 期间落定提交的帧。

每个文档状态分配自己的内存中连续 Chord 投递序列。Durable 不持久化也不经 `WatchHandle` 暴露该序列。状态和 watch 独立于已加载跟踪器缓存保留不可变修订版。重开创建新的状态生命周期和水合。

内部地，状态附着使用 Chord 的同步原子快照并注册边界：快照包含附着之前的每个提交，之后每个精确帧被缓冲直到激活。这防止快照与基于更新未见修订版的操作配对。

### 9.2 `watchDoc`

任务、钩子和工具可以观察其代码拥有令牌和 owner/键的任何已存在文档。在受信任的 Session 代码内部没有额外的子树权限系统。

在 Session 线上，`watchDoc()` 解析一个已存在的具体化身，以 O(1) 捕获其当前不可变跟踪器修订版，并注册接收之后每个精确的已提交修订版和操作批次。缺失时返回 `undefined`。`start()` 之前，`watch.value` 保持获取时的修订版，同时更晚的帧缓冲。

```ts
const watch = await api.watchDoc(JobOutputDoc, producerTaskId, context);
if (watch === undefined) return;
try {
  await initializeConsumer(watch.value, context);
  watch.start(async (value, ops, deliveryContext) => {
    await consume(value, ops, deliveryContext);
  });
} catch (error) {
  await watch.stop();
  throw error;
}
```

`start()` 安装唯一监听器并调度投递；它绝不内联调用用户代码。每个回调收到精确的不可变已提交值和产生它的精确操作批次。调用之前，`watch.value` 前进到该值。watch 在开始下一次回调之前等待监听器，但 Session 提交从不等待回调落定。

watch 至多保留 100 个待投递的已提交帧，不含正在投递的帧。加入第 101 帧时，用一次自包含的根替换 `[["r", newestValue]]` 替换完整的未投递后缀，使用最新的精确不可变修订版和该提交的 Context。之后精确帧正常跟随该替换。再次溢出再次替换待投递后缀。没有序列化字节测量、值复制、操作重放或重新差分。这是收敛观察，不是审计流；需要每个转换的消费者必须单独持久化那些事实。

`watch.value` 和每个先前返回的修订版在受信任的不可变契约下永远稳定。消费者不得变更它们或保留的后代。选中提交的 Context 的值被保留，不继承生产者的取消。回调拥有自己的异步工作。

watch 保持绑定其原始化身。退役把精确的终态 `[["r", null]]` 帧排队，或把它折叠进值为 `null` 的溢出替换。该回调落定后，watch 以 `retired` 关闭，绝不跟随替换化身。

`stop()` 是幂等的。它同步注销、丢弃待投递帧、阻止另一个回调开始，并返回共同的终态 promise。已在运行的回调不被中止或加入，仍归调用者所有。获取时的 `Context` 治理 watch 生命周期。获取期间的取消在拒绝前清理；之后的取消和 Session close 以同样方式停止后续投递。监听器失败丢弃待处理工作，并只以 `listener_error` 关闭该 watch。第一个终止原因获胜，每个迟到的拒绝都被观察。

### 9.3 会话视图

公开视图是会话活动 transcript 及其内置文档的固定结构化挂载：

```ts
type ConversationView = {
  readonly conversation: ConversationRecord;
  /** 原始活动条目，如 `ContextView.entries`（第 2.1 节）：head 标记，然后其 head 之后的非 head 条目。 */
  readonly entries: readonly EntryRecord[];
  /** `pi.agent`、`pi.live`、`pi.inbox`、`pi.provider` 和 `pi.usage`，按 kind 为键；缺失的文档缺席。 */
  readonly docs: Readonly<Record<string, JsonObject>>;
};
```

这些 kind 及其字段是公开协议。第三方文档经它们自己的 Chord 对象暴露，不被挂载。

Harness 每个会话至多保留一个挂载。第一个 `viewState()`、`watch()` 或事件附着在 Session 线上从已提交的活动 transcript 和文档构建其修订版；最后一个观察者分离时挂载被丢弃。挂载从 Session 的 `subscribeCommits()` 发布推导每个下一修订版，像 `watchDoc()` 一样：每个发布都已持久，所以视图只显示已提交状态。触及该会话的一次发布产生一个 Chord 批次：

```text
document op ["s", ["generation", "message"], value]
-> view op ["s", ["docs", "pi.live", "generation", "message"], value]
```

不带 head 的追加条目是 `entries` 末尾的一次拼接。追加的 head 标记 `H` 使条目成为 `H` 加上 `H.head` 处或之后的当前非 head 条目：保留的条目留下，拼接移除其他并向前插入 `H`。每个保留条目已被挂载，因为 Harness 写入者绝不以当前范围之前的 head 为目标：重置和交接 head 自己，压缩摘要以当前范围的保留条目为目标，而到达更早的 head 写入是过期的（第 6 节）。以更早为目标的原始 head 写入只显示已挂载的条目（第 12 节）。
文档创建和退役设置和删除 `docs` 键。经 `parent.at` 的父条目不可变，所以子会话的挂载只跟随自己的会话。不触及任何已挂载内容的发布不创建修订版；
冗余的非空批次仍是真实的发布。挂载的文档修订版在受信任的不可变契约下结构共享。挂载不做语义投影，也不拥有持久化。

`Conversation.viewState()` 把挂载暴露为一次性的只读 Chord 状态。`Conversation.watch()` 经第 9.2 节的串行化精确帧 watch 暴露同一挂载，带有界待投递帧和整值溢出替换。

### 9.4 Agent 事件（实验性）

`watchEvents(harness, conversationId, context): Promise<AgentEventStream>`，从包根导出，是实验性适配器，把一个会话的已提交发布翻译成形状类似 coding agent 的 `AgentSessionEvent` 的 agent 事件。它不拥有跟踪器或持久化，只覆盖一个会话（不含其拥有的子树），并且只在使其为真的提交之后发出事件。其协议可能不经通知而变化。

```ts
/**
 * 工具事件关于哪个调用。`toolCallId` 对模型发起的调用是提供方的 ID，对嵌套调用是 `<parent call ID>/<key>`；消费者匹配它，绝不解析它。`taskId` 是调用的工具任务，从未得到任务的调用缺席。嵌套调用还按调用 ID 和工具任务指名其调用者。
 */
type ToolEventCall = {
  toolCallId: string;
  toolName: string;
  taskId?: TaskId;
  parentToolCallId?: string;
  parentTaskId?: TaskId;
};

type AgentEvent =
  | {
      type: "snapshot";
      entries: readonly EntryRecord[];
      run?: { inputs: readonly SubmissionId[] };
      /** 当前 generation 尝试：其 在途部分、重试退避、或延迟轮询。 */
      generation?: { attempt: number; message?: AssistantMessage; retry?: { at: number; error: string }; deferred?: { pollAt: number } };
      tools: readonly ToolSlot[];
      /** `pi.live.nestedTools`（第 8.2 节）。 */
      nestedTools: readonly NestedToolSlot[];
      /** `pi.live.compactions`（第 8.2 节）。 */
      compactions: readonly CompactionStatus[];
      /** `pi.live.compactionFailure`（第 8.2 节）。 */
      compactionFailure?: CompactionFailure;
      inbox: readonly { id: SubmissionId; mode: InboxItem["mode"] }[];
      /** `pi.agent`；缺失时 `{}`。 */
      agent: AgentState;
      usage: UsageState;
    }
  | { type: "run_start"; inputs: readonly SubmissionId[] }
  | { type: "run_end"; inputs: readonly SubmissionId[] }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; usage: Usage; changes: readonly MessageChange[] }
  | { type: "message_end"; entry: EntryRecord }
  | ({ type: "tool_execution_start"; args: JsonObject } & ToolEventCall)
  | ({
      type: "tool_execution_update";
      /** 保留窗口的一次前端修剪加追加，或其替换。 */
      output?: { trimStart?: number; append?: string } | { set: string };
      details?: JsonValue;
      diagnostics?: readonly ToolDiagnostic[];
    } & ToolEventCall)
  /** 模型发起的调用以其 `entry` 结束，嵌套调用以其 `result`；两者皆无的情况见下。 */
  | ({ type: "tool_execution_end"; entry?: EntryRecord; result?: NestedToolExecutionResult } & ToolEventCall)
  | { type: "inbox_update"; items: readonly { id: SubmissionId; mode: InboxItem["mode"] }[] }
  | { type: "submission"; record: SubmissionRecord }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "auto_retry_end"; attempt: number }
  | { type: "deferred_poll"; pollAt: number }
  | { type: "entry_appended"; entry: EntryRecord }
  | { type: "agent_changed"; agent: AgentState }
  | { type: "usage_changed"; usage: UsageState }
  | { type: "task_failed"; taskId: TaskId; kind: string; message: string }
  | { type: "compaction_start"; taskId: TaskId; reason: CompactionReason; blocking: boolean }
  /** 任务的回执说明它是否产出了摘要；摘要条目有自己的事件。 */
  | { type: "compaction_end"; taskId: TaskId; reason: CompactionReason; error?: string };

/** 在途 assistant 消息的一次变更，相对于该消息。 */
type MessageChange =
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: AssistantMessage["content"][number] }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_delta"; contentIndex: number; path: readonly (string | number)[]; delta: string }
  | { type: "block"; contentIndex: number; block: AssistantMessage["content"][number] }
  | { type: "message"; message: AssistantMessage };

interface AgentEventStream {
  /** 附着时的 `snapshot` 事件。 */
  readonly snapshot: Extract<AgentEvent, { type: "snapshot" }>;
  start(listener: (events: readonly AgentEvent[], context: Context) => Promise<void>): void;
  stop(): Promise<WatchEnd>;
  readonly closed: Promise<WatchEnd>;
}
```

每个事件相对于 `snapshot` 和它之前的事件，绝不相对于 Durable 的文档布局。`snapshot` 替换消费者持有的一切；其他每个事件在其之上应用。附着在 Session 线上原子地捕获快照并注册后续发布。

事件从已提交变更推导：

- `run_start`/`run_end`：`pi.live.run` 出现、被移除、或被第一个输入不同的后继运行替换。加入当前运行的转向和其任务之间的移交不是运行事件。输入的结果是 `submission` 事件。
- `turn_start`：一个 `pi.generation` 任务被创建。`turn_end`：generation 的结果被提交——当它保持 `completing` 或变为终态时，以先到者为准——所以在保持时创建的后继在它之后开始。
- `message_start`：一次尝试的第一个已提交部分结果，或对没有已提交部分结果的消息条目，条目本身；每个带 `model` 消息的条目之后有 `message_end`。generation 只在有内容时提交部分结果，且每个清除部分结果的内置路径都追加其条目，所以每条开始的消息以其条目结束。没有消息的条目是 `entry_appended`。
- `message_update`：已提交部分结果上的 Chord 操作，翻译后：向 `content` 的插入开始块，向块的 `text` 或 `thinking` 的追加是 delta，向工具调用 `arguments` 内字符串的追加是路径相对 `arguments` 的 `toolcall_delta`，块内任何其他变更发送那个 `block`（它已持有批次对它的后续变更），`content` 的任何其他变更发送整个 `message`。每次更新携带部分结果的当前 `usage`，如同 coding agent 的 JSON 模式；只有 `usage` 的变更不发送 changes。只有 delta 在传输，所以节流的部分结果不在网络上造成写放大。
- `tool_execution_start`：槽变为 `running`；`args` 来自同一提交中工具任务的意图检查点。未运行就变为 `done` 的槽（未提供的调用、无效参数、阻止、意图之前的故障）只有 `tool_execution_end`。`tool_execution_update`：槽保留窗口的输出追加、前端修剪和替换，以及变化时槽当前的 `details` 和 `diagnostics`；被移除的——如安全重放重启工具时——发送 `null` 和 `[]`。
`tool_execution_end`：槽变为 `done`，带其携带诊断的 `pi.tool-result` 条目，或在故障或孤儿之后不带。因运行结束而消失的未完成槽，以同一提交中追加的结果条目结束——如被中止轮中未开始的调用——在 `message_start` 之前，或不带条目。嵌套槽产生相同事件并带 `parentToolCallId`；嵌套调用以其 `result` 结束——取自其终态提交发布的 `NestedCallDoc` 值——或在故障、孤儿或其槽未完成就消失时没有。快照显示带 summary 的已完成嵌套槽，而非其结果；迟到的订阅者从活跃调用者的 `NestedCallDoc` 按调用键（槽的 `callId` 去掉 `<parentCallId>/` 前缀）读取结果。
- `inbox_update`、`agent_changed`、`usage_changed`：文档变化；退役的读作其初始值，如同快照中一样。注册表安装和设置变更不做提交也不发出任何东西；展示已解析工具或已解析模型的 UI 经 `Conversation.agent()` 重新解析。
- `auto_retry_start`/`auto_retry_end`、`deferred_poll`：`pi.live.generation` 获得 `retry` 或失去它，或获得 `deferred` 或移动其 `pollAt`。
- `task_failed`：会话的任务落定 `faulted` 或 `orphaned`。
- `compaction_start`/`compaction_end`：状态出现在 `pi.live.compactions` 或从中消失。同一提交把任务记入 `pi.live.compactionFailure` 时，`compaction_end` 携带 `error`。重试退避只显示在快照的 `compactions` 中。排队的摘要稍后以其自己的 `message_start`/`message_end` 和 `submission` 事件放置。

一次提交产生一个批次，按此顺序：`tool_execution_start`、首个部分结果的 `message_start`、`message_update`、`tool_execution_update`、
以及 retry/deferred 事件；然后按追加顺序的条目及其 `message_start`/`message_end` 或 `entry_appended`——工具结果的 `tool_execution_end` 直接先于其 `message_start`，与 coding agent 相同——以及嵌套调用的 `tool_execution_end`（子在前）先于条目；然后是无条目结束的工具的 `tool_execution_end`；然后 `compaction_end`、`task_failed`、`turn_end`、`run_end`；然后按 ID 顺序的 `submission` 事件；然后 `inbox_update`、`agent_changed` 和 `usage_changed`；最后是 `compaction_start`、`run_start` 和 `turn_start`。流至多缓冲 100 个未投递批次；再加一个就用最新已提交状态的一次 `snapshot` 替换每个未投递批次。因此流收敛但不承诺每个转换；`Submission.wait()` 报告精确结果。重连的消费者重新附着并从其 `snapshot` 开始；没有重放。传输背压和断连策略属于消费者。

Print 模式 await 自己的输入 `Submission` 并打印其答案。TUI 渲染 `ConversationView`；事件可以驱动瞬时动画。

### 9.5 任务图视图

任务图视图把 Session 的每个活跃任务显示为一个结构化值，供 UI 和调试：什么在运行、什么在等什么、每个任务拥有哪些会话。它之于 Session 的任务，如同会话视图（第 9.3 节）之于一个会话。

```ts
type TaskGraphState =
  | { readonly status: "pending" | "running"; readonly phase: string }
  | {
      readonly status: "waiting";
      readonly phase: string;
      readonly on: readonly TaskId[];
      readonly policy: JoinPolicy;
    }
  /** 结果被保持，直到其普通拥有工作排空（第 5.5 节）。 */
  | { readonly status: "completing"; readonly outcome: TaskOutcome<JsonValue>["status"] };

type TaskGraphNode = {
  readonly id: TaskId;
  readonly kind: string;
  readonly conversationId: ConversationId;
  /** owner 任务；会话拥有的任务缺席。 */
  readonly owner?: TaskId;
  readonly background: boolean;
  readonly abortRequested: boolean;
  readonly state: TaskGraphState;
  /** 本任务拥有的会话，按 ID 顺序。 */
  readonly conversations: readonly ConversationId[];
};

type TaskGraph = {
  /** 每个活跃任务，以其十进制 ID 为键。 */
  readonly tasks: Readonly<Record<string, TaskGraphNode>>;
};

type TaskGraphWatch = WatchHandle<TaskGraph>;

interface Harness {
  taskGraph(context: Context): Promise<AttachedReplicatedState<TaskGraph>>;
  watchTaskGraph(context: Context): Promise<TaskGraphWatch>;
}
```

节点持有已提交任务记录，去掉其输入、检查点载荷、结果载荷和 memos：`phase` 是检查点的阶段，`on` 和 `policy` 是存储的等待，`outcome` 是持有结果的状态。`running` 是持久状态：open 把存活的 `running` 任务改为 `pending`（第 5.4 节），所以它们显示为 `pending` 直到调度器再次预留，而 `waiting` 和 `completing` 任务保持其状态。一个 pending 任务是否受阻、`on` 中哪些任务仍活跃，取决于注册表和图的其余部分；`inspect()` 推导它们。节点从创建其任务的提交存在到使任务终态的提交。Owner 边不可变，所以节点的 `conversations` 在其存活期间只增不减。

图只持有活跃任务。owner 任务已终态的会话——例如其锚点完成后的后台子代理会话——没有列出它的节点；那里的后续任务是该会话的顶层节点。把它放在其父下方的 UI 从 `ConversationRecord.owner` 读取会话的 owner 边，`ConversationView.conversation` 也携带它。

Harness 至多保留一个图挂载。第一个 `taskGraph()` 或 `watchTaskGraph()` 在 Session 线上从已提交的活跃任务及其拥有的会话构建其修订版——每个活跃任务一次 owner 扫描——并在执行期间持有变更线；最后一个观察者分离时挂载被丢弃。它像会话视图一样从 `subscribeCommits()` 发布前进：改变一个节点的一次发布产生一个设置或删除 `tasks[id]`、或设置节点 `conversations` 的 Chord 批次。不改变任何节点的发布不创建修订版。任务和会话记录是不可变值；节点与它们不共享任何东西。

`taskGraph()` 把挂载返回为一次性的只读 Chord 状态。`watchTaskGraph()` 经第 9.2 节的串行化精确帧 watch 返回它。两者只读：都不启用调度。Close 在其封锁点结束它们，像其他每个状态和 watch（第 2.2 节）。

```ts
const graph = await harness.taskGraph(context);
graph.subscribe((value) => {
  for (const node of Object.values(value.tasks)) {
    const where = node.owner === undefined ? `conversation ${node.conversationId}` : `task ${node.owner}`;
    render(`${node.id} ${node.kind} ${node.state.status} under ${where}`);
  }
});
```

## 10. 存储契约

有序扫描基于游标。精确身份查找按键。

```ts
type Page<T, C> = {
  readonly items: readonly T[];
  readonly next?: C;
};

type Cursor = Readonly<Record<string, JsonValue>>;

/** ID 顺序：`ascending` 最旧在前，`descending` 最新在前。 */
type ScanOrder = "ascending" | "descending";

type ConversationQuery = {
  readonly ownerConversationId?: ConversationId;
  readonly ownerTaskId?: TaskId;
  readonly order?: ScanOrder; // 默认 ascending
};

type EntryQuery = {
  readonly conversationId: ConversationId;
  readonly minEntryId?: EntryId; // 含
  readonly maxEntryId?: EntryId; // 含
  readonly order?: ScanOrder; // 默认 descending
};

type TaskQuery = {
  readonly conversationId?: ConversationId;
  readonly kind?: string;
  readonly status?: "pending" | "running" | "waiting" | "completing" | "terminal";
  readonly abortRequested?: boolean;
  readonly background?: boolean;
  readonly order?: ScanOrder; // 默认 ascending
};

type SubmissionQuery = {
  readonly conversationId?: ConversationId;
  readonly status?: SubmissionRecord["status"];
  readonly order?: ScanOrder; // 默认 ascending
};

type DocumentPoint = Seq | "current";

type DocumentAddress = {
  readonly kind: string;
  readonly scope: DocumentRecord["scope"];
  readonly key?: string;
};

type DocumentQuery = {
  readonly scope: DocumentRecord["scope"];
  readonly at: DocumentPoint;
  readonly kind?: string;
};

type DocumentContent =
  | { readonly version: number; readonly kind: "base"; readonly value: JsonObject }
  | { readonly version: number; readonly kind: "delta"; readonly ops: readonly Op[] };

type StoredDocument = {
  readonly record: DocumentRecord;
  readonly version: number;
  readonly value: JsonObject;
  /** 在选中基线之后重放以物化 `value` 的增量。 */
  readonly deltasSinceBase: number;
};

type StorageWrite =
  | { readonly type: "conversation"; readonly value: ConversationRecord }
  | { readonly type: "entry"; readonly value: EntryRecord }
  | { readonly type: "task"; readonly value: TaskRecord<JsonValue, JsonValue, JsonValue> }
  | { readonly type: "submission"; readonly value: SubmissionRecord }
  | {
      readonly type: "document.create";
      readonly record: DocumentCreate;
      readonly content: Extract<DocumentContent, { kind: "base" }>;
    }
  | {
      readonly type: "document.copy";
      readonly record: DocumentCreate;
      readonly source: { readonly id: DocumentId; readonly at: DocumentPoint };
    }
  | {
      readonly type: "document.change";
      readonly id: DocumentId;
      readonly content: DocumentContent;
    }
  | { readonly type: "document.retire"; readonly id: DocumentId };

/**
 * 信任拥有它的 Session 提供语义有效的记录、引用、祖先关系和转换。强制原子性、全局 ID 所有权、不可变的会话/条目创建、文档记录一致性，以及分离的值；Session 串行化提交。序列严格递增但可有间隔。一旦 commit() 返回，之后经该 Storage 的读取都能观察到它。
 */
interface Storage {
  commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>;
  /**
   * 从唯一的全局数字命名空间分配，高于之前铸造或存储的每个 ID，跨重开也如此：扫描按 ID 排序即创建顺序，Harness 依赖它。通用品牌只在编译期。
   */
  mintId<I extends Id<string>>(): Promise<I>;

  conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined>;
  scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<ConversationRecord, Cursor>>;

  entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, context: Context): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;
  scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<EntryRecord, Cursor>>;

  task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
  scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

  submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined>;
  scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<SubmissionRecord, Cursor>>;
  submissionByRequest(conversationId: ConversationId, requestId: string, context: Context): Promise<SubmissionRecord | undefined>;

  findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined>;
  document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined>;
  scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<DocumentRecord, Cursor>>;

  close(context: Context): Promise<void>;
}
```

方法抛出的每个错误对 Session 都是最终的（第 10.1 节），所以后端在方法内部重试自己的瞬时失败。读取对无效请求抛出 `StorageRequestError`，无持久效果；从 `commit()` 抛出则与其他错误一样是致命的。

`document.copy` 读取与命令顺序无关的已提交批前源状态。源必须是在所选点存活的会话文档，且 kind/key/history/fork 必须与子创建记录匹配。Storage 以源的存储版本持久化一条独立的完整子基线。一批次不得创建、变更或退役被选中的源。之后的源变更、回收、退役或后端重开都不能影响子。

游标是后端拥有的 JSON 对象。调用者只把它们往返于同一存储上的同一次扫描；跨存储或跨查询使用不受支持。会话、条目、任务和提交扫描按其查询的 `order`、按 ID 运行。游标携带返回它的扫描的顺序：带游标的扫描继续那个顺序，无论其查询重复 `order` 还是省略它，并拒绝要求另一顺序的查询。Storage 实现必须遵守 `order`；忽略它的会不出错地返回方向错误的页。
Session 拥有变更线，所以存储实现不添加第二个面向调用者的提交互斥。每个后端仍使一个被接纳的批次原子。

`findLatestHeadMarker()` 返回在其可选含端截止点或之下、携带 `head` 的最新可见条目。返回的条目是标记；其 `head` 值是上下文的实际下界。`scanEntries()` 对含端的 ID 范围分页，默认最新在前，同时应用每个会话祖先截断；最旧在前时，先读根的段，再读每个分叉的。无界时对完整可见历史分页。要读条目 `E` 处的上下文，找到 `E` 处或之前的标记，然后从 `marker?.head` 扫到 `E`。当前上下文省略上界。会话 owner 过滤器有索引且是合取的。它们支持归属遍历而无需全会话扫描；应用维护的注册表不能替代这些内核索引。

`entry(id)` 把精确全局查找与历史文档读取所需的提交序列组合。`entry(conversationId, id)` 只在该条目经请求会话的祖先链可见时返回该对。`limit` 总是最大页大小。
`findDocument()` 在当前或历史成员资格下解析一个精确的逻辑 kind/作用域/键地址。缺失键指单例，不是每个族成员。`scanDocuments()` 只枚举在一个精确作用域、其选中点存活的化身，并可限制一个族/单例 kind。它用递增的化身 ID。没有普通的 open 时全文档扫描。任务查询支持会话、kind、活跃/终态状态、中止标记和后台状态。

`document(id, at)` 物化一个特定化身，绝不在同一逻辑地址跟随替换。调用者在尚未持有化身 ID 时用 `findDocument()` 解析地址。它选最新的适用基线，应用其有序 Chord 增量尾部，并返回分离的物化值、存储定义版本和该基线之后重放的增量数。基线/增量记录是后端私有的。查找绝不扫描无关文档。未知 ID 返回 `undefined`。在 `"current"`，已退役化身返回 `undefined`。对 rewindable 会话化身的数字查找在其半开生命周期之外返回 `undefined`，在其内重建选中的值。对已知 current-only 化身的数字查找拒绝，而不是依赖被回收的内容。元数据成员资格历史上仍可查询。缺失的必需基线、增量尾部内的版本变化、或无法在可寻址生命周期内应用的操作，是存储损坏，不是缺席。

一个规范化批次对每个化身至多含一条创建/变更内容命令，且还可以退役该化身。Storage 在退役之前应用内容，与写入数组顺序无关。创建加退役用批次序列同时盖两个生命周期界。一个逻辑地址上的退役加创建使新化身在该序列成为当前。增量不能跨越存储版本边界；版本转换必须是基线。

语义一致性测试套件覆盖内存、SQLite 和 JSONL。

### 10.1 失败

每类错误一条规则，宿主无需读代码就知道会发生什么。

**存储错误结束 Session。** `Storage` 方法抛出的任何错误——提交、读取或 `mintId()`——使 Session 失败，下面有两个例外。Session 和 Harness 都不重试任何东西：Storage 在方法内部重试自己的瞬时失败。重开从已提交的内容恢复，它总是一致的，因为提交是原子的；抛出的调用可能提交了也可能没提交，所以重开后重新提交的宿主复用其 `requestId`，它会找到已接纳的提交。第一次失败时：

- 命中它的调用以该错误拒绝。之后每个调用、每个待决等待（`submission.wait()`、`waitForTask()`、`waitForIdle()`、`abortTask()`）、以及之后开始的每个等待，都以 `SessionFailed` 拒绝——其 `cause` 是第一个错误；它返回时仍在进行的每个 Storage 调用也是，
  无论它返回什么。
- watch 和事件流以 `{ reason: "session_failed", error }` 结束；已附着的复制状态停止更新并保持其最后的值。
- 运行中的任务调用收到其 abort 信号。`HarnessOptions.onReport` 收到该错误一次，在 Session 被封锁之后，所以回调调用的报告处理程序会发现它已失败。
- Session 关闭自己。`closed` 在该 close 运行之后落定 `{ reason: "failed", error }`——后端无法干净关闭时也是；普通 `close()` 之后落定 `{ reason: "closed" }`。关闭后端等待每个进行中的 Storage 调用——拒绝新的——并等待运行中的任务代码返回：忽略其 abort 信号的代码使后端保持打开、`closed` 保持待决。
- 失败的 `Storage.close()` 也使 Session 失败，除非它已经失败；`close()` 调用以它拒绝，`closed` 落定 `failed`。等待和 watch 已像 close 一样结束（`session_closed`）。

例外只使其调用失败，且只适用于读取：`StorageRequestError`——Storage 对无效读取抛出，无持久效果（未知会话、畸形游标或来自另一扫描顺序的游标、文档不保留的历史）——以及因其调用者上下文被中止而被拒绝的读取。来自 `commit()` 或 `mintId()` 的错误绝不适用的：一批次一旦被接纳，是否已提交是未知的。

捕获了失败读取的提交回调之后无法提交：Session 在回调之后检查其健康状况。在内存中采纳已提交批次失败也使 Session 失败，因为内存会落后于存储。

**Session 自己的簿记失败也使其失败。** 调度器为自己做的提交（对账、预留、故障或终态写入）中的抛出使 Session 失败。那里唯一的扩展代码是任务的 `migrate`，其抛出被捕获并阻塞该任务；任何其他抛出的是存储失败、宿主回调——例如 `snapshot()` 抛出的 `RegistryReader`——或缺陷，再运行一次提交解决不了任何一个。Session 自身组件（调度器、提交、视图、任务图、文档观察者）的提交监听器中的抛出同样使其失败，因为它们的内存会落后于存储；提交本身成立。

**用户代码只使其单元失败。** 抛出的任务阶段使该任务 `faulted` 结束；抛出的 `migrate` 以 `migration_failed` 阻塞它；抛出的工具、或其环境无法构建的工具，得到错误结果；抛出的钩子被上报并跳过——`beforeTool` 除外，其抛出阻止该调用；抛出的提交回调、`conversationCreated`、`init`、或文档的 `initial`、`migrate`、`checkpointWhen` 回滚其提交并拒绝它。不得使其调用者失败的回调被容纳：抛出、或返回被拒绝 promise 的宿主 `subscribeCommits()` 或 `subscribeClose()` 监听器、watch 监听器、复制状态订阅者、视图观察者，被上报，其他监听器仍运行；监听器抛出的 watch 以 `listener_error` 结束。抛出或拒绝的 `onReport` 被丢弃，因为没有留下可报告的对象。抛出的 `now()` 被上报一次，之后用 `Date.now` 代替。

## 11. 后端

### 11.1 内存

内存存储是参考语义。它复制保留的写入值和所有读取结果。这有意模拟 SQLite 编解码和 JSONL 序列化自然产生的所有权边界；它不是防御性校验。它保留 rewindable 记录，只在已提交基线或退役之后回收 latest 记录。

### 11.2 SQLite

一个 SQL 事务是一次 Session 提交。SQLite 存储：

- 会话、条目、任务和提交记录；
- 文档记录；
- 按文档和提交序列索引的文档基线/增量。

活跃任务转换替换一行。终态任务保留为小记录。文档读取使用有索引的基线加尾部范围。第一个实现直接存储 Chord 记录；它不把通用操作翻译为 SQLite JSON 函数。

Schema 形状、WAL 检查点节奏和同步默认值是后端实现选择，由一致性、重开、查询计划和存储基准测试验证。

### 11.3 JSONL

JSONL 依赖可移植的 `FileSystem` 能力，而不是更广的 `ExecutionEnv`。它使用可回收的边车（sidecar）文件而不把它们暴露给 harness。仅持久化并不提供所有权边界：内存中保留的任何解码索引、物化值或缓存都必须与提交参数分离，且不得经读取直接暴露。JSONL 后端不能简单地在别名化的内存表周围加文件追加。

```text
main.jsonl       table writes, document records, and one marker per commit
doc-<id>.jsonl   one document incarnation
task-<id>.jsonl  live task replacements
```

发布协议：

1. 把完整的已准备记录追加到每个受影响的边车。
2. 追加一条列出那些记录的完整主标记。
3. 只在标记写入成功之后在内存中发布。

每次提交都用此协议；没有独立边车快速路径。JSONL 创建接受默认为 `false` 的 `fsync` 选项。没有 `fsync` 时，它保证普通的进程崩溃一致性，而不是断电、主机、内核或文件系统故障后的存活。带 `fsync: true` 时，后端追加所有受影响的边车记录、冲刷每个受影响的边车，然后才追加主标记。普通发布不显式冲刷 `main.jsonl`；因此一个已确认的尾部提交仍可能消失，但存活下来的标记不应越过其边车数据。纯主文件的提交没有边车可冲刷。带 `fsync: true` 的破坏性回收之前，后端冲刷 `main.jsonl` 一次，使授权标记不会在其替换或移除存活时消失。该冲刷失败时，已提交状态保持已发布，回收被推迟。非空的临时替换也在重命名之前冲刷。

恢复：

- 移除撕裂的末行。
- 忽略并移除未确认的边车尾部。
- 只应用已确认的记录。
- 缺失必需的已确认数据是损坏，打开失败。
- 更晚提交的 latest 基线或退役可以证明更早的物理记录不再需要。
- 任何不确定的追加失败毒化打开的后端。

回收只在授权基线/退役提交之后开始。没有边车记录残留时，直接移除边车。否则，它写一个临时替换、重命名它，并使缓存的文件描述符失效，使未来的追加不能指向已取消链接的 inode。冲刷 `main.jsonl` 以授权回收不会压缩它。初始实现不压缩 `main.jsonl`。

## 12. API 陷阱

这些是契约，不是添加防御性机制的邀请：

- **分离的草稿工作：** Session 回调落定之后，草稿读取、草稿写入和所有 `Tx` 操作都拒绝。在回调落定之前运行的即发即忘工作仍可能变更活跃事务，不受支持。
- **写后读：** 在第一次表写入之前读取每个需要的表行。文档草稿之后仍可用；表读取不行。
- **向忙碌会话写入：** 只有 Harness 向有活跃运行的会话追加。generation 准备其请求期间由 `Harness.commit()` 或自定义任务追加的原始条目可能错放其系统提示词条目；使用写提交。
- **失败运行后的排队项：** 失败和任务中止不动收件箱。排队的 follow-up 在 `pi.inbox` 中等待，其 `wait()` 不落定，直到下一个输入或排队写入的边界放置它们、或宿主撤回它们；仅展示写入不运行边界。压缩摘要就是这样的提交：当手动或后台压缩在该空闲会话中完成时，其最终边界放置等待的 follow-up 并启动一次运行。
- **压缩花费：** 每次手动和后台压缩为每次尝试支付一次摘要请求，即使其摘要因更晚的压缩截断更远而过期结束。
- **压缩期间的 head 和编辑：** 摘要反映其压缩选中范围时的上下文。它摘要期间放置的应用编辑——例如替换条目 20 的写入——在摘要截过其目标时丢失：摘要仍描述旧的条目 20，而编辑的目标离开范围。其间放置的应用 head——例如在 85 处截断以遗忘条目 10-84 的——被在 90 处截断的摘要撤销：
  那个摘要仍描述 10-84。把这类写入放在压缩之前。
- **摘要时间戳：** 排队摘要的用户消息携带其压缩完成的时间，不是其放置时间。按消息时间戳判断用量陈旧性的代码——例如对视图消息用 pi-ai `estimateContextTokens()`——可能误判；Harness 估算用条目顺序（第 8.3 节）。
- **写入过去的原始 head：** 用 `tx.appendEntry()` 直接写入、以会话活跃范围之前的条目为目标的 head 改变模型上下文，但已挂载视图只保留它已持有的条目，直到挂载被重建。使用写提交，其过期检查会拒绝它。
- **子代理花费被双计：** 运行被拥有会话的工具不得在其结果中报告该会话的 usage；子会话的 `pi.usage` 已计入它，子树求和会计两次。
- **拥有的工作保持其 owner：** 拥有活跃普通工作的任务保持 `completing` 直到该工作结束（第 5.5 节）。扩展在子代理会话中启动的前台工作保持调用它的工具，进而保持运行；在其工具 completing 时向子代理提问会延长保持。Esc 或宿主超时结束它；不应保持其 owner 的工作应创建为会话拥有且 `background`。
- **钩子创建的工作：** 钩子在发起任务的调用内运行，所以它们创建的、归该任务所有的工作保持它。必须延迟任务完成的工作必须在任务提交其结果之前创建；之后对已发布事件做出反应的监听器无法延长它。运行任务的拥有工作不得在运行被释放后写 transcript。
- **abort 处理程序中的补偿：** abort 处理程序不能创建拥有的子任务，因为其任务带中止标记。在做效果的层级补偿——在该任务自己的 abort 处理程序中、或内联、或通过用 `waitForTask()` 等待的后台会话拥有任务；非后台的会被到达其会话的任何级联中止。
- **钩子 memo 名字：** 钩子与任务和其他钩子共享发起任务的 memo 命名空间。给 memo 名加前缀。
- **长事务：** 异步提交回调持有 Session 变更线。绝不在其中 await 模型、工具、进程、网络调用、人类、嵌套 Session 提交或 Session 等待者。使用当前 `Tx` 上的方法。
- **提交内的读取：** `snapshot()`、`documentState()`、`watchDoc()`、`getTask()` 和其他 Session、Harness、运行时读取可能在变更线上排队——例如加载不在内存中的文档。在持有该线的提交回调内，这样的读取永不返回，线保持被持有。只有缓存命中才返回，所以挂起是间歇性的。经 `tx` 读取。
- **显式创建：** 只有类型化的 `tx.doc()` 创建缺失文档。快照、状态和 watch 查找返回 `undefined`。
- **族初始化：** 对缺失族地址的第一次获取选择其种子。已有实例和之后的调用忽略种子；种子既不是身份也不是更新。
- **检查点饥饿：** 若 `checkpointWhen()` 从不返回 true，文档存活期间重放和 current-only 文档存储可无界增长。
- **错误的 fork 设置：** `current`、`initial` 和 `asOf` 是产品语义，不是优化。改变它们就改变子会话行为。
- **Schema 稳定性：** 文档 kind 和可见挂载路径是持久化/公开协议。值迁移不能重命名 kind；kind 变更需要显式复制和退役。传入声称相同 kind 的不兼容定义令牌是不受支持的调用者误用；Session 不维护文档定义注册表来检测它。
- **受信任的不可变修订版：** `snapshot()`、状态值、watch 值及其后代可能共享跟踪器拥有的容器。绝不变更它们；需要可变所有权时先复制。不提供运行时冻结。
- **Watch 激活：** `start()` 之前，`watch.value` 保持不可变的获取修订版。先从它初始化消费者。启动后，该属性在其回调之前前进到每个投递的不可变修订版；每个更早的引用保持稳定。
- **缓冲的 watch：** 慢的或未启动的 watch 保留至多 100 个精确已提交帧。溢出用一次整值根替换替换未投递后缀，所以中间的已提交状态可能被省略。必须审计每个转换的消费者必须把每个事实持久化在不可变条目或日志中并显式扫描该历史。
- **Watch 停止：** 监听器可以调用并 await `stop()`；它阻止未来的回调，但既不中止也不加入已在运行的回调。
- **持久进展节奏：** 客户端只看到已提交的进展。崩溃可能丢失当前未提交的节流窗口。
- **大的终态结果：** 终态任务记录仍可查询。把大结果放在条目或更长命的文档中，结果里只保留其 ID。绝不引用被同一结果退役的任务作用域文档。
- **原始 transcript：** 视图条目不是模型上下文。渲染编辑、仅展示条目和模型过滤需要相应的归约器。
- **保留的 `pi.` 名字：** 以 `pi.` 开头的任务名、文档 kind 和条目 kind 按约定属于内置。没有东西强制；复用一个会与 Harness 行为冲突，例如 `pi.system` 条目被当作系统消息重放。
- **过早的资源处置：** 卸载或替换扩展只停止新使用。立即释放资源可能使仍在运行的调用失败。
- **选择中遗漏的守卫：** 数组选择遗漏了守卫扩展——例如权限钩子——的会话在没有它的情况下运行。扩展被整体选择；没有注册表范围的钩子或包装器。
- **选择编辑与副本：** `{ add, remove }` 总是编辑宿主默认选择。写到从其 owner 复制了任何选择的子会话——数组或 `{ add, remove }` 对象——它会替换那个选择，所以子会话得到带编辑的宿主默认，而不是 owner 的选择。改为从已解析 agent 计算子会话的数组（第 7.3 节）。
- **副本是一次性的：** 新的任务归属会话在创建时复制其 owner 的 `pi.agent`；之后 owner 的变更不到达它。分叉改为保留其 `asOf` 副本（第 2.2 节）。
- **恢复时的环境：** 恢复后的工具重运行重新构建其环境，用会话当前的 `cwd`——可能与第一次尝试的不同。
- **移动默认选择：** 默认选择上的会话在设置或已安装扩展变化时变化；每次变化追加 `pi.system` 条目并错过提供方提示词缓存。
- **不稳定的提示词文本：** 输出在没有真实内容变化时也变化的节渲染器——例如内嵌时间——追加系统增量并击败提供方提示词缓存。
- **close 时不配合的代码：** close 加入每个调用。忽略其信号的任务处理程序、工具或钩子使 `close()` 保持待决、Storage 保持打开，直到它返回；取消 close 等待不结束它。
- **比 Harness 活得久的对象：** 在关闭 Harness 之前关闭暴露 Harness 状态的 Chord 对象和链接。被 close 结束的状态保持其最后的值且不再更新。
- **致命存储错误：** 存储错误之后 Session 已失败并关闭自己；重开它（第 10.1 节）。重试失败的调用不会成功：在 Storage 内部重试瞬时失败。
- **JSONL 持久性：** 默认 JSONL 顺序处理普通进程崩溃；不带持久模式它不承诺已确认的提交在断电或主机故障后存活。

## 13. 非目标

Durable 没有：

- 整个 Session 的 DOM；
- 可见但非持久的发布；
- Session 内核语义事件日志或独立维护的事件状态；
- Session 作用域的 rewindable 文档；
- 自动检查点启发式；
- 自动第三方视图挂载；
- CRDT/离线多写者合并；
- 任意 Chord 操作的 SQL 翻译；
- JSONL 全局压缩或自动损坏修复；
- 更早 harness 原型的兼容层；
- 单进程内对不配合扩展代码的强制终止。
