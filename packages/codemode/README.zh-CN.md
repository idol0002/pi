# @earendil-works/pi-codemode

在一个 QuickJS 虚拟机（编译为 WebAssembly）中运行模型编写的 JavaScript，其中唯一的能力就是调用注入的工具。嵌套的工具调用不会进入 LLM 上下文；只有脚本的输出和返回值会进入。

脚本可以使用 `tools`、`ALL_TOOLS`、`text`、`image`、`exit`、`store` 和 `load`，并且可以以一行 `// @options:` 开头。coding agent 用它实现内置的 `codemode` 工具。该包没有对 pi 的依赖，也可以独立使用，把任何函数（远程 API、MCP 服务器、应用服务）暴露给模型编写的脚本。

该包运行在两类环境中。每一类都有自己的沙箱类，但它们共享同一套 API、同一个脚本环境和同一种结果格式：

| 环境 | 沙箱 | 导入来源 | 脚本运行位置 |
| --- | --- | --- | --- |
| Node 和 Bun | `CodemodeSandbox` | `@earendil-works/pi-codemode` | 每次执行一个 worker 线程 |
| Cloudflare Workers 和 Durable Objects | `RemoteCodemodeSandbox` | `@earendil-works/pi-codemode/portable` | 单独部署的 Worker 中的一个 Durable Object |

