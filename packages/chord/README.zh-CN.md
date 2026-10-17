# @earendil-works/chord

Chord 用**对象（object）**构建应用：这些对象存在于多个进程中（服务器、worker、浏览器标签页），并可在运行期间**热重载**。

- **对象**是某个地址上的状态加代码。它按需创建，只要有人引用就存活。
- 每个人拿到的是**引用（reference）**，绝不是对象本身。引用在本地和跨进程的行为一致，并在重载后继续有效。
- 每个对象都知道自己的**主体（principal）**：所有者和访客拿到的是不同的对象，具有不同的方法。
- **状态**是可观察的 JSON。远程观察者先收到快照，随后是增量（delta）。
- **热重载**在运行期间替换代码。进行中的工作用它启动时的代码完成，状态被保留，不兼容的变更在安全点迁移。

契约（contract）是用 [TypeBox](https://github.com/sinclairzx81/typebox) schema 描述的运行时值。宿主之间通过链路（link）交换 JSON 帧：内存、Node IPC 通道或 WebSocket。

## 入口

| 导入 | 内容 | 运行环境 |
|--------|----------|---------|
| `@earendil-works/chord` | 契约（`local`、`remote`、`method`、`opaque`）、声明（通过工厂的 `self`：`state`、`derive`、`resource`、`on`、`task`）、宿主（`createHost`、`defineFacet`、`defineRegistry`）、链路（`memoryLinkPair`、`ipcLink`、`webSocketLink`、`acceptWebSockets`）、错误（`ChordError`、`isChordError`、`forbidden`、`invalid`）。还包括共享基础：`Context`、`JsonValue`、`JsonRepresentation`、`Draft`、`copyJson`、`isJsonValue`，以及 `replicatedState` 及其类型。 | Node 和浏览器 |
| `@earendil-works/chord/node` | 子宿主进程：`createHostManager`、`forkDriver`、`childControl`、`processLock`；facet 模块加载器 `nodeLoader`。 | Node |
| `@earendil-works/chord/context` | 显式取消与调用值：`BACKGROUND_CONTEXT`、`withCancel`、`withAbortSignal`、`withoutAbortSignal`、`withContextValue`、`awaitWithContext`。 | Node 和浏览器 |
| `@earendil-works/chord/delta` | 事务性 JSON 追踪器、结构化 diff、不可变应用，以及操作批次的线上编码器/解码器。 | Node 和浏览器 |
| `@earendil-works/chord/output` | 有界输出流与节拍化进度：`OutputBuffer`（流的头部或尾部窗口、`OutputLimits`、`OutputSkip`）、`boundOutput`、`sanitizeOutput`、`utf8ByteLength`，以及 `Progress`（对变化值的自适应提交）。 | Node 和浏览器 |

## 快速开始

```ts
import { Type } from "typebox";
import { createHost, hostNamed, method, remote } from "@earendil-works/chord";

// contract.ts: 提供者和消费者共享
export const Counter = remote("demo.counter", {
	version: 1,
	input: Type.Object({ name: Type.String() }),
	host: hostNamed("server"), // 对象所在之处；调用者永远不指定宿主
	variants: {
		default: {
			state: { count: Type.Number() },
			methods: { increment: method(Type.Object({ by: Type.Number() })) },
		},
	},
});

const host = createHost({ name: "server", self: { kind: "server" } });

host.serve(Counter, ({ name }, _principal, self) => {
	const count = self.state("count", Type.Number(), 0);
	return {
		variant: "default",
		count,
		increment: async ({ by }, ctx) => {
			count.change(ctx, (n) => n + by);
		},
	};
});

await host.root(async (ctx) => {
	const clicks = await ctx.get(Counter, { name: "clicks" }); // 就绪并带状态；root 结束时释放
	clicks.count.subscribe((n) => console.log("count", n));
	await clicks.increment({ by: 2 }, ctx); // 先输出 0，再输出 2
});
```

## 文档

- [教程](docs/tutorial.zh-CN.md)：一个共享待办清单，逐章节构建。每个示例都可以作为 `test/tutorial.test.ts` 运行。
- [使用指南](docs/guide.zh-CN.md)：契约、对象、状态、root、生命周期、插件、热重载、宿主和链路的 API 参考。
- [规范](docs/spec.zh-CN.md)：兼容性、生命周期和重载语义，以及已知限制和实现决策。
- [Delta 指南](src/delta/README.zh-CN.md)：`@earendil-works/chord/delta` 的所有权、生命周期、操作和副本契约。

## 追踪 JSON 增量

从 `@earendil-works/chord/delta` 导入独立的事务性追踪器：

```ts
import { applyImmutable, track } from "@earendil-works/chord/delta";

const tracker = track({ output: "", count: 0 });
const change = tracker.beginChange();
change.state.output += "done\n";
change.state.count += 1;
const prepared = change.prepare();

tracker.adopt(prepared);
const replica = applyImmutable(prepared.base, prepared.ops);
```

`tracker.value` 始终是最新采纳的不可变修订版。prepare 不改变权威状态；adopt 校验准备结果并交换根指针。被赋值的容器按值复制，未变化的子树可以在修订版之间共享。

追踪器使用受信任的不可变所有权，而不是防御性复制或冻结。`track(initial)`、`prepareReplace(value)`、`replicatedState(initial)` 和 `replace(context, value)` 直接取得无别名严格 JSON 根的所有权，不遍历它们。调用者不得修改已转移或已发布的数据。通过 draft 放入的值已经被复制过，因此那次遍历也会在 draft 变更之前拒绝非严格 JSON。已发布的值不会被冻结。进程内消费者可以与提供者共享容器；修改已消费的值违反契约，可能破坏权威状态。在任何可变的信任边界处克隆或序列化。

复制状态（replicated state）通过回调提供同样的模型。`replicatedState` 是独立的可观察值，不依赖宿主；Durable 用它实现文档、视图和任务图状态：

```ts
import { replicatedState } from "@earendil-works/chord";

const initial = { output: "", count: 0 };
const status = replicatedState(initial); // 转移 initial 的所有权
status.change(context, (draft) => {
	draft.output += "done\n";
	draft.count += 1;
});
```

一次成功的 `change()` 恰好发布一个原子修订版。如果回调抛出异常，原值和序列保持不变。回调返回后 draft 引用即不可用。追踪器会发出字符串追加和头部截断操作、数组 splice 与置换、set 和 delete；大量编辑可能折叠为一次完整替换。

`replicatedState(source, { onError })` 则把一个只发布的状态附加到权威修订版来源（`ReplicatedStateSource`）：它先捕获快照，然后按游标顺序发布每个已提交的帧。

### 公共状态订阅

`state.subscribe(async (value, context, delivery) => { ... })` 对每个订阅独立串行化回调。值可用时立即开始水合（hydration），其返回的 promise 必须先结算，更新才会开始。同步回调仍然同步运行。在异步回调内部读取捕获的 `value`：`state.value` 可能已经指向更新的修订版。

每个订阅最多保留 100 个待处理的完整值投递（不含正在运行的回调）。溢出时，只保留最新的待处理值、上下文和投递元数据；尚未开始的初始水合会被保留。因此公共投递序列可能跳号。这是按帧数的策略，不是按字节的限制。

返回的取消订阅函数立即丢弃待处理工作并阻止新回调。它既不中止也不等待正在运行的回调。同步抛出和 promise 拒绝会被观察、上报，不会停止其他订阅或后续回调。附加来源使用其 `onError` 处理器；可变状态（以及没有处理器的附加来源）通过在微任务中抛出异常来报告失败。取消订阅不会让正在运行的回调隐藏之后的拒绝。

Chord 对象的 cell 及其远程可读对象有各自的订阅模型；见使用指南中的 [State](docs/guide.zh-CN.md#state)。
