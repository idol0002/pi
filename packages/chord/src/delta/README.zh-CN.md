# Chord Delta

Chord Delta 为有序副本生成不可变的 JSON 修订和精确的操作批次。从
`@earendil-works/chord/delta` 导入。

不可变性是一份所有权契约。没有任何东西被冻结或防御性复制，因此非法变更不会被检测到。
它会静默地破坏状态。

```ts
import { applyImmutable, applyImmutableBatches, track } from "@earendil-works/chord/delta";

const initial = { output: "", entries: [] as { id: number }[] };
const tracker = track(initial); // `initial` 已被转移：绝不能再修改它

const change = tracker.beginChange();
change.state.output += "done\n"; // 仅在该变更打开期间 draft 可变
change.state.entries.push({ id: 1 }); // 放入的值会被克隆；调用者保留自己的对象
const prepared = change.prepare(); // 从此 draft 句柄不可再用

// tracker.value、prepared.base、prepared.value 和 prepared.ops（包括路径
// 和负载）按契约不可变。
tracker.adopt(prepared); // tracker.value === prepared.value

// 与 prepared.base 和 op 负载共享容器：也绝不能修改它。
const replica = applyImmutable(prepared.base, prepared.ops);
```

## 变更权限

| 值 | 可以修改吗？ |
| --- | --- |
| 传给 `track()`、`prepareReplace()`、`replicatedState()` 或 `replace()` 的根 | 否。所有权已转移给 tracker。 |
| `change.state` 及从它读出的句柄 | 可以，但仅在该变更打开期间。在 `prepare()`、`abort()` 或另一次 adopt 之后，任何使用都会抛出异常。通过其元素已从 draft 中移除的句柄进行的写入会被忽略。 |
| 被赋值或插入 draft 之后的外部值 | 可以。draft 存储的是经过校验的克隆。 |
| `tracker.value`、`prepared.base`、保留的旧修订 | 否。 |
| `prepared.value`、`prepared.ops`、op 元组、路径、排列、负载 | 否。负载可能与 `prepared.value` 的部分是同一对象。 |
| `applyImmutable()` / `applyImmutableBatches()` 的输入和结果 | 否。结果与两个输入共享容器。 |
| 来自复制状态和 cell 的值（`value`、监听器值、进程内句柄） | 否。进程内消费者可能与提供者共享容器。 |
| 传给 `apply()` 的可变副本 | 只能通过 `apply()`，且使用其独占拥有的批次。在批次之间直接编辑它的代码会破坏收敛。 |
| 传给 `apply()` 的批次 | 被消费。`apply()` 会把负载容器并入副本。应为恰好一个副本使用一份分离的拷贝，之后绝不再碰它。 |

## 重放批次

不可变重放是首选的进程内路径。一个批次可以扇出到任意数量的不可变副本：

```ts
let replica = tracker.value; // 与权威共享；绝不修改
// 对每个已采用的批次，按顺序：
replica = applyImmutable(replica, prepared.ops); // replica 必须等于 prepared.base
```

当只需要有序积压的最终结果时，重放其批次而不拼接它们的操作。整个调用共享一个写时复制
作用域，因此不会暴露任何中间修订，保留它们也是不安全的：

```ts
replica = applyImmutableBatches(
  replica,
  queuedFrames.map((frame) => frame.ops),
);
```

当每个中间修订都会被发布或保留时，使用单独的 `applyImmutable()` 调用。

可变重放需要分离的起始根，以及每个副本对每个批次的一份分离拷贝。绝不要把同一个内存中的
批次应用到两个可变副本：

```ts
import { apply } from "@earendil-works/chord/delta";

const detach = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let replica = detach(tracker.value); // 独占拥有的起始根
// 对每个已采用的批次，按顺序：
replica = apply(replica, detach(prepared.ops)); // 仅供该副本使用的新拷贝
// 只有 apply() 可以改动 `replica`；不要在应用代码中编辑它。
```

为每个副本解析一份单独序列化的消息也是有效的分离方式。`decode()` 不复制负载，因此把一个
内存中的 `WireOp[]` 解码给两个可变副本会让它们互相别名。

## 该做与不该做

- 应当先构建全新的根再转移它；在摄入边界校验不可信的根。
- 应当保持修订之间的结构共享，例如 `replace(ctx, { ...state.value, changed })`。
- 应当在把任何已发布的值交给可能修改它的代码之前克隆或序列化。
- 应当用 `prepare()` 或 `abort()` 了结每个变更。
- 不要在已转移的根中的两个位置复用同一容器。
- 不要修改 tracker 拥有的、已发布的或从批次收到的任何东西。
- 不要在变更结束后保留 draft 句柄，也不要放置已了结的句柄。
- 不要从 op 形状推断含义。只有结果值是契约。

## 根与放置

完整的根是受信任的。`track()` 和 `prepareReplace()` 以 O(1) 取得所有权，从不遍历树。
根必须无别名、无环，是严格的 JSON：致密的普通数组、普通对象或 null 原型对象（带可枚举的
自有数据属性）、字符串、布尔值、有限数字和 `null`。违反时的行为未指定。例如，被两个键共享的
容器可能使 `prepared.value` 偏离副本从 `prepared.ops` 计算出的结果。

