# 用 Chord 构建一个共享待办清单

## 1. Chord 解决什么问题？

一个待办清单有数据、对数据的操作，以及若干正在查看它的人。你可以手写对象创建、订阅清理、
进程间消息和代码替换。Chord 替你把这些环节连起来。

**宿主（host）**是拥有对象的运行时。**对象（object）**在某个地址上把状态和方法组合在一起，
比如"家庭待办清单"。**引用（reference）**是调用方指向那个对象的引用，不是对象本身。多个引用
可以到达同一个对象。引用也可以通过连接到达另一个宿主。

```text
browser host                         server host
ref + subscribed rows -- link --> Todos view (owner or guest)
                                           |
                                        ref
                                           v
                                   TodoStore: rows + methods
```

我们将从单个宿主内部开始，加入可观察状态，然后与浏览器共享它。最后再加入后台工作、插件和
热重载。**实时状态（live state）**指数据变化时订阅者收到新值，而无需再次请求。

<!-- example:01 -->
```ts
const host = createHost({ self: "server", name: "todo-server" });
assert.equal(host.name, "todo-server");
await host.close();
```

断言通过：宿主的名字是 `todo-server`。创建宿主不会创建待办对象、启动服务器套接字或持久化
数据。`close()` 关闭它的对象和连接。

> **提示：**这些是可执行的 TypeScript 示例，用断言展示结果。共享的导入在文末。后面的章节
> 复用前面的契约和函数，但每节的测试都从全新的宿主开始。仅测试用的清理代码会在断言失败时
> 也关闭宿主；代码片段省略了这部分清理。

## 2. 你的第一个对象

在调用方使用对象之前，需要就它的名字和成员达成一致。这个约定就是**契约（contract）**：一个
运行时值，同时也为 TypeScript 提供类型。**schema** 描述一个值的形状。我们用 TypeBox 的
`Type` 编写 schema。`method(args, result)` 按参数和结果的 schema 声明方法：`method()` 不接受
参数也不返回值，而下文用到的 `method(undefined, Type.String())` 不接受参数但返回字符串。

先从一个命名列表的标签开始。`local` 表示只有本宿主内的代码能访问它。输入
`{ list: "family" }` 标识我们想要哪个列表；它不是 `label` 的参数。

<!-- example:02-contract -->
```ts
const TodoLabel = local("tutorial.todos", {
	version: 1,
	input: Type.Object({ list: Type.String() }),
	members: { label: method(undefined, Type.String()) },
});
```

**工厂（factory）**是一个同步函数，它创建对象的实现：调用方将看到的方法和状态。`serve` 注册
一个契约及其工厂。仅注册不会激活这个惰性对象；第一次 `get` 才会。

**root** 是一棵短的调用树，比如一次按钮点击的工作。`host.root` 启动它。它的**上下文**
（context），即 `ctx`，携带取消信号、调用方身份和嵌套调用的代码版本。把它传给你在该 root 中
调用的方法。

<!-- example:02-call -->
```ts
const host = createHost({ self: "server" });
host.serve(TodoLabel, ({ list }) => ({ label: () => `Todos for ${list}` }));
const result = await host.root(async (ctx) => {
	const todos = await ctx.get(TodoLabel, { list: "family" });
	return todos.label(ctx);
});
assert.equal(result, "Todos for family");
```

结果是 `"Todos for family"`。`await ctx.get` 在对象上线后完成（而且，后面会看到，还要有它的
状态）。通过 `ctx.get` 获得的引用在这个 root 结束时释放。我们从不直接拿到工厂返回的对象。
不带 `ctx` 的独立调用，比如 `todos.label()`，会启动自己的 root。无参数的方法只接受上下文：
`todos.label(ctx)`；它的实现是 `(ctx) => …`。在 root 或方法内部，传入已有的 `ctx`，让嵌套调用
留在同一棵调用树里。

工厂还可以收到 `principal`（谁在请求）和 `self`（对象的声明 API）。我们暂时还不需要它们。

> **为什么：**引用把调用方与实现分开。之后替换代码时，不需要替换每个调用方的引用。

## 3. 给列表加上实时状态

一个标签不是待办清单。我们需要能变化的行（rows），以及一个始终与之一致的计数。**单元
（cell）**拥有一个可观察的 JSON 值。**派生（derivation）**从单元或其他可读源计算另一个可观察
值。

扩展契约，加入 `rows`、`openCount` 和编辑方法。状态成员描述的是值，不是方法。这在与约版本 1
上新增了成员；只需要 `label` 的旧调用方仍然拥有它需要的一切。

`self.state(name, schema, initial)` 声明一个单元并返回它。名字 `rows` 很重要：重载时，Chord
按这个名字匹配到已有单元并保留其值。`self.derive(sources, fn)` 声明一个派生；它没有名字，
因为它不持有任何重载必须保留的东西。

