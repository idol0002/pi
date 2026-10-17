# Chord 规范

本文档规定 `src` 中的运行时。当它与代码不一致时，该不一致是一个 bug。[已知限制与决策](#12-已知限制与决策)列出了运行时尚未做到的事情，以及下文各节留作开放的选择。

硬性约束：
- Chord 的运行时只依赖自己的 `delta` 模块（tracker、applyImmutable、encoder/decoder、diff）以及 Node/浏览器内建能力和用于 schema 的 `typebox`。不依赖其他 Pi 包。
- 内置插件是受信任的，以进程内方式从源码加载。插件加载器使用带缓存破坏查询的动态 `import()`（所有者批准的例外，`TODO(loader)`：替换为隔离的、可驱逐的加载器；旧模块副本会泄漏；TUI 插件需要隔离）。
- 必须支持热重载。只有 Chord/运行时代码变更或宿主级崩溃恢复才重启宿主。

## 1. 概念

| 术语 | 含义 |
| --- | --- |
| facet | 一个插件面向某个宿主（surface）的代码：它服务对象类型（`defineFacet`）。 |
| object type | 名称 + 契约。`remote`（可从其他宿主寻址；为输入、变体状态成员、方法参数/结果提供 schema）或 `local`（仅限宿主内；成员可以是任何东西，包括函数和原生对象，但必须列在契约中：`method`、`opaque` 或 state schema）。 |
| factory | `(input, principal, self) => implementation`。同步。通过插件 facet 的 `host.serve(type, factory, options)` 注册。 |
| object | object type 的一个实例。身份由 `(type, canonicalInput, principalKey)` 决定。拥有 cell、资源、引用、监听器、任务、注册。跨重载存活。 |
| implementation | 对象的代码：一次 factory 运行的返回值（方法 + 状态成员；remote 类型还有 `variant`）。不可变，按代码版本。 |
| reference | `get` 的返回值：对对象的迟到绑定声明，绝不是对象或其实现。被引用期间对象存活。 |
| principal | 应用自定义。由 link 盖章。宿主内代码以 `host` principal 身份行动。 |
| root | 一次短的 Chord 调用树，在受信任的入口被接纳（不带 root 的 link 请求、UI 事件、定时器、`host.root`）。携带 `{ rootId, codeVersion }`。 |
| code version | 每个宿主一次提交的实现/注册集合（服务器发放的 id）。 |
| code holder | 不是 root 的长生命周期执行：Durable 阶段/工具运行、浏览器、`self.task` 循环。它们发起的每次 Chord 调用都开始一个全新的短 root。 |

## 2. 契约

契约是每个类型的运行时值（发布的 bundle 中没有 TypeScript；第三方插件单独构建）。TS 类型从它们推断。

```ts
export const Chat = remote("pi.chat", {
	version: 1,                                   // 契约版本：普通数字，只在破坏性变更时递增
	input: Type.Object({ session: Type.String(), conversation: Type.Number() }),
	host: hostFamily("session:", "session"),       // 其对象所在位置：`session:` + input.session
	variants: {
		viewer: { state: { view: ViewSchema } },
		participant: {
			state: { view: ViewSchema },
			methods: { send: method(SendSchema, Type.Object({ submissionId: Type.Number() })) },
		},
	},
});

export const Index = local("pi.index", {
	version: 1,
	input: Type.Object({ session: Type.String() }),
	members: {
		search: method(Type.Object({ query: Type.String() }), Type.Array(Hit)),
		onChange: method(Type.Function([Change], Type.Void()), Unsubscribe),   // local 允许非 JSON
		harness: opaque("pi.durable-harness@1"),                               // 原生对象，按名称+版本
	},
});
```

- 输入身份：规范化（应用默认值、剔除未知字段）、校验，然后做规范化 JSON，等于其 schema 默认值的字段被省略。更改默认值或规范化规则需要新的类型名。
- Remote 调用在提供者边界校验参数/结果和状态值。Local 调用不做每次调用的校验。
- Local 契约列出每个成员（`members: { search: method(...), harness: opaque(...), status: Schema }`）。仍处于 `loading` 的引用必须能在任何实现存在之前知道 `h.x` 是方法（调用者等到 live）、状态成员（可读值）还是 opaque 值。契约中缺失的成员只有引用 live 之后才能发现。
- 每个 bundle 内嵌它构建时所依据的契约 token（自己的副本）。指纹 = 规范化描述的哈希。
- 放置（remote 类型，必填）：`host: hostNamed(name)`（单个宿主）或 `hostFamily(prefix, key)`（宿主 `prefix` + 输入中必填的字符串字段 `key`）。纯数据，放在描述中（因此也在指纹和 `hold` token 中）；没有 `at` 选项。`get` 用调用者的契约规范化输入，解析宿主，若就是本宿主则本地获取，否则远程获取。`serve`（以及加载一个 facet 的重载）拒绝放置排除本宿主名称的类型。宿主拒绝其自身契约把输入放置到别处的 hold（`invalid/placement`），中继拒绝目标与其 token 的放置和输入不一致的 hold。覆盖要求放置相等，`accepts` 适配器绝不桥接两个放置：移动类型是破坏性变更。remote 引用的地址是类型、规范化输入和 principal：没有宿主名。

### 兼容性规则

针对版本 M 构建的消费者绑定到版本 N 的提供者，当且仅当 N = M 且提供者的描述覆盖消费者的；否则只能通过提供者声明的 `accepts[M]` 适配器（`serve(type, factory, { accepts: { 1: (current) => v1View } })`）；再否则 `contract_mismatch`。

覆盖（covers）：消费者的每个成员都存在且种类相同；方法：双方要么都带参数要么都不带，提供者接受消费者能发送的每个参数（新字段可选，不得新增必填或改类型），提供者的结果符合消费者期望的结果（多出的字段没问题；void 消费者接受任何结果）；状态：提供者值符合消费者 schema（多出的字段没问题）；opaque：同名同版本。

增量变更无需递增版本号。破坏性变更（删除/重命名/改类型、新增必填，或形状相同但含义改变）递增数字。相同版本 + 不覆盖的描述 = 忘记递增版本号，被拒绝。不递增版本号的含义变更无法检测（作者的责任，与 Durable 文档版本一样）。

检查时机：`get` 绑定、重载准备（新提供者 token 对每个持有该类型的存活消费者和每个导入它的已加载插件）、远程引用（`hold` 帧中的消费者 token）。

对 `lifetime: "host"` 对象的精确宿主自有引用是生命周期 pin，不是持有旧契约的存活消费者。当其提供者被替换时，commit 会把该引用替换为绑定到新提供者契约的引用，并在释放旧引用之前获取新的，因此同一个对象、状态和未变更的资源得以存活。它不需要针对自己先前契约的 `accepts` 适配器。Prepare/abort 不改变该引用。所有其他消费者保留自己的 token 和正常的覆盖/适配器检查；状态版本和迁移检查不变。

## 3. 工厂与声明

工厂是同步的；返回 promise 会抛出异常。声明只有在其某些东西能在重载后存活且必须被重新找到时才有名字：状态（其值）和资源（打开的值），外加监听器（保留的订阅）。名字是字符串，在每个对象内按声明种类唯一（重名是 `invalid/duplicate`）；各种类名字独立。派生和任务没有名字：重载会创建新的。引用按其地址标识。

```ts
host.serve(StatusStore, ({ session }, _host, self) => {
	const status = self.state("status", StatusSchema, { running: false, tasks: 0 },  // schema 必填，初始值
		{ version: 2, migrate: (old, from) => upgrade(old, from) });                     // 每 cell；默认版本 1
	const errors = self.state("errors", Type.Array(Type.String()), []);
	const catalog = self.get(Catalog, {});                         // 引用；身份 = 规范化地址（+ at）
	const watch = self.resource("watch", {
		version: 1, deps: [catalog], exclusive: false,
		open: async ({ signal }) => openWatch(session, signal),
		close: async (w) => w.close(),
	});
	self.on("changes", watch, (w) => w.events, (event, ctx) => status.change(ctx, (d) => { d.tasks = event.tasks; }));
	self.task(async (ctx) => { /* 循环直到 ctx.signal 中止 */ });
	const visible = self.derive([status], (s) => project(s));      // 同步 fn
	self.register(Routes, { "GET /status": handler });              // 注册键是注册表自己的键；仅 `lifetime: "host"` 对象
	return { status: visible, errors, report: (args, ctx) => { status.replace(ctx, args); } };  // 暴露的状态 = 返回值
}, {
	linger: 30_000,                                                  // 仅 lifetime 为 "referenced"（默认）时
});
```

| 声明 | 重载后存活 | 说明 |
| --- | --- | --- |
| `state(name, schema, initial \| { init }, { version?, migrate? })` | 同一 cell 和值（`initial` 被忽略，`init` 不运行）；版本升高时迁移；重载新增的 cell 在 prepare 时运行 `init`（受门控对象：在门处） | Schema 必填（运行时没有 TypeScript）。`change(ctx, draft => void)`、`replace(ctx, value)`、`value`、`subscribe`。通过 `change` 的写入只触及被修改的路径。私有状态是实现不返回的 cell。`init(ctx)`（可以是异步）给出首个值，见激活 |
| `get(type, input, { at? })` | 再次声明（同一地址）时保留 | 返回引用 |
| `resource(name, { version, deps?, exclusive?, open, close? })` | `version`、`deps` 或 `exclusive` 未变时保留；保留的资源在 commit 时采用新声明（其 `close`） | `open` 在 prepare（非独占）或门处（独占）运行；返回资源，其 `.value` 是打开的值；被替换的资源用它自己声明的 `close` 关闭 |
| `on(name, source, [select,] handler)` | source 和 `select`（身份或源文本）未变时保留同一订阅；`handler` 被替换 | 每个事件在当前代码版本中开始全新 root；保留的订阅不重新运行 `select`。状态 source 在启动时以及每次替换它的重载之后都送出当前值 |
| `task(fn)` | commit 时以新代码重启：旧运行经 ctx.signal 中止，其结束后新运行才启动（至多 `taskStopDeadline`，默认 5 s，之后无论如何停止并报告） | 一个 code holder；其内部调用开始全新 root |
| `derive(sources, fn)` | 新的派生，在 commit 时计算 | 同步 fn |
| `register(registry, { key: value })` | commit 时替换值 | 仅 `lifetime: "host"` 对象 |
| `expose(resource)` | 跟随资源 | 一个 local 成员（通常是 `opaque`），引用在 live 后的值就是资源的值 |

实现的状态成员可以是 cell、派生，或对象持有的引用的状态成员（对象 live 后它们才有定义）。`cell.replace(ctx, value, { diff? })` 在新值与旧值共享容器时（或 `diff: true`）发布结构化 diff，否则发 `r`。Facet 的 `setup` 收到其宿主的 `{ serve, name, root, registry, signal }`；一旦本次 facet 运行不再被安装（一次已提交的重载替换或移除了它、加载它的重载中止、或宿主关闭），`signal` 就中止。

每 cell 的 `migrate` 是 `(old, fromVersion) => new`。一个 cell 可能落后多个版本（作者在两次重载之间递增了不止一次）。没有 `migrate` 时，版本升高保留原值，该值必须符合新 schema。

**状态上的监听器做对账。** source 为状态的监听器（cell、派生、引用的状态成员）在启动时订阅并拿到当前值，之后是每个新值。替换其 source 的重载（每个派生都是新的；指向另一地址的引用是另一个 source）会重新订阅它，因此它会再次拿到当前值：其 handler 必须做对账（幂等），而不是数事件。事件 source（资源的 events、任何其他 `subscribe`）不送当前值；对它的保留订阅不受重载影响。

**方法。** `method(args?, result?)`：不带 `args` 的方法不接收参数（调用者 `ref.name(ctx?)`，实现 `(ctx) => …`；有返回值时写 `method(undefined, result)`）；不带 `result` 则为 void（调用者得到 `undefined`，无论实现返回什么）。描述记录两者（缺失的字段），`call` 帧对它们不携带 `args`，`result` 帧不携带 `value`。消费者和提供者必须在方法是否接收参数上一致；不带结果的消费者接受提供者的结果。

相对指南移除的内容：`self.own`、`holdWhile`、异步工厂、推断依赖。

### 同步工厂，异步激活

`self.get` 和 `self.resource` 只声明并返回占位符。对象的激活：

1. 同步运行工厂（声明）；
2. await 已声明资源的 `open()`（例如连接数据库）；
3. await 已声明引用变为 live（依赖先激活，合并进行）；
4. 并行运行每个带 `init` 的 cell 的 `init`，各自在以宿主 principal 身份行动的独立 root 中；校验并安装值；
5. 附加派生，启动监听器和任务；
6. 对象 live：引用 `live`，`ready` resolve。

在工厂内部，占位符不得被使用（`resource.value` 和带 `init` 的 cell 的 `value` 抛出 `not_ready`；引用调用抛出异常）。抛出异常的 `init`，或返回其 schema 拒绝的值的 `init`，会像失败的 `open` 一样使激活失败。`init` 不得等待自己的对象或持有它的对象（它还未 live），也不得读取自己对象的另一个 `init` cell（它们并行运行）。`init` 从对象反正会读取的来源给出第一个值；它不持久化任何东西，有 `init` 也不会让 cell 被保存到任何地方。方法/监听器/任务只在 live 对象上运行，因此其依赖是 live 的。对象只有在其引用就绪（live，remote 的还要已水合）且它暴露或派生自的状态 source 有值时才 live，包括它们转发以其他方式持有的 remote 引用的情况；等待引用受宿主 `readyTimeout` 限制（默认 60 s，`unavailable/ready_timeout`，跨宿主的引用环同样如此）。持有 `loading` 引用的外部消费者（`host.hold`）：调用等待到 live（ctx 取消、截止时间）；状态成员在第一次水合前抛出 `not_ready`。激活失败传播给依赖者和所有等待的 get；下一次 get 重试。

### 生命周期

`serve(type, factory, { lifetime })`：

| `lifetime` | 创建 | 结束 | `linger` |
| --- | --- | --- | --- |
| `"referenced"`（默认） | 其地址第一次被 `get` 时 | 最后一个引用释放后，再加 `linger` | 允许（默认 0） |
| `"host"` | 其 facet 加载时（或在 `serve` 时）；加载等待其 live | 宿主关闭时，或重载移除其 facet 时 | 拒绝 |

- `"host"` 在 `serve` 时对 remote 类型、不接受 `{}` 的输入、以及与 `linger` 同用都会被拒绝；
  类型（`ServeOptionsFor`）在编译期拒绝同样的组合，此类输入指带必填字段的输入。
  该类型恰好有一个对象：空输入（应用默认值），以宿主 principal 创建。无论 principal 是什么，
  每个 `get` 都到达它（工厂看到的是宿主 principal）；带其他输入的 `get` 是 `invalid/input`。
  其他引用不改变其生命周期：宿主保留自己的引用直到关闭。
- 只有 `"host"` 对象可以注册（否则 `invalid/not_host_lifetime`）。
- 激活失败的 `"host"` 对象由下一个改动其类型的重载重新启动。把类型改为 `"host"` 的重载会创建其
  对象；改为 `"referenced"` 的重载释放宿主的引用，此后对象只在还有其他人引用它时存活。

### 宿主对象就绪

- `host.install(facet, { awaitHostObjects? })` 同步安装声明并返回该 facet 宿主对象激活的 promise。
  `host.load(facets, { awaitHostObjects? })` 在 await 其宿主对象激活之前安装整批。`awaitHostObjects`
  默认为 true。未被引用的对象不激活。
- 工厂、资源打开、依赖和激活收尾的失败会以激活错误 reject 返回的 promise（保留 ChordError 码；普通
  错误包装为 `unavailable`）。宿主对象失败也会到达 `onError`。安装不是回滚事务；`install` 的
  setup/注册错误同步抛出。放弃启动时应关闭宿主。
- `{ awaitHostObjects: false }` 启动同样的宿主对象，但在安装完成后即 resolve，不等待其激活。
  `host.ready()` await 调用时宿主对其宿主对象引用的快照（包括直接 `serve` 和延迟加载），对它们的
  激活失败 reject，并且不获取额外引用。它不是持续健康检查，也不 await 任务完成或远程状态水合。
- 本地引导就绪与上游接纳是分开的。worker 连接其上游 link，以 `{ awaitHostObjects: false }` 加载，
  await 其本地引导引用（例如 Harness，不依赖上游），然后宣布控制就绪让父级接受 link。只有在接纳
  之后才 await `host.ready()`。否则一个向服务器 SessionStatus 报告的宿主对象会与等待控制就绪的父级
  死锁。延迟加载跳过整个屏障，而不是挑选依赖；调用者显式选择本地引导引用，让引导保持忙碌直到完全
  就绪，并传播后续的启动错误。

## 4. Principal、变体、引用

- Principal 是应用的类型 `P`（`createHost<P>`、`Host<P>`、`defineFacet<P>`、`Factory<C, P>`、`Ctx<P>`；默认 `unknown`）。Chord 不发明任何 principal：`createHost({ self })` 是宿主自己代码的 principal（root、对象内代码、`lifetime: "host"` 对象），`connect(link, { principal })` 是父级自己的请求所充当的，`accept(link, { principal })` 是 link 所充当的，`Route.principal(hostName)` 是被路由宿主回调时所充当的。全部必填。
- `createHost({ principalKey })` 把 principal 映射为包含连接来源和授权修订的键。对象按 principal 键区分。宿主自己的 principal 按键识别（`principalKey(p) === principalKey(self)`），不按对象身份，因此相等的 principal 绝不会创建第二个对象。
- Remote 工厂返回 `{ variant, ...members }`；`variant` 必须是已声明的变体；成员必须与之匹配。Local 工厂返回任意对象。`variant` 是保留的成员名。
- 引用：`status`（`loading | live | released | gone`）、`ready` promise、`variant`、`shape`（`{ variant, members, contract }`）、`onStatus(listener)`（每次状态变化，`gone` 时带错误）、迟到绑定成员、`release()`。`self.get` 是同步的（对象在其引用就绪后才 live）；`ctx.get` 和 `host.get` 在引用就绪后 resolve：live，且其变体的每个状态成员已水合（`state: false`：仅 live）。它们以激活错误、`aborted`（ctx 中止或已 settle，`signal`）或 `unavailable/ready_timeout` reject，只释放该引用。`host.hold` 是面向 UI 运行时的同步形式。持有的 remote 引用在释放前保持订阅其变体的状态；link 断开后其最后的值保持可读，同时它重新 hold。状态成员类型为 `T`；第一次水合前读取抛出 `not_ready`，变体之外抛出 `not_in_variant`，结束后抛出结束的错误。remote 引用类型是按 `variant` 判别的联合。形状变化（重载、变体）被推送；当前变体缺失的成员 reject `not_in_variant`；已释放的引用 reject `released`；强制销毁使引用变为 `gone`。
- 共享绑定：同一键（类型、规范化输入身份、principal 键、消费者契约指纹）的宿主上的 remote 引用是同一绑定的视图：一次 hold，每个状态成员一条流，调用经由该 hold。视图有各自的拥有者（对象、调用、外部）、状态、观察者和 `release`；绑定对所有视图一起结束（gone）或重新 hold。没有视图时绑定关闭，或为 `linger.types[typeName]` ms（`createHost({ linger: { types, cap } })`，至多 `cap`，默认 4，最近释放的先出）保持持有和水合。
- 方法是 `(args, ctx) => Promise<result>`。工厂仍要检查参数；变体不是完整的授权。
- 吊销：`host.invalidatePrincipal(match)` 强制销毁本宿主上匹配的对象并经 link 传播；link 重新盖章或关闭。

## 5. 生命周期

- 引用拥有者：对象（声明的 `get`）、调用（`ctx.get`，settle 时释放）、连接（remote 引用；中继按来源连接映射）、宿主（`lifetime: "host"`）、UI。
- 激活按地址合并；如果所有请求者在完成前离开，结果被销毁。工厂抛出：回退声明，reject get，下一次 get 重试。
- 最后一个引用释放 + `linger` 后销毁：任务中止、监听器移除、资源关闭（逆序；全部运行；错误聚合）、对象的引用释放（级联）。
- 批量强制销毁（`host.close`、`invalidatePrincipal`）分波进行，引用者在被引用者之前，因此资源的 `close` 仍可使用其对象的引用；`host.close` 在对象之后关闭 link。
- 强制销毁：引用立即 `gone`，新调用被拒绝，进行中的调用上下文中止，然后是协作式清理。
- 引用图在宿主内无环（在 get 时检查）；跨宿主靠约定。

## 6. Root 与代码版本

- `Ctx = { signal, rootId, codeVersion, get(...): Promise<Ref>, principal? }`。显式；不依赖 AsyncLocalStorage（可在开发中用于警告）。
- link 为不带 root 的请求创建 root；嵌套的远程调用携带 `{rootId, codeVersion}`。
- 分发：带代码版本 E 的调用运行对象为 E 的实现。宿主至多保留 `current` 和 `previous` 两个代码版本（双版本规则）。宿主没有的代码版本的调用（早于 previous，或宿主启动更晚）被拒绝 `superseded`（可通过开始新 root 重试）。绝不替换为其他代码版本。
- 浏览器绝不把代码版本带进服务器：浏览器调用在服务器开始 root。浏览器通过形状/重置推送和服务器的 `Manifest` 对象得知变更；不兼容的契约指纹 → `upgrade_required`。

## 7. 重载

显式触发（`reload_plugins` 工具、按钮、API）。串行化；不嵌套。

1. 构建/类型检查门（应用工具链，在 Chord 之外）：依赖闭合的集合；拒绝没有契约版本递增的破坏性 remote 契约变更。
2. 加载：在每个受影响的宿主上，导入新的 facet 模块（缓存破坏）。
3. 准备：对每个受影响类型的每个 live 对象，以记录模式运行新工厂：现有 cell 可读，写入抛出异常；监听器/任务/注册被记录而不启动；引用被记录；名字是新的或 `version`/`deps` 变了的非独占资源以候选者身份打开（abort 时关闭）。校验键、变体、注册表冲突。准备期间激活的新对象使用当前代码版本（旧代码）。任何失败：abort，丢弃候选者。投票。
4. 门（仅限有版本被提升的 cell 或替换独占资源的对象，以及依赖这些资源的对象）：
   - 接纳切断：从现在起，尚未触及该对象的旧代码版本 root 得到 `upgrade_conflict`（可重试），不排队。已持有其激活租约的 root 被豁免；其重新进入被接纳。
   - 等待被豁免的激活完成，截止时间（默认 5 s）。错过截止时间：中止重载，重新打开，一切未变（报告阻塞的 root）。
   - 独占资源：关闭旧的，打开新的；失败则重新打开旧的并中止。
   - 把 `migrate` 运行到私有副本；校验。
5. 提交（服务器先提交自己，再向子级发送 commit；该决定不持久化，见第 12 节；FIFO link 保证没有宿主在提交前收到新代码版本的 root）：每个宿主在一个同步步骤中安装迁移后的 cell 值和 cell 版本、把实现安装为代码版本 E'、交换注册表、以新代码重启任务、重新绑定监听器、向订阅者推送形状/重置、打开门。E' 为 current，E 为 previous。
   协调者的结果携带 `children`：每个参与的子级已准备的报告（其投票）。
6. 退役：当 `previous` 的 root 不存在时（且在子级上，父级已退役它），丢弃其实现并释放只有它声明的声明。下一次重载先等待这个，至多 `retireDeadline`；然后中止仍在 `previous` 上运行的 root（其 ctx signal），给它们至多 1 s 停止，无论如何退役。协调者在发送 `prepare` 之前退役，因此其 `retire` 帧先到达子级。

兼容变更（无状态版本提升、无独占资源变更）跳过门：不等待。

状态兼容规则：重载准备比较每个 cell 的新旧 schema 和版本。未变：兼容（无门）。版本提升：门 + `migrate`（或保留的值），按新 schema 校验。schema 变了但版本未提升：拒绝重载。版本降低：拒绝。schema 完全相同但含义改变也需要递增版本（无法检测；作者的责任）。初始值和 migrate 输出被校验；开发模式下每次写入都校验。

## 8. 注册表

```ts
export const Routes = defineRegistry<RouteHandler>("http.routes", { conflict: "error" });
self.register(Routes, { "GET /download": handler });       // 在 `lifetime: "host"` 对象中；键是注册表的键
host.registry(Routes).get("GET /download", ctx);            // ctx.codeVersion 的表（无 ctx 时为当前）
host.registry(Routes).subscribe((table, codeVersion) => ...);     // 面向命令式消费者（Durable）的桥
```

按代码版本的不可变表；顺序 = 首次注册顺序，替换时保留。应用可以从该表（按代码版本快照）实现 Durable 的 `RegistryReader`，让阶段 pin 一个完整快照；Chord 不发布该桥。

## 9. 宿主与 link

- `createHost({ name, self, principalKey, upstream?: { link, principal } })`；子级用 `host.accept(link, { principal })`；父级用 `host.connect(link, { principal })`；`host.route(prefix, { authorize(principal, hostName), resolve(hostName) => Promise<Link>, principal(hostName) })`。
- Link：`memoryLinkPair()`（测试）、Node IPC（child_process）、WebSocket（服务器 `ws`，浏览器 `WebSocket`）。
- Principal 盖章：接受方为连接者盖章（来自其认证器）；转发的 principal 只从父 link 接受；父级自己的请求（无转发 principal）充当传给 `connect` 的 principal；负载中的 principal 字段被忽略。
- 以落后于父级的代码版本连入的子级被围栏（不被路由任何东西），并通过其模块重载到父级的代码版本而对账。其旧代码版本的 root 向上游发起的调用按父级的当前代码版本被接纳（父级从未运行过该代码版本），而不是拒绝 `superseded`。
- 中继：服务器把 hold 转发到目标宿主的子 link（`at`，由消费者从契约的放置和规范化输入解析，并与两者核对），按来源连接映射引用；在解析/生成之前授权，之后再核对。
- 线上帧（JSON）：`hello`/`bye`、`hold`/`release`（经 link 的引用：`hold` 返回 `shape` 或 `gone`；没有单独的 `get`）、`shape`、`call`/`result`/`cancel`、`sub`/`unsub`/`resync` 和 `state`、`gone`、`root_end`、`retire`、`invalidate`、`ping`/`pong`、`ack`、重载控制（`prepare`/`vote`/`commit`/`abort`）。
- 状态：一次 `hold` 隐含其变体的状态（`state: false`：`sub` 之前没有；`unsub` 停止）。提供者以单元应答：一个 `shape`，其 `state` 列出消费者缺少的成员，随后每个列出的成员一个 `state` 帧 `as: "snap"`；消费者在这些快照到达后应用该形状。成员后续的 `state` 帧（按 hold id 和成员 `m` 寻址）是 `ops`（每流 delta 编码器）、`reset` 或 `error`；不带 `value` 的 `snap`/`reset` 携带 `undefined`。第一次水合前失败的快照以该错误结束引用。重载或变体变更发送带新成员的单元；离开的成员停止。`again` 标记 link 断开后的重新 hold（消费者已有值）。`origin` 指明 hold 来自哪个客户端连接（由接受客户端的宿主盖章，中继转发，只从父 link 接受）。
- 协议版本：`hello` 携带 `protocol`（`PROTOCOL_VERSION`，现为 4；缺失表示 1）。看到其他版本的一方不再处理任何东西，调用 `LinkOptions.onProtocolMismatch({ local, peer })` 并以原因 `protocol-version <其版本>` 关闭 link；对端的连接读到该原因并同样报告不匹配。对端之间不协商：过时的一方必须加载当前代码（浏览器刷新页面）。帧字段随版本变化：`shape` 帧命名变体为 `variant`，代码版本以 `codeVersion` 传输（2）；remote 契约 token 携带其放置（`host`），`hold` 携带消费者规范化后的输入（3）；hold 隐含其状态、单元、`origin`，`shape` 不带代码版本（4）。
- 流控：两端在 hello 中声明 `acks`，并确认自己处理过的帧（`ack`，除 `ack` 外所有帧的累计计数）。在未确认帧超过窗口（`window`，默认 256 KiB JSON 文本）时，状态在发送方按创建顺序冲刷的槽位中等待：每个成员流一个（ops 追加，快照或重置替换，release 或 `unsub` 丢弃），每个 hold 一个单元槽（惰性：发送时从当前值构建；更新的单元合并进它）。等待的 ops 按每个 link 限量（`pendingCap`，默认四个窗口）：超出后，最老的流变为在冲刷时按其当前值构建的 reset（中继向下游发送 `resync` 并丢弃该成员的 ops 直到 reset 到达）。hold 的第一个单元（非 `again`）和除状态外的每个帧都立即发送。不报告帧大小的 link（IPC）从不做窗口控制；没有 `acks` 的对端既不做窗口控制也不被确认。接受方可以限制对端进行中的调用数（`maxCalls`）；超出部分立即以 `unavailable/too_many_calls` 应答。连接之外的任何东西不得向 link 添加帧：确认会统计它们。

## 10. 宿主管理器（库）

`createHostManager({ driver, keepAlive })`：fork 驱动（entry、init、lock、env）、串行化的启动/停止/替换、替换前先退出、宽限期后的进程树终止、控制通道（ready/fatal/shutdown）、存活回调（booting、activeCalls、带心跳的 viewers、durable 任务、idleFor）。

## 11. 测试覆盖

测试至少覆盖：生命周期/引用/linger/强制销毁/gone；激活合并与放弃；principal 与变体；经内存 link 的远程调用，含中继和 principal 伪造尝试；经 link 的状态 snap/ops/reset 加重连；按代码版本的注册表；重载：兼容（不等待、被 pin 的 root）、准备隔离（写入抛出异常、失败的工厂使一切不变）、带 migrate 和门的状态版本提升、迟到旧 root 的 `upgrade_conflict`、截止时间中止、独占资源替换、跨宿主提交顺序、双版本退役和 `superseded`。

## 12. 已知限制与决策

### 仍然开放

- **跨宿主退役。** 子级在其父级退役某代码版本（`retire` 帧）且其自身该版本的 root 结束之后才退役它；服务器根据自身的 root 决定。同步加入的子级（hello 或对账）会被告知父级此前已退役哪些代码版本。在 worker 上启动、调用到一个已退役双方共有代码版本的服务器的 root 仍会得到 `superseded`（可重试）。
- **提交决定不持久化**（第 7 节第 5 步）。服务器在自己的提交与子级的提交之间崩溃，会让该子级停留在旧代码版本，直到它重连并被对账。
- **一层重载参与者。** 只有协调者的直接子宿主参与；子级不向自己的子级转发 `prepare`。
- **对账需要子级的模块列表。** 它在集群重载时被记住（`host.remoteModules`），因此服务器重启会忘记它，落后于重启后服务器的子级于是不重载任何模块：它拿到代码版本 id 配自己的代码。对账投票截止时间固定为 30 s；失败的对账关闭 link，宿主管理器随后重启 worker。
- **link 不可恢复。** 提供者一次性释放经关闭 link 持有的一切，因此重新 hold 的对象是新对象。为重连窗口保留引用需要 link 上的会话 id。link 断开时进行中的调用 reject `unavailable`；它们是否运行过是未知的。
- **被拒绝的客户端无从得知。** WebSocket 适配器关闭未认证的套接字；客户端看到上游掉线，其调用等待重连直到 ctx 被中止。
- **发布队列是进程级且同步的。** 一个慢观察者会延迟该进程中后续的每个通知，包括同一进程中其他宿主的通知。
- **没有自动重启。** 终态宿主失败由宿主管理器的 `keepAlive` 或 `fatal` 路径接手，不在 Chord 内部。
- **Node 加载器泄漏。** 每次重载导入的新模块副本从不被驱逐，且它不隔离插件（`TODO(loader)`）。
- **过期的套接字锁。** 在 Linux 以外的 Unix 系统上，两个进程在同一时刻探测同一个过期套接字文件可能都拿到锁。管理器按锁名串行化启动。
- **监听器 `select` 身份。** source 和 `select` 未变时，监听器的订阅跨工厂运行保留；`select` 在完全相同或源文本相同时视为未变，因此实现依赖捕获值且这些值在两次运行间变化的 `select` 不会被检测到。
- **关闭与死 link。** `host.close()` 分波销毁对象（引用者在被引用者之前）并最后关闭 link。等待一个已经断开的 link 上的远程调用的 `close` 会等待重连；请为这类调用设界限。

### 决策

- **错误。** 沿用指南的错误码；`reason` 字段携带细节，例如 `invalid/args`、`invalid/cycle`、`invalid/duplicate`、`invalid/read_only`、`invalid/not_host_lifetime`、`invalid/registry_conflict` 或 `unavailable/unknown_type`。工厂或依赖抛出的 `ChordError` 在每个依赖者中保留其错误码；其他错误变为 `unavailable`，原始错误作为 `cause`。
- **重载错误。** 没有 `reload_aborted` 码。失败的重载抛出原因的错误码和 reason，消息为 `reload aborted: …`（原因被附加）。其自身的 reason 有 `aborted/gate_deadline`（`details` 中带阻塞的 root）、`aborted/deadline`、`aborted/vote_deadline` 和 `unavailable/reload_running`。跨宿主时，消息指明失败的宿主。子级不能自行重载（`unavailable/not_coordinator`）。
- **准备期间的新对象。** 重载预分配下一个代码版本（"pending"）。同一次重载新增的类型从中服务；它们的对象只为 pending 代码版本安装实现，重载中止时被强制销毁。
- **门接纳。** 从门开始到 commit 或 abort，创建受变更类型的新对象失败并报 `upgrade_conflict`（可重试，reason `gate`）；没有东西被暂停，因此不可能死锁。受门控对象得到 `minCodeVersion = E'`：携带更旧代码版本的调用和写入被永久拒绝 `upgrade_conflict`，受门控对象在 commit 时丢弃其 previous 代码版本的实现。只有 cell 版本或独占资源变化的对象被门控。
- **门期间的任务与监听器。** 受门控对象的任务在接纳切断时中止，commit 时以新代码重启，abort 时以旧代码重启。受门控对象的监听器事件被排队，commit 时经新监听器重放，abort 时经旧监听器重放。
- **被豁免的 root** 是在切断时已调用进对象且仍在运行的 root。每个宿主记住一个 root 的调用从哪些 link 发出，并在 root 结束时在这些 link 上发送 `root_end`，因此租约跨宿主存活于调用之外。
- **移除的类型与错过的退役。** 被移除类型的对象在 commit 时强制销毁。错过退役截止时间时强制退役：先中止那些 root（其 ctx signal，reason `superseded`；被中继调用的 root 取消其下游调用），然后关闭只有该代码版本声明的东西，它们的下一次调用是 `superseded`。
- **重载期间的加入者。** 参与者是重载开始时同步的子宿主。运行期间 hello 到达的子级在重载结束时被决定：同步，或对账到已提交的代码版本；已经落后的子级立即被围栏，因此其 root 期间的调用按父级的代码版本被接纳。重载开始时正在运行的对账只在该重载结束后同步其子级，针对它提交的代码版本。对账在 `prepare` 之前宣布父级已退役的代码版本。
- **双版本规则。** commit 之后创建的受变更类型对象只有新代码；previous 代码版本的 root 调用它得到 `superseded`。
- **校验。** 远程调用在引用分发时校验，宿主内也是：直接绑定按提供者的 schema，经适配器的绑定按消费者的。提供者对远程状态成员的每个快照和重置在每次（重新）订阅时校验一次，经 `accepts` 适配器时按消费者的契约，否则按自身的；ops 只在开发模式校验。重载时，版本不变时新提供者的描述必须覆盖旧提供者的，此外还要对照存活消费者和 facet 的 `uses` 检查。
- **契约。** Local 契约列出其成员，因此 loading 的引用知道成员是方法、状态还是 opaque。规范化身份省略等于默认值的输入字段；用 TypeBox 时，用 `Type.Optional(Type.X({ default }))` 让调用者省略它们。提供者的变体必须覆盖消费者的变体；消费者契约未列出的成员被隐藏。schema 变更检测比较规范化 JSON，因此重排 `anyOf` 分支算变更。指纹使用非加密的 64 位哈希：同步且浏览器安全；契约是受信任的。
- **Principal。** 入口处的 root ctx 充当其 principal（`host.root(fn, { principal })`）；对象内的上下文充当 `host`。接受方决定 link 的种类和名称（`accept(link, { principal, kind, name })`）；只有配置过的宿主 link 可寻址、携带 root 并可投票，控制帧只从父级接受。客户端绝不携带 root 或代码版本。中继需要匹配的 `route`；`authorize(principal, hostName)` 在 `resolve` 之前和之后再运行一次，吊销或重新盖章 principal 会立即关闭其中继。`invalidatePrincipal(match)` 重新盖章或关闭匹配的 link，并把模式匹配传播给子宿主。
- **Cell 与可读值。** 从 `change` 返回的值替换该值且总是被校验；`replace` 转移所有权而不复制；默认（`{ diff }` 可覆盖）在新值在同一键上复用旧值的容器时发布 diff，否则发 `r`。`subscribe(fn)` 送出值，从当前值开始；`events(fn)` 送出 `snap`，然后 `ops`，或 `reset`。引用状态成员是稳定的可读值，loading 时抛出 `not_ready`，变体之外抛出 `not_in_variant`，其 source 移动时重置；在它们可读之前添加的监听器随后拿到快照。remote 状态成员在引用被持有期间保持水合。
- **引用与调用。** 引用的身份是其地址；同一次运行中对同一地址的第二个 `self.get` 返回同一引用。不带 ctx 或带任务 ctx 的引用调用在当前代码版本开始全新 root；其调用或 root 已 settle 的 ctx 被拒绝（`aborted/expired`），来自其他宿主的 ctx 是 `invalid/foreign_ctx`。在工厂内部调用引用抛出 `not_ready`。
- **资源与销毁。** 新的和被替换的独占资源在门处打开，同一对象依赖它们的非独占资源也一样。仍在销毁中的地址的新对象等待该销毁完成。在其 signal 中止之后才完成的资源 open 会立即关闭其值。
- **Link 与宿主管理器。** 每个收到的帧都按其 schema 校验；畸形帧、重复 id 和来自错误一侧的控制帧关闭 link。每个连接每 `pingInterval` ping 一次，`pingTimeout` 内没有帧则关闭。子级持有内核锁（Linux 和 Android 上是抽象套接字，Windows 上是命名管道，其他平台是探测的套接字文件），在存储打开之前由 `childControl().lock()` 获取。管理器在每个退出路径上杀掉子级的进程组，并从子级的存活报告推导 `booting` 和 `idleFor`。WebSocket 支持是结构性的，因此 Chord 不依赖 `ws`。
- **流控只阻挡状态。** 中继（Cloudflare 到浏览器）可能掩盖慢读者，因此不能依赖传输层背压；确认是端到端的。结果不得排在状态之后，因此 link 是 FIFO 的，例外是等待中的状态帧可以被超越：结果可能先于它之前产生的状态变更到达。同一订阅的帧保持有序。等待的状态被合并而不是排队，并按每个 link 限量，因此停滞的对端消耗有界内存，它收到的下一帧就是最新的。新引用的第一个单元不被阻挡，因此 `get` 绝不排在其他流之后。
- **状态 API 保持不变。** 对象保留具名 cell 和未命名派生；让每个对象恰好有一个状态值的方案被否决。没有新的、具体的问题就不要重新讨论。