Draft 放置会被复制，这次复制遍历同时进行校验。放置来自属性写入、索引写入、`push`、
`unshift`、`splice`、`fill` 和 `copyWithin`。非严格值在 draft 改变之前抛出 `TypeError`；
例如 `push(valid, invalid)` 不会插入任何东西。被拒绝的值包括：环、访问器（从不调用）、
symbol 键、类实例、稀疏或非普通数组、函数、bigint、`NaN`、无穷和 `undefined`。
null 原型对象被接受并保留。放置一个 draft 句柄会克隆其当前内容。把一个值放置到多个路径
会得到独立的容器。

`undefined` 规则：

- `draft.obj.key = undefined` 删除 `key`。
- `arr[i] = undefined`、`push(undefined)`、`unshift`、`splice` 和 `fill` 遇到 `undefined` 会抛出异常。
- 放置的对象或数组内任何位置嵌套的 `undefined` 都会抛出异常。它不会像 `JSON.stringify` 那样被丢弃。

数组保持致密。写到下一个索引之后和删除元素都会抛出异常。增大 `length` 插入 `null`；缩小它
移除元素。

## 生命周期

`tracker.value` 是最新采用的修订。`beginChange()` 在其上打开一个覆盖 draft，从不修改它。
draft 可以跨 `await` 保持打开。`prepare()` 物化候选值和 ops，不改动权威。`adopt()` 检查
准备结果并交换根指针。

多个变更可以基于同一个修订打开或准备。采用其中一个会让其他全部失效：打开的 draft 变为
不可用且其 `prepare()` 抛出异常，已准备的竞争者会被 `adopt()` 拒绝。`adopt()` 也拒绝外来的、
已中止的以及已被消费的准备结果。`prepare()` 之后的 `Change.abort()` 或 `Prepared.abort()`
会阻止采用。候选值保持可读。

无操作批次：

- 空 `ops` 意味着 `prepared.value === prepared.base`。恢复为原值的写入和深度相等的容器赋值
  通常会归一化为空。
- 相等性忽略键顺序和原型。深度相等的赋值保留上一个修订的顺序和原型，即使 draft 显示的是
  新的。
- 结构性数组编辑即使结果深度相等，也可能发出非空的精确批次。
- 采用无操作仍会推进 `tracker.revision` 并使竞争者失效。复制状态不发布无操作。

`prepareReplace(value)` 是整根操作，不是 diff。如果 `value` 与当前根深度相等，`ops` 为空并
保留当前根（比较可能遍历两棵树）。否则 `ops` 为 `[["r", value]]` 且 `prepared.value === value`，
因此副本会收到完整的根。

数组修改器：`push`、`pop`、`shift`、`unshift`、`splice`、`reverse`、`sort`、`fill` 和
`copyWithin`。持有的句柄在重新索引后跟随元素。

## 操作

路径包含对象键和非负整数数组索引。

| 元组 | 含义 |
| --- | --- |
| `["r", value]` | 替换完整的值。 |
| `["s", path, value]` | 设置对象属性或数组元素。 |
| `["d", path]` | 删除对象属性或移除数组元素。 |
| `["a", path, text]` | 向字符串追加。 |
| `["t", path, count]` | 从字符串前端移除 `count` 个 UTF-16 码元。 |
| `["p", path, index, remove, items]` | 对数组做 splice。 |
| `["m", path, permutation]` | 重排数组：`new[i] = old[permutation[i]]`。 |

批次是精确的但不是规范化的。同一变更可能使用不同的元组，大的编辑集合可能折叠为一个区域
splice、一个祖先 `s` 或 `r`。

保留键：tracker 绝不把 `__proto__`、`constructor` 或 `prototype` 作为路径段发出。在这些键
上或之下的变更会折叠为对最近的安全祖先的一次 set，或在根上的 `r`。`apply()`、
`applyImmutable()`、`applyImmutableBatches()` 和 `decoder()` 以 `UnsafePathError` 拒绝这些段。
Applier 把值写为自有数据属性，从不通过原型 setter。Applier 检查 op 形状和路径安全，但不检查
负载严格性。Chord 的远程状态应用从 JSON 帧解码的批次，因此其负载是严格的 JSON；对来自任何
其他来源的批次请校验其负载。

`encoder()` 把重复的路径内联为 `WireOp` 元组；`decoder()` 校验并还原 `Op` 元组。每个有序状态
流使用一对 encoder/decoder。路径 ID 跨批次有效，一个 `r` 重置两个字典。在解码或应用错误之后，
丢弃 decoder 和副本，从后续的 `r` 恢复。

## 限制与陷阱

- 没有冻结。修改任何不可变值都会静默破坏状态。
- 进程内共享：本地句柄、cell 订阅者和 `replicatedState` 订阅者收到的是提供者的容器。消费者
  的修改会破坏权威并使远程副本发散。
- 大型扁平数组内部的变更会为新修订复制该数组的指针存储。
- 放置校验在批量插入时消耗时间和内存。在一个基准测试中，unshift 10 万个三字段对象增加了
  约 19 ms 和 20 MiB 的瞬时堆。
- Draft 读取经过代理。一次测量中，2 万次热点嵌套读取经 tracker 约需 9 ms，而原始对象为
  0.08 ms；可用 `node --expose-gc packages/chord/test/delta-traversal.bench.ts --quick` 对比。
- 外部代理作为放置、会修改 draft 的参数强转回调、非基本类型的数组索引、非数字的比较结果都在
  契约之外。会修改、准备、中止或采用的 sort 比较器同样如此。行为未指定。
- 对象身份不被复制。每个路径都是独立的值放置。
- 一个 tracker 是一个修订序列。投递顺序和持久化属于外围协议。