<!-- example:03-contract -->
```ts
const Todo = Type.Object({ text: Type.String(), done: Type.Boolean() });
const Rows = Type.Array(Todo);
const TodoStore = local("tutorial.todos", {
	version: 1,
	input: Type.Object({ list: Type.String() }),
	members: {
		label: method(undefined, Type.String()),
		rows: Rows,
		openCount: Type.Number(),
		add: method(Type.Object({ text: Type.String() })),
		finish: method(Type.Object({ index: Type.Integer() })),
		reset: method(Rows),
	},
});
```

工厂现在声明一个单元和一个派生。它被包在 `todoStore` 里，后者接受单元的选项（第 9 节会提升
其版本）；目前 `todoFactory` 使用默认值。每个方法收到自己的参数和一个上下文；修改单元会同时
更新它的读取者和派生出的计数。`add`、`finish` 和 `reset` 没有声明结果，所以它们不返回值。

<!-- example:03-factory -->
```ts
/** The store's factory; `options` versions its rows (section 9). */
const todoStore =
	(options?: StateOptions<Static<typeof Rows>>): Factory<typeof TodoStore> =>
	({ list }, _principal, self) => {
		const rows = self.state("rows", Rows, [], options);
		const openCount = self.derive([rows], (todos) => todos.filter((todo) => !todo.done).length);
		return {
			label: () => `Todos for ${list}`,
			rows,
			openCount,
			add: ({ text }, ctx) => {
				rows.change(ctx, (draft) => {
					draft.push({ text, done: false });
				});
			},
			finish: ({ index }, ctx) => {
				rows.change(ctx, (draft) => {
					const todo = draft[index];
					if (!todo) throw invalid("args", "No such todo");
					todo.done = true;
				});
			},
			reset: (next, ctx) => {
				rows.replace(ctx, next, { diff: true });
			},
		};
	};
const todoFactory = todoStore();
```

`change(ctx, fn)` 给 `fn` 一个临时的可变**草稿（draft）**。这里 `add` 推入一行，`finish` 改一个
字段。回调抛错时草稿被丢弃。回调必须是同步的。

`replace(ctx, value)` 替换整个值。我们用它重置一个完全归我们拥有的列表。`{ diff: true }` 要求
Chord 只发布结构上的变化。不带该选项时，当新值与旧值在相同键上共享容器，替换会自动做 diff；
无关的值通常发布整体替换。无论哪种方式，订阅者收到的最终值都相同。

<!-- example:03-call -->
```ts
const host = createHost({ self: "server", dev: true });
host.serve(TodoStore, todoFactory);
const todos = await host.get(TodoStore, { list: "family" });
const counts: (number | undefined)[] = [];
const stop = todos.openCount.subscribe((value) => counts.push(value));
await host.root(async (ctx) => {
	await todos.add({ text: "Buy milk" }, ctx);
	await todos.finish({ index: 0 }, ctx);
	await todos.reset([], ctx);
});
assert.deepEqual(counts, [0, 1, 0]);
assert.deepEqual(todos.rows.value, []);
stop();
todos.release();
```

计数订阅者看到 `0, 1, 0`：最初为空、一个未完成的待办、然后没有未完成的待办。重置为空不会
再触发一次计数通知，因为派生出的计数仍然是零。最终的行是 `[]`。`subscribe` 立即用当前值回调
一次，并返回取消订阅函数。被 await 的 `get` 确保值已存在：你持有的引用是上线的，带着它的
状态。

> **为什么：**可重载的状态放在单元里，不放闭包变量。把 `cell.value`、`ref.rows.value` 和订阅
> 值当作不可变。只在 `change` 内修改草稿；不要把草稿留到以后用。派生是同步运行的，所以用它
> 做投影，不要做数据库操作。

## 4. 让对象使用对象和资源

保存一个待办可能同时需要列表和数据库连接。**引用**让它指向的对象保持存活。`self.get` 声明
一个由本对象拥有的引用；它比单次方法调用活得更久。

**资源（resource）**是运行时打开、之后关闭的东西，比如数据库连接。它的 `open` 可以是异步的，
即使工厂必须是同步的。示例数据库是刻意伪造的：它只是把字符串存在内存里。

`opaque<T>("name@version")` 描述一个原生的、仅限宿主的成员。它不是 JSON 状态，不能跨链路
发送。`self.expose` 把那个成员连接到声明的资源，且不在工厂期间读取资源。

