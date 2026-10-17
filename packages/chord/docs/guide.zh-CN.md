# Chord 使用指南

> 描述 `src` 中的运行时实现。[规范文档](spec.zh-CN.md)定义其语义并列出已知限制。

Chord 用**对象（object）**构建应用。这些对象分布在多个进程中（服务器、worker、浏览器标签页），并且可以在运行中**热重载（hot reload）**。

- **对象类型（object type）**由契约（contract）声明：一个名字、一个输入（对象的地址）和若干成员。插件的 **facet**（它针对某一宿主的代码：服务器、worker、浏览器）负责提供对象类型。
- **对象（object）**是对象类型的一个实例：某个地址上的状态加代码。它按需创建，只要还有人引用它就存活。
- 每个人拿到的都是**引用（reference）**，而不是对象本身。引用在本地和跨进程中的行为一致，并且能在重载后存活。
- 每个对象都知道自己的**主体（principal）**：所有者和访客拿到的是不同的对象，带有不同的方法。
- **状态（state）**是可观察的 JSON。远程观察者先收到快照，之后收到增量。
- **热重载**在运行中替换代码。进行中的工作在它启动时的代码上完成，状态被保留，不兼容的变更在安全点迁移。

## 目录

- [快速上手](#快速上手)
- [契约](#契约)
- [提供对象](#提供对象)
- [声明](#声明)
- [激活](#激活)
- [主体与变体](#主体与变体)
- [引用](#引用)
- [状态](#状态)
- [调用、ctx 与 root](#调用ctx-与-root)
- [生命周期](#生命周期)
- [注册表](#注册表)
- [插件](#插件)
- [热重载](#热重载)
- [宿主与链路](#宿主与链路)
- [Durable](#durable)
- [错误](#错误)
- [经验法则](#经验法则)

## 快速上手

```ts
import { Type } from "typebox";
import { createHost, method, remote } from "@earendil-works/chord";

// contract.ts：提供者和消费者共享
export const Counter = remote("demo.counter", {
	version: 1,
	input: Type.Object({ name: Type.String() }),
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
	const clicks = await ctx.get(Counter, { name: "clicks" });  // 已就绪，带状态；root 结束时释放
	clicks.count.subscribe((n) => console.log("count", n));
	await clicks.increment({ by: 2 }, ctx);  // 先打印 0，再打印 2
});
```

## 契约

契约是一个运行时值：一个名字、一个版本号，以及对成员的描述。打包产物中没有 TypeScript，所以运行时能检查的一切都必须写进契约。TypeScript 类型从契约推断。

### 远程类型

远程类型可以被其他宿主访问。所有跨网络传输的内容都有 schema，由提供者校验。

```ts
export const Chat = remote("pi.chat", {
	version: 1,
	input: Type.Object({ session: Type.String(), conversation: Type.Number() }),
	host: hostFamily("session:", "session"),  // 对 `{ session: "S1", … }` 来说，对象位于 `session:S1`
	variants: {
		viewer: {
			state: { view: ConversationViewSchema },
		},
		participant: {
			state: { view: ConversationViewSchema },
			methods: {
				send: method(SendInputSchema, Type.Object({ submissionId: Type.Number() })),
				stop: method(),  // 无参数、无返回值：`chat.stop(ctx)`
			},
		},
	},
});
```

**远程类型位于哪里**是契约的一部分，因此调用方不需要指定宿主：

- `host: hostNamed("server")`：每个对象都位于名为 `server` 的宿主上。
- `host: hostFamily("session:", "session")`：对象位于 `session:` + 输入中的 `session` 字段（必填字符串）。TypeScript 会对照输入检查字段名。

`get` 会规范化输入（应用默认值）、解析宿主，然后：如果对象就在本宿主上就在此获取，否则通过链路到对方获取。`serve` 会拒绝放置位置不包含本宿主的类型，所以放错位置的类型会在启动时、或在加入它的那次重载时失败。拿到持有权（hold）的宿主会检查自己的契约是否把该输入放在自己这里，中继方会对照其契约令牌检查持有目标：客户端永远不能决定对象放在哪里。放置位置是描述和指纹的一部分：移动一个类型是破坏性变更，指向它的引用会收到 `upgrade_required`。

### 本地类型

本地类型只能在宿主内部访问。其成员可以是任何东西：函数、回调、原生对象。非 JSON 的成员用不透明（opaque）描述符或函数描述符表示。

```ts
export const Index = local("pi.index", {
	version: 1,
	input: Type.Object({ session: Type.String() }),
	members: {
		search: method(Type.Object({ query: Type.String() }), Type.Array(HitSchema)),
		onChange: method(Type.Function([ChangeSchema], Type.Void()), UnsubscribeSchema),
		harness: opaque("pi.durable-harness@1"),
	},
});
```

### 输入标识对象

`{ session: "S1", conversation: 1 }` 永远指向同一个对象。输入会被规范化（应用默认值、删除未知字段）、校验，并以规范形式序列化。等于默认值的字段会被省略，所以新增一个带默认值的可选字段不会改变已有地址。修改默认值或输入的规范化方式，则需要新的类型名。

### 版本与兼容性

每个打包产物都带有它构建时依赖的每份契约的自己的副本。当消费者绑定到提供者时，会比较两份副本：

> 针对版本 M 构建的消费者绑定到版本 N 的提供者，当且仅当 **N = M 且提供者的描述覆盖消费者的**。否则提供者必须在 `accepts[M]` 中提供适配器，否则绑定失败并报 `contract_mismatch`。

"覆盖"指提供者仍然提供消费者构建时依赖的一切：
- 每个成员都存在且种类相同；
- 方法接受消费者能发送的一切（新参数必须是可选的），并且至少返回消费者期望的内容（结果中多出的字段没问题）；
- 状态值符合消费者的 schema；
- 不透明成员的名字和版本相同。

| 变更 | 版本 | 结果 |
| --- | --- | --- |
| 新增方法、可选参数、结果字段、状态字段 | 保持 | 正常绑定 |
| 删除或重命名成员；把参数改为必填；改变类型 | **升级** | 旧消费者需要 `accepts`，或者也一起重载 |
| 形状相同但含义不同（`query` 现在是正则表达式） | **升级** | 同上；无法检测，靠你自己 |
| 破坏性形状变更但忘了升级版本 | 保持 | 被拒绝："consumer needs member `search`" |

```ts
// 版本 2 改变了 `search` 的含义；旧消费者通过适配器继续工作
host.serve(Index, indexFactory, {
	accepts: {
		1: (current) => ({ search: ({ query }, ctx) => current.search({ query: escapeRegExp(query) }, ctx) }),
	},
});
```

## 提供对象

```ts
host.serve(Type, (input, principal, self) => implementation, options);
```

- **工厂函数（factory）**同步执行。它声明对象需要什么，并返回其实现：方法和状态成员，远程类型还要返回 `variant`。返回 Promise 会抛错。
- 每个 `(type, input, principal)` 组合对应一个**对象**。它持有对象的状态、资源和引用，并在重载后存活。被替换的只是实现。
- **选项：**
  - `accepts`：为基于旧契约版本构建的消费者提供的适配器；
  - `lifetime`：`"referenced"`（默认）在第一次 `get` 时创建对象，在最后一个引用释放后销毁；`"host"` 在插件加载时创建，保留到宿主关闭（见[生命周期](#生命周期)）；
  - `linger`：最后一个引用释放后，被引用的对象再保留多久。

## 声明

重载会在同一个对象上再次运行工厂。需要跨重载保留内容的声明都有一个**名字**：新代码的 `status` 单元就是旧代码的 `status` 单元，连值一起保留。派生（derivation）和任务（task）不跨重载保留任何东西，因此没有名字。

```ts
host.serve(StatusStore, ({ session }, _host, self) => {
	const status = self.state("status", StatusSchema, { running: false, tasks: 0 });
	const errors = self.state("errors", Type.Array(Type.String()), []);
	const catalog = self.get(Catalog, {});
	const db = self.resource("db", {
		version: 1,
		open: async ({ signal }) => openSqlite(statusPath(session), { signal }),
		close: async (db) => db.close(),
	});
	self.on("catalogChanges", catalog.rows, (rows, ctx) => errors.replace(ctx, checkRows(rows)));
	self.task(async (ctx) => {
		while (!ctx.signal.aborted) {
			await sleep(10_000, ctx.signal);
			await db.value.run("INSERT INTO history VALUES (?)", [JSON.stringify(status.value)]);
		}
	});
	const summary = self.derive([status, errors], (s, e) => ({ ...s, failing: e.length > 0 }));
	return { summary, report: reportMethod(status) };  // 暴露的状态就是实现返回的内容
});
```

| 声明 | 是什么 | 重载时 |
| --- | --- | --- |
| `self.state(name, schema, initial \| { init }, { version?, migrate? })` | 一个可观察的 JSON 单元；schema 必填 | 同一个单元和值（`init` 不再运行）；版本升高时迁移 |
| `self.get(Type, input, { at? })` | 指向另一个对象的引用；其身份就是地址 | 再次声明则保留，否则释放 |
| `self.resource(name, { version, deps?, exclusive?, open, close? })` | 一个连接、监视、套接字、端口 | 保留；仅当 `version`、`deps` 或 `exclusive` 变化时才重新打开 |
| `self.on(name, source, handler)` 或 `self.on(name, source, select, handler)` | 对状态或事件源做出反应 | 只要源和 `select` 不变，就是同一个订阅，换上新处理函数 |
| `self.task(async (ctx) => ...)` | 长期运行的后台工作 | 旧运行通过 `ctx.signal` 中止；它结束后新代码才启动（上限 `taskStopDeadline`，默认 5 秒） |
| `self.derive(sources, fn)` | 状态的实时投影；`fn` 是同步的 | 一个新的派生，在重载提交时计算 |
| `self.register(Registry, { key: value })` | 注册表中的一项 | 在提交时替换 |
| `self.expose(resource)` | 由资源支撑的成员（本地类型） | 跟随资源 |

名字是字符串：同一次运行中重复声明同一个名字会失败（`invalid/duplicate`）。每种声明有各自的名字空间，所以一个单元和一个资源可以同名。

当监听器声明在同一个资源（或源）上且 `select` 相同（同一个函数，或源码文本相同的函数）时，它的订阅会跨重载保留。`select` 不会被再次调用，因此只接受单个订阅者的源（如 Durable 的 watch）能在重载后存活，且 `select` 可以把值包进一个新的适配器对象。如果 `select` 的结果依赖重载之间会变化的捕获值，这种变化不会被察觉；给这类监听器换个新名字。

**状态上的监听器做的是调和（reconcile）。** 状态上的监听器（单元、派生、引用的状态成员）启动时先拿到当前值，之后每拿到一个新值。当重载替换了它的源（派生在每次重载时都是新的），它重新订阅并再次拿到当前值。所以处理函数要写成"把现状对齐到拿到的值"（按照值去设置、比较、启动或停止），而不是每次调用都计数或追加。事件源（资源的事件）不会投递当前值。

不再声明的名字会被释放、关闭或停止，且发生在旧代码完成手头工作之后。

**必须跨重载存活的状态放在单元（cell）里，**绝不放在闭包变量里。闭包变量的寿命只有一版代码。

```ts
// 错误：每次重载都归零
host.serve(Visits, (_, _p, self) => {
	let visits = 0;
	return { hit: async (ctx) => ++visits };
});

// 正确
host.serve(Visits, (_, _p, self) => {
	const visits = self.state("visits", Type.Number(), 0);
	return {
		hit: async (ctx) => {
			visits.change(ctx, (n) => n + 1);
			return visits.value;
		},
	};
});
```

**方法**在契约中用 `method(args?, result?)` 声明。不带 `args` 的方法不接受参数：调用方写 `ref.hit(ctx)`（或 `ref.hit()`），实现是 `(ctx) => …`。不带 `result` 的方法不返回值：实现不返回东西，调用方拿到 `undefined`。`method(undefined, Type.Number())` 表示无参数但返回一个数字。

## 激活

工厂是同步的，但激活不是。`self.get` 和 `self.resources` 只做*声明*；慢的工作发生在之后：

```text
get(Index, { session: "S1" })
 1. 运行工厂               → 得到声明
 2. 打开声明的资源        → 例如连接 SQLite
 3. 等待声明的引用        → 依赖先激活
 4. 运行单元的 init       → 例如把行读进单元
 5. 上线（live）              → 引用变为 "live"；监听器和任务启动
```

```ts
host.serve(Index, ({ session }, _host, self) => {
	const db = self.resource("db", { version: 1, open: () => openSqlite(indexPath(session)), close: (db) => db.close() });
	return {
		search: async ({ query }, ctx) => db.value.all("SELECT entryId, text FROM fts WHERE fts MATCH ?", [query]),
	};
});

host.serve(Chat, ({ session, conversation }, principal, self) => {
	const index = self.get(Index, { session });  // 在 Index 上线前只是一个占位符
	return {
		variant: "participant",
		find: async ({ query }, ctx) => index.search({ query }, ctx),  // 只会在 Chat（和 Index）上线后运行
		// ...
	};
});
```

**规则：**
- 在工厂内部，绝不使用你声明的东西：`db.value` 和 `index.someState.value` 会抛 `not_ready`，调用引用也会抛错。在方法、监听器、任务和 `init` 中使用它们。
- **对象只有在它的引用就绪后才上线**：引用上线，并且（对远程引用）其变体的每个状态成员都已注水（hydrated）。对它转发或从远程引用派生的状态也一样：那个状态有值后它才上线。如果引用在宿主的 `readyTimeout`（默认 60 秒）后仍未就绪，激活以 `unavailable/ready_timeout` 失败；跨宿主的引用循环也会这样结束，而不是挂死。
- **对同一地址的并发 `get` 共享一次激活**，所以数据库只打开一次。
- **失败会传播：**如果 `openSqlite` 抛错，`Index` 失败，`Chat` 带着该原因失败，每个等待中的 `get` 都拒绝。下一次 `get` 会重试。
- **被放弃的激活：**如果在激活完成前所有人都释放了引用，结果会被销毁。

### 启动就绪与父级接纳

`await host.load(facets)` 和 `await host.install(facet)` 会等待它们安装的 `lifetime: "host"` 对象上线：资源已打开、声明的引用已上线、注册已发布。一次 load 中的所有 facet 都先安装完，再统一等待激活，所以宿主对象可以使用后面 facet 中的提供者。被引用的对象只在有人引用时才创建。工厂、依赖和资源的错误会让启动以该引用的激活错误拒绝；宿主对象的失败也会到达 `onError`。安装失败不会回滚：放弃启动时请关闭宿主。`install` 同步注册，所以设置/注册错误仍然同步抛出。

`await host.ready()` 等待调用时已存在的宿主对象，包括直接的 `host.serve(..., { lifetime: "host" })` 和之前延迟的 load。它是激活屏障，不是持续健康检查，也不是等待任务完成。之后的安装需要再次等待就绪。

worker 可能需要在父级接受其链路**之前**打开本地 Harness 并宣布控制就绪。向服务器的 SessionStatus 汇报的宿主对象，在那个接纳完成之前无法上线。如果先等待整个 load 再宣布控制就绪，就会死锁。所以要显式地推迟整个屏障：

```ts
// 先接通上游链路；它的出站引用可以排队，直到父级接纳它。
await worker.load(workerFacets, { awaitHostObjects: false });  // install 也支持
const harness = await worker.get(Harness, {});        // 仅本地引导；无上游依赖
announceControlReady();                               // 父级现在可以接受 worker 链路
await worker.ready();                                 // 所有宿主对象上线，包括上游引用
harness.release();
```

`awaitHostObjects: false` 仍然会启动每个宿主对象；它跳过的是等待，不是激活。运行时不会自动分类上游依赖。你需要选一个没有上游依赖的本地引导引用，在加载上游消费者之前接通它，并让父级在完整屏障之前接纳链路。控制就绪只表示"可以接纳"，不表示每个宿主对象都已上线。在完整屏障落定之前，把 worker 的引导计为忙碌；之后的失败通过 worker 的 fatal/启动错误路径上报。在父级接纳链路之前，绝不要等待一个对象需要父级的引用（远程引用，或持有远程引用的本地引用）。

要把资源打开的原生对象（本地类型的 `opaque` 成员）交出去，用 `expose` 暴露该资源。引用在对象上线后读到它的值，上线前读到 `undefined`：

```ts
host.serve(Harness, (_, _host, self) => {
	const durable = self.resource("durable", { version: 1, open: () => DurableHarness.open(storage), close: (h) => h.close() });
	return { harness: self.expose(durable) };  // 契约成员：harness: opaque<DurableHarness>("pi.durable-harness@1")
});

const harness = await ctx.get(Harness, {});
harness.harness.resume();  // DurableHarness 本身
```

## 主体与变体

应用自己定义主体（principal）以及它们的键。Chord 不发明任何主体：应用为每个请求可以代表的主体负责。

```ts
type Principal =
	| { kind: "owner"; access: "local" | "relay" }
	| { kind: "guest"; id: string; name: string; session: string; mode: "view" | "full"; revision: number }
	| { kind: "worker"; session: string; generation: number }
	| { kind: "server" }   // 父级自己的请求，从 worker 视角看
	| { kind: "host" };    // 宿主自己的代码

const host = createHost<Principal>({
	name: "server",
	self: { kind: "host" },
	principalKey: (p) =>
		p.kind === "owner" ? `owner:${p.access}` :
		p.kind === "guest" ? `guest:${p.id}:r${p.revision}` :
		p.kind === "worker" ? `worker:${p.session}:${p.generation}` :
		p.kind,
});
```

- `createHost<Principal>` 为每个工厂的 `principal`、`ctx.principal`、路由、`accept` 和 `invalidatePrincipal` 模式提供类型，代码可以按 `kind` 收窄而不需要类型断言。facet 模块也要声明：`defineFacet<Principal>((api) => …)`（应用通常导出自己的 `defineFacet` 和 `Ctx` 别名）。不带类型参数时，主体是 `unknown`。
- 每个主体键一个对象：所有者的两个标签页共享一个对象，访客各有自己的。
- 宿主内部的代码以 `self` 身份行动，所以内部对象是共享的。与 `self` 键相同的主体就是宿主自己的，无论由哪个对象承载。
- 链路会盖上连接方的主体印记。调用方永远无法自报主体。
- 子宿主声明父级自己的请求以什么身份行动：`connect(link, { principal })`（或 `upstream: { link, principal }`）。父级中继的请求以它转发的调用方身份行动。
- 路由声明它解析的宿主回调时以什么身份行动：`route(prefix, { …, principal: (name) => … })`。

**远程工厂选择一个变体：**

```ts
host.serve(Chat, ({ session, conversation }, principal, self) => {
	if (!canView(principal, session)) throw forbidden();
	const c = self.get(Conversation, { session, conversation });  // 以 host 身份：一个共享实例
	if (!canSend(principal)) return { variant: "viewer", view: c.view };
	const author = authorOf(principal);
	return {
		variant: "participant",
		view: c.view,
		send: async (input, ctx) => c.submit(input, author, ctx),
		stop: async (ctx) => {
			await c.stop(author, ctx);
		},
	};
});
```

```ts
const chat = await ctx.get(Chat, { session: "S1", conversation: 1 });  // 位于 session:S1
if (chat.variant === "participant") showComposer(chat.send);  // 收窄：`send` 只在这个变体存在
else showReadOnly();
```

**变体做不到的事：**
- **它不是完整的授权。**方法仍要检查自己的参数：提交是否属于这个会话、会话 ID 是否属于这个主体。
- **它不覆盖持有对象期间会变化的标志。**那些是状态，例如 `you: { canDraw: boolean }`。
- **撤销**是 `host.invalidatePrincipal(match)`。它强制销毁匹配的对象，本地和跨链路都一样，这些对象的引用变成 `gone`。新的 `get` 会带着新授权运行工厂。

本地类型没有变体。它们的调用者只在宿主内部，以 `self` 身份行动。如果本地对象需要知道是谁在行动，显式传参，比如上面的 `author`。

## 引用

| 位置 | API | 释放时机 |
| --- | --- | --- |
| 工厂内 | `self.get(Type, input)`：同步；对象就绪后才上线 | 随对象（或其被替换的声明） |
| 一次调用中 | `await ctx.get(Type, input, { state? })` | 调用落定时 |
| Chord 之外 | `await host.get(Type, input, { signal?, state? })` | `ref.release()` |
| UI 运行时 | `host.hold(Type, input)`：同步，可能处于 `loading` | `ref.release()` |

```ts
const chat = await ctx.get(Chat, input);  // 就绪：已上线，变体的每个状态成员都已注水
chat.status;  // "loading" | "live" | "released" | "gone"
chat.variant;  // 当前变体；多变体引用可以按它收窄
chat.shape;  // { variant, members, contract }
const send = chat.send;  // 一个稳定函数：始终派发到当前代码
chat.view.value;  // 当前值，类型为 T
chat.view.subscribe((v) => render(v));
chat.onStatus((status, error) => { if (status === "gone") reconnect(error); });
chat.release();
```

- **持有的引用可用：**被 `await` 的 `get` 在对象上线且其变体的每个状态成员都有第一个快照（本地或远程）后完成。它以激活错误（`forbidden`、不可达等）、`aborted`（ctx 已中止或调用先落定的 `ctx.get`；`host.get` 的 `signal`）、或超过宿主 `readyTimeout` 后的 `unavailable/ready_timeout` 拒绝。届时只释放那一个引用。
- **持有的引用保持订阅**其变体的状态，无论有没有监听器，直到被释放。链路断开后，最后的值在重新持有期间（状态 `loading`）仍可读取。
- **第一次注水前读状态抛 `not_ready`**（还在加载的 `hold`、工厂内读成员）。当前变体之外的成员抛 `not_in_variant`；已终结的引用抛出它的终结原因（`released`，或 `gone` 错误）。在注水前添加的监听器会在那时收到快照。
- **`state: false`** 给出只含方法的引用：它不接收状态（除非对同一对象的另一个引用需要），其对象上线后它即就绪。
- **对 `loading` 引用的调用会等待**它上线，遵守 `ctx` 取消和截止时间。
- 当前变体中不存在的成员以 `not_in_variant` 拒绝。
- `release()` 之后，每个成员都以 `released` 拒绝。
- **`gone`** 表示对象在被引用期间被强制移走：撤销、归档、其宿主死亡。重新调用 `get`，或显示"不可用"。`onStatus` 报告每次状态变化（`live`、链路重连时的 `loading`、`released`、带错误的 `gone`），UI 无需轮询。
- **指向同一远程对象的引用共享一个绑定**（每个宿主和键：类型、规范化输入、主体键、契约指纹）：链路上一个持有、每个状态成员一条流、调用走同一个持有。每个引用保留自己的状态、观察者和 `release`。配置 `createHost({ linger: { types: { [typeName]: ms }, cap } })` 后，最后一个引用被释放的绑定会继续保留（并保持注水）`ms` 毫秒，同时最多 `cap` 个（默认 4），这样重新拿引用在链路上零成本。
- **返回值就是值。**任何想共享的长生命周期东西都是一个用 `get` 访问的对象。

## 状态

```ts
const todos = self.state("todos", Type.Array(TodoSchema), []);

todos.change(ctx, (draft) => {
	draft.push({ id: "t1", text: "Write docs", done: false });
});
todos.change(ctx, (draft) => {
	draft[0].done = true;
});
todos.replace(ctx, []);

todos.value;  // 不可变
todos.subscribe((value) => render(value));

// 镜像外部不可变存储：订阅者拿到的是 diff，不是整个值
view.replace(ctx, conversation.view);                    // 新值复用旧容器时做 diff
view.replace(ctx, rebuilt, { diff: true });              // 总是 diff
```

- `change` 是原子的：要么一个新修订版，要么回调抛错则什么都不变。
- `change` 只触碰你修改的路径，所以代码不认识的字段能存活。只在代码拥有整个值时用 `replace`。
- 值是不可变的。绝不修改你读到或收到的值。
- 远程引用先收到其变体每个状态成员的快照，然后是增量。重连或重载后收到 `reset` 快照，不重放任何东西。
- `replace` 在新旧值共享容器时（同一状态的新修订版）发送结构化 diff，否则发送单次整体替换。`{ diff: true | false }` 可以强制其一。两种方式下值都一样。
- 实现可以把另一个对象的状态成员暴露为自己的：`return { variant: "viewer", view: conversation.view }`。只有当该成员有了值（本地或远程），对象才上线。

**第一个值来自某个源的单元**声明 `{ init }` 而不是初始值：

```ts
const db = self.resource("db", { version: 1, open: () => openSqlite(path), close: (db) => db.close() });
const notes = self.state("notes", Type.Array(NoteSchema), { init: () => db.value.all("SELECT * FROM notes") });
```

`init(ctx)` 在资源打开、引用上线之后、对象上线之前运行，所以任何方法、监听器、任务或订阅者都不会看到非来自源的值。用任务来加载值则只会在对象上线后才开始：中间进来的方法会从占位符得到答案（存在的笔记读出来是 unknown），且异步加载可能在 `await` 期间覆盖一次写入。`init` 可以是异步的，并拿到一个 `ctx` 去调用其他对象。同一对象的多个 `init` 并行运行，所以一个不能读另一个的单元。抛错或值不合法会使激活失败。重载保留单元及其值，不再运行 `init`；重载新增的单元在重载准备阶段运行 `init`，其失败会拒绝这次重载。

`init` 读取的是对象反正要有的源。它不保存任何东西：必须活过进程的东西，由修改它的代码写到那个源（数据库、文件、Durable 文档）里。

```ts
const visible = self.derive([catalog.rows], (rows) => rows.filter((r) => visibleTo(principal, r)));
const openCount = self.derive([todos], (t) => t.filter((x) => !x.done).length);
```

派生函数是同步的。派生没有名字：每次重载都产生一个新的，在重载提交时计算。

## 调用、ctx 与 root

每个方法拿到 `(args, ctx)`，无参数方法拿到 `(ctx)`。把 `ctx` 传给你调用的所有东西：

```ts
send: async (input, ctx) => {
	ctx.signal.throwIfAborted();
	const uploads = await ctx.get(Uploads, {});  // 本次调用拥有的引用；落定时释放
	const files = await uploads.resolve({ ids: input.uploads }, ctx);
	return c.submit({ ...input, files }, author, ctx);
},
```

**root** 是一棵短的调用树，从入口开始：
- 由链路发起，针对没有 root 就到达的请求；
- 由 `host.root(fn)` 发起，针对定时器和脚本；
- 由投递给监听器的每个事件发起（`self.on`）；
- 由 `task` 或 Durable 阶段发起的每个 Chord 调用发起。

一个 root 在它启动时的代码（其**代码版本**）上运行，跨宿主，直到结束。保持 root 短。长期运行的工作用 `task`，长时间等待用状态。

```ts
// 错误：把一个 root（及其那版代码）挂住几分钟
approve: async (ctx) => waitForHuman(ctx),

// 正确：把请求记为状态；答复是另一个调用
request: async (req, ctx) => {
	pending.change(ctx, (d) => {
		d.push(req);
	});
},
answer: async ({ id, value }, ctx) => {
	pending.change(ctx, (d) => {
		settle(d, id, value);
	});
},
```

## 生命周期

对象在被**引用**期间存活，每个引用都有归属：

| 归属 | 获取方式 | 释放时机 |
| --- | --- | --- |
| 另一个对象 | `self.get` | 该对象被销毁，或不再声明它 |
| 一次调用 | `ctx.get` | 调用落定 |
| 一个连接 | 远程宿主的 `get` | 释放、断连、撤销 |
| 宿主 | `lifetime: "host"` | 宿主关闭（或重载移除了它的 facet） |
| UI | `useObject` | 卸载 |

- **销毁（disposal）**在最后一个引用释放后运行，再加 `linger`。任务被中止、监听器移除、资源按逆序关闭（每个 close 都会运行，错误被收集），然后释放对象自己的引用，这可能进一步销毁其他对象。
- **资源的 `close` 仍可以使用其对象引用的对象。**宿主关闭和撤销也一样：`host.close()` 和 `invalidatePrincipal` 先销毁引用方，再销毁被引用方，最后关闭链路。在 `close` 中给跨链路的远程调用绑定 signal：链路已断的调用会等待重连。
- **强制销毁**（撤销、归档）让引用立刻变 `gone`，并中止进行中的调用。
- **引用不能成环。**在单个宿主内，这在 `get` 时检查。

```ts
host.serve(Conversation, conversationFactory, { linger: 30_000 });  // 很快切回来不会重新打开它的 watch
host.serve(Index, indexFactory, { lifetime: "host" });              // 从加载到宿主关闭只有一个对象
```

**`lifetime: "host"`** 用于输入为空（或只有默认值）的本地类型：该类型恰好有一个对象，在其 facet 加载时以宿主主体创建。每个 `get` 都到达那个对象，无论谁在问；带其他输入的 `get` 是无效的。别人持有的引用不改变它的生命周期，它也不能 `linger`。只有这类对象能向注册表注册。TypeScript 会拒绝远程类型、有必填字段的输入使用 `lifetime: "host"`，也拒绝它与 `linger` 同时使用；`serve` 在运行时做同样的检查，针对没有类型的调用方。

## 注册表

```ts
export const Routes = defineRegistry<RouteHandler>("http.routes", { conflict: "error" });

// 贡献（只能来自 `lifetime: "host"` 对象）
host.serve(Downloads, (_, _host, self) => {
	const blobs = self.get(Blobs, {});
	self.register(Routes, {
		"GET /download": async (request, who, ctx) => {
			const file = await blobs.find({ id: request.query.id }, ctx);
			if (!canView(who, file.session)) return forbidden();
			return stream(file, ctx);
		},
	});
	return {};
}, { lifetime: "host" });

// 消费：一个请求看到的是它自己代码版本的表
server.on("request", (req, res) =>
	host.root(async (ctx) => {
		const route = host.registry(Routes).get(`${req.method} ${pathOf(req)}`, ctx);
		return route ? route(req, principalOf(req), ctx) : notFound(res);
	}),
);
```

- 每个代码版本有一张完整的表。重载绝不会出现某项缺失的瞬间。
- 在重载前启动的请求继续用旧表。
- 顺序是首次注册顺序，替换后保留。
- `conflict: "error"` 使重复的键导致注册（或重载）失败。

## 插件

插件是一个功能，每种宿主一个 **facet**：

```text
plugins/chat/
  contract.ts    Chat, Conversation, Drafts
  server.ts      服务器的 facet
  worker.ts      会话 worker 的 facet
  web.tsx        浏览器的 facet
```

```ts
// plugins/chat/worker.ts
import { defineFacet } from "@earendil-works/chord";
import { Chat, Conversation } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(Conversation, conversationFactory, { linger: 30_000 });
	host.serve(Chat, chatFactory);
});
```

```ts
// 宿主加载插件中属于自己种类的 facet
await host.load([
	new URL("../plugins/chat/worker.ts", import.meta.url),
	new URL("../plugins/status/worker.ts", import.meta.url),
]);
```

内置插件是本仓库的可信代码，直接从源码加载。

facet 的 `setup` 参数就是它的宿主，收窄到插件需要的部分：`serve`、`name`、`root(fn)`、`registry(R)` 和 `signal`——当这一轮 facet 不再被安装时（被重载替换或移除，或加载它的重载中止），signal 会中止。不是 Chord 方法、监听器或任务的代码（Durable 工具和钩子、原生库的回调）用它来启动 root 和读注册表，而不是去找进程级全局宿主：

```ts
export default defineFacet((host) => {
	host.serve(Sessions, sessionsFactory);
	tools.register("rename_session", (args) =>
		host.root(async (ctx) => (await ctx.get(Sessions, {})).rename(args, ctx)),
	);
});
```

## 热重载

```ts
await host.reload([new URL("../plugins/chat/worker.ts", import.meta.url)]);  // 或重载所有变化的插件
```

### 发生什么

1. **加载**新模块。
2. **准备（prepare）：**在现有对象上运行新工厂，无副作用。单元写入抛错，监听器和任务不启动，注册被收集，变化的资源在旧资源旁打开。契约对每个在线消费者做检查。任何失败都让一切保持原样。
3. **闸门（gate）：**仅当某单元的版本被提高或排他资源变化时才需要。
4. **提交（commit）：**在一个同步步骤里，安装新代码、换注册表、重启任务、重绑监听器，并向订阅者发送 `reset` 和形状更新。
5. **退役（retire）：**旧代码继续运行它启动的 root。它们结束后被丢弃，连同只有它声明的东西。如果下一个重载开始时它们还在运行，那个重载最多等 `retireDeadline`，然后中止它们（通过 `ctx.signal`），再关闭只有旧代码使用的东西。

### 兼容变更：无需等待

修 bug、新方法、新单元、新资源和注册变更都立即切换。旧代码上启动的 root 在旧代码上结束，新 root 拿到新代码。

### 改变状态的形状或含义：提高单元版本

```ts
// v1: { running, tasks }，其中 tasks 数的是阶段
// v2: tasks 数的是任务，usage 是新增的
host.serve(StatusStore, ({ session }, _host, self) => {
	const status = self.state("status", StatusV2, { running: false, tasks: 0, usage: emptyUsage() }, {
		version: 2,
		migrate: (old, from) => (from < 2 ? { running: old.running, tasks: 0, usage: emptyUsage() } : old),
	});
	return {
		status,
		report: async (s, ctx) => {
			status.replace(ctx, s);
		},
	};
});
```

在闸门处，对每个在线的 `StatusStore`：
1. **已进入的 root 先完成。**它们的重入调用被放行。
2. **还没接触过它的旧 root 拿到 `upgrade_conflict`**，而不是让旧代码碰已迁移的状态。它们作为新 root 重试。
3. **`migrate` 在私有副本上运行**，结果对照新 schema 校验。
4. **提交。**新 root 使用新代码和迁移后的状态。

如果闸门内的 root 在期限内（5 秒）没完成，重载被**中止**，什么都不变。错误会指出阻塞的 root。

版本属于单元（默认 1）；对象的其他单元不迁移。运行时逐单元比较新旧代码的 schema 和版本：
- 不变：兼容；
- 版本提高：迁移（没有 `migrate` 则值保留，且必须符合新 schema）；
- schema 变了**但**版本没提高，或版本降低：重载被拒绝。

schema 完全相同但含义变了也需要提升版本。这种事运行时无法替你检测。

### 资源

```ts
const db = self.resource("db", { version: 2, open: () => openSqlite(path, { wal: true }), close: (db) => db.close() });  // 1 → 2: 重新打开
const port = self.resource("port", { version: 1, exclusive: true, open: () => listen(8787), close: (s) => s.close() });
```

- 重载保留资源已打开的值，除非其 `version`、`deps` 或 `exclusive` 变化：`open` 不会再次运行。版本是必填的：原生值没有 schema 可供检测变化。保留的资源在提交时仍采用新代码的声明，所以之后的 `close` 是新代码的。
- 变化的资源在准备阶段于旧资源旁打开。旧资源在旧代码退役时用它自己的 `close` 关闭。
- `exclusive` 资源不能同时存在两个，所以在闸门处交换：关旧的、开新的，失败则重新打开旧的。

### 契约变更

| 变更 | 结果 |
| --- | --- |
| 增量式，版本不变 | 重载；消费者继续工作 |
| 破坏性，版本已提升，带 `accepts[old]` | 重载；旧消费者走适配器 |
| 破坏性，无适配器 | 拒绝，除非消费者在同一批里重载 |
| 破坏性，版本未提升 | 拒绝："consumer needs member …" |

宿主自己**指向 `lifetime: "host"` 对象的引用**是生命周期钉（lifecycle pin），不是旧版本消费者。当重载替换其提供者时，这个引用在提交时采用新契约；它不要求为自己的 `accepts` 适配器。对象、单元和未变化的资源保持存活，无需重新激活。被拒绝的重载保留原引用和原契约。其他引用（`self.get`、`ctx.get`、`host.get`、对端）仍遵守上面的兼容性规则；存储状态变化时仍需要状态版本提升和迁移。

### 多个插件同时重载

一起重载它们：`host.reload([a, b])`。准备阶段一次性看到所有新代码，所以变化的契约和它的更新消费者可以互相校验。

在服务器上，`host.reload(serverFacets, { remote: { "session:": workerFacets } })` 会同时重载每个已连接的 worker。它的报告覆盖服务器；`report.children["session:S1"]` 说明每个 worker 变更、准备和闸门了什么。

## 宿主与链路

```ts
// 服务器
const server = createHost<Principal>({ name: "server", self: { kind: "host" }, principalKey });
server.accept(webSocketLink(wss, { principal: (req) => authenticate(req) }));  // 从 cookie 盖上 owner 或 guest 印记
server.route("session:", {
	authorize: (principal, host) => canReach(principal, host),  // 在解析或孵化之前
	resolve: (host) => workers.ensure(host),  // 指向 worker 的链路，需要时孵化
	principal: (host) => workers.principal(host),  // worker 调用服务器时以什么身份
});

// worker
const worker = createHost<Principal>({
	name: `session:${id}`,
	self: { kind: "host" },
	principalKey,
	upstream: { link: ipcLink(process), principal: { kind: "server" } },  // 服务器自己的请求以此身份行动
});

// 任何地方
const chat = await ctx.get(Chat, { session: "S1", conversation: 1 });  // 浏览器 → 服务器 → worker session:S1
const sessions = self.get(Sessions, {});  // `hostNamed("server")`：worker → 服务器，以 worker{S1} 身份
```

- **服务器在其子级之间中继**：worker 到 worker，浏览器到 worker。
- **断连：**浏览器断开时，恰好释放它在各 worker 中持有的引用。
- **跨链路的主体：**
  - 被转发的主体只接受来自父级链路的；
  - 对象自己发起的调用以它的宿主身份行动；
  - 链路互相 ping，死链路释放通过它持有的一切。
- **客户端来源：**来自浏览器的持有带有其连接的不透明 id（`origin`），服务器中继该持有时转发它，worker 因此能区分自己的客户端。客户端不能自行设置它。断连会立刻释放该客户端的持有。
- **慢对端：**对端确认它处理了什么。当一窗口（`window`，默认 256 KiB）的帧未被确认时，状态等待并按成员的流合并；调用、结果和新引用的第一个快照从不停滞，所以一个 `get` 不会排在其他引用的状态后面。等待中的操作按链路设上限（`pendingCap`，默认四个窗口）：超过后，最旧的流被其当前值替换。所以高负载下，结果可能先于它 caused 的状态变化到达：等你需要的状态，而不是假设调用返回时它已经在那里。
- **跨宿主重载：**服务器为每个宿主协调准备和提交。
- **晚启动的 worker**（重载后才孵化的）在被路由任何东西之前，先追平服务器的代码版本。期间它们的 root 对服务器的调用改在服务器当前代码版本上运行，而不是失败 `superseded`。
- **协议版本：**两端在 hello 中宣布链路协议版本。不同版本的对端不通信：链路关闭，`onProtocolMismatch`（`connect` 和 `accept` 的 `LinkOptions` 字段）通知需要加载新代码的一侧。浏览器重载页面而不是重连：

  ```ts
  host.connect(webSocketLink(socket), { onProtocolMismatch: () => location.reload() });
  ```
- **浏览器**不参与提交。它们通过形状和 `reset` 消息了解新代码，不兼容的契约让它们的调用以 `upgrade_required` 失败。

## Durable

worker 的宿主把 Durable Harness 作为 `lifetime` 为 `"host"` 的本地对象提供。Durable 阶段不是 root：它由 Durable 自己钉在其注册表快照上。钩子或工具发起的每个 Chord 调用都开始一个全新的短 root。

```ts
host.serve(Harness, (_, _host, self) => {
	const durable = self.resource("durable", {
		version: 1,
		open: () => DurableHarness.open(storage, { models, registry: durableRegistry(host, Extensions) }),  // 读取代码版本表的读取器
		close: (h) => h.close(),
	});
	return { conversation: (id: number) => durable.value.conversation(id) };
}, { lifetime: "host" });

// 插件像任何注册一样贡献一个 Durable 扩展
host.serve(Guard, (_, _host, self) => {
	self.register(Extensions, {
		guard: defineExtension({
			name: "guard",
			hooks: [hook(ToolTask, { beforeTool: (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined) })],
		}),
	});
	return {};
}, { lifetime: "host" });
```

一次改变 guard 的重载：已在运行的 Durable 阶段保留旧快照，下一个阶段用新的，任何时刻都不会出现没有 guard 的阶段。

## 错误

| 代码 | 含义 |
| --- | --- |
| `forbidden` | 工厂或方法拒绝了这个主体 |
| `invalid` | 输入、参数或结果未通过校验 |
| `not_ready` | 在工厂内使用了声明的资源或引用，或在引用第一次注水前读了状态 |
| `not_in_variant` | 该成员不存在于你所拥有的变体中 |
| `released` | 引用已被释放 |
| `gone` | 对象在被引用期间被强制移走。重新调用 `get`。 |
| `contract_mismatch` | 提供者的契约不覆盖消费者的，且没有适配器 |
| `upgrade_conflict` | 一个旧 root 碰到了已被迁移的对象。作为新 root 重试。 |
| `superseded` | root 的代码版本在此宿主上已不可用。重试。 |
| `upgrade_required` | 浏览器的契约过时了。重载它的 web facets。 |
| `unavailable` | 目标宿主无法到达或启动；原因 `ready_timeout`：引用在 `readyTimeout` 内未就绪 |
| `aborted` | 调用的 `ctx` 被取消 |

## 经验法则

| 应该 | 不应该 |
| --- | --- |
| 可重载的状态放在单元里 | 闭包变量（重载即丢失） |
| 单元的形状或含义变化时，提升单元版本并写 `migrate` | 改 schema 不提版本（被拒绝），改含义不提版本（静默出错） |
| 破坏性变更提升契约版本；为旧消费者加 `accepts` | 同一版本下重命名或删除成员（被拒绝） |
| 慢的设置放在资源的 `open` 里 | 在工厂内 await（工厂是同步的） |
| 副作用放在资源、监听器、任务和注册里 | 在工厂体内做副作用（它们会在准备阶段运行） |
| 方法内用 `ctx.get` | 方法内用 `self.get`（每次调用都会新建引用） |
| 保持 root 短；长等待用状态 | 在方法里 await 一个人 |
| 在方法里检查参数 | 把变体当成全部授权 |
| 到处传 `ctx` | 用调用方的 `ctx` 启动后台工作（应该用任务） |
| 把状态值当作不可变的 | 修改你读到的值 |
