# @earendil-works/pi-durable

> **实验性。** API 在版本之间可能不经通知即变更。

一个持久化的 agent harness。对话、模型轮次、工具调用和你自己的状态在任何内容被展示之前都会提交到存储。如果进程在轮次中途死亡，重新打开存储即可从停止处继续工作。

模型访问构建在 [`@earendil-works/pi-ai`](../ai/README.md) 之上，文档状态构建在 `@earendil-works/chord` 之上。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [概念](#概念)
- [持久化与恢复](#持久化与恢复)
- [扩展](#扩展)
- [工具](#工具)
- [Code Mode](#code-mode)
- [系统提示](#系统提示)
- [每对话 Agent](#每对话-agent)
- [设置](#设置)
- [环境](#环境)
- [重载](#重载)
- [观察对话](#观察对话)
- [忙碌的对话](#忙碌的对话)
- [重置与交接](#重置与交接)
- [压缩](#压缩)
- [Agent 事件（实验性）](#agent-事件实验性)
- [钩子](#钩子)
- [更多对话与分叉](#更多对话与分叉)
- [中止与子 agent](#中止与子-agent)
- [子任务](#子任务)
- [任务图](#任务图)
- [你自己的状态](#你自己的状态)
- [用量与成本](#用量与成本)
- [存储](#存储)
- [错误](#错误)
- [示例](#示例)
- [设计文档](#设计文档)

## 安装

```bash
npm install @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

## 快速开始

```typescript
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

const models = createModels();
models.setProvider(openaiProvider()); // 读取 OPENAI_API_KEY

const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } });

const submission = await root.submit({ type: "input", content: "What is the capital of France?" }, context);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	console.log(answer?.model?.[0]);
}
await harness.close(context);
```

发生了什么：

- `Harness.open()` 在一个存储后端上打开一个 Session。`MemoryStorage` 把所有东西放在内存里。
- `root()` 返回根对话，首次使用时按给定的 agent 选择创建它。对话是一份不可变条目的记录。
- `submit()` 持久化地接纳你的输入并返回一个 `Submission`。一个内置的生成任务调用模型并追加答案。
- `wait()` 在输入被回答（`done`）或失败（`unanswered`，带原因）时 resolve。

每个异步调用都接受一个携带取消能力的 Chord `Context`。`BACKGROUND_CONTEXT` 从不取消。取消一个等待只取消那次等待，绝不取消工作本身。

## 概念

- **Harness**：一个打开的存储加上在其上运行 agent 的机制。所有变更都经过一行原子的提交，任何内容在其提交被存储之前都不会被展示。
- **Conversation**：一份记录（transcript）。`root()` 在首次使用时创建根对话；你可以创建更多对话并分叉它们。`Conversation` 句柄不持有状态；按 `id` 比较句柄。
- **Entry**：一条不可变的记录，例如用户消息（`pi.user`）、模型响应（`pi.assistant`）、工具结果（`pi.tool-result`）、系统提示变更（`pi.system`）、重置（`pi.reset`），或你自己的种类。模型看到的是从最近一次重置开始的条目。
- **Commit**：一次原子写入。`conversation.commit((tx) => ...)` 可以一起追加条目、编辑文档和创建任务；要么全部存储，要么全不存储。
- **Document**：与记录一起存储、在提交中变更的类型化 JSON 状态。内置的文档保存每个对话的 agent 选择（`pi.agent`）、面向提供商的会话身份（`pi.provider`）、正在运行的生成和工具（`pi.live`）、排队的提交（`pi.inbox`）和开销（`pi.usage`）。
- **Task**：一个持久化的状态机，每一步都保存检查点，因此重启的进程从最后一个检查点继续。每个任务都有拥有者：它的对话，或另一个任务。Harness 把回答运行为内置任务：`pi.generation` 调用模型并拥有其工具调用的 `pi.tool` 任务，等待它们，再把这次运行交给下一次生成。
- **Submission**：你交给对话的东西，要么是用户输入，要么是要写入的条目，可以等待它。
- **Turn 与 run**：turn 是一次模型响应及其工具调用；run 是从一次输入到其最终答案的各次 turn。run 进行期间对话处于忙碌状态。
- **Extension**：一个命名的捆绑包，包含工具、系统提示段、钩子、包装器和任务。
- **Registry**：本进程安装的扩展。它可以在 Harness 运行期间变化；新工作使用新状态。
- **Agent**：对话运行所依据的东西：模型、思考级别、选中的扩展、工具、指令和工作目录。按对话以名称存储在 `pi.agent` 中，每次使用时对照 registry 解析。

一次被回答的输入，以条目和任务表示：

```text
submit(input) → pi.user
  pi.generation → pi.system（仅当提示或工具变化时）、pi.assistant（工具调用）
    pi.tool × n → pi.tool-result × n   （由生成任务拥有，它等待它们）
  pi.generation → pi.assistant（答案）→ submission done
```

## 持久化与恢复

使用 SQLite 或 JSONL 存储让对话跨重启保留：

```typescript
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const harness = await Harness.open(await openNodeSqliteStorage("./session.sqlite"), { models, registry }, context);
const root = await harness.root(context); // 与上次相同的根对话
harness.resume(); // 继续上一个进程未完成的任何 run
```

被崩溃或关闭打断的工作保持待处理。`resume()` 启动任务调度器；提交或等待也会启动它。每个对话在 `pi.provider` 中有自己的持久化 UUIDv7，作为 `sessionId` 转发给 pi-ai，用于提供商的提示缓存和会话亲和。它跨重新打开、重试、重置、压缩和模型切换存活；子对话或分叉获得新的身份。旧对话在第一次生成或压缩请求之前收到并持久化一个。

带相同 `requestId` 的重试提交会返回已有的 submission，而不是提交两次：

```typescript
const submission = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// 重启后：相同的请求 ID 找到相同的 submission。
const again = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// again.id === submission.id
```

`harness.submission(id)` 按 ID 重新获取一个 submission，例如重启后等待它。

## 扩展

Harness 运行的代码（内置任务除外）以命名扩展的形式出现，安装在你的进程拥有的 registry 中：

```typescript
import { createRegistry, defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const Coding = defineExtension({
	name: "coding",
	sections: [section("preamble", () => "You are a concise coding assistant.", { tag: false })],
	hooks: [hook(ToolTask, { beforeTool: (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined) })],
});

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Coding);
```

扩展可以携带 `tools`、`sections`、`hooks`、`wraps`（按名称装饰某个工具或段）和 `tasks`。默认情况下，每个对话按安装顺序选中每个已安装的扩展。registry 中的任何东西都不被存储；对话存储的是扩展名称。

## 工具

`@earendil-works/pi-durable/tools` 提供 `read`、`write`、`edit` 和 `bash`，以及包含全部四个的 `CodingTools` 扩展。它们只通过调用的环境（见[环境](#环境)）接触文件和进程。

`read` 把图片文件作为一个图片块返回，调用它的程序拿到的是 `ImageContent`。限制取模型的 `inputLimits.images.resize`，默认 2000x2000 像素和 4.5 MB base64。没有图片处理器时，它在限制内的 PNG、JPEG、GIF 和 WebP 文件（尺寸从文件头读取）原样发送、不解码，并拒绝更大的和其他格式。有处理器时，它解码每张图片，按 EXIF 方向转正，把 BMP 转为 PNG，并缩小到限制内。基于 Photon 的处理器运行在 WebAssembly 上，只在你导入它时加载：

```typescript
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node"; // 或 /images/cloudflare，或 /images 的 createPhotonImages(wasm)
import { createCodingTools } from "@earendil-works/pi-durable/tools";

registry.install(createCodingTools({ images: await createNodePhotonImages() }));
```

没有图片输入的模型看到的是占位符而不是图片，`read` 会在诊断中说明。`/images/node` 在 worker 线程中准备图片，因此一张大照片（一两秒的工作）绝不会阻塞事件循环；worker 在 30 s 没有图片后退出，释放 Photon 的 WebAssembly 内存（`createNodePhotonImages({ worker: false, idleMs })`）。在其他地方，`createPhotonImages()` 和 `/images/cloudflare` 在调用线程上工作，解码占用图片完整大小的 WebAssembly 内存且不再收缩；在 Cloudflare Workers 这类内存受限的宿主上，除非图片都很小，否则不要挂处理器。

用 TypeBox schema 定义自己的工具。`defineTool()` 从 `parameters` 推导 `args` 类型，Harness 在 `execute()` 之前校验它。`api.output()` 流式输出运行中的输出，当 `execute()` 不返回 `output` 时它成为结果：

```typescript
import { Type } from "@earendil-works/pi-ai";

const count = defineTool({
	name: "count",
	description: "Count from 1 to n",
	parameters: Type.Object({ n: Type.Number() }),
	execute: async (args, api) => {
		for (let i = 1; i <= args.n; i++) api.output(`${i}\n`);
		return {};
	},
});
registry.install(defineExtension({ name: "count", tools: [count] }));
```

每次调用都作为自己的持久化任务运行。其意图在 `execute()` 运行之前就已提交。如果进程在调用中途死亡，工具只有在声明了 `replay: "safe"` 时才会在重新打开后重跑；否则模型得到一个 `interrupted` 错误结果，附带目前已提交的输出。从 `execute()` 抛出异常会给模型一个错误结果。结果还可以返回 `usage`，它被计入对话的[用量](#用量与成本)。它还可以返回 `control: { terminate: true }`：当该轮的每个结果都要求它时，run 结束而不再发起模型请求。

结果有三个通道：给模型的 `output`、给调用工具的程序的 `structuredOutput`（见[从工具调用工具](#从工具调用工具)），以及给 UI 的 `details`。声明了 `structuredOutputSchema` 的工具返回匹配的 `structuredOutput`，由 Harness 校验。调用没有声明 schema 的工具的程序得到其有界输出：一个文本项作为字符串，一张图片作为其 `ImageContent`，没有内容作为 `""`，其他情况作为内容列表，错误结果也一样。`structuredOutput` 始终是工具自己的值：schema 工具的错误结果保留它返回的值，没有 schema 的工具的错误文本在 `tool_error` 诊断中，与抛出异常的消息一样。记录中只存储 `output` 和 `details`：

```typescript
const lines = defineTool({
	name: "lines",
	description: "Count the lines of a file",
	parameters: Type.Object({ path: Type.String() }),
	structuredOutputSchema: Type.Object({ lines: Type.Number() }),
	execute: async (args, api, context) => {
		const text = await readText(api, args.path, context);
		const count = text.split("\n").length;
		return { output: [{ type: "text", text: `${count} lines` }], structuredOutput: { lines: count } };
	},
});
```

缺失、未声明或无效的 `structuredOutput` 会把嵌套调用的结果变成带 `invalid_structured_output` 诊断的错误结果；对模型发起的调用（它看不到这个值），该值被丢弃并通过 `onReport` 报告。错误结果可以省略它，程序随后在 `tool_error` 诊断中找到其文本；Harness 自己写的错误结果（blocked、invalid、interrupted、aborted）不带它，其 `diagnostics` 说明出了什么问题。对 schema 工具的 `output` 做脱敏的 `afterTool` 钩子也必须脱敏其 `structuredOutput`。内置的 `bash` 返回 `{ output, truncated, fullOutputPath?, exitCode }`，其中 `output` 是模型看到的保留尾部，用 `api.retainedOutput()` 读取，并以仍携带它的错误结果应答非零退出。

后安装的扩展中同名的工具会在两者都被选中时替换先安装的，`wrapTool()` 装饰胜出的那个工具：

```typescript
const Venv = defineExtension({ name: "venv", tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })] });
const Timing = defineExtension({
	name: "timing",
	wraps: [wrapTool(createBashTool(), (bash) => ({ ...bash, execute: (args, api, ctx) => timed(() => bash.execute(args, api, ctx)) }))],
});
```

### 从工具调用工具

工具用 `api.executeTool()` 调用另一个工具，就像 code mode 脚本或 MCP 桥那样。嵌套调用是调用者拥有的独立工具任务：它被校验，运行 `ToolTask` 钩子，有自己的输出限制和重放策略，并把结果返回给调用者而不是记录：

```typescript
const testsPass = defineTool({
	name: "tests_pass",
	description: "Run the test suite and say whether it passed",
	parameters: Type.Object({}),
	execute: async (_args, api, context) => {
		const run = await api.executeTool("bash", { command: "npm test" }, context, { progress: false });
		// bash 未完成时缺失，例如超时。
		const exitCode = (run.structuredOutput as { exitCode: number } | undefined)?.exitCode;
		return { output: [{ type: "text", text: exitCode === 0 ? "passed" : "failed" }] };
	},
});
```

- 调用者拿到嵌套调用的 `taskId`、`structuredOutput`、`details`、`diagnostics`、`usage` 和 `isError`，而不是给模型看的 `output`。被阻止、无效、失败或中止的嵌套调用返回 `isError` 结果。`executeTool()` 本身在 `execute()` 已返回、调用者被中止或 Harness 关闭时 reject；取消其 `context` 只停止等待。
- 钩子能看到嵌套调用的 `call.parent`，因此守卫可以区别对待来自脚本的调用。
- 调用者运行期间，其嵌套调用显示在 `docs["pi.live"].nestedTools` 中，带它们运行所用的参数，完成后还有一个 `summary`（错误、时长、用量），并作为带 `parentToolCallId` 和 `parentTaskId` 的工具事件。`progress: false` 让嵌套调用的运行输出不进入 `pi.live`。调用者 settle 之前，它留下的仍在运行的嵌套调用被中止，包括更早一次尝试发起的。调用者的结果消息不列出其嵌套调用；它们的任务记录保存它们。
- 每个嵌套调用有一个键，即它在调用者嵌套调用中的位置，除非调用者传入 `{ key }`。重放安全的调用者在崩溃后重跑并以相同顺序调用，或传入相同的键时，会拿回它已经发起的嵌套调用（已完成或仍在运行），而不是重新启动。崩溃在结果提交之前打断的嵌套调用遵循其自身的 `replay` 策略，因此有外部效果的重放安全工具仍需要自己的幂等性。非重放安全的调用者从不重跑，因此重启后其未完成的嵌套调用连同它们拥有的一切一起被放弃，之后才会再次运行。
- 嵌套调用的 `usage` 计在其自己的工具名下；在调用者的结果中转发它会重复计数。
- 嵌套结果不被保留：它们只存在于调用者的任务文档（`NestedCallDoc`，每个嵌套调用一个，按其键索引，保存 `{ taskId, result? }`）中，直到调用者 settle。嵌套调用的任务记录只保留一个小的回执。存储的结果正是 `executeTool()` 返回的内容，不含模型的 `output`，因此图片或 `bash` 尾部只存储一次。
- 没有任何东西限制调用嵌套的深度；默认 `callers` 的工具甚至可以调用自己。在重要的地方限制 `callers`（见下文）。

### 谁可以调用工具

工具上的 `callers` 说明谁可以调用它：模型、经 `executeTool()` 的其他工具，或两者（默认）。对话的 `modelTools` 收窄向模型提供哪些工具，但不把它们从工具那里拿走：

```typescript
const codemode = defineTool({ name: "codemode", callers: ["model"], ... }); // 脚本不能启动脚本
const search = defineTool({ name: "mcp__github__search", callers: ["tools"], ... }); // 绝不提供给模型

// 模型只被提供 codemode；其脚本调用 read、bash 和 MCP 工具。
await root.configure({ modelTools: [codemode] }, context);
// 模型被提供除 bash 之外的一切，脚本仍可调用 bash。
await root.configure({ modelTools: { remove: [bash] } }, context);
```

`conversation.agent()` 解析两个列表：提供给模型的 `tools`，以及嵌套调用在其中解析的 `callable`。`tools` 仍然决定什么被启用；`modelTools` 不能往里加。

`deferred: true` 的工具在被加载之前不提供给模型，但其他工具可以随时调用它。`@earendil-works/pi-durable/tool-search` 的 `tool_search` 工具（`createToolSearchExtension()`）让模型搜索延迟工具并用 `control.addTools` 加载匹配项，后者把它们记入 `modelTools`；已加载的工具在该分支上保持可用，压缩之后也是，且 `codemode` 段不包含延迟工具。把它用于大型工具集，例如 MCP 服务器的。

### 重启会放弃的任务

只在内存中被创建者 await、且创建者在重启后从不恢复的任务，可以用 `abandonOnRestart: true` 创建。当后来的 Harness 开始调度并发现它仍然存活时，它连同其拥有的一切一起被中止（`abortReason: "restart"`），在任何部分再次运行之前。非重放安全工具的嵌套调用自动获得这一行为，这类工具用 `api.createTask()` 创建的子任务也是。这样被放弃的任务如果定义缺失，会等到其扩展被安装，因此其 abort 处理器仍能清理。它的调用者和对话随它一起等待；`harness.inspect()` 显示它为 blocked。此时中止它会使其成为孤儿，与任何中止一样。

## Code Mode

`@earendil-works/pi-durable/codemode` 添加一个 `codemode` 工具：模型编写 JavaScript，以 `await tools.<name>(args)` 的形式调用对话的工具，运行在 QuickJS 沙箱（`@earendil-works/pi-codemode`）中。每次调用都是一次嵌套工具调用，只有脚本的输出到达模型。脚本跨重启存活：它从停止处恢复，不重复运行已完成的调用。

```typescript
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }) }));
```

该扩展还添加一个 `codemode` 提示段，在 token 预算内以 TypeScript 声明的形式列出脚本可调用的工具；脚本用 `searchTools()`、`describeTool()` 和 `describeNamespace()` 找到其余的。用 `namespaces: [{ name, description, prefix }]` 按名称前缀分组工具，例如 MCP 服务器的 `mcp__github__`。结果的阅读体验与 coding agent 的一致：一个头部、脚本的输出，失败时还有已完成的调用；超过 `max_output_tokens` 的文本被截断，完整文本放在临时文件中。脚本还能拿到 `models.*`：模型目录、`models.classify()` 和 `models.generateImages()`，它们作为内部工具的嵌套调用运行（`models: false` 关闭它们）。在 Cloudflare 上，改传一个 `RemoteCodemodeSandbox`。脚本运行时关闭沙箱（例如关机时）不是一种结果：脚本用下一个进程的沙箱恢复。失败的嵌套调用在脚本中以错误文本 reject，除非工具声明了 schema 并在错误的同时返回了自己的值：`tools.bash` 在非零退出时也 resolve 为 `{ output, exitCode, ... }`，所以脚本应检查 `exitCode`。`store(key, value)` 和 `load(key)` 按对话保存 JSON 值；分叉看到的是其入口时的值。

它如何跨重启存活：沙箱确定性地运行脚本（虚拟时钟、带种子的随机数、UTC），工具在把每个结果交给脚本之前先把它写入日志。重启后，工具再次运行脚本并按相同顺序交给它日志中的结果，因此它以相同参数发起相同调用；这些调用按键重新挂到其嵌套调用上，然后脚本继续。当脚本走了与之前不同的路径、沙箱指纹或 code mode 版本变了、或其 `timeout_ms` 在此期间已过时，重跑改为以错误结束该调用。重启时仍在运行的嵌套调用遵循其自身的重放策略。

## 系统提示

系统提示由选中扩展的段构建，在每次请求之前按顺序渲染。段能看到解析后的 agent、为该请求构建的环境以及已提交的文档：

```typescript
section("cwd", (input) => input.env?.cwd); // 渲染为 <cwd>\n...\n</cwd>；undefined 则省略
```

对话的 `instructions` 最后渲染，作为段 `instructions`。段和工具变更以带位置的系统条目存储在记录中。只重新发送变化的部分，这让提供商的提示缓存保持有效。每次返回不同内容的段（例如当前时间）会破坏这一点。

## 每对话 Agent

每个对话把它的运行配置存储在自己的 `pi.agent` 文档中。`configure()` 在一次提交中修改它；未设置的字段跟随宿主：

```typescript
await root.configure(
	{
		model: { provider: "openai", modelId: "gpt-6-sol" },
		thinkingLevel: "high",
		extensions: { remove: [Coding] }, // 编辑宿主默认值；数组则精确选中这些，按顺序
		tools: [readTool, bashTool], // 数组精确启用这些；{ remove: [...] } 去掉一些
		modelTools: [readTool], // 在其中，只向模型提供 read；工具仍可调用 bash
		instructions: "Only read; never edit files.",
		cwd: "/work/repo",
	},
	context,
);
await root.configure({ tools: null }, context); // null 把字段清回宿主默认值
const agent = await root.agent(context); // 已解析：模型、扩展、工具、段、cwd
```

扩展和工具以对象传入、按名称存储，因此存储的名称比其代码活得久：扩展被卸载后，选中它的对话只是不再得到它，直到它被再次安装。`createConversation()`、`fork()` 和 `root()` 接受与 `agent` 相同的变更形式。任务拥有的对话（例如子 agent 的）以拥有者对话 agent 的副本开始。分叉以其父级在分叉入口时的 agent 开始。请求的模型、提示和提供的工具在准备时固定；变更从下一次请求开始生效。工具调用和钩子按其任务阶段解析到的 agent 行动，环境在每次使用时按当前 `cwd` 构建，因此 `cwd` 或扩展变更可以到达模型已经发起的调用。

## 设置

每个对话共享的运行策略以 `settings` 传入。它在每次使用时读取，从不存储，因此 getter 可以让它保持实时，例如由设置文件支持：

```typescript
const harness = await Harness.open(storage, {
	models,
	registry,
	settings: {
		extensions: [CodingTools, Coding], // 默认选择；缺失时：每个已安装的扩展
		stream: { timeoutMs: 120_000 },
		retry: { maxRetries: 3 },
		compaction: { reserveTokens: 16384 },
		progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
		toolExecution: "parallel",
		contextRetentionMs: 600_000, // 空闲对话的上下文在内存中保留这么久（在无法 unref 定时器的地方惰性检查）
		documentRetentionMs: 600_000, // 已加载且无人观察的文档在其最后一次使用后保留这么久；被观察的总是保留
		get followUpMode() {
			return userSettings.followUpMode;
		},
	},
}, context);
```

## 环境

`env` 为每次工具调用、段渲染和 `runtime.env()` 构建执行环境。它收到对话的 ID、其 agent 的 `cwd` 和已提交的读取，因此一个函数就能实现每对话一个目录或每对话一个容器：

```typescript
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const harness = await Harness.open(storage, {
	models,
	registry,
	env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
}, context);
```

`env` 抛出异常会成为该调用的错误结果。没有环境时，内置工具以错误结果失败。每次调用一个全新的环境对象也没问题：`edit` 和 `write` 按环境的 `id` 和路径把对一个文件的修改串行化。自定义 `ExecutionEnv` 应设置 `id`，使相同 id 在相同路径下看到相同文件，例如每个容器一个 id。

宿主也可以直接使用环境，例如展示项目的文件。`openBinaryReader()` 读取一个已打开文件的字节区间，`openDirReader()` 分页读取目录，带 argv 数组的 `exec()` 不经 shell 直接运行程序，并报告每个输出块来自哪个流：

```typescript
const status = { stdout: "", stderr: "" };
await env.exec(["git", "status", "--porcelain=v2", "-z"], {
	onOutput: (text, _context, { stream }) => {
		status[stream] += text;
	},
}, context);
```

中止 context 停止一次调用；`cleanup()` 用于关闭环境。自定义环境可以用 `@earendil-works/pi-durable/testing` 的 `registerEnvConformance()` 自检，与下文的存储一样。

一些环境还实现可选的 `listFiles()`：一个目录下任意深度的文件和目录，像 `fd` 那样列出，跳过 git 忽略的内容，到达边界时以 `truncated` 停止。`NodeExecutionEnv` 不实现它；pi-env 的 `RemoteExecutionEnv` 和 `LocalExecutionEnv` 实现。方法缺失或以 `not_supported` 失败时，调用者回退到自己的遍历：

```typescript
const listing = await env.listFiles?.(".", { exclude: ["node_modules"], maxEntries: 50_000 }, context);
```

## 重载

安装一个与已安装名称相同的扩展会原地替换它，一步完成：

```typescript
registry.install(await loadCodingExtension()); // 同名 "coding"：替换已安装的那个
```

`registry.uninstall(extension)` 移除该名称的已安装扩展，无论它是哪个对象。

已经启动的工作保留它拿到的代码：一个运行中的工具调用在旧实现下完成，每个任务阶段在阶段开始时从 registry 一次性解析钩子和 agent。下一个阶段、请求或调用使用新代码。重启后，重新安装相同的扩展；扩展 `tasks` 的待处理任务在它安装后恢复。

## 观察对话

UI 需要的一切都是已提交的状态。`viewState()` 以只读 Chord 状态返回对话的结构化视图，每次触及它的提交之后更新：

```typescript
const view = await root.viewState(context);
view.subscribe((value) => {
	// value.entries：活跃的记录
	// value.docs["pi.live"]：运行中的生成（流式部分、重试、延迟）和工具调用（输出、details）
	// value.docs["pi.inbox"]、value.docs["pi.usage"]、value.docs["pi.agent"]、value.docs["pi.provider"]
	render(value);
});
// 之后：view.dispose();
```

`watch()` 送达同样的视图以及每次提交的精确 Chord 操作，一次一个回调：

```typescript
const watch = await root.watch(context);
render(watch.value); // 附加时的状态
watch.start(async (value, ops) => {
	await send(ops); // 例如发给一个应用它们的远程客户端
});
// 之后：await watch.stop();
```

慢的 watch 至多保留 100 个未送达的帧。超过后，待处理帧被一个携带完整最新视图的帧替换。晚加入或重连的客户端从当前视图开始；不重放任何东西。

部分答案和工具输出默认至多每 100 ms 提交一次，因此崩溃至多损失这个窗口。`settings.progress` 修改间隔；存储在远端的宿主可以降低提交频率，例如 `{ partialIntervalMs: 500, outputIntervalMs: 500 }`。

## 忙碌的对话

run 处理一次输入期间，对话处于忙碌状态。向忙碌的对话提交会把提交放入对话的收件箱，即视图中的 `docs["pi.inbox"]`：

```typescript
await root.submit({ type: "input", content: "Also run the tests" }, context); // follow-up（默认）
await root.submit({ type: "input", content: "Use pnpm, not npm", whenBusy: "steer" }, context);
await root.submit({ type: "input", content: "Only if idle", whenBusy: "reject" }, context); // 抛出 ConversationBusy
await root.submit({ type: "write", entry: { kind: "app.note", data: "user opened a file" } }, context);
```

- **Steer** 放在当前工具轮次之后，加入正在运行的工作。
- **Follow-up** 在 run 回答时放置，并开始下一次 run。
- **Write** 追加一个条目而不向模型请求任何东西。只有 `kind` 和 `data` 的 write 不改变模型看到的任何东西，因此立即追加，即使在 run 中途，也绝不排队：聊天消息在发送后立即出现在记录中。因此它可能出现在更早提交、仍在排队的条目之前，除非排在排队的重置之后——那种情况下它会等待，以免重置把它藏掉。带 `model`、`head` 或 `edits` 的 write 像 steer 一样等待下一个边界。
- `await submission.abort(context)` 撤回一个排队的提交。
- [设置](#设置)中的 `steeringMode: "all"` 和 `followUpMode: "all"` 一次放置所有排队条目，而不是每轮一个。

run 失败时，排队条目留在收件箱中，直到下一次输入或排队的 write 放置它们，最老的先放。

输入以 `pi.user` 条目放置。要以其他形式展示它，给它一个带你的 kind 和 data 的 `entry`；模型仍把 `content` 看作用户消息：

```typescript
await root.submit(
	{
		type: "input",
		content: "ann: can you check the build?",
		entry: { kind: "chat.mention", data: { author: "ann", text: "can you check the build?" } },
	},
	context,
);
// 放置为 { kind: "chat.mention", data: { author: "ann", ... }, model: [{ role: "user", content: "ann: can you check the build?" }] }
```

它的行为与其他输入一样：开始 run、steer、follow-up 或拒绝，并被回答。排队期间，其收件箱项携带该条目。kind 不得以 `pi.` 开头。

## 重置与交接

`reset()` 开始一个新上下文。模型不再看到更早的条目，但它们保留在存储中：

```typescript
await root.reset(undefined, context);                                  // 从零开始
await root.reset("We were fixing the flaky login test. Continue.", context); // 从一条交接说明开始
```

忙碌时，重置像 write 一样排队。当它在工具轮次中被放置时，当前 run 结束。工具可以用 `control: { handoff: "..." }` 请求同样的事。

## 压缩

压缩缩小模型看到的内容：它总结更早的条目并追加一个 `pi.compaction` 条目，后者保存摘要并指向它保留的第一个条目。更早的条目保留在存储中。

```typescript
const id = await root.compact("Keep the failing test names", context); // 手动，带可选指令
const { outcome } = (await harness.waitForTask(id, context)).state;
if (outcome.status === "completed" && outcome.result.submissionId !== undefined) {
	const placed = await (await harness.submission(outcome.result.submissionId, context))!.wait(context);
	console.log(placed.status); // "done"，或带原因 "stale" 的 "unanswered"
}
```

摘要生成期间对话继续工作。对话空闲时摘要立即放置，否则在下一个轮次边界。Esc（`abort()`）取消手动压缩。

生成也会自行压缩，由[设置](#设置)控制：

```typescript
settings: {
	compaction: {
		enabled: true, // 自动压缩；手动 compact() 总是可用
		reserveTokens: 16384, // 超过 contextWindow - reserveTokens 时，下一次请求等待压缩
		keepRecentTokens: 20000, // 大致多少近期上下文逐字保留
		backgroundTokens: 32768 // 低于这个值这么多时，后台开始一次压缩；0 禁用
		modelOverrides: {
			// 精确的 "provider/modelId"；这里设置的每个字段替换该模型的上面对应字段
			"local/small-32k": { reserveTokens: 4096, keepRecentTokens: 8000, backgroundTokens: 4096 },
		},
	},
}
```

固定的 token 数很少能同时适合 32k 和 1M 的上下文窗口；`modelOverrides` 让一个 harness 同时服务两者。对话的当前模型决定使用哪个条目，在阈值检查时、上下文溢出后、以及压缩选择总结内容时。

当提供商因上下文过长拒绝请求时，生成压缩并重试一次。在放置时会切到当前上下文起点之前的摘要以 `stale` settle，因此多个在途时，切得最远的那个保持生效。总结的开销计入 `pi.usage`。`CompactionTask` 上的 `beforeCompact` 钩子可以拒绝或提供自己的摘要。

当生成在阻塞阈值处等待的压缩失败时，生成也失败，且不发送请求：其输入以 `model_error` settle 为 `unanswered`，细节为 `Compaction failed: <error>`。发现无可压缩或被拒绝的压缩让请求继续。

运行中的压缩列在 `docs["pi.live"].compactions` 中，带原因、尝试次数和重试退避。最新一次失败保留在 `docs["pi.live"].compactionFailure`（任务、原因、错误）中，直到某次压缩产出摘要。agent 事件增加 `compaction_start` 和 `compaction_end`（压缩失败时带 `error`），快照中增加 `compactions` 和 `compactionFailure` 字段。

## Agent 事件（实验性）

对于想要 coding-agent 风格事件（`message_start`、`message_update`、`tool_execution_start` 等）而非结构化状态的消费者：

```typescript
import { watchEvents } from "@earendil-works/pi-durable";

const stream = await watchEvents(harness, root.id, context);
initialize(stream.snapshot); // 条目、run、在途生成、工具、压缩、收件箱、agent、用量
stream.start(async (events) => {
	for (const event of events) console.log(JSON.stringify(event));
});
```

事件从提交派生，每次提交一批，并应用在快照之上。消息和工具更新携带 delta：文本和思考的追加、工具调用参数文本的追加、输出的裁剪和追加。当消费者落后超过 100 批时，它收到一个全新的 `snapshot` 事件代替。完整的一次运行的流见 `test/examples/19-json.ts`。

## 钩子

钩子让扩展在选中它们的对话中观察或调整内置任务：

```typescript
import { GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";

const Guard = defineExtension({
	name: "guard",
	hooks: [
		hook(ToolTask, { beforeTool: (call) => (call.name === "bash" ? { block: "bash is disabled here" } : undefined) }),
		hook(GenerationTask, { onYield: (answer) => (needsMoreWork(answer) ? { continue: "Keep going." } : undefined) }),
	],
});
```

- **生成：** `beforeRequest`（替换一次请求的消息）、`afterResponse`、`onYield`（用另一条用户消息继续 run）和 `afterTools`（一轮的工具完成后运行）。
- **工具：** `beforeTool`（阻止或改写参数）和 `afterTool`（替换结果）。

要把钩子限制到某些对话，只在那些对话中选中其扩展，例如 `configure({ extensions: { add: [Guard] } })`。

## 更多对话与分叉

```typescript
const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
const fork = await root.fork(entryId, { ownership: { kind: "ownerless" } }, context);
```

分叉看到其父级截至 `entryId` 的条目，然后独立继续。它保留父级截至该条目的 agent，但获得新的提供商会话身份。两者都接受 `agent` 和 `init`，在创建它们的提交中应用。

## 中止与子 agent

`await root.abort(context)` 停止一个对话：排队的输入被撤回（排队的 write 保留），其当前工作的每个任务被中止，调用在对话空闲后 resolve。

对话可以被任务**拥有**。子 agent 工具在 `api.commit()` 内创建其子对话，带 `ownership: { kind: "task", taskId: api.taskId }`，然后通过 `api.conversation(id)` 驱动它：

```typescript
const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description: "Delegate a self-contained task to a subagent and get its answer back.",
			parameters: Type.Object({ task: Type.String() }),
			replay: "safe", // 崩溃后的重跑找到同一个子对话和提交
			execute: async (args, api, context) => {
				const child = await api.commit(async (tx) => {
					// 所有权索引记住这个子对话，因此重跑会复用它。
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// 以本对话 agent 的副本开始：模型、扩展、工具、cwd。
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// 一个更便宜的模型，且没有自己的子 agent。
					await configure(tx, created.id, { model: haiku, extensions: { remove: [Subagent] } });
					return created.id;
				}, context);
				await api.details({ conversationId: child }, context); // 让 UI 可以附加到子对话
				const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
				const settled = await (await (await api.conversation(child, context))!.submit(request, context)).wait(context);
				return { output: [{ type: "text", text: settled.status }] };
			},
		}),
	],
});
```

被拥有的工作属于其拥有者：

- 中止调用会中止子对话。调用失败也一样：`execute()` 抛出，或打断非重放安全调用的崩溃。
- 父级只在子对话空闲后才是空闲的。
- 以 `{ background: true }` 创建的任务是一个边界：它拥有的工作在父级中止后存活，也不让父级保持忙碌。`root.abort(context, { background: true })` 连它一起中止。

示例以产品代码的形式展示了两种模式：

- [`22-subagent-foreground.ts`](test/examples/22-subagent-foreground.ts)：上面的工具，返回子对话的答案。UI 通过调用的 `details` 找到子对话，并把子对话的事件缩进打印在调用之下。
- [`23-subagent-background.ts`](test/examples/23-subagent-background.ts)：一个 `subagent` 工具背后的持久化子 agent，可生成、发消息（steer 或 follow-up）、等待、停止和列出。每个子对话由一个后台锚点任务拥有，因此父级的 Esc 和空闲等待永远到不了它。每条消息由一个后台报告任务投递，答案到达后作为 follow-up 输入发回父级；请求 ID 防止重启后重复发送消息或报告。

## 子任务

任务可以拥有子任务，用 `ownership: { kind: "task", taskId }` 创建，并通过提交一个 `waiting` 状态等待它们：

```typescript
pay: async (task, runtime, context) => {
	await runtime.commit(async (tx) => {
		const payments = [];
		for (const card of task.input.cards) {
			payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
		}
		// 每笔支付完成后在 `decide` 恢复；第一次失败会中止其余的。
		return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "failFast" };
	}, context);
},
decide: async (task, runtime, context) => {
	const outcomes = await runtime.outcomes(task.state.checkpoint.payments, context);
	// ……提交结账自身的结果
},
```

- **等待：** 任务等待期间不运行任何代码。`allSettled` 下，`on` 中的每个任务都完成后恢复；`failFast` 下，第一个失败的子任务也中止其他。`on` 也可以命名其他任务，配合 `allSettled`。
- **完成：** 拥有的工作仍在运行时完成的任务处于 `completing`：其结果已决定，但它变为终态、`waitForTask()` 返回，要等到那份工作完成。失败或中止的结果先中止那份工作。
- **中止：** 中止自底向上运行。中止一个任务先中止它拥有的工作，其自身的 abort 处理器在那份工作完成后才启动，因此每个任务撤销自己的效果。

[`24-child-tasks.ts`](test/examples/24-child-tasks.ts) 运行一个带四笔支付的结账：一张被拒的卡、一个被取消的结账，以及支付运行中的一次重启。

## 任务图

`harness.taskGraph(context)` 把 Session 的每个存活任务显示为一个 Chord 状态，用于任务面板或调试。每个节点有它的拥有者边（`owner` 任务，对话拥有的任务则为空）、其状态、是否 `background` 或被标记中止，以及它拥有的对话。`harness.watchTaskGraph(context)` 以 watch 的形式送达同样的值，就像对话的 `watch()`。

```typescript
const graph = await harness.taskGraph(context);
graph.subscribe((value) => {
	for (const node of Object.values(value.tasks)) {
		const status = node.state.status === "waiting" ? `waiting on ${node.state.on.join(", ")}` : node.state.status;
		console.log(`${node.id} ${node.kind} ${status}`, node.owner ?? `conversation ${node.conversationId}`);
	}
});
```

任务随创建它的提交出现，随使其终态的提交消失。状态是已提交的：`pending`、`running`、`waiting`（带 `on` 和 `policy`）和 `completing`（带被持有结果的 status）。重启后，曾是 `running` 的任务显示为 `pending`，直到再次运行。待处理任务是否因定义缺失而阻塞不属于图的一部分；`harness.inspect()` 报告它。图只列出存活任务：一旦子 agent 的拥有者任务终态，其对话中后来的任务就是顶层节点，对话的 `ConversationRecord.owner`（也在其视图的 `conversation` 中）把它链接到父级。[`24-child-tasks.ts`](test/examples/24-child-tasks.ts) 在支付运行时打印结账的树。

## 你自己的状态

文档是与条目一起提交的类型化 JSON 对象。定义一个，并在提交中编辑它：

```typescript
import { defineDoc } from "@earendil-works/pi-durable";

const Todos = defineDoc<{ items: string[] }>({
	kind: "app.todos",
	version: 1,
	scope: "conversation",
	history: "latest", // 或 "rewindable"，用 snapshotAsOf() 读旧值
	fork: "initial", // 分叉以什么开始："initial"、"current" 或 "asOf"
	initial: () => ({ items: [] }),
});

await root.commit(async (tx) => {
	(await tx.doc(Todos, root.id)).items.push("write docs");
}, context);
console.log(await harness.snapshot(Todos, root.id, context));
```

`harness.watchDoc()` 和 `harness.documentState()` 像上面的视图一样观察单个文档。`HarnessOptions.conversationCreated(tx, conversation)` 在每个创建或分叉对话的提交中运行，包括工具的裸 `tx.createConversation()`，因此每个对话都得到你的文档；`createConversation()`、`fork()` 和 `root()` 中的 `init` 在同一次提交中写入每次调用的数据。扩展的工具、段和钩子通过 `api` 或 `input.read` 读取自己的文档，并把缺失的文档当作其默认值（[`11-extension-state.ts`](test/examples/11-extension-state.ts)）。

## 用量与成本

每个对话在 `docs["pi.usage"]` 中保存 token 和成本合计：模型响应按 `provider/model`，报告用量的工具结果按工具名。失败和中止的尝试也计入。对整个 Session：

```typescript
const usage = await harness.usage(context); // { models: { "openai/gpt-6-sol": Usage }, tools: {...} }
```

## 存储

| 后端 | 导入 | 说明 |
|---|---|---|
| 内存 | 包根的 `MemoryStorage` | 不持久化任何东西。 |
| SQLite | `@earendil-works/pi-durable/storage/sqlite/node` 的 `openNodeSqliteStorage(file)` | 一个数据库文件。WAL 模式，`synchronous = NORMAL`：提交在进程崩溃后存活；断电或宿主故障可能丢失最新的。 |
| JSONL | `@earendil-works/pi-durable/storage/jsonl/node` 的 `openNodeJsonlStorage(directory, context)` | 一个目录内的追加式文件。传 `{ fsync: true }` 在每个提交标记之前冲刷。它也把整个历史保存在内存中，因此内存随之增长；长期运行的 agent 请用 SQLite。 |
| Cloudflare Durable Object | `@earendil-works/pi-durable/storage/sqlite/cloudflare` 的 `openDurableObjectSqliteStorage(ctx.storage)` | 一个 SQLite 支持的 Durable Object 的 SQLite 存储；提交即其存储事务。 |

SQLite 存储在共享数据库时可以为表和索引起命名空间：向 `SqliteStorage.open(database, options)`、`openNodeSqliteStorage(path, options)` 或 `openDurableObjectSqliteStorage(ctx.storage, options)` 传 `{ prefix: "pi_" }`。存储把带前缀的名称渲染进其 SQL，因此适配器不需要支持。前缀必须是 SQLite 标识符且不能以 `sqlite_` 开头；宿主可以保留更多，例如 Durable Objects 的 `_cf_`。更改前缀不会迁移已有数据。

通过 Cloudflare 适配器、用同一存储对象打开的多个 Pi 存储自动共享一个操作队列。要与宿主表共享数据库，创建一个适配器并同时用于 Pi 和所有宿主查询；直接的存储调用绕过队列，可能随 Pi 事务一起被回滚：

```typescript
const database = new DurableObjectSqliteDatabase(ctx.storage);
const piStorage = await SqliteStorage.open(database, { prefix: "pi_" });
await database.exec("CREATE TABLE IF NOT EXISTS host_notes (text TEXT)");
await database.run("INSERT INTO host_notes (text) VALUES (?)", text);
```

一个存储同一时间由一个进程拥有；没有跨进程锁。可移植的 SQLite 和 JSONL 核心（`/storage/sqlite`、`/storage/jsonl`）不需要 Node API 即可运行，例如在 Bun 或 Cloudflare Durable Objects 上，只要提供一个异步的 `SqliteDatabase` 门面或 `@earendil-works/pi-durable/env` 的 `FileSystem`。

SQLite 适配器实现基于 promise 的 `exec`、`run`、`get`、`all`、`transaction` 和 `close`。`run`、`get` 和 `all` 接受 SQL 文本加位置绑定；适配器可以按 SQL 文本缓存预编译语句。事务回调收到一个事务句柄；事务中的所有工作必须使用它，句柄在回调 settle 后过期。适配器必须把不相关的操作和其他事务排队到该事务结束，因此在回调内部调用 `database` 本身永远不会 settle：

```typescript
await database.transaction(async (transaction) => {
	await transaction.exec("CREATE TABLE example (value TEXT)");
	await transaction.run("INSERT INTO example (value) VALUES (?)", "stored atomically");
});
```

自定义后端可以用任何 Vitest 或 Jest 兼容的运行器运行共享的一致性测试套件：

```typescript
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";

registerStorageConformance({ describe, expect, it }, "My Storage", async (use) => {
	const storage = await openMyStorage();
	try {
		await use(storage);
	} finally {
		await closeMyStorage(storage);
	}
});
```

包根会加载 TypeBox，因为工具任务用 pi-ai 的 `validateToolArguments()` 校验参数。未打包时约 23 MB 峰值 RSS，摇树后的 bundle 约 4 MB。

## 错误

三条规则决定一个错误的后果：

1. **存储错误终结 Harness。** 触发它的调用以该错误 reject。它之后的一切、以及每个待处理的等待，都以 `SessionFailed` reject（其 `cause` 是该错误）；watch 和事件流以 `session_failed` 结束；运行中的任务收到其中止信号；`onReport` 收到一次该错误。Harness 随后自行关闭。没有任何重试；自定义存储自行重试其瞬时失败。重新打开即可恢复：提交是原子的，存储是一致的，用相同 `requestId` 重新提交会找到已被接纳的 submission。
2. **无效读取只失败该次调用：** 存储读取对坏游标、未知对话或文档不保留的历史抛出 `StorageRequestError`。你取消的读取也只失败它自己。该豁免只覆盖读取：`commit()` 或 `mintId()` 的任何错误（包括 `StorageRequestError`）按规则 1 终结 Harness。
3. **你的代码只失败自己的单元：** 抛出异常的任务阶段使该任务故障，抛出异常的工具得到错误结果，抛出异常的钩子被报告并跳过（`beforeTool` 阻止该调用），抛出异常的提交回调回滚该提交。抛出异常或返回被拒绝 promise 的监听器被报告，其他监听器仍运行。例外是 `snapshot()` 抛出异常的宿主 `RegistryReader`：没有它 Harness 无法调度，因此它像存储错误一样终结 Harness。

`harness.closed` 在 Harness 关闭后 settle，无论是 `close()` 还是存储错误之后，宿主可以这样在失败时重启：

```typescript
harness.closed.then((end) => {
	if (end.reason === "failed") reopen(end.error);
});
```

失败会自行关闭 Harness；该关闭完成后 `closed` 就 settle，即使存储无法干净地关闭。关闭会等待运行中的任务代码返回，因此忽略其中止信号的代码会延迟 `closed`。

## 示例

可运行的示例在 [`test/examples`](test/examples)。在该包目录下运行：

```bash
node --conditions=source --experimental-strip-types test/examples/14-chat.ts
```

| 示例 | 展示 |
|---|---|
| [14-chat](test/examples/14-chat.ts) | 一问一答 |
| [16-real-model](test/examples/16-real-model.ts) | 从 OpenAI 流式获取答案 |
| [17-coding-tools](test/examples/17-coding-tools.ts) | JSONL 存储上使用工具的一轮 |
| [18-print](test/examples/18-print.ts) | 打印模式：提交提示，打印答案 |
| [19-json](test/examples/19-json.ts) | JSON 模式：agent 事件或原始视图操作，在 SQLite、JSONL 或内存上 |
| [20-inbox](test/examples/20-inbox.ts) | 忙碌时的 steer、follow-up、write 和撤回 |
| [21-late-join](test/examples/21-late-join.ts) | 在 run 中途附加视图和事件流 |
| [22-subagent-foreground](test/examples/22-subagent-foreground.ts) | 重放安全的子 agent 工具，调用拥有其子对话，子对话事件显示在调用之下 |
| [23-subagent-background](test/examples/23-subagent-background.ts) | 持久化子 agent：生成、steer、停止、列出，答案回传，重启安全 |
| [24-child-tasks](test/examples/24-child-tasks.ts) | 拥有并等待四笔支付的结账：failFast、中止、重启 |
| [25-compaction](test/examples/25-compaction.ts) | 长对话的压缩：后台、手动、上下文溢出后 |
| [26-coding-agent](test/examples/26-coding-agent.ts) | CodingTools、来自设置对象的实时设置、跟随对话目录的环境 |
| [27-plan-mode](test/examples/27-plan-mode.ts) | 作为带自己文档的扩展的只读计划模式，用 `configure()` 切换 |
| [28-reviewer](test/examples/28-reviewer.ts) | 带自己的模型、扩展、工具、目录和评审循环的评审对话 |
| [29-sandbox-per-conversation](test/examples/29-sandbox-per-conversation.ts) | 每对话一个环境，从应用文档中查找 |
| [30-tool-override](test/examples/30-tool-override.ts) | 某些对话的同名 bash，以及为胜出的 bash 计时的包装器 |
| [31-reload-and-restart](test/examples/31-reload-and-restart.ts) | 调用中途重载扩展，以及跨重启存活的存储选择 |
| [00](test/examples/00-conversation.ts)–[13](test/examples/13-recovery.ts) | 底下的各层：session、文档、分叉、watch、Harness、agent 配置、重载、扩展状态、任务、恢复 |

调用 OpenAI 的示例需要 `OPENAI_API_KEY`；大多数示例否则使用 faux 提供商。

## 设计文档

- [`docs/spec.md`](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)：规范性规格

基准测试：`npm run bench:storage`、`npm run bench:storage:memory`、`npm run bench:tool-output` 和 `npm run bench:nested-tools`。

## 许可证

MIT