<!-- example:04-database -->
```ts
const Database = local("tutorial.database", {
	version: 1,
	input: Type.Object({}),
	members: { db: opaque<{ saved: string[] }>("tutorial.database@1") },
});
const SavedTodos = local("tutorial.saved-todos", {
	version: 1,
	input: Type.Object({ list: Type.String() }),
	members: { add: method(Type.Object({ text: Type.String() })) },
});
const host = createHost({ self: "server" });
let opens = 0;
const closed = Promise.withResolvers<void>();
host.serve(Database, (_input, _principal, self) => {
	const db = self.resource("db", {
		version: 1,
		open: async () => {
			opens++;
			return { saved: [] as string[] };
		},
		close: () => closed.resolve(),
	});
	return { db: self.expose(db) };
});
```

工厂返回一个暴露的标记，不是已打开的连接。Chord 在声明完成后运行 `open`。名为 `closed` 的
Promise 让测试能观察到最终的清理。

现在把 `SavedTodos` 声明为同时持有 store 和数据库的对象。它的编辑方法只在激活之后才使用
这些依赖。

<!-- example:04-saving -->
```ts
host.serve(TodoStore, todoFactory);
host.serve(
	SavedTodos,
	({ list }, _principal, self) => {
		const database = self.get(Database, {});
		const todos = self.get(TodoStore, { list });
		return {
			add: async ({ text }, ctx) => {
				database.db!.saved.push(text);
				await todos.add({ text }, ctx);
			},
		};
	},
	{ linger: 0 },
);
```

一个外部消费者持有 `SavedTodos` 的引用。我们也直接持有 `Database`，以便检查保存了什么。

<!-- example:04-call -->
```ts
const saved = await host.get(SavedTodos, { list: "family" });
const database = await host.get(Database, {});
await host.root((ctx) => saved.add({ text: "Buy milk" }, ctx));
assert.deepEqual(database.db!.saved, ["Buy milk"]);
assert.equal(opens, 1);
const statuses: string[] = [];
saved.onStatus((status) => statuses.push(status));
database.release();
saved.release();
await closed.promise;
assert.equal(saved.status, "released");
assert.ok(statuses.includes("released"));
```

方法执行后，假数据库里有 `["Buy milk"]`。它只打开了一次，尽管有两个对象引用它。
`SavedTodos` 和 `Database` 只有在它们的资源和声明的依赖就绪后才上线。这就是为什么在这个
已上线对象的方法里 `database.db!` 是安全的：激活已经建立了那个依赖。外部调用者则要 await 它
的 `get`。

两个外部引用都释放后，`SavedTodos` 被销毁，并释放它自己的数据库引用。没有引用剩下时，数据
库关闭；我们等 `closed.promise` 来证明这一点。被释放的引用保持 `released` 状态，
`onStatus` 报告这次转变。`onStatus` 观察变化；与状态订阅不同，它不投递初始状态。

`linger` 是最后一个引用释放后的延迟（毫秒）。零表示不设宽限期直接销毁；正值可以在屏幕短暂
隐藏时避免重新打开昂贵的资源。linger 不是持久化。

> **提示：**工厂只声明依赖。绝不在工厂里调用被引用对象的方法或读 `resource.value`，重载期间
> 也不行。激活发生在其后。当资源的配置需要重新打开时，提升它的 `version`。销毁会停止任务和
> 监听器、关闭资源，然后释放引用。

## 5. 谁在请求？一个 store，两种视图

所有者可以添加待办；访客只能读。**主体（principal）**是应用定义的调用方身份。**变体
（variant）**是远程对象向某个主体提供的一组命名成员。它让 UI 得以发现编辑方法是否可用。

不要为每个查看者创建单独的数据单元：他们的列表会分叉。相反，每个视图持有同一个宿主本地的
`TodoStore` 并暴露它的行。`self.get` 以宿主自己的主体行动，所以所有者视图和访客视图共享那个
store。远程视图对象本身则按主体键分开。远程契约还要说明它的对象位于哪里：
`host: hostNamed("server")` 把每个 `Todos` 对象放到名为 `server` 的宿主上。第 6 节会用到。

<!-- example:05-views -->
```ts
const Todos = remote("tutorial.todo-view", {
	version: 1,
	input: Type.Object({ list: Type.String() }),
	host: hostNamed("server"),
	variants: {
		viewer: { state: { rows: Rows } },
		editor: {
			state: { rows: Rows },
			methods: { add: method(Type.Object({ text: Type.String() })) },
		},
	},
});

/** Who may ask: the owner, a guest, or the server's own code. */
type Principal = "owner" | "guest" | "server";

function serveViews(api: Pick<Host<Principal>, "serve">): void {
	api.serve(Todos, ({ list }, principal, self) => {
		if (list !== "family") throw forbidden("This list is not shared");
		const store = self.get(TodoStore, { list });
		if (principal === "guest") {
			return { variant: "viewer", rows: store.rows };
		}
		return {
			variant: "editor",
			rows: store.rows,
			add: ({ text }, ctx) => {
				if (text.trim().length === 0) throw invalid("args", "A todo needs text");
				return store.add({ text }, ctx);
			},
		};
	});
}
```

