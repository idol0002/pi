# Codemode

`codemode` 工具让模型编写 JavaScript 脚本，调用 pi 的其他工具并运行非 LLM 模型（如分类器和图像模型）。只有脚本的输出会到达模型，因此脚本可以并行执行调用，并在模型看到结果之前过滤大结果。启用方法见[启用 codemode](cli.zh-CN.md#enable-codemode)。

## 脚本

工具输入是原始 JavaScript 源码，不是 JSON，也不是 markdown 代码围栏。它作为 async 函数体在 QuickJS 沙箱中运行，因此顶层 `await` 和 `return` 都可用。沙箱没有 Node API、文件系统、网络或定时器；脚本只能通过工具和 `models` 访问外部世界。

脚本可以以一行选项开头。它必须是第一行；选项行出现在其他任何位置都会在脚本运行前使调用失败：

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

- `max_output_tokens`（默认 10000）限制输出。超长输出会保留开头和结尾，全文写入一个临时文件，其路径包含在结果中。当输出超过 16777216 字符的文本与 base64 图像数据，或超过 100000 次 `text()`、`image()` 和 `console` 调用时，脚本失败；大数据请改用工具写入文件。
- `timeout_ms` 是整个脚本的硬性截止时间。默认不设置。图像生成可能需要数分钟，因此不要为生成图像的脚本设置过短的截止时间。

结果以 `Script completed` 或 `Script failed`、耗时和输出开头。文本和图像项按顺序出现，各占一行。当输出有多个文本项（来自 `text()` 或 `return`）时，每项以 `==> text N/M <==` 行开头。`console` 调用集中在一个 `<console_output>` 块中，每次调用一行。失败的脚本保留其部分输出，后跟 `Script error:` 和错误信息。工具调用是真实的：失败前已发出的调用不会被撤销。脚本结束时仍在运行的调用会被取消，未 await 的 promise 会被丢弃。

## 全局对象

| 全局对象 | 用途 |
|---|---|
| `tools.<name>(args)` | 调用一个工具。见[调用工具](#call-tools)。 |
| `text(value)` | 向输出添加一个文本项。字符串原样添加，其他值转为 JSON。 |
| `image(value)` | 向输出添加图像：base64 `data:` URL、`{ image_url }` 对象，或图像块 `{ type: "image", data, mimeType }`（如 MCP 工具和 `models.generateImages()` 返回的）。不支持远程 URL。接受 PNG、JPEG、GIF 和 WebP。每张图像还会保存到临时文件，结果中会在图像前给出路径。 |
| `console.log(...)` | 在其他输出之后的 `<console_output>` 块中添加一行。参数以空格连接；`info`、`warn`、`error` 和 `debug` 同样如此。 |
| `return value` | 顶层 `return` 会像 `text()` 一样添加该值。 |
| `exit()` | 成功结束脚本。 |
| `store(key, value)` / `load(key)` | 在多次 `codemode` 调用之间保存小型 JSON 值。见[存储值](#store-values)。 |
| `ALL_TOOLS` | 所有可调用工具的 `{ name, description }` 列表，包括描述中未列出的工具。 |
| `searchTools(query, { limit?, namespace? })` | 按相关性对可调用工具排序（BM25，默认 limit 8）。解析为 `{ name, description }[]`。 |
| `describeTool(name)` | 解析为工具的描述和 TypeScript 声明，或 `undefined`。 |
| `describeNamespace(name)` | 解析为某个命名空间（如 MCP 服务器）的 `{ name, description?, instructions?, tools }`，或 `undefined`。 |
| `models` | 列出并运行非 LLM 模型。见[模型](#models)。 |

## 调用工具

会话可调用的每个工具都是 `tools` 的一个方法，以其标识符命名：JavaScript 标识符中不合法的字符会变成 `_`，因此 MCP 工具 `mcp__dev-radius__search` 对应 `tools.mcp__dev_radius__search`。每个方法接受一个包含工具参数的对象。

调用的解析结果取决于工具：

- 有输出 schema 的工具解析为结构化值。`bash` 解析为 `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`，非零退出码时也是如此。它的 `output` 不受模型可见的 2000 行或 50KB 限制：最多容纳 1 MiB，更长的输出保留首尾各 512 KiB，中间是省略标记，并设置 `truncated`，完整输出在 `full_output_path`。
- MCP 工具解析为其 `CallToolResult`，包括 `isError` 和 `structuredContent`。
- `read` 解析为文件文本；对图像则解析为图像块 `{ type: "image", data, mimeType, note }`，可交给 `image()` 显示。`data` 是模型会看到的 base64 图像，`note` 是 accompanying 文本，如缩放提示。
- 其他工具（如 `edit` 和 `write`）解析为其文本输出。

失败、被阻止或参数非法的调用会以携带工具错误文本的 `Error` reject。用 `Promise.allSettled()` 保留成功调用的结果。

`codemode` 的工具描述按命名空间（例如单个 MCP 服务器）分组列出工具及其 TypeScript 声明。`deferred` 暴露方式的工具不在此列——默认 `codemode` 暴露方式的 MCP 工具属于此类——因此描述保持不变，MCP 服务器连接时也不变。已列出的声明共享 3000 估算 token 的预算（[设置](settings.zh-CN.md#tools)中的 `codemode.inlineBudget`）。脚本通过 `searchTools()`、`describeTool()`、`describeNamespace()` 或过滤 `ALL_TOOLS` 找到其他工具。

`codemode` 激活时，[设置](settings.zh-CN.md#tools)中的 `codemode.mode` 决定其他工具如何呈现。`on`（默认）时已声明工具保持声明状态，其描述说明如何从脚本调用。`only` 时它们对模型隐藏，改为列在 `codemode` 描述中，模型通过脚本调用它们。`codemode` 描述、`describeTool()` 和 `ALL_TOOLS` 中的工具声明携带工具的提示词指南，因为系统提示词规则只覆盖已声明的工具。

## 存储值

`store(key, value)` 以字符串键保存 JSON 值供后续 `codemode` 调用使用；存储 `undefined` 会删除该键。`load(key)` 返回该值或 `undefined`。只有脚本成功时写入才会保留：每个成功存储值的脚本会向会话追加一条 `codemode-store` 自定义条目，因此恢复的会话保留这些值，且每个分支只看到其路径上写入的值。

存储用于小型状态，如 ID、游标或摘要。单个值最多 262144 字符的 JSON，所有值合计最多 1048576。不要存储图像数据；用 `image()` 显示图像，它同时会把图像保存到临时文件。

## 模型

`models` 访问模型目录，用会话的凭据运行非 LLM 模型：分类器回答关于 JSON 状态的类型化问题（部分模型还支持图像），图像模型生成图像。聊天模型会列出但不能从脚本运行。可用的分类器和图像模型见[使用分类器模型](models.zh-CN.md#use-classifier-models)和[使用图像模型](models.zh-CN.md#use-image-models)。

```ts
type ModelType = "chat" | "image" | "classifier";

/** 目录条目。`provider` 和 `id` 标识它；其他字段取决于类型。 */
interface ModelInfo {
  type?: ModelType;
  provider: string;
  id: string;
  name: string;
  api: string;
  input: ("text" | "image")[];
  contextWindow?: number;
  [key: string]: unknown;
}

declare const models: {
  /** 某类型的所有已知模型，可选限定单个提供商。 */
  getModelsOfType(type: ModelType, provider?: string): Promise<ModelInfo[]>;
  /** 某类型中提供商凭据可用的模型。 */
  getAvailableOfType(type: ModelType, provider?: string): Promise<ModelInfo[]>;
  /** 单个目录条目，或 undefined。 */
  getModelOfType(type: ModelType, provider: string, id: string): Promise<ModelInfo | undefined>;
  /** 回答关于 `context.state` 的 `context.questions`；答案按问题 ID 在 `result.answers` 中。 */
  classify(model: ModelInfo, context: ClassifierContext): Promise<ClassifierResult>;
  /** 从 `context.input` 的文本和图像块生成图像；用 image() 显示 `result.output` 块。可能需要数分钟。 */
  generateImages(model: ModelInfo, context: ImagesContext): Promise<ImagesResult>;
};
```

`classify()` 和 `generateImages()` 只使用 `model` 的 `provider` 和 `id`，因此 `{ provider, id }` 也可以。它们在提供商出错时不抛异常：检查 `stopReason` 和 `errorMessage`。每个脚本同时最多运行四个此类调用；更多调用会等待空位，因此对大量条目使用 `Promise.all()` 也没问题。它们的用量会计入 `codemode` 工具结果并计入会话成本。

模型 ID 在不同提供商之间不同，例如 `typesafe/jev-latest` 和 `openrouter/typesafe/jev-1.13`。用 `models.getAvailableOfType(type)` 找到当前凭据可用的 ID。

### 分类

```ts
interface ClassifierContext {
  /** 要分类的数据。 */
  state: Record<string, unknown>;
  /** 与 `state` 一起评判的图像。只有 `input` 包含 "image" 的模型接受它们。 */
  images?: { type: "image"; data: string; mimeType: string }[];
  /** 按 ID 组织的问题。一次调用回答全部。 */
  questions: Record<string, ClassifierQuestion>;
}

type ClassifierQuestion =
  /** 选择一个标签。`criteria` 把每个标签映射到其含义。 */
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  /** 在有序量表上打分。`criteria` 描述每一级，从最低开始。 */
  | { type: "score"; instructions: string; criteria: string[] }
  /** 是或否。 */
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };

interface ClassifierResult {
  provider: string;
  model: string;
  /** 按问题 ID 组织的答案。 */
  answers: Record<string, ClassifierAnswer>;
  usage?: ModelUsage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
}

type ClassifierAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  /** `score` 是期望的级别索引，从 0 到 `criteria.length - 1`。 */
  | { type: "score"; score: number; confidence: number }
  /** `true` 的概率。 */
  | { type: "bool"; probability: number };

/** Token 计数与美元成本（当服务报告时）。 */
type ModelUsage = { input: number; output: number; totalTokens: number; cost: { total: number } };
```

对多个条目分类时，每个条目调用一次 `classify()`。下面的脚本对反馈消息排序，例如对脚本前面某工具返回的消息：

```js
const jev = await models.getModelOfType("classifier", "typesafe", "jev-latest");
const results = await Promise.all(
  messages.map((message) =>
    models.classify(jev, {
      state: { message },
      questions: {
        sentiment: {
          type: "choice",
          instructions: "How does the user feel about the product?",
          criteria: { positive: "Satisfied or happy", negative: "Unhappy or frustrated", neutral: "Neither" },
        },
        urgency: {
          type: "score",
          instructions: "How urgently does this need a reply?",
          criteria: ["no reply needed", "reply this week", "reply today"],
        },
      },
    }),
  ),
);
return results.map((result, i) =>
  result.stopReason === "stop"
    ? { message: messages[i], sentiment: result.answers.sentiment.choice, urgency: result.answers.urgency.score }
    : { message: messages[i], error: result.errorMessage },
);
```

`input` 包含 `"image"` 的分类器还能评判图像。`tools.read()` 返回的图像文件是图像块，可放入 `images`。其他分类器在 `images` 非空时返回错误结果。

```js
const luna = await models.getModelOfType("classifier", "openai", "gpt-6-luna");
const photo = await tools.read({ path: "screenshot.png" });
const result = await models.classify(luna, {
  state: { task: "Settings page redesign" },
  images: [photo],
  questions: {
    broken: {
      type: "bool",
      instructions: "Does the screenshot show a broken layout?",
      criteria: { true: "Overlapping, cut-off, or misaligned elements", false: "Clean layout" },
    },
  },
});
```

### 生成图像

```ts
interface ImagesContext {
  /** 文本块形式的提示词，加上用于编辑或作参考的图像块。 */
  input: (TextBlock | ImageBlock)[];
}

interface ImagesResult {
  provider: string;
  model: string;
  /** 生成的图像，以及同时返回文本的模型的文本块。 */
  output: (TextBlock | ImageBlock)[];
  usage?: ModelUsage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
}

type TextBlock = { type: "text"; text: string };
/** `data` 是 base64。 */
type ImageBlock = { type: "image"; data: string; mimeType: string };
```

用 `image(block)` 显示生成的图像。不要用 `text()`、`console` 或 `return` 打印 `data`：它很大，且模型无法把它当文本读。`image()` 还会把每张图像保存到临时文件并把路径放进结果，后续轮次可以复制或移动该文件。

```js
// @options: {"timeout_ms": 300000}
const painter = await models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
const result = await models.generateImages(painter, {
  input: [{ type: "text", text: "A red fox in the snow, watercolor" }],
});
if (result.stopReason !== "stop") return result.errorMessage;
for (const block of result.output) {
  if (block.type === "image") image(block);
  else text(block.text);
}
```

## 限制

- 脚本的 VM 有 256 MB 内存。耗尽时抛出 `InternalError: out of memory`；对大数据应过滤或聚合，而不是累积。
- 在 Bun 上，停止脚本或到达截止时间会及时结束调用，但不轮询 QuickJS 中断处理器的内置函数可能在返回前继续在其 worker 中计算。
- 一个 pi 进程中所有会话合计最多两个 codemode worker 存活。被取消的 worker 在退出前占用其槽位。达到上限时，新脚本立即失败而不会启动另一个 worker；等现有 worker 退出后重试。
- 等待一个永远不会 settle 的 promise（没有工具调用在进行）的脚本会立即失败，因为没有定时器。
- 脚本不能启动其他 `codemode` 脚本。
