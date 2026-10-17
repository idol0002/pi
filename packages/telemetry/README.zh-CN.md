# @earendil-works/pi-telemetry

面向 pi 包的厂商中立遥测契约和带类型的 schema 工具。

该包提供：

- 显式的、基于回调的 `TelemetryContext` / `TelemetrySpan` 契约；
- 共享的 `NOOP_TELEMETRY_CONTEXT`；
- 参考实现 `InMemoryTelemetryContext`；
- 可序列化的 schema 定义，带推断的 TypeScript 类型；
- 不含 exporter、全局当前 span 状态或对遥测后端的依赖。

应用可以使用内存参考实现，或为 OpenTelemetry、Sentry、日志或其他后端提供适配器。Pi 包显式传递遥测上下文，并单独定义其领域 schema。

## 目录

- [安装](#安装)
- [遥测概念](#遥测概念)
- [核心上下文 API](#核心上下文-api)
- [适配器契约](#适配器契约)
- [No-op 上下文](#no-op-上下文)
- [内存参考适配器](#内存参考适配器)
- [适配器一致性](#适配器一致性)
- [带类型的 Schema](#带类型的-schema)
  - [开始与结束属性](#开始与结束属性)
- [Schema 元数据](#schema-元数据)
- [Pi 包集成](#pi-包集成)
- [安全与可移植性](#安全与可移植性)
- [API 参考](#api-参考)
- [开发](#开发)
- [许可证](#许可证)

## 安装

```bash
npm install @earendil-works/pi-telemetry
```

## 遥测概念

遥测描述程序在运行期间做了什么。该包用 span、属性、事件、状态和显式上下文来建模这些工作：

| 概念 | 通俗含义 |
|---|---|
| **Span** | 一次操作的计时记录，例如加载一个账号或发起一次 AI 请求。它开始于工作之前，结束于工作完成时。 |
| **父 span 与子 span** | 操作可以包含更小的操作。一个请求 span 可能包含一次缓存查找和一次数据库查询。它们共同构成一棵树，显示时间花在了哪里。 |
| **属性** | 附加到 span 上的具名事实，例如 `provider: "openai"`、`cache.hit: true` 或 `item_count: 12`。属性描述操作及其结果。 |
| **事件** | span 期间某个时点发生的具名事件，例如 `retry.scheduled` 或 `cache.lookup`。事件没有时长，可以携带自己的属性。 |
| **状态** | 操作的结果：`ok` 或 `error`。error 状态可以包含错误名和消息。 |
| **上下文** | 标识新工作在 span 树中归属位置的句柄。从某个上下文开始的 span 是它的子 span。 |

例如，加载一个账号可能产生这样的遥测：

```text
example.account.load                         span
├─ attributes: account.id=123, found=true   关于该 span 的事实
├─ event: example.cache.lookup              span 期间的事件
│  └─ attribute: cache.hit=false            关于该事件的事实
└─ status: ok                               最终结果
```

span 是诊断数据，不是业务状态。记录它绝不能改变账号加载是否运行、成功、失败或被持久化。适配器把这些通用概念翻译为 OpenTelemetry、Sentry、日志或其他后端使用的对应概念。

## 核心上下文 API

`TelemetryContext` 围绕一个回调启动 span。回调收到一个 `TelemetrySpan`，它同时也是子 span 的显式父上下文。

```typescript
import {
  NOOP_TELEMETRY_CONTEXT,
  type TelemetryContext,
} from '@earendil-works/pi-telemetry';

async function loadAccount(
  accountId: string,
  telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT,
) {
  return telemetryContext.startSpan(
    {
      name: 'example.account.load',
      attributes: { 'example.account.id': accountId },
    },
    async (span) => {
      const account = await readAccount(accountId);
      span.setAttributes({ 'example.account.found': account !== undefined });
      return account;
    },
  );
}
```

把回调 span 传给底层工作，形成显式嵌套：

```typescript
return telemetryContext.startSpan({ name: 'example.parent' }, async (parentSpan) => {
  return parentSpan.startSpan({ name: 'example.child' }, async (childSpan) => {
    childSpan.addEvent('example.cache.lookup', { 'example.cache.hit': true });
    return performWork();
  });
});
```

没有公开的 `end()` 方法。`startSpan()` 负责 settle，并让 span 保持打开，直到回调的值或 promise settle。对于由正常返回值表示的预期失败，显式设置状态：

```typescript
return telemetryContext.startSpan({ name: 'example.save' }, async (span) => {
  const result = await save();
  if (!result.ok) {
    span.setStatus({
      status: 'error',
      error: { name: 'SaveError', message: result.reason },
    });
  }
  return result;
});
```

## 适配器契约

适配器实现 `TelemetryContext`，把通用 API 桥接到其后端。它必须：

- 同步地、恰好一次地创建子 span 并调用回调；
- 保留回调的返回值和 rejection 值，同步抛出时返回以相同值 reject 的 promise；
- 让原生 span 保持打开，直到返回的 promise settle；
- 把正常完成视为 `ok`，把抛出/rejection 视为错误，除非显式设置过状态；
- 重复的 `setStatus()` 调用后写优先；
- 合并 `setAttributes()` 调用，后定义的值替换先前的值，`undefined` 被忽略；
- 让记录方法是同步的、被动的、不抛出的；
- 忽略 settle 之后的调用；
- 原子地忽略一次失败的记录调用，抑制后端失败，并且仍然恰好执行一次业务回调。

适配器可以在内部激活后端原生的环境上下文以支持自动埋点，但 pi 代码总是通过 `TelemetryContext` 参数传播父上下文。Exporter 缓冲、冲刷、采样、后端 ID 和后端特定的上下文对象属于适配器。用[适配器一致性测试套件](#适配器一致性)检查这些可观察语义。

## No-op 上下文

遥测可选时使用 `NOOP_TELEMETRY_CONTEXT`：

```typescript
import { NOOP_TELEMETRY_CONTEXT } from '@earendil-works/pi-telemetry';

const result = await NOOP_TELEMETRY_CONTEXT.startSpan(
  { name: 'example.operation' },
  () => runOperation(),
);
```

no-op 上下文：

- 同步调用回调；
- 保留返回值和异步 rejection，并把同步抛出转换为以相同值 reject 的 promise；
- 使用一个共享的冻结惰性 span，包括嵌套 span；
- 不检查也不保留名称、属性、事件或状态。

## 内存参考适配器

`InMemoryTelemetryContext` 是后端中立的参考实现。它适用于测试、本地诊断，以及有意想要进程内捕获而不带 exporter 的应用：

```typescript
import { InMemoryTelemetryContext } from '@earendil-works/pi-telemetry';

const telemetry = new InMemoryTelemetryContext();

await telemetry.startSpan(
  { name: 'example.operation', attributes: { input: 'demo' } },
  async (span) => {
    span.addEvent('example.started');
    span.setAttributes({ output_count: 3 });
  },
);

console.log(telemetry.getSpans());
```

`getSpans()` 按 span 开始顺序返回分离的快照。每个 `RecordedTelemetrySpan` 包含确定性的数字 ID、父 ID、合并后的属性、有序事件、最终状态、settle 状态和确定的结束序号。它不记录时间戳。

该适配器可以安全地当作普通 `TelemetryContext` 使用，但其存储是无界的且限于进程内。创建新实例可以隔离测试或记录范围；除非调用者的数据策略允许，不要捕获敏感属性。

## 适配器一致性

`@earendil-works/pi-telemetry/testing` 导出一套与测试运行器无关的一致性测试套件，按分组用例建模。fixture 提供一个全新的上下文，并把其后端已完成的 span 转换为规范化的 `RecordedTelemetrySpan` 快照：

```typescript
import {
  createTelemetryAdapterConformance,
  type TelemetryAdapterFixture,
} from '@earendil-works/pi-telemetry/testing';
import { describe, it } from 'vitest';

const conformance = createTelemetryAdapterConformance(async () => {
  const adapter = createMyTelemetryAdapter();
  return {
    context: adapter.context,
    getSpans: async () => adapter.normalizedSpans(),
    async [Symbol.asyncDispose]() {
      await adapter.close();
    },
  } satisfies TelemetryAdapterFixture;
});

for (const group of new Set(conformance.map((testCase) => testCase.group))) {
  describe(group, () => {
    for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
      it(testCase.name, () => testCase.run());
    }
  });
}
```

该套件检查：同步的单次进入、结果与 rejection 的同一性、自动与显式状态、属性合并、事件顺序、settle 后的惰性调用、嵌套与并发的父子关系，以及对不可读遥测负载失败的抑制。`getSpans()` 可以在返回之前冲刷异步 exporter。testing 子路径使用 Node 的断言 API；根遥测包保持运行时中立。

## 带类型的 Schema

底层 span API 有意接受开放的名称和属性袋，让适配器保持通用。领域包可以定义封闭的、可序列化的 schema，并从中推断精确的 TypeScript 类型。

```typescript
import {
  createTypedSpanStarter,
  defineTelemetrySchema,
} from '@earendil-works/pi-telemetry';

export const EXAMPLE_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    'example.read': {
      description: 'Read one resource',
      parents: { kind: 'any' },
      startAttributes: {
        'example.resource': {
          type: 'string',
          required: true,
          values: ['account', 'project'],
          description: 'Resource kind',
        },
      },
      endAttributes: {
        'example.item_count': {
          type: 'number',
          description: 'Number of returned items',
        },
      },
      events: {
        'example.cache': {
          description: 'Cache lookup result',
          attributes: {
            'example.cache.hit': {
              type: 'boolean',
              required: true,
              description: 'Whether the cache contained the resource',
            },
          },
        },
      },
      status: {
        default: 'ok',
        errorWhen: 'The read throws or returns an error result',
      },
    },
  },
} as const);

const startSpan = createTypedSpanStarter(
  telemetryContext,
  [EXAMPLE_TELEMETRY_SCHEMA],
);
```

starter 为每个 span 暴露一个重载，并在编译期检查名称和属性。联合类型的名称必须在调用前收窄，以保持每个运行时名称与其属性 schema 的对应关系。其回调收到一个绑定相同 schema 的子 starter，已绑定到回调 span：

```typescript
await startSpan(
  'example.read',
  { 'example.resource': 'account' },
  async (span, startChildSpan) => {
    span.addEvent('example.cache', { 'example.cache.hit': true });
    const accounts = await readAccounts();
    span.setAttributes({ 'example.item_count': accounts.length });

    await startChildSpan(
      'example.read',
      { 'example.resource': 'project' },
      async (childSpan) => {
        const projects = await readProjects();
        childSpan.setAttributes({ 'example.item_count': projects.length });
      },
    );

    return accounts;
  },
);
```

### 开始与结束属性

`startAttributes` 和 `endAttributes` 描述属性通常何时已知，而不是分开的运行时存储：

| Schema 字段 | 值如何被记录 | 必填性 |
|---|---|---|
| `startAttributes` | 在 span 创建时通过带类型 starter 的 `attributes` 参数传入 | 每个定义显式设置 `required: true` 或 `false` |
| `endAttributes` | 之后通过受 schema 限定的 span 的 `setAttributes()` 方法添加 | 总是可选 |

两组都成为同一后端 span 上的普通属性。没有单独的结束属性负载或结束回调。在前面的例子中，`example.resource` 在 `example.read` 开始时已知，而 `example.item_count` 只有在 `readAccounts()` 返回之后才已知：

```typescript
await startSpan(
  'example.read',
  { 'example.resource': 'account' }, // 必填的开始属性
  async (span) => {
    const accounts = await readAccounts();
    span.setAttributes({
      'example.item_count': accounts.length, // 可选的结束属性
    });
    return accounts;
  },
); // 回调 resolve 时 span settle
```

“结束”指完成时的补充：结束属性可以在回调活跃期间的任何时点设置，不可用时可以省略。一次都不调用 `setAttributes()` 是合法的。这对早期失败、取消以及并非每条路径都存在的提供商特定数据很重要。

重复的 `setAttributes()` 调用合并进同一个属性袋。同一键上后定义的值替换先前的值，`undefined` 被忽略。受 schema 限定的方法只接受当前 span 声明的结束属性。

属性不会结束 span。从回调返回、resolve、抛出或 reject 控制 settle；`startSpan()` 执行实际的结束操作。settle 之后的适配器调用是惰性的。

starter 可以组合多个独立版本化的 schema：

```typescript
import { AGENT_TELEMETRY_SCHEMAS } from '@earendil-works/pi-agent-core';

const startAgentSpan = createTypedSpanStarter(
  telemetryContext,
  AGENT_TELEMETRY_SCHEMAS,
);
```

内联的 schema 数组自动保留其元组类型。单独声明的数组应使用 `as const`。数组中字面量重复的 span 名称在编译期被拒绝；schema 在运行时不被合并、检查或保留。

由 schema 推导的类型拒绝：缺失的必填属性、未知键、无效的封闭集值、未声明的事件，以及空 schema 上的属性。结束属性总是可选的补充；类型系统不要求调用 `setAttributes()`。

`defineTelemetrySchema()` 是带类型的恒等函数。它返回普通的可 JSON 序列化数据，不做任何运行时校验或父规则强制。

## Schema 元数据

支持的属性类型有：

- `string`、`number` 和 `boolean`；
- `string[]`、`number[]` 和 `boolean[]`。

属性定义支持：

- `values`：标量值的封闭集；
- `elementValues`：数组元素的封闭集；
- `examples`：文档示例；
- `sensitive`：标记需要特殊处理的数据；
- `cardinality`：记录预期的 `low` 或 `high` 基数。

开始和事件属性声明 `required`。结束属性不声明；见[开始与结束属性](#开始与结束属性)。

父元数据是描述性的 schema 数据：

- `{ kind: 'any' }`：根或任何调用者 span；
- `{ kind: 'root_or_external' }`：根或 schema 之外的调用者自有 span；
- `{ kind: 'spans', spans: [...] }`：仅限列出的 schema span。

适配器不需要理解 schema 对象。埋点辅助函数和测试用它们保持发出的名称和属性一致。

## Pi 包集成

包的所有权有意拆分：

- `@earendil-works/pi-telemetry` 拥有厂商中立的契约、no-op 和内存参考上下文、schema 工具和适配器一致性套件；
- `@earendil-works/pi-ai` 在提供商请求选项中接受并传播 `telemetryContext`，但不拥有遥测 schema；
- `@earendil-works/pi-agent-core` 拥有并导出 pi AI 请求和 harness 的 schema、它们的组合只读 schema 元组，以及带类型的 span 辅助函数。

```typescript
import {
  AGENT_TELEMETRY_SCHEMAS,
  AI_TELEMETRY_SCHEMA,
  HARNESS_TELEMETRY_SCHEMA,
  startAiSpan,
  startHarnessSpan,
} from '@earendil-works/pi-agent-core';
```

pi 的 schema 使用 pi 自有的 `pi.ai.*`、`pi.harness.*` 和 `pi.session.*` 名称。适配器可以在不改变发出的 pi 词汇的情况下把它们翻译为后端约定。

## 安全与可移植性

遥测是进程内的诊断数据，不是持久化的应用状态。不要把 `TelemetryContext`、`TelemetrySpan` 或后端原生的 trace 对象持久化到记录、消息、快照或延迟句柄中。

属性值有意限制为基本标量和数组。领域埋点应避免提示词、补全、工具参数或输出、文件内容、提供商负载、请求头、凭据和自由格式的错误细节，除非其 schema 和数据策略明确允许。

该包不使用 `AsyncLocalStorage` 或其他运行时特定的环境上下文 API。它适用于 Node.js、Bun、浏览器和 worker；后端适配器自行负责其运行时兼容性。

## API 参考

### 核心类型与值

| 导出 | 用途 |
|---|---|
| `TelemetryContext` | 启动由回调管理的子 span |
| `TelemetrySpan` | 记录属性、事件和状态；同时充当子上下文 |
| `SpanOptions` | span 名称和可选的开始属性 |
| `SpanAttributes` / `AttributeValue` | 开放的适配器级属性袋及支持的值 |
| `SpanStatus` | 显式的 `ok` 或 `error` 状态 |
| `NOOP_TELEMETRY_CONTEXT` | 禁用遥测时的共享被动上下文 |
| `InMemoryTelemetryContext` | 带确定性进程内记录的参考适配器 |
| `RecordedTelemetrySpan` | 规范化的捕获 span 快照 |
| `RecordedTelemetryEvent` | 规范化的捕获事件快照 |

### Schema 定义与推断

| 导出 | 用途 |
|---|---|
| `defineTelemetrySchema()` | 可序列化 schema 数据的带类型恒等辅助函数 |
| `createTypedSpanStarter()` | 把父上下文绑定到一个或多个 schema 词汇 |
| `TypedSpanStarter` | 精确的 starter 类型，回调递归绑定子 starter |
| `TelemetrySchemaDefinition` | 顶层 schema 形状 |
| `TelemetrySpanDefinition` | span 元数据、父规则、属性、事件和状态规则 |
| `TelemetryAttributeType` | 支持的标量和数组类型名 |
| `TelemetryAttributeMetadata` | 描述、敏感性和基数元数据 |
| `TelemetryAttributeDefinition` | 属性类型、允许值、示例和元数据 |
| `TelemetryStartAttributeDefinition` | 带必填性的开始属性定义 |
| `TelemetryEventAttributeDefinition` | 带必填性的事件属性定义 |
| `TelemetryEventDefinition` | 事件描述和属性定义 |
| `TelemetryParentDefinition` | 开放、外部根或有限的 schema 父规则 |
| `TelemetrySchemaSpanName` | 已声明 span 名称的联合 |
| `TelemetrySchemaSpanStartAttributes` | 单个 span 精确推断的开始属性 |
| `TelemetrySchemaSpanEndAttributes` | 单个 span 可选推断的结束属性 |
| `TelemetrySchemaSpanEventName` | 单个 span 声明的事件的联合 |
| `TelemetrySchemaSpanEventAttributes` | 单个事件精确推断的属性 |
| `SchemaTelemetrySpan` | 限定到单个 schema span 的 span 视图 |
| `TelemetrySchemaSpanUnion` | schema 中所有 span 的判别联合 |
| `InferStartAttributes` | 从开始定义推断的必填和可选值 |
| `InferOptionalAttributes` | 从结束定义推断的可选值 |
| `InferEventAttributes` | 从事件定义推断的必填和可选值 |
| `InferRequiredAndOptionalAttributes` | 带必填性定义的共享推断工具 |
| `ExactTelemetryAttributes` | 拒绝预期属性集之外的键 |

### Testing 子路径

| 导出 | 用途 |
|---|---|
| `createTelemetryAdapterConformance()` | 创建与运行器无关的适配器一致性用例 |
| `TelemetryAdapterFixture` | 单个用例的全新上下文和规范化快照读取器 |
| `TelemetryAdapterFixtureFactory` | 创建隔离的 fixture |
| `TelemetryAdapterConformanceCase` | 由测试运行器执行的分组用例 |

## 开发

在该包目录下：

```bash
npm test
npm run build
```

仓库范围的类型检查、格式化、lint 和冒烟检查：

```bash
npm run check
```

## 许可证

MIT