这里的主体是字符串 `"owner"` 和 `"guest"`，由可信的应用代码赋予；还有 `"server"`，即宿主自己
的代码：每个宿主创建时都带有 `self`，即它自己的 root 和对象所代表的主体。Chord 不发明主体。
`createHost` 和 `Host` 的 `Principal` 类型参数把工厂里的 `principal` 定为该类型，所以
TypeScript 会检查那些比较。`principalKey` 把身份映射到对象身份。真实应用应该使用稳定身份、
连接来源和授权修订号，而不是显示名。

<!-- example:05-call -->
```ts
const host = createHost<Principal>({ name: "server", self: "server", principalKey: (principal) => principal });
host.serve(TodoStore, todoFactory);
serveViews(host);
const owner = await host.get(Todos, { list: "family" }, { principal: "owner" });
const guest = await host.get(Todos, { list: "family" }, { principal: "guest" });
assert.ok(owner.variant === "editor"); // narrows the reference to the editor variant
assert.equal(guest.variant, "viewer");
await host.root((ctx) => owner.add({ text: "Buy milk" }, ctx), { principal: "owner" });
assert.deepEqual(guest.rows.value, [{ text: "Buy milk", done: false }]);
// @ts-expect-error A viewer has no add: TypeScript refuses it, and so does the provider.
await assert.rejects(guest.add({ text: "Not allowed" }), (error) => isChordError(error, "not_in_variant"));
await assert.rejects(owner.add({ text: " " }), (error) => isChordError(error, "invalid"));
```

所有者拿到 `editor`；访客拿到 `viewer`。两者看到同一条牛奶待办。引用的类型是其各变体的联合：
`add` 只有在按 `variant` 收窄后才可访问（`assert.ok(owner.variant === "editor")` 就在做这个）。
访客的 `add` 被 TypeScript 拒绝，即使强行调用也会以 `not_in_variant` 拒绝。纯空白文本以
`invalid` 拒绝：它是字符串，符合 schema 要求，但违反了只有方法知道的规则。坏的输入用
`invalid`；`forbidden` 只用于不允许做某事的调用方。

> **为什么：**变体不是全部授权。工厂检查哪个列表可以打开；方法检查操作的参数。生产代码还
> 必须执行可能变化的授权。用 `host.invalidatePrincipal(match)` 撤销匹配的对象；被持有的引用
> 变成 `gone`。UI 观察 `onStatus`，在合适时拿新的引用。访客提供的名字或消息文本绝不能用来
> 确立身份。

## 6. 从另一个进程访问列表

浏览器无法调用仅限宿主的契约。`remote` 契约只描述经过 schema 校验、能以 JSON 传输的状态和
方法。我们的 `Todos` 视图是远程的；底层的 `TodoStore` 和数据库保持本地。调用方永远不指定宿主：
`browser.get(Todos, …)` 到达 `server` 是因为契约这么说的，而服务器会拒绝提供、或被要求提供
一个不归它放置的类型。每个会话放在一个宿主上的类型写
`host: hostFamily("session:", "session")`：其输入的 `session` 字段选择宿主
（`{ session: "S1" }` 位于 `session:S1`）。

**链路（link）**在宿主之间承载有序消息。内存链路在一个测试进程里运行两端，但使用远程协议。
接受方宿主从它的认证器那里盖上调用方的主体印记，而不是从方法参数或客户端自报的身份。连接方
声明其父级自己的请求以什么主体行动（`upstream: { link, principal }`，或 `connect(link, {
principal })`）。

<!-- example:06 -->
```ts
const server = createHost<Principal>({ self: "server", name: "server" });
server.serve(TodoStore, todoFactory);
serveViews(server);
const [down, up] = memoryLinkPair();
server.accept(down, { principal: "owner", kind: "client" });
const browser = createHost({
	self: "browser",
	name: "browser",
	kind: "client",
	upstream: { link: up, principal: "server" },
});
const todos = await browser.get(Todos, { list: "family" });
assert.ok(todos.variant === "editor");
assert.deepEqual(todos.rows.value, []);
const updated = Promise.withResolvers<void>();
const stop = todos.rows.subscribe((rows) => {
	if (rows.length === 1) updated.resolve();
});
await browser.root((ctx) => todos.add({ text: "Buy milk" }, ctx));
await updated.promise;
assert.deepEqual(todos.rows.value, [{ text: "Buy milk", done: false }]);
// Deliberately bypass TypeScript to simulate a malformed caller.
await assert.rejects(todos.add({ text: 123 } as never), (error) => isChordError(error, "invalid"));
stop();
// A held reference keeps its state without listeners.
assert.deepEqual(todos.rows.value, [{ text: "Buy milk", done: false }]);
todos.release();
```