参见[在 Node 和 Bun 上使用](#在-node-和-bun-上使用)和[在 Cloudflare Workers 上使用](#在-cloudflare-workers-上使用)。第三种沙箱 `InlineCodemodeSandbox` 在调用者线程上运行脚本，适用于其他运行时，或者在 Cloudflare 上可以接受阻塞调用者时使用。

## 在 Node 和 Bun 上使用

```ts
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

const sandbox = new CodemodeSandbox({
	timeoutMs: 60_000,
	tools: [
		{
			name: "read",
			execute: async (args, { signal }) => {
				const { path } = args as { path: string };
				return await readFile(path, "utf8");
			},
		},
	],
});

const result = await sandbox.execute(`
	const source = await tools.read({ path: "package.json" });
	text("bytes " + source.length);
	return JSON.parse(source).name;
`);

console.log(result.output); // [{ type: "text", text: "bytes 1234" }]
if (result.ok) console.log(result.value); // "@earendil-works/pi-codemode"
else console.error(result.error.kind, result.error.message);

await sandbox.close();
```

`code` 是一个异步函数的函数体：`return` 和顶层 `await` 都可用。在任何沙箱中，脚本内部都可以使用：

- `tools.<name>(args)` 返回一个 promise。参数和结果经过一次 JSON 往返。抛出异常的工具会以携带相同消息的 `Error` reject。工具名同时也以标识符形式暴露：标识符中不合法的字符会变成 `_`（`toCodemodeIdentifier`），因此 `my-tool` 既可以通过 `tools.my_tool` 访问，也可以通过 `tools["my-tool"]` 访问。
- `ALL_TOOLS` 列出每个工具的 `{ name, description }`，其中 `name` 是标识符形式。
- `text(value)` 向 `result.output` 追加一个文本项；非字符串的值会被 JSON 序列化。`console.log/info/warn/error/debug` 会追加带 `console: true` 的文本项。
- `image(urlOrItem)` 追加一个图片项。它接受 base64 的 `data:` URL、`{ image_url }`，或图片块（`{ type: "image", data, mimeType }`，即 MCP 工具和 `@earendil-works/pi-ai` 产生的格式）。远程 URL 会被拒绝。
- `exit()` 立即成功结束脚本，保留其输出和 store 写入。
- 传给沙箱的 `globals` 会作为顶层函数被调用，例如宿主提供的辅助函数 `image(ref)`。它们的行为类似工具，但不会记录在 `result.calls` 中。形如 `models.classify` 的名字会把函数挂到一个冻结的 `models` 对象上。设置 `spread: true` 后，`execute` 接收所有调用参数组成的数组而不是第一个参数；`signature` 会替换根据 schema 生成的声明。
- `store(key, value)` 和 `load(key)` 同步读写 JSON 值。参见 [Store](#store)。
- 其他一概没有：没有定时器、`fetch`、`process`、`require`、模块或 `WebAssembly`。`eval` 和 `Function` 可用，但只能在同一个 VM 内生成更多代码。

`timeoutMs: Infinity` 禁用截止时间；脚本会一直运行直到结束或被 `signal` 中止。如果一个脚本在等待一个永远无法 settle 的 promise（没有待处理的工具调用，且 VM 没有定时器或 I/O），它会立即失败而不是挂起。

`memoryLimitBytes` 限制 VM 的堆大小。超出限制的分配会在脚本内部以 `InternalError: out of memory` 失败。

中止、超时和 `close()` 会请求终止 worker，但不等待 worker 退出。在 Bun 上，一个长时间运行的内置方法（如 `String.prototype.indexOf`）可能不会轮询 QuickJS 的中断处理器，因此其 worker 可能持续计算直到该内置方法返回。停止时会在请求终止后对 worker 执行 unref，因为 `terminate()` 内部会 ref 它。这并不保证计算已经停止。在 Bun 1.4.0 上，一个未完成的 `terminate()` 即使有 `unref()` 仍可能延迟宿主进程退出；取消结果和 `close()` 不会等待它。

需要限制并发度的宿主可以用 `onWorkerStarted(exited)` 跟踪 worker 的实际生命周期，`execute()` 或 `start()` 启动的每个 worker 都会触发它。它的 promise 在该 worker 退出时 resolve，而不是在脚本结果 settle 时：

```ts
const workers = new Set<Promise<void>>();
const sandbox = new CodemodeSandbox({
	onWorkerStarted(exited) {
		workers.add(exited);
		void exited.then(() => workers.delete(exited));
	},
});
```

在 `exited` resolve 之前保持占用一个并发槽位。`close()` 不会等待这些 promise。

要强制执行准入限制，可以传入 `acquireWorker()`。它在 WASM 加载之后、每个 worker 创建之前同步运行。抛出异常可以在不启动 worker 的情况下拒绝该次执行；否则返回一个释放回调。沙箱会在 worker 真正退出时或 worker 构造失败时调用一次该回调。在多个沙箱实例之间共享预留状态，并且不要在脚本结果 settle 时释放它。

## Store

`store`/`load` 让脚本可以跨执行保留值。沙箱自身不持久化任何东西：把当前值作为 `options.store` 传入，成功的结果会通过 `result.storeWrites`（`{ set, delete }`）报告脚本改动了什么。失败的执行不报告任何写入。

```ts
const result = await sandbox.execute(`store("runs", (load("runs") ?? 0) + 1)`, { store: saved });
if (result.ok) {
	for (const key of result.storeWrites.delete) delete saved[key];
	Object.assign(saved, result.storeWrites.set);
}
```

`load` 返回一个副本，修改它不会改变 store。存储 `undefined` 会删除该键。单个值最多 `MAX_STORE_VALUE_CHARS`（256 Ki）个 JSON 字符，所有值合计最多 `MAX_STORE_TOTAL_CHARS`（1 Mi）；超出的写入会在脚本内部抛出 `RangeError`。

## 源码格式

`parseCodemodeSource()` 接受首行可以是选项行的脚本：

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
const source = await tools.read({ path: "package.json" });
text(JSON.parse(source).name);
```

支持的字段有 `max_output_tokens`（输出的 token 预算）和 `timeout_ms`（硬性截止时间）。沙箱不会对它们采取行动，由调用者决定。选项行会被替换为空行，因此堆栈跟踪中的行号仍与输入一致。空输入、无效 JSON、未知字段、只有选项行没有代码、或选项行不在第一行，都会抛出 `CodemodeSourceError`。`CODEMODE_SOURCE_GRAMMAR` 是一个 Lark 文法，供支持文法约束工具输入的提供商使用。两者也可以从轻量的 `@earendil-works/pi-codemode/source` 入口获取。

## 打包后的 Node 和 Bun 宿主

默认情况下，`CodemodeSandbox` 从安装的包中加载 `quickjs-wasi/quickjs.wasm`，并启动与本包模块相邻的 worker 文件。宿主被打包后这两者都不在磁盘上，因此需要同时传入两者：

```ts
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";

const sandbox = new CodemodeSandbox({
	tools,
	// 按路径编译一次并缓存。
	wasm: loadQuickJSWasm(pathToQuickJSWasm),
	// 你的构建产物中一个包含 `import "@earendil-works/pi-codemode/worker";` 的文件。
	workerUrl: new URL("./codemode-worker.js", import.meta.url),
});
```

`workerUrl` 接受 URL 或字符串。对于 Bun 编译的可执行文件，把 worker 作为额外的构建入口包含进来，并以字符串形式传入其相对源码路径，例如 `"./src/codemode-worker.ts"`；Bun 会从其内嵌模块图中解析这种形式。

## 在 Cloudflare Workers 上使用

`CodemodeSandbox` 需要 Node 或 Bun。它在 worker 线程中运行每个脚本，并从磁盘读取 QuickJS 二进制。Cloudflare Workers 两者皆无，而且无法在运行时编译 WebAssembly。另外两个沙箱具有相同的 API、相同的脚本环境和相同的 `CodemodeResult`，区别只在于 VM 运行的位置：

| 沙箱 | VM 运行位置 | 适用场景 |
| --- | --- | --- |
| `CodemodeSandbox` | 一个 worker 线程 | Node 和 Bun |
| `RemoteCodemodeSandbox` | 另一个 isolate，通常是独立 Worker 中的 Durable Object | 运行 agent 会话的 Durable Object |
| `InlineCodemodeSandbox` | 调用者线程 | 其他任何有 WebAssembly、且可接受阻塞调用者的地方 |

后两者从 `@earendil-works/pi-codemode/portable` 导入，它没有 Node 导入。在 Cloudflare 上，`@earendil-works/pi-codemode/cloudflare` 额外提供可部署的 Durable Object 和由 Wrangler 编译的 QuickJS 模块。

### 为什么要单独的 Worker

QuickJS 是同步运行的，因此一个正在计算的脚本会一直占用其线程，直到它 await 一个工具。在 Cloudflare 上实测（2026 年 10 月），一个计算十秒的脚本在两种部署方式下会让会话对象的其他所有请求都延迟整整十秒：

- 放在会话的 Durable Object 内
- 放在该对象加载的 Dynamic Worker 中

而在单独部署的 Worker 的 Durable Object 中，延迟约为 50 ms。因此 `RemoteCodemodeSandbox` 把工具和调用记录留在会话中，只把 VM 发送到沙箱 Worker。每次工具调用都通过 Workers RPC 返回会话。

### 部署沙箱 Worker

完整配置见 [`examples/cloudflare`](https://github.com/earendil-works/pi/tree/main/packages/codemode/examples/cloudflare)。沙箱 Worker 只有一个文件：

```ts
// sandbox/src/index.ts
export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

export default {
	fetch: () => new Response("Not found", { status: 404 }),
};
```

```jsonc
// sandbox/wrangler.jsonc
{
	"name": "pi-codemode-sandbox",
	"main": "src/index.ts",
	"compatibility_date": "2026-04-22",
	"workers_dev": false,
	"preview_urls": false,
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CodemodeSandbox"] }],
	"limits": { "cpu_ms": 60000 }
}
```

在沙箱 Worker 的项目中安装 `@earendil-works/pi-codemode`，然后运行 `npx wrangler deploy`。Wrangler 会把 QuickJS（约 640 KB）打包为已编译的 WebAssembly 模块。该对象没有路由、不保留状态，也从不使用其存储。

### 从 agent 的 Worker 中使用

用 `script_name` 绑定该类。绑定从 agent 自己的 Worker 导出的类会重新引入上述阻塞问题。

```jsonc
// agent/wrangler.jsonc
"durable_objects": {
	"bindings": [
		{ "name": "CODEMODE_SANDBOX", "class_name": "CodemodeSandbox", "script_name": "pi-codemode-sandbox" }
	]
}
```

然后替换沙箱。工具、除 worker 专属的 `wasm`、`workerUrl`、`acquireWorker` 和 `onWorkerStarted` 之外的选项、以及结果都保持不变：

```ts
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";

interface Env {
	CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
}

// 之前：new CodemodeSandbox({ tools, timeoutMs: 60_000 })
const sandbox = new RemoteCodemodeSandbox({
	tools,
	timeoutMs: 60_000,
	remote: () => env.CODEMODE_SANDBOX.getByName(sessionId),
});
const result = await sandbox.execute(code, { signal, store });
```

在 agent 的 Worker 中从 `/portable` 导入沙箱。导入 `/cloudflare` 会把 QuickJS 也打包进去。`remote` 在每次执行时调用一次，负责选择运行该次执行的 Durable Object。

- **每个会话一个对象**，`getByName(sessionId)`，让一个会话的脚本共用同一个对象。同一会话的两个脚本在一个线程上轮流执行。
- **每次执行一个对象**，`getByName(crypto.randomUUID())`，让每个脚本独占一个对象。

用 `wrangler dev -c agent/wrangler.jsonc -c sandbox/wrangler.jsonc` 在本地同时运行两个 Worker。

### Cloudflare 上的限制

- **中断预算。** 脚本在不调用工具的情况下计算时，任何定时器都无法运行，`Date.now()` 也不会前进。一个从不让出（yield）的脚本只受中断预算限制，不受 `timeoutMs` 限制。QuickJS 在运行时会轮询一个中断处理器，沙箱会统计轮询次数。超出预算后，执行以 `kind: "timeout"` 失败。
   - 默认的 `DEFAULT_INTERRUPT_BUDGET` 为 100,000 次轮询，在 Apple M 系列笔记本上约等于 2 秒的紧密循环，在 Cloudflare 上约等于 10 秒。
   - 把预算保持在 Worker 的 `cpu_ms` 限制（默认 30 秒）以下。触达该限制会重置整个对象，而不是让一个脚本失败。
- **内存。** 每个 VM 默认最多使用 32 MiB。同一个 isolate 中的所有 VM 共享其 128 MB。
- **修改限制。** Durable Object 会按自己的限制封顶每个请求，无论客户端请求多少。要修改限制，在沙箱 Worker 中子类化它：

```ts
import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";

export class CodemodeSandbox extends CodemodeSandboxDurableObject {
	protected maxInterruptBudget = 200_000;
	protected maxMemoryLimitBytes = 64 * 1024 * 1024;
}
```

- **中止与超时。** `timeoutMs` 和 `signal` 会让调用者一侧立即结束执行，返回 `kind: "timeout"` 或 `kind: "aborted"`。远程 VM 会在下一次工具调用时停止。此刻正在计算的远程 VM 会继续运行，直到它调用一个工具或用完预算。
- **计费。** 每次执行是一个 Durable Object 请求。执行运行期间，沙箱对象按墙钟时长计费，包括等待工具的时间。

### 在调用者线程上

当可以接受阻塞调用者时，例如在一个只服务单个请求的无状态 Worker 中，可以直接在调用者线程上运行 VM，无需额外部署：

```ts
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

const sandbox = createInlineCodemodeSandbox({ tools, timeoutMs: 60_000, interruptBudget: 50_000 });
const result = await sandbox.execute(code);
```

`createInlineCodemodeSandbox()` 会把 Wrangler 编译的 QuickJS 模块传给 `InlineCodemodeSandbox`。使用其他打包工具时，从 `/portable` 导入 `InlineCodemodeSandbox`，并把你自己编译的模块作为 `wasm` 传入。

- **阻塞。** 正在计算的脚本会阻塞调用者，直到它 await 一个工具或用完 `interruptBudget`。
- **栈。** QuickJS 的栈保护被降低到 `INLINE_MAX_STACK_SIZE`，使其在调用者较小的栈耗尽之前先触发。

## 提供给模型的声明

工具和全局函数可以携带 `description`、`inputSchema` 和 `outputSchema`（JSON Schema）。`renderDeclarations()` 把它们转换为 TypeScript 声明，用于面向模型的工具描述：

```ts
renderDeclarations({ tools: sandbox.tools, globals: sandbox.globals });
// declare const tools: {
//   /** Read a file */
//   read(args: {
//     path: string;
//   }): Promise<string>;
// };
```

属性描述会变成 `//` 注释。类型无法表达的约束会以标签的形式跟在后面，例如 `// @integer @minimum 1 @default 20`；当类型超出大小限制时它们会被最先丢弃。schema 只影响声明的形状，值不会依据它们进行校验。本地引用（`#/$defs/...`、`#/definitions/...`）会被展开；递归引用和远程引用渲染为 `unknown`。

## 与 pi-agent-core 一起使用

要给一个 `Agent` 提供 codemode 工具，把它的其他工具暴露给沙箱，并把 `execute()` 包装为 `AgentTool`：

```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type CodemodeJsonSchema,
	CodemodeSandbox,
	type CodemodeTool,
	renderDeclarations,
} from "@earendil-works/pi-codemode";
import { Type } from "typebox";

const sandboxTools: CodemodeTool[] = agentTools.map((tool) => ({
	name: tool.name,
	description: tool.description,
	inputSchema: tool.parameters as CodemodeJsonSchema,
	outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
	execute: async (args, { signal }) => {
		const result = await tool.execute("nested", args as never, signal);
		if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
		return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	},
}));

const codemodeTool: AgentTool = {
	name: "codemode",
	label: "Codemode",
	description: `Run JavaScript that calls tools as \`await tools.<name>(args)\`. Output with text() or return.\n\n${renderDeclarations({ tools: sandboxTools })}`,
	parameters: Type.Object({ code: Type.String() }),
	execute: async (_toolCallId, { code }, signal) => {
		const sandbox = new CodemodeSandbox({ tools: sandboxTools });
		try {
			const result = await sandbox.execute(code, { signal });
			const content = [...result.output];
			if (result.ok && result.value !== undefined) content.push({ type: "text", text: JSON.stringify(result.value) });
			if (!result.ok) content.push({ type: "text", text: result.error.stack ?? result.error.message });
			return { content, details: undefined, isError: !result.ok };
		} finally {
			await sandbox.close();
		}
	},
};
```

`result.output` 的各项已经符合 `@earendil-works/pi-ai` 的 `TextContent` 和 `ImageContent` 形状。直接调用 `tool.execute()` 会跳过 agent 的 `beforeToolCall` 和 `afterToolCall` 钩子。要让嵌套调用也经过这些钩子，把每次调用通过 `@earendil-works/pi-agent-core` 的 `runToolCall()` 处理，[mcp-codemode 示例](https://github.com/earendil-works/pi/tree/main/packages/agent/examples/mcp-codemode)就是这么做的。该示例还在脚本内部拒绝失败的嵌套调用，并把 codemode 与 MCP 工具结合使用。

## 确定性运行

`sandbox.start(code, options)` 运行脚本的方式允许宿主在重启后再次运行并得到相同行为，例如从其调用结果的持久化日志中恢复。`execute()` 不受影响。

VM 只有在宿主喂给它东西时才运行，也没有定时器或 I/O，因此除它从环境中读取的内容之外，它是确定性的。`start()` 把这些也固定下来：

- **时间：** `Date.now()` 读取 `startedAt`，然后是正在处理的结果的 `now`，绝不倒退。`performance.now()` 从 `startedAt` 起算。
- **随机性：** `Math.random()` 和 VM 的其他随机性都来自 `seed`。
- **时区：** UTC，与宿主无关。
- **垃圾回收：** 不存在 `WeakRef` 和 `FinalizationRegistry`。
- **结果顺序：** 宿主用结果编号（1、2、……）应答每次调用，VM 严格按照该顺序应用结果，无论传输层以什么顺序送达。

运行会声明自己的工具和全局函数，宿主亲自应答每一次调用：

```ts
const run = sandbox.start(code, {
	startedAt: Date.now(),
	seed: 7,
	tools: [{ name: "read", description: "Read a file" }],
	onStarted: (fingerprint) => {}, // VM 是什么：引擎版本、prelude 哈希、限制
	onCall: (call) => {
		// call.id 是 VM 为该调用分配的编号，按脚本发起调用的顺序。
		void readFile(call.args).then((text) => run.deliver(nextResult++, Date.now(), call.id, { ok: true, value: text }));
	},
	onIdle: (seq, issued) => {}, // 在结果 `seq` 之后（0：首次运行），共 `issued` 次调用
});
const result = await run.result;
```

除非给定 `timeoutMs`，否则运行没有截止时间。结果编号必须按 1、2、……连续递增。相同的脚本、`startedAt`、`seed`、工具（连同其 `jsName`）、全局函数和 store，以相同的顺序应答相同的结果，就会在任何具有相同指纹的 VM 上发起相同的调用、使用相同的参数，并产生相同的输出。要以脚本无法捕获的错误结束一次运行，中止其 `signal`。

## 结果

`execute()` 对脚本失败从不 reject。`result.error.kind` 是以下之一：

| kind      | 含义                                                                        |
| --------- | --------------------------------------------------------------------------- |
| `script`  | 脚本抛出异常或解析失败；`stack` 指向 `codemode.js:<line>`                  |
| `timeout` | 截止时间已过或中断预算耗尽；已请求关闭 VM                                   |
| `aborted` | `options.signal` 触发或调用了 `close()`；已请求关闭 VM                      |
| `sandbox` | VM 或其传输失败，例如 wasm trap、缺少 worker 文件或远程调用失败             |

`result.output` 按脚本产生的顺序保存文本和图片项，失败的执行也是如此。宿主会保留全部内容直到脚本结束，因此输出限制为 `MAX_OUTPUT_CHARS`（16 Mi）个文本和 base64 图片数据字符，以及 `MAX_OUTPUT_ITEMS`（100000）个项。超出任一限制，脚本会以 `RangeError` 失败，即使它捕获了该错误也是如此。`result.calls` 列出每次工具调用及其 `status: "ok" | "error" | "cancelled"`。脚本返回时仍在运行（未被 await）的调用会通过该工具的 `signal` 中止，并报告为 `cancelled`。

## 工作原理

本节描述 `CodemodeSandbox`。其他沙箱共享相同的宿主侧、prelude 和 VM，只替换 worker 线程。参见[在 Cloudflare Workers 上使用](#在-cloudflare-workers-上使用)。

每次 `execute()` 启动一个 worker 线程（含 VM 创建约 20 ms），由它从编译好的 wasm 模块实例化一个全新的 QuickJS VM。该 VM 是一个独立的 wasm 实例，拥有自己的线性内存。它唯一的导入是一个 WASI 垫片（时钟、随机数和 stdout/stderr 写入，worker 会丢弃这些输出）和一个宿主调用入口，因此脚本只能通过 worker 注册的函数触达宿主。

worker 在 VM 内求值一个 prelude，它把唯一的宿主桥接保存在闭包中，并在其上构建 `tools`、`console` 和全局函数。脚本被编译为异步函数体。

工具调用作为消息中继到宿主线程；宿主运行工具并把 JSON 结果发回。宿主持有截止时间和中止信号。任一触发时，它设置一个 VM 会轮询的共享中断标志，然后调用 `worker.terminate()`。在 Bun 上需要这个标志，因为 `terminate()` 无法停止一个在 wasm 中空转的线程（`while (true) {}` 或 `while (true) await null`）。

worker 把脚本执行移出宿主线程：QuickJS 是同步运行的，宿主线程上一个空转的脚本会阻塞其事件循环。

## 运行时说明

- Node 和 Bun 支持内存限制、中断，以及深层递归时可捕获的 `RangeError`（QuickJS 的栈保护已启用；否则 wasm 栈会溢出并 trap）。Bun 可能在不可中断的内置方法执行期间延迟 worker 退出；结果不会等待退出。
- 堆栈跟踪使用 QuickJS 帧（`at f (codemode.js:2:31)`），并像 V8 一样以 `Name: message` 作为前缀。包装前缀与脚本共享第 1 行，因此行号是精确的；第 1 行的列号有偏移。
- QuickJS 是解释执行。胶水代码和过滤工具结果足够快；重计算比 V8 慢。