浏览器先看到空快照，然后是新的牛奶待办。`ready` 表示远程引用已绑定到一个上线的对象**并且**
拥有它的状态：其变体的每个状态成员都有快照。被持有的引用保持订阅状态，无论有没有监听器，
直到被释放。

跨网络传输的内容：输入和消费者的契约描述、提供者的形状（变体和成员）、方法参数和结果，以及
该引用变体的状态。状态以**快照（snapshot）**开始，即当前完整值；后续的**增量（delta）**描述
变化。重绑和重载可能发送 `reset`，一个全新的完整值。函数、资源连接和单元实例不会跨网络传输。

那个故意传的坏参数以 `invalid` 拒绝。远程参数、结果和出站状态都在提供者边界校验。本地方法
没有逐次调用的 schema 校验；它们仍需要应用层检查。`dev: true` 会在开发期间额外检查单元写入。

> **提示：**把 `memoryLinkPair` 换成 `webSocketLink`（WebSocket）或 `ipcLink`（子进程 IPC 通
> 道），对象契约保持不变。那些适配器包装的是已有连接，不是认证器。用已认证的主体配置
> `accept`。浏览器是 `kind: "client"`；受信任的子宿主以 `kind: "host"` 及其配置的名字接受。

## 7. 对变化做出反应并运行后台工作

不是所有工作都来自方法调用。应用可能在行变化时更新活动指示器，或运行后台提醒。**监听器
（listener）**对一个可观察源做出反应。**任务（task）**是由对象拥有的后台执行，在对象被销毁
或其代码被重载时中止。

我们的活动对象镜像行数。它的任务插入一条示例待办，然后等待关闭。这些 Promise 让那些事件在
测试中是确定的；它们不是存储的应用状态。

<!-- example:07 -->
```ts
const Activity = local("tutorial.activity", {
	version: 1,
	input: Type.Object({}),
	members: { seen: Type.Number() },
});
const host = createHost({ self: "server" });
host.serve(TodoStore, todoFactory);
const observed = Promise.withResolvers<void>();
const seeded = Promise.withResolvers<void>();
const stopped = Promise.withResolvers<void>();
host.serve(Activity, (_input, _principal, self) => {
	const todos = self.get(TodoStore, { list: "family" });
	const seen = self.state("seen", Type.Number(), 0);
	self.on("rows", todos.rows, (rows, ctx) => {
		seen.replace(ctx, rows?.length ?? 0);
		if (rows?.length === 1) observed.resolve();
	});
	self.task(async (ctx) => {
		await todos.add({ text: "Review the list" }, ctx);
		seeded.resolve();
		await new Promise<void>((resolve) => {
			if (ctx.signal.aborted) resolve();
			else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
		});
		stopped.resolve();
	});
	return { seen };
});
const activity = await host.get(Activity, {});
await Promise.all([seeded.promise, observed.promise]);
assert.equal(activity.seen.value, 1);
activity.release();
await stopped.promise;
```

最终的 `seen` 是 `1`。每个监听器事件都收到一个全新 root 的 `ctx`；它的写入属于那棵短调用树。
任务不是一个巨大的 root：用任务上下文发起的 Chord 方法调用会开始全新的短 root。我们把那个
上下文传给 `todos.add`，让取消跟随任务。释放 activity 引用会中止它的任务并 resolve
`stopped`。

`self.on(name, source, handler)` 声明监听器；`self.task(fn)` 声明任务。状态上的监听器（如此处
的 `rows`）启动时拿到当前值，之后每次变化都拿到。每当重载替换了它的源（派生在每次重载时都
是新的），它再次拿到当前值，所以处理函数必须做调和（`seen` 是从行数设置的，不是累加的）。
监听器还可以用 `self.on(name, resource, select, handler)` 订阅资源的事件流：`select` 拿到已打
开的资源并返回带 `subscribe` 的东西；事件流不投递当前值。只要资源和选择器不变，保留的订阅
就能跨重载存活；处理函数切换到新代码。捕获了会变化的配置的选择器应该换个新的监听器名字。
任务没有名字：重载会重启所有任务。

> **为什么：**不要在方法里等一个人、睡几分钟或跑无限循环。那会把一个 root 钉住，还可能阻塞
> 状态迁移。把待处理的请求存进单元，在另一个调用里答复；或者用遵守 `ctx.signal` 的任务。绝不
> 把已完成方法的 `ctx` 留着做后台工作。

## 8. 把功能打包成插件

现在插件可以贡献一个菜单动作，而不需要修改中央 switch。**注册表（registry）**是一张命名的
贡献表。**facet** 是插件针对一种宿主的代码：它提供对象类型。插件可以有服务器、worker 和浏
览器 facet，各自安装该功能的一部分。

注册属于 **lifetime 为 `"host"`** 的对象：宿主在其 facet 加载时创建这样的对象，并保留到宿主
关闭，即使没有屏幕需要它。这让我们的菜单贡献一直存在。默认 lifetime（`"referenced"`）的对象
仍然只在被引用时创建。

<!-- example:08 -->
```ts
const Actions = defineRegistry<(ctx: Ctx) => Promise<number>>("tutorial.actions");
const Menu = local("tutorial.menu", { version: 1, input: Type.Object({}) });
let click: (() => Promise<number>) | undefined;
const storeFacet: Facet = {
	name: "todo-store",
	...defineFacet((api) => api.serve(TodoStore, todoFactory)),
};
const menuFacet: Facet = {
	name: "todo-menu",
	...defineFacet(
		(api) => {
			api.serve(
				Menu,
				(_input, _principal, self) => {
					const todos = self.get(TodoStore, { list: "family" });
					self.register(Actions, {
						addSample: async (ctx) => {
							await todos.add({ text: "Try plugins" }, ctx);
							return todos.openCount.value;
						},
					});
					return {};
				},
				{ lifetime: "host" },
			);
			click = () => api.root((ctx) => api.registry(Actions).get("addSample", ctx)!(ctx));
		},
		{ uses: [TodoStore] },
	),
};
const host = createHost({ self: "server" });
await host.load([menuFacet, storeFacet], { awaitHostObjects: false });
await host.ready();
assert.equal(await click!(), 1);
assert.equal(host.registry(Actions).table().size, 1);
```

点击返回 `1`，注册表里有一项。菜单的依赖可以来自 load 批次中更靠后的 facet：`load` 先安装整
个批次，再等待宿主对象激活。facet 声明 `uses`，让重载也能检查它消费的契约。

facet API 提供 `serve`、`name`、`root` 和 `registry`。我们普通的 UI 回调使用它保存的
`api.root`，而不是进程级全局宿主。带 `ctx` 查找注册表项用的是该 root 代码版本的表。不带
`ctx`，查找用当前的表。重复的键默认失败；`subscribe` 可以把表桥接到命令式消费者。

通常使用 `await host.load(facets)`（或 `await host.install(facet)`），它会等待那些宿主对象。
本例用 `awaitHostObjects: false` 显式推迟那个屏障，然后 await `host.ready()`。它等待的是宿主
对象的一个快照，不是任务完成或之后的加载。失败会拒绝就绪 Promise；放弃启动需要关闭宿主，
因为安装不是可回滚的事务。

> **提示：**只在需要时使用延迟就绪。worker 可能必须先 await 一个独立的本地引导引用，宣布控
> 制就绪让父级接纳它的链路，然后才 await `host.ready()`。在接纳之前等待依赖上游的宿主对象会
> 死锁。

对于真实的插件文件，默认导出 `defineFacet(...)`。Node 宿主配置
`createHost({ loader: nodeLoader })`，其中 `nodeLoader` 从 `@earendil-works/chord/node` 导入，
然后把模块 URL 传给 `load` 和 `reload`。这里的内存 facet 对象避免了文件系统设置。内置 facet
是可信的进程内代码，不是沙箱；当前的 Node loader 把旧模块副本留在内存里，反复加载有这个限
制。

## 9. 在不丢失列表的情况下修改运行中的代码

引用之所以有用，正是因为在实现变化时调用方可以一直持有它。**代码版本（code version）**标识
一组已提交的代码和注册表。一个 root 保持它启动时的代码版本。新 root 用最新的。

### 兼容的代码变更：无需等待

给同一个命名 facet 一个新工厂。它改变标签但保留单元声明。这个测试故意暂停一个调用方，展示
旧 root 看到的东西；应用方法不应该这样暂停。

<!-- example:09-compatible -->
```ts
const host = createHost({ self: "server" });
const facet = (label: string): Facet => ({
	name: "todos",
	setup: (api) =>
		api.serve(TodoStore, (input, principal, self) => ({
			...todoFactory(input, principal, self),
			label: () => label,
		})),
});
await host.load([facet("Original")]);
const todos = await host.get(TodoStore, { list: "family" });
await todos.add({ text: "Buy milk" });
const entered = Promise.withResolvers<void>();
const resume = Promise.withResolvers<void>();
const oldRoot = host.root(async (ctx) => {
	const first = await todos.label(ctx);
	entered.resolve();
	await resume.promise; // Test-only pause: pin an old caller during reload.
	return [first, await todos.label(ctx)];
});
await entered.promise;
const compatible = await host.reload([facet("Updated")]);
assert.deepEqual(compatible.gated, []);
assert.equal(await todos.label(), "Updated");
resume.resolve();
assert.deepEqual(await oldRoot, ["Original", "Original"]);
assert.equal(todos.rows.value?.[0]?.text, "Buy milk");
```

旧 root 暂停期间重载照样提交：`gated` 为空。新调用看到 `"Updated"`；恢复后的旧 root 两次都看
到 `"Original"`。牛奶那一行存活。兼容的代码变更不会等那个旧 root 完成。

### 状态变更：提升版本并迁移

假设新策略把已有的待办文本转成大写。schema 不变，但数据的含义变了。我们仍要提升该单元的
**状态版本**（`self.state` 的 `version` 选项，默认 1）。它属于单个单元，独立于契约版本。
**迁移（migration）**（`migrate`）把该单元的旧值转换成新表示。

<!-- example:09-migrate -->
```ts
const events: string[] = [];
const stopEvents = todos.rows.events((event) => events.push(event.type));
const migrated = await host.reload([
	{
		name: "todos",
		setup: (api) =>
			api.serve(
				TodoStore,
				todoStore({
					version: 2,
					migrate: (old, from) => {
						assert.equal(from, 1);
						return (old as Static<typeof Rows>).map((todo) => ({ ...todo, text: todo.text.toUpperCase() }));
					},
				}),
			),
	},
]);
assert.equal(migrated.gated.length, 1);
assert.deepEqual(todos.rows.value, [{ text: "BUY MILK", done: false }]);
assert.deepEqual(events, ["snap", "reset"]);
stopEvents();
```

迁移收到旧的行和它们的状态版本 `1`。它返回新的行；引用现在读到
`[{ text: "BUY MILK", done: false }]`。订阅者收到包含迁移后值的 `reset` 事件。事件断言先看到
初始的 `snap`，然后是那个 `reset`。有一个对象被闸门拦下。**闸门（gate）**等待已进入该对象的
调用完成，然后在私有副本上迁移、校验并提交。没进入过的旧 root 之后不能拿旧代码碰已迁移的数
据：它们收到 `upgrade_conflict`，应该在新 root 中重试。

改变单元的 schema 也需要提升版本，还要迁移，除非旧值已经符合新 schema。schema 相同但含义变
了（如本例）无法自动检测。真实的迁移必须引用它支持的每个已存储版本，不能假设每个安装都刚好
落后一个版本。

### 契约变更：为旧调用方保留适配器

把 `label` 改名为 `heading`。这是破坏性契约变更，所以用契约版本 2。提供者的 `accepts[1]` 适
配器构建版本 1 的消费者仍然期望的实现。

<!-- example:09-contract -->
```ts
// Remove label from the new provider's contract: it is now called heading.
const { label: _label, ...members } = TodoStore.def.members;
const RenamedStore = local("tutorial.todos", {
	version: 2,
	input: TodoStore.def.input,
	members: { ...members, heading: method(undefined, Type.String()) },
});
await host.reload([
	{
		name: "todos",
		setup: (api) =>
			api.serve(
				RenamedStore,
				(input, principal, self) => {
					const { label, ...implementation } = todoStore({ version: 2 })(input, principal, self);
					return { ...implementation, heading: label };
				},
				{
					accepts: {
						1: (current) => ({ ...current, label: current.heading }),
					},
				},
			),
	},
]);
assert.equal(await todos.label(), "Todos for family");
const newer = await host.get(RenamedStore, { list: "family" });
assert.equal(await newer.heading(), "Todos for family");
assert.equal(todos.rows.value?.[0]?.text, "BUY MILK");
```

旧引用的 `label` 和新引用的 `heading` 都返回 `"Todos for family"`。两者都仍能到达迁移后的行。
适配器映射的是实现，不是引用；转发已有方法保留了它的上下文。这里我们把单元保持在版本 2，
让这次纯代码变更不重复迁移。

> **为什么：**契约版本保护调用方；状态版本保护存储的数据；资源版本控制重新打开。不要用一个
> 数字管三件事。增量式的兼容契约可以保持版本；破坏性的形状或含义变更需要提升契约版本，并为
> 旧消费者提供适配器。重载先准备候选；准备失败则旧代码继续运行。错过期限的迁移闸门会中止，
> 而不是在活跃旧代码底下换数据。

## 10. 测试对象，而不是整个部署

大多数实现只需要一个裸宿主。状态测试用真实工厂；想在没有真实数据库或服务的情况下测试委托
时，用假 facet。这里的假实现记录编辑视图向 store 发送了什么。

<!-- example:10 -->
```ts
const host = createHost<Principal>({ name: "server", self: "server", dev: true });
const received: string[] = [];
const fake: Facet = {
	name: "fake-store",
	...defineFacet((api: FacetApi) => {
		api.serve(TodoStore, (input, principal, self) => ({
			...todoFactory(input, principal, self),
			add: ({ text }) => {
				received.push(text);
			},
		}));
	}),
};
await host.load([fake]);
serveViews(host);
const owner = await host.get(Todos, { list: "family" }, { principal: "owner" });
assert.ok(owner.variant === "editor");
await owner.add({ text: "Test delegation" });
assert.deepEqual(received, ["Test delegation"]);
await assert.rejects(owner.add({ text: "" }), (error) => isChordError(error, "invalid"));
owner.release();
await assert.rejects(owner.add({ text: "Too late" }), (error) => isChordError(error, "released"));
```

假实现收到了 `["Test delegation"]`。空文本在到达假实现之前就失败了。被释放的引用以
`released` 拒绝后续调用。`isChordError(error, code)` 检查稳定的错误码；避免只测消息的措辞。

我们的其他测试覆盖了真实单元（第 3 节）、资源清理（4）、主体变体（5）、内存链路上的客户端
（6），以及跨重载保留的调用方（9）。被 await 的 `get` 之后状态就在那里；对之后的变化，await
你需要的那次值。总是取消订阅并关闭宿主；泄漏的引用会掩盖生命周期 bug，或让后台任务继续运
行。

> **提示：**假实现必须遵守它提供的契约。这个假实现把所有普通成员委托给 `todoFactory`，只替换
> `add`；它故意只记录调用而不更新行。不要把它和持久化混淆。

## 11. 保持这些习惯

一次临时调用的引用不应该意外变成永久的。一个屏幕不应该因为一次按钮点击结束就丢失数据。第
一种生命周期用 `ctx.get`，第二种用 `host.get`。

<!-- example:11 -->
```ts
const host = createHost({ self: "server" });
host.serve(TodoStore, todoFactory);
const screen = await host.get(TodoStore, { list: "family" });
await host.root(async (ctx) => {
	const temporary = await ctx.get(TodoStore, { list: "family" });
	await temporary.add({ text: "Keep roots short" }, ctx);
}); // The temporary reference is released here; screen still holds the store.
assert.equal(screen.openCount.value, 1);
screen.release(); // No reference remains; without persistence, disposal loses these rows.
```

root 结束后，屏幕仍然看到计数 `1`，因为它拥有一个单独的引用。屏幕释放它之后，没有引用剩下。
本教程的单元在内存里：重载保留上线的对象，但销毁或进程重启会丢失行。真正的持久化属于数据
库资源，配上显式的加载/保存策略。

### 检查清单与常见错误

- 可重载的状态放在单元里，不放闭包变量：工厂会重新运行。
- 修改草稿，不修改已发布的值：单元之外的修改会绕过更新。
- 字段编辑用 `change`，自己拥有的快照用 `replace`：替换可能抹掉代码不认识的字段。
- 在同步工厂里声明依赖，不在方法里：激活和重载需要完整的声明列表。
- 临时的方法依赖用 `ctx.get`：它们的引用随调用结束。
- 把 `ctx` 传进嵌套调用：取消和代码版本必须保持一致。
- 保持 root 短、任务可取消：迁移和关闭需要工作落定。
- 检查授权和参数，而不只是变体：可用的方法不是完整策略。
- 在可信入口盖主体印记，不来自客户端载荷：名字不是身份。
- 读状态前先 await `get`：你持有的引用是上线且已注水的；加载中的引用（`host.hold`）抛
  `not_ready`。
- 释放引用并取消订阅：否则无用的对象一直被引用或被观察。
- 状态版本、契约版本、资源版本各自为自己的变化提升：每个保护不同的边界。
- 报告启动成功之前，先 await 宿主对象就绪：已声明不等于已上线。
- 保持引用依赖无环：对象不能通过另一个对象等自己。

### 导入与运行示例

这些是 `test/tutorial.test.ts` 的共享导入。相对路径在该测试目录下正确；应用从
`@earendil-works/chord` 导入同样的名字。`assert` 表达期望值；`it` 和 `onTestFinished` 来自测
试运行器；`readFileSync` 被教程的源码比对检查使用，应用不用它。

<!-- example:imports -->
```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { it, onTestFinished } from "vitest";
import {
	type Ctx,
	createHost,
	defineFacet,
	defineRegistry,
	type Facet,
	type FacetApi,
	type Factory,
	forbidden,
	type Host,
	hostNamed,
	invalid,
	isChordError,
	local,
	memoryLinkPair,
	method,
	opaque,
	remote,
	type StateOptions,
} from "../src/index.ts";
```

在 `packages/chord` 下运行：

```sh
node ../../node_modules/vitest/dist/cli.js --run test/tutorial.test.ts
```

每个编号章节有一个测试。每个 TypeScript 代码块都与可运行源码逐字比对，所以只改其中一份会导
致测试失败。测试夹具添加了清理和漂移检查；它从不使用真实的数据库、网络服务或提供者 API。

接下来阅读[使用指南](guide.zh-CN.md)了解 API 参考，阅读[规范文档](spec.zh-CN.md)了解兼容
性、生命周期和重载规则，包括其已知限制。如果文档与 `src` 不一致，以当前实现为准。
