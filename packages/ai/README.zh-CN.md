# @earendil-works/pi-ai

统一的 LLM API，提供提供商集合、自动认证解析、token 与成本跟踪，以及简单的上下文持久化和会话中途切换到其他模型的能力。

**注意**：聊天目录只包含支持工具调用（function calling）的模型，因为这对 agent 工作流至关重要。图片和分类目录则使用各自操作所需的能力。

## 目录

- [支持的提供商](#支持的提供商)
- [安装](#安装)
- [快速开始](#快速开始)
- [提供商与模型](#提供商与模型)
  - [提供商工厂](#提供商工厂)
  - [所有内置提供商](#所有内置提供商)
  - [查询模型](#查询模型)
  - [静态目录读取](#静态目录读取)
  - [动态提供商](#动态提供商)
- [认证](#认证)
  - [认证如何解析](#认证如何解析)
  - [转换请求头](#转换请求头)
  - [凭据存储](#凭据存储)
  - [环境变量](#环境变量)
- [工具](#工具)
  - [定义工具](#定义工具)
  - [处理工具调用](#处理工具调用)
  - [流式工具调用与部分 JSON](#流式工具调用与部分-json)
  - [校验工具参数](#校验工具参数)
  - [完整事件参考](#完整事件参考)
- [图片输入](#图片输入)
- [图片生成](#图片生成)
- [分类](#分类)
- [思考/推理](#思考推理)
  - [统一接口（streamSimple/completeSimple）](#统一接口streamsimplecompletesimple)
  - [提供商专属选项（stream/complete）](#提供商专属选项streamcomplete)
  - [流式思考内容](#流式思考内容)
- [停止原因](#停止原因)
- [错误处理](#错误处理)
  - [中止请求](#中止请求)
  - [中止后继续](#中止后继续)
  - [调试提供商负载](#调试提供商负载)
  - [观察提供商流事件](#观察提供商流事件)
- [自定义提供商](#自定义提供商)
  - [createProvider()](#createprovider)
  - [直接调用 API 实现](#直接调用-api-实现)
  - [OpenAI 兼容性设置](#openai-兼容性设置)
- [用于测试的 Faux 提供商](#用于测试的-faux-提供商)
- [跨提供商交接](#跨提供商交接)
- [系统消息](#系统消息)
- [上下文序列化](#上下文序列化)
- [浏览器使用](#浏览器使用)
- [打包与摇树优化](#打包与摇树优化)
- [OAuth 提供商](#oauth-提供商)
  - [Vertex AI](#vertex-ai)
  - [CLI 登录](#cli-登录)
  - [编程式 OAuth](#编程式-oauth)
- [从旧全局 API 迁移](#从旧全局-api-迁移)
- [开发](#开发)
- [许可证](#许可证)

## 支持的提供商

- **OpenAI**（包括 Decisions 分类器 API）
- **Ant Ling**
- **Azure OpenAI (Responses)**
- **OpenAI Codex（旧版）**（ChatGPT Plus/Pro 订阅，需要 OAuth，见下文）
- **Radius**（API key 或 OAuth，带动态刷新的网关目录）
- **TypeSafe**（System One 分类器 API）
- **DeepSeek**
- **NVIDIA NIM**
- **Anthropic**
- **Google**
- **Vertex AI**（通过 Vertex AI 使用 Gemini）
- **Mistral**
- **Groq**
- **Cerebras**
- **Cloudflare AI Gateway**
- **Cloudflare Workers AI**
- **xAI**
- **OpenRouter**
- **Vercel AI Gateway**
- **ZAI Coding Plan（国际）**（另有独立的中国提供商）
- **MiniMax**（另有独立的中国提供商）
- **Together AI**
- **Baseten**
- **Hugging Face**
- **Moonshot AI**（另有独立的中国提供商）
- **GitHub Copilot**（需要 OAuth，见下文）
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Fireworks**（使用 OpenAI 和 Anthropic 兼容 API）
- **Kimi For Coding**（Moonshot AI 订阅端点，使用 Anthropic 兼容 API）
- **Meta**（Model API，使用 OpenAI Responses 兼容 API）
- **Qwen Token Plan**（独立的 Individual 和现有目录，另有独立的中国提供商）
- **Xiaomi MiMo**（默认为 API 计费端点，另有面向 `cn`/`ams`/`sgp` 区域的独立 Token Plan 提供商）
- **任何 OpenAI 兼容 API**：Ollama、vLLM、LM Studio 等。

## 安装

```bash
npm install @earendil-works/pi-ai
```

TypeBox 的导出会从 `@earendil-works/pi-ai` 重新导出：`Type`、`Static` 和 `TSchema`。

## 快速开始

你构建一个由提供商组成的 `Models` 集合并通过它流式调用。最快的起步方式是注册所有内置提供商；关心包体积的应用则注册单个提供商（参见[提供商工厂](#提供商工厂)和[打包与摇树优化](#打包与摇树优化)）。

```typescript
import { Type, type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

// 一个注册了所有内置提供商的 Models 集合
const models = builtinModels();

// 对集合进行同步查找
const model = models.getModel('openai', 'gpt-4o-mini')!;

// 用 TypeBox schema 定义工具，获得类型安全和校验
const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

// 构建对话上下文（易于序列化，可在模型之间迁移）
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?', timestamp: Date.now() }],
  tools
};

// 方式一：流式调用，包含所有事件类型。
// 认证通过提供商解析（这里从环境变量读取 OPENAI_API_KEY）。
const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // 工具参数正在以流式方式传输
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error.errorMessage}`);
      break;
  }
}

// 流式结束后获取最终消息，加入上下文
const finalMessage = await s.result();
context.messages.push(finalMessage);

// 如有工具调用则处理
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // 把工具结果加入上下文（支持文本和图片）
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// 如果有工具调用，则继续对话
if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// 方式二：不使用流式，直接获取完整响应
const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

本 README 其余部分的代码片段都假设已按上述方式（注册了相关提供商）设置好 `models` 集合。

## 提供商与模型

**提供商（provider）** 是运行时单元：它拥有自己的模型目录、自己的认证（API key 解析、OAuth 流程）和自己的流式行为。`Models` 集合持有提供商，并把每个请求路由给拥有该模型的提供商。

提供商在内部共享 **API 实现**（即线上协议）：Anthropic 模型使用 `anthropic-messages`，OpenAI 使用 `openai-responses`，而 xAI、Groq、Cerebras、OpenRouter 以及大多数其他提供商共享 `openai-completions`。混合 API 的提供商（GitHub Copilot、OpenCode Zen）按模型分发。

### 提供商工厂

对于只需要特定提供商的应用，每个内置提供商都有一个工厂，各自是一个子路径导入，只拉取该提供商的目录：

```typescript
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
// ……“支持的提供商”列表中每个提供商一个模块

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

提供商工厂导入自己的模型目录和一个惰性 API 包装器，不会导入其他提供商。配合打包工具的代码分割，SDK 实现（`@anthropic-ai/sdk`、`openai`、`@google/genai` 等）会留在惰性 chunk 中，在首次请求该 API 的模型时才加载。

### 所有内置提供商

对于想要全部功能的应用（如快速开始所示）：

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels(); // 一个注册了所有内置提供商的 Models 集合
```

这会导入所有目录和每个内置提供商工厂。它是重量级且明确的入口。`builtinModels()` 接受与 `createModels()` 相同的选项（`credentials`、`authContext`）；如果你想在自己的集合上注册它们，`builtinProviders()` 会返回提供商数组。

### 查询模型

读取是同步的，返回最近已知的列表：

```typescript
const providers = models.getProviders();           // 已注册的 Provider 对象
const provider = models.getProvider('anthropic');  // 单个提供商

const all = models.getModels();                    // 跨提供商的所有聊天模型
const anthropicModels = models.getModels('anthropic');
const model = models.getModel('anthropic', 'claude-sonnet-4-5');

for (const m of anthropicModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  Context: ${m.contextWindow} tokens`);
  console.log(`  Vision: ${m.input.includes('image')}`);
  console.log(`  Reasoning: ${m.reasoning}`);
}
```

不带限定的读取 `getModels()`/`getModel()`/`getAvailable()` 返回可用于 `stream()` 的聊天模型（`Model<Api>`）。`*OfType` 读取返回单一模型类型，`getAllModels()`/`getAllAvailable()` 则以 `AnyModel` 返回所有类型：

```typescript
const images = models.getModelsOfType('image', 'openrouter');           // ImageModel[]
const flux = models.getModelOfType('image', 'openrouter', 'black-forest-labs/flux.2-pro');
const jev = models.getModelOfType('classifier', 'typesafe', 'jev-latest');
const availableImages = await models.getAvailableOfType('image');
const everything = models.getAllModels();                               // AnyModel[]
```

模型的 `type` 决定哪个操作接受它：聊天模型用于流式对话，`type: "image"` 模型生成图片，`type: "classifier"` 模型对结构化状态进行分类。`type` 在聊天模型上是可选的，因此没有 `type` 的模型就是聊天模型。不要直接比较 `type`；用 `isModelType()` 收窄混合列表，或用 `getModelType()` 读取有效类型：

```typescript
import { isModelType } from '@earendil-works/pi-ai';

for (const model of models.getAllModels()) {
  if (isModelType(model, 'image')) {
    // model: ImageModel<ImageApi>
  }
}
```

ID 在每个提供商和类型内唯一；同一个上游模型可能为不同操作拥有多个条目。在提供商上，`getModels()` 返回聊天模型，可选的 `getAllModels()` 返回所有类型；只有聊天模型的提供商可以省略它。

动态列出的聊天模型类型为 `Model<Api>`。当需要 API 专属的选项类型时，用 `hasApi()` 守卫收窄：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const m = models.getModel('anthropic', 'claude-sonnet-4-5');
if (m && hasApi(m, 'anthropic-messages')) {
  // m: Model<'anthropic-messages'> — 流选项完全有类型
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### 静态目录读取

对于想要生成的内置目录并拥有完整字面量类型（提供商和模型 ID 自动补全）的工具，可以独立于任何集合使用：

```typescript
import {
  getAllBuiltinModels,
  getBuiltinClassifierModel,
  getBuiltinClassifierModels,
  getBuiltinImageModel,
  getBuiltinImageModels,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini'); // 类型为 Model<'openai-responses'>
const radius = getBuiltinModel('radius', 'balanced');   // 类型为 Model<'pi-messages'>
const flux = getBuiltinImageModel('openrouter', 'black-forest-labs/flux.2-pro');
const jev = getBuiltinClassifierModel('typesafe', 'jev-latest');
const providers = getBuiltinProviders();
const openrouterChat = getBuiltinModels('openrouter');        // Model[]
const openrouterImages = getBuiltinImageModels('openrouter'); // ImageModel[]
const typesafeClassifiers = getBuiltinClassifierModels('typesafe'); // ClassifierModel[]
const openrouterAll = getAllBuiltinModels('openrouter');      // AnyModel[]
```

### 动态提供商

提供商的模型列表可以是动态的（llama.cpp 服务器、实时的 OpenRouter 列表）。读取保持同步；拉取是一个显式的异步动作：

```typescript
// getModels() 返回最近已知的列表（首次刷新前为空）
await models.refresh({ providers: ['llamacpp'] }); // 刷新一个提供商
await models.refresh();                            // 并发刷新所有提供商，尽力而为
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

静态内置提供商对 `refresh()` 是无操作。Radius 同时是静态和动态的：它内置公开的 `radius.pi.dev` 目录供同步 API 查找，刷新时在配置了认证的情况下叠加缓存的和新拉取的 `/v1/config` 模型。构建动态提供商参见 [createProvider()](#createprovider)。

## 认证

每个提供商拥有自己的认证：API key 如何解析（存储的凭据、环境变量、AWS profile 或 gcloud ADC 之类的环境来源），以及在支持的情况下 OAuth 登录/刷新流程。

### 认证如何解析

调用 `models.stream()` 时，集合通过拥有该模型的提供商解析认证并合并进请求。显式的每请求值总是优先：

```typescript
// 通过提供商解析（环境变量、存储的凭据、OAuth token）：
await models.complete(model, context);

// 显式 key 优先于提供商解析出的任何值：
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

你可以在不发起请求的情况下检查解析结果。传入提供商 ID 得到提供商范围的认证，或传入模型以包含其静态 `model.headers`：

```typescript
const providerAuth = await models.getAuth(model.provider);
const modelAuth = await models.getAuth(model);

if (modelAuth) {
  console.log(`configured via ${modelAuth.source}`); // 例如 "ANTHROPIC_API_KEY"、"OAuth"、"stored credential"
  console.log(modelAuth.auth.headers);              // 提供商认证头 + model.headers
} else {
  console.log('not configured');
}
```

两个重载都会解析凭据、在必要时刷新过期的 OAuth，并可能返回由认证派生的 `apiKey`、`headers` 或 `baseUrl`。`getAuth()` 对未配置的提供商解析为 `undefined`，在真正出问题时以 `ModelsError` reject（`"oauth"`：token 刷新失败，凭据保留以便重新登录；`"auth"`：key 解析或凭据存储失败）。请求路径把同样的失败作为流错误暴露。

`getAuth()`、`checkAuth()`、`getAvailable()`、登录和注销通过其现有的选项或交互对象接受可选的调用者取消，未提供 signal 时保持无限制。提供商的 `login`、`ApiKeyAuth.check`、`ApiKeyAuth.resolve` 和 `OAuthAuth.refresh` 实现总是收到具体的 signal，并且必须在阻塞工作中遵守它。

### 转换请求头

`Models.stream()`、`complete()`、`streamSimple()` 和 `completeSimple()` 接受一个仅属于 Models 的 `transformHeaders` 选项。它在提供商认证、`model.headers` 和显式 `options.headers` 合并之后、提供商分发之前运行一次：

```typescript
const response = await models.completeSimple(model, context, {
  headers: { "X-Client": "my-app" },
  transformHeaders: async (headers) => ({
    ...headers,
    "X-Request-ID": crypto.randomUUID(),
  }),
});
```

顺序为：

```text
provider auth headers -> model.headers -> explicit options.headers -> transformHeaders -> Provider.stream*()
```

请求头名称合并不区分大小写。显式请求头覆盖认证/模型请求头，转换拥有最终控制权；对某个请求头返回 `null` 可以抑制低层默认值，从而支持删除。

`transformHeaders` 属于 `Models` 而非 `Provider`。`Models` 的实现必须消费它并在调用 `Provider.stream*()` 之前移除它。提供商实现继续接收普通的 `ApiStreamOptions` 或 `SimpleStreamOptions`，从不自行处理该转换。用这个选项代替在 `stream*()` 之前调用 `getAuth(model)`，后者会把请求认证解析两次。

### 凭据存储

存储的凭据（交互输入的 API key、OAuth token）保存在 `CredentialStore` 中——每个提供商一条带类型标签的凭据。pi-ai 自带一个内存默认实现；应用可以注入持久化存储：

```typescript
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() 接受相同的选项：
// const models = builtinModels({ credentials: myFileBackedStore });
```

契约很小：`read(providerId)`、列出非机密 `{ providerId, type }` 元数据的 `list()`、`modify(providerId, fn)`（唯一的写入路径——串行化的读-改-写），以及 `delete(providerId)`。每个操作都接受可选的取消选项。枚举操作不得解析机密或执行已配置的 key 命令。OAuth token 刷新在 `modify` 内运行，因此并发请求和进程不会对同一个轮换 token 重复刷新。存储的凭据*拥有*其提供商：只有在没有任何存储时才会查询环境变量，刷新失败也绝不会静默回退到环境变量 key。

API key 凭据使用与 pi 的 `auth.json` 相同的判别字段，并可携带提供商范围的环境/配置值：

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
} as const;
```

### 环境变量

内置提供商解析以下环境变量（Node.js；浏览器中请显式传入 `apiKey`）：

| 提供商 | 环境变量 |
|----------|------------------------|
| OpenAI | `OPENAI_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL`（如 `https://{resource}.ai.azure.com`）或 `AZURE_OPENAI_RESOURCE_NAME`。支持 `*.openai.azure.com`、`*.cognitiveservices.azure.com` 和 `*.ai.azure.com`；根端点自动规范化为 `/openai/v1`。可选：`AZURE_OPENAI_API_VERSION`（默认 `v1`）、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。 |
| Anthropic | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_OAUTH_TOKEN` |
| Radius | `RADIUS_API_KEY` |
| TypeSafe | `TYPESAFE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY` 或 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）+ `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan（国际） | `ZAI_API_KEY` |
| ZAI Coding Plan（中国） | `ZAI_CODING_CN_API_KEY` |
| MiniMax（国际） | `MINIMAX_API_KEY` |
| MiniMax（中国） | `MINIMAX_CN_API_KEY` |
| Moonshot AI / Moonshot AI（中国） | `MOONSHOT_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Meta | `META_API_KEY` |
| Qwen Token Plan（现有目录） | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan（Individual） | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan（中国） | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo（API 计费） | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan（中国） | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan（阿姆斯特丹） | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan（新加坡） | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

`qwen-token-plan-individual` 和 `qwen-token-plan` 共享国际端点和
`QWEN_TOKEN_PLAN_API_KEY`。Individual 提供商只暴露面向 Individual
订阅的模型，而现有提供商为保持向后兼容保留更宽的目录。
存储的凭据仍然按提供商隔离，因此请把 key 保存到你注册的提供商 ID 下。

Amazon Bedrock 解析环境中的 AWS 凭据（`AWS_PROFILE`、访问密钥对、`AWS_BEARER_TOKEN_BEDROCK`、ECS 任务角色、web identity token）；其提供商自有的登录流程支持 bearer token、AWS profile 和现有凭据链。Vertex AI 解析显式 key 或 gcloud Application Default Credentials 加上 project/location，其提供商自有的登录流程支持 API key、ADC 和服务账号文件。

## 工具

工具让 LLM 能够与外部系统交互。本库使用 TypeBox schema 定义类型安全的工具，并使用 TypeBox 内置的校验器和值转换工具进行自动校验。TypeBox schema 可以作为普通 JSON 序列化和反序列化，因此非常适合分布式系统。

### 定义工具

```typescript
import { Type, type Tool, StringEnum } from '@earendil-works/pi-ai';

// 用 TypeBox 定义工具参数
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: Type.Object({
    location: Type.String({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// 注意：为了 Google API 兼容性，请使用 StringEnum 辅助函数而不是 Type.Enum
// Type.Enum 生成的 anyOf/const 模式 Google 不支持

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

### 工具的受限采样

工具可以选择加入提供商侧的受限采样（constrained sampling）。对 JSON-schema 工具，`strict: 'prefer'` 在受支持时使用提供商侧的严格 schema 强制，否则回退到普通工具调用。`strict: 'require'` 在当前提供商/模型无法满足时使请求失败。设置 `constrainedSampling: false` 可以显式退出；其行为与省略该字段相同。

```typescript
const strictTool: Tool = {
  name: 'edit_file',
  description: 'Edit a file',
  parameters: Type.Object({
    path: Type.String(),
    content: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' }
};
```

严格 JSON-schema 受限采样受 OpenAI、Anthropic、受支持的 Amazon Bedrock Converse 模型、Mistral 以及通过 Google Generative AI 和 Vertex 适配器的 Gemini 3 工具调用支持。Google 使用 `VALIDATED` 函数调用模式（显式请求时为 `ANY`）；更早的 Gemini 版本对 `strict: 'prefer'` 回退，并因不强制 required 参数而拒绝 `strict: 'require'`。Bedrock 的严格工具能力由模型结构化输出元数据生成；自定义 Bedrock 模型可以覆盖 `compat.supportsStrictMode`。OpenAI Responses 和 Chat Completions 还能通过 OpenAI Lark 或 regex 文法变体发出文法约束的自定义工具。如果同时提供多个 OpenAI 变体，Lark 优先于 regex。文法约束在当前模型支持文法工具时生效；否则该工具回退到普通函数/JSON-schema 处理。文法工具能力属于模型元数据：生成的目录为在透传 OpenAI 自定义工具的端点上的 GPT-5+ 模型设置 `compat.supportsOpenAIGrammarTools`（OpenAI、OpenAI Codex、Azure OpenAI Responses、GitHub Copilot、opencode 和 Cloudflare AI Gateway）。OpenAI 对 GPT-5 之前的模型拒绝 `type: "custom"` 工具，而规范化工具 schema 的网关（如 OpenRouter）会破坏它们，因此该标志在其他地方保持关闭。自定义模型定义可以通过 `compat` 选择加入。具备文法能力的模型会拒绝没有非空受支持变体的文法配置。原生文法工具的参数 schema 必须是对象，且恰好有一个必填的字符串属性：

```typescript
const patchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a patch',
  parameters: Type.Object({
    input: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: {
    type: 'grammar',
    variants: {
      openai_lark: 'start: /.+/s'
    }
  }
};
```

### 处理工具调用

工具结果使用内容块，可以同时包含文本和图片：

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// 检查响应中的工具调用
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // 用参数执行你的工具
    // 校验见“校验工具参数”一节
    const result = await executeWeatherApi(block.arguments);

    // 加入带文本内容的工具结果
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// 工具结果也可以包含图片（供具备视觉能力的模型使用）
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### 流式工具调用与部分 JSON

流式过程中，工具调用参数会随到达逐步解析。这让你可以在完整参数可用之前做实时 UI 更新：

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // 流式期间 toolCall.arguments 包含部分解析的 JSON
    // 这允许渐进式 UI 更新
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // 保持防御性：参数可能不完整
      // 例如：在内容尚未完成时就显示正在写入的文件路径
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // 内容可能不完整或缺失
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // 此时 toolCall.arguments 是完整的（但尚未校验）
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**关于部分工具参数的重要说明：**
- 在 `toolcall_delta` 事件期间，`arguments` 包含对部分 JSON 的尽力解析
- 字段可能缺失或不完整——使用前务必检查存在性
- 字符串值可能在单词中间被截断
- 数组可能不完整
- 嵌套对象可能只填充了一部分
- `arguments` 至少是空对象 `{}`，绝不会是 `undefined`
- Google 提供商不支持函数调用流式传输。你会收到一个携带完整参数的单个 `toolcall_delta` 事件。

### 校验工具参数

实现自己的工具执行循环时，用 `validateToolCall` 在把参数传给你的工具之前进行校验：

```typescript
import { validateToolCall, type Tool } from '@earendil-works/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // 依据工具的 schema 校验参数（参数无效时抛出异常）
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ……把工具结果加入上下文
    } catch (error) {
      // 校验失败——把错误作为工具结果返回，让模型可以重试
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

### 完整事件参考

成功生成遵循 `start → updates* → done`。生成开始后的失败遵循 `start → updates* → error`。请求设置可能在生成开始前失败，此时流中只有 `error`；在 `start` 之前出现 `done` 和更新事件都是无效的。直接 API 的 `streamSimple()` 调用在请求认证缺失时同步抛出。

每个非终结事件的 `partial` 是共享的、实时的“到目前为止的响应”辅助对象。它有意不是事件发生时刻的快照：随着生成推进，提供商可能修改同一个消息和内容块，包括在较旧的事件还在流队列中等待时。请在处理事件时检查它，而不是把它保留为历史状态。文本和普通思考块在 `*_start` 事件发出时为空，只通过匹配的 `*_delta` 事件增长，直到权威的 `*_end`；redacted thinking 可能在开始时就已完整且不发出 delta。`toolcall_start` 时的工具调用参数取决于提供商；`toolcall_delta` 携带后续的 JSON 更新。

助手消息生成期间发出的所有流事件：

| 事件类型 | 描述 | 关键属性 |
|------------|-------------|----------------|
| `start` | 流开始 | `partial`：初始助手消息结构 |
| `text_start` | 文本块开始 | `contentIndex`：在内容数组中的位置 |
| `text_delta` | 收到文本片段 | `delta`：新文本，`contentIndex`：位置 |
| `text_end` | 文本块完成 | `content`：完整文本，`contentIndex`：位置 |
| `thinking_start` | 思考块开始 | `contentIndex`：在内容数组中的位置 |
| `thinking_delta` | 收到思考片段 | `delta`：新文本，`contentIndex`：位置 |
| `thinking_end` | 思考块完成 | `content`：完整思考，`contentIndex`：位置 |
| `toolcall_start` | 工具调用开始 | `contentIndex`：在内容数组中的位置 |
| `toolcall_delta` | 工具参数流式传输 | `delta`：JSON 片段，`partial.content[contentIndex].arguments`：部分解析的参数 |
| `toolcall_end` | 工具调用完成 | `toolCall`：完整但未经 schema 校验的工具调用，含 `id`、`name`、`arguments` |
| `done` | 流完成 | `reason`：停止原因（"stop"、"length"、"toolUse"），`message`：最终助手消息 |
| `error` | 发生错误 | `reason`：错误类型（"error" 或 "aborted"），`error`：带部分内容的 AssistantMessage |

不同内容块的流事件不保证连续。提供商可能在同一个上游 chunk 中发出文本、思考和工具调用的 delta，pi 可能把对应的事件交错呈现，例如 `text_start`、`text_delta`、`toolcall_start`、`text_delta`、`toolcall_delta`。消费方必须使用 `contentIndex` 把每个 delta/end 事件关联到其内容块，并且不得假设某个块的 `*_start`/`*_delta`/`*_end` 序列不会被其他块的事件打断。

## 图片输入

具备视觉能力的模型可以处理图片。你可以通过 `input` 属性检查模型是否支持图片。把图片传给非视觉模型时，它们会被静默忽略。

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('openai', 'gpt-4o-mini')!;

// 检查模型是否支持图片
if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

// 访问响应
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

## 图片生成

图片模型与聊天模型位于同一个 `Models` 集合和同一个 `Provider` 上，因此每个提供商一份凭据即可覆盖两者。它们的类型是带 `type: "image"` 的 `ImageModel`，通过 `generateImages()` 使用——这是一次性 API，等待提供商响应并返回最终的 `AssistantImages` 结果。不要对它们使用聊天/流式 API；`stream()` 会拒绝图片模型。

### 基础图片生成

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels();

const model = models.getModelOfType('image', 'openrouter', 'google/gemini-2.5-flash-image')!;

// 认证通过提供商解析（这里是 OPENROUTER_API_KEY）；显式 apiKey 优先
const result = await models.generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
});

for (const block of result.output) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'image') {
    console.log(block.mimeType);
    console.log(block.data.substring(0, 32));
  }
}
```

`generateImages()` 只接受 `ImageModel` 值。如果上游模型同时支持聊天和图片生成，目录会包含提供商和 ID 相同的独立条目：`getModel()` 返回其聊天操作，`getModelOfType('image', ...)` 返回其图片操作。失败从不 reject；它们返回带 `stopReason: "error"` 的 `AssistantImages`，包括未知提供商、未配置的认证以及没有图片实现的提供商。

提供商通过 [`createProvider()`](#createprovider) 的 `images` 选项声明图片支持：一个从 `model.api` 到带 `generateImages()` 的实现的映射。图片模型与聊天模型放在同一个 `models` 列表中。存在 `images` 时 `api` 变为可选，因此纯图片提供商就是一个没有聊天模型的提供商：

```typescript
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';

const pixels = createProvider({
  id: 'pixels',
  auth: { apiKey: envApiKeyAuth('Pixels API key', ['PIXELS_API_KEY']) },
  models: [{
    type: 'image',
    id: 'flux-pro',
    name: 'FLUX Pro',
    api: 'pixels-images',
    provider: 'pixels',
    baseUrl: 'https://api.pixels.test/v1',
    input: ['text'],
    output: ['image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
  images: {
    'pixels-images': { generateImages: async (model, context, options) => { /* ... */ } },
  },
});
models.setProvider(pixels);
```

旧的全局 API（`getImageModel()` / `getImageModels()` / `getImageProviders()` / `generateImages()`）在 [compat 入口](#从旧全局-api-迁移)上仍然可用：

```typescript
import { getImageModel, generateImages } from '@earendil-works/pi-ai/compat';

const model = getImageModel('openrouter', 'google/gemini-2.5-flash-image');
const result = await generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
}, {
  apiKey: process.env.OPENROUTER_API_KEY
});
```

一些模型还支持图片输入：

```typescript
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('input.png');
const result = await models.generateImages(model, {
  input: [
    { type: 'text', text: 'Create a variation of this image with a blue background.' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ]
});
```

在模型元数据上检查能力：

```typescript
console.log(model.input);  // ['text'] 或 ['text', 'image']
console.log(model.output); // ['image'] 或 ['image', 'text']
```

### 说明与限制

- 图片模型与聊天模型共享 `Models` 和 `Provider`；用 `getModelsOfType('image')` 列出，用 `generateImages()` 运行，绝不要用聊天/流式 API。
- 图片生成模型不参与工具调用。
- 输出在 `AssistantImages.output` 中返回，可以同时包含 base64 编码的 `ImageContent` 块和 `TextContent` 块。
- 有些模型只返回图片，有些返回图片加文本。检查 `model.output`。
- 有些模型接受图片输入，有些只支持文本生成图片。检查 `model.input`。
- 与流式 API 一样，图片生成支持 `apiKey`、`signal`、`headers`、`onPayload` 和 `onResponse` 等选项，结果可以包含 `stopReason`、`responseId` 和 `usage`。
- 如果你想让模型在对话中分析图片或调用工具，请使用支持图片输入的模型的常规聊天 API。
- 目前图片生成只能通过一个提供商使用：OpenRouter。

## 分类

分类器模型消费结构化的 JSON 状态（可选地加上图片），并回答一个或多个有类型的问题。它们不使用聊天或图片生成 API。TypeSafe 的 Jev 模型、Cloudflare 的 Clef 模型和 OpenAI 的 GPT-6 Luna 可从以下内置提供商获得：

| 提供商 | 模型 ID | 认证 |
| --- | --- | --- |
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `typesafe/jev-1.13`、`~typesafe/jev-latest` | `OPENROUTER_API_KEY` 或 OpenRouter OAuth |
| `cloudflare-workers-ai` | `typesafe/jev`、`@cf/cloudflare/clef`、`@cf/cloudflare/clef-flash` | `CLOUDFLARE_API_KEY` 和 `CLOUDFLARE_ACCOUNT_ID` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `opencode` | `jev-1.13`、`jev-1.13-free` | `OPENCODE_API_KEY` |
| `openai` | `gpt-6-luna` | `OPENAI_API_KEY` |

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels();
const model = models.getModelOfType('classifier', 'typesafe', 'jev-latest')!;
const result = await models.classify(model, {
  state: { message: 'The change works perfectly, thanks.' },
  questions: {
    category: {
      type: 'choice',
      instructions: 'Classify the message.',
      criteria: {
        approval: 'The user approves of the result',
        correction: 'The user requests a correction'
      }
    },
    satisfaction: {
      type: 'score',
      instructions: 'Score user satisfaction.',
      criteria: ['dissatisfied', 'neutral', 'satisfied']
    },
    approved: {
      type: 'bool',
      instructions: 'Does the user approve?',
      criteria: { true: 'Approval', false: 'No approval' }
    }
  }
});

console.log(result.answers);
```

公开契约使用 `bool` 问题和 `{ type: "bool", probability }` 答案。TypeSafe 适配器在两者与其 `noul` 线上表示之间转换。与图片生成一样，`classify()` 对提供商、认证或响应错误返回带 `stopReason: "error"` 的结果而不是 reject。

当服务报告 token 计数时，`result.usage` 会携带它们及其按模型目录价格计算的成本，与聊天消息的 `Usage` 形状相同。所有 System One 服务都报告 token 计数；一个以畸形答案作答的请求仍保留其 usage。`llama-cpp-classify` 之类的本地分类器不报告 usage。

`ClassifierOptions.temperature` 在答案 logits 归一化之前把它们除以给定值；大于 1 的值让分布更平缓。无法应用它的 API（如 System One 和 OpenAI Decisions）会忽略它。

`ClassifierContext.images` 保存与状态一起判定的图片块（`{ type: "image", data, mimeType }`）。只有 `input` 包含 `"image"` 的模型接受它们；`classify()` 对其他模型返回错误结果。

### OpenAI Decisions

`openai-decisions` API 调用 OpenAI 的 [Decisions API](https://developers.openai.com/api/docs/guides/decisions)（`POST /v1/decisions`）。GPT-6 Luna 是它唯一的模型。状态以 JSON 文本发送；带图片时，输入是一条用户消息，先放状态，再以 data URL 形式放图片（最多 128 张）。`choice` 和 `score` 问题映射到同名的 Decisions 类型。`bool` 问题变为 `predicate` 问题；predicate 没有 criteria 字段，因此 true 和 false 的含义会被附加到 instructions 中。如果 OpenAI 拒绝回答某个问题，整个结果就是错误。usage 只报告输入 token，按目录输入价格乘以 OpenAI 的长上下文倍率计价。

该端点需要 OpenAI API key；Sign in with ChatGPT 凭据会被拒绝，因此当 `openai` 提供商使用 OAuth 时，它会在 `getAvailableOfType('classifier')` 中隐藏 `gpt-6-luna`。API 拒绝超过 922K token 的输入，但运行超过约五秒（目前约 600K 以上输入 token）的请求会以网关超时（504）失败。

### llama.cpp 上的聊天模型

llama.cpp 也通过 `/v1/systemone` 原生提供 Julia-1、Kev 等决策模型。自 llama.cpp 0.6.0 起，`GET /models` 会在这些模型的 `architecture.output_modalities` 中列出 `decisions`。它们使用 `typesafe-system-one` API，以服务器的 `/v1` URL 作为 `baseUrl`（例如 `http://127.0.0.1:8080/v1`）；它需要一个 `apiKey`，除非 llama.cpp 以 `--api-key` 启动，否则它会忽略该值。`llama-cpp-classify` API 是聊天模型的回退方案。

`llama-cpp-classify` API 把 llama.cpp `llama-server` 服务的聊天模型变成分类器。每个问题变成一个聊天提示：状态、请求中的每个问题、再次的状态，以及该问题及其以单 token 标签表示的答案（choice 用字母，bool 用 `Yes`/`No`，score 用数字）。到最后一个问题为止的提示部分由请求的所有问题共享，因此服务器的提示缓存对每个请求只求值一次状态。服务器返回下一个 token 的对数概率，答案就是标签 token 上的 softmax。choice 最多支持 62 个选项，score 最多 10 级。模型的 `baseUrl` 是服务器 URL；末尾的 `/v1` 会被忽略。在路由模式下，模型 ID 用于选择模型。

```typescript
import { createProvider } from '@earendil-works/pi-ai';
import { llamaCppClassifyApi } from '@earendil-works/pi-ai/api/llama-cpp-classify.lazy';

const provider = createProvider({
  id: 'local-llama',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [{
    type: 'classifier',
    id: 'qwen3-4b',
    name: 'Qwen3 4B',
    api: 'llama-cpp-classify',
    provider: 'local-llama',
    baseUrl: 'http://127.0.0.1:8080',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768
  }],
  classifiers: { 'llama-cpp-classify': llamaCppClassifyApi() }
});
```

原始标签概率通常过于自信；传入大于 1 的 `temperature` 让它们更平缓。

自定义提供商按 API ID 注册分类器模型和实现：

```typescript
createProvider({
  id: 'classifier-service',
  auth,
  models: [model],
  classifiers: {
    'classifier-api': { classify: async (model, context, options) => result }
  }
});
```

## 思考/推理

许多模型支持思考/推理能力，可以展示其内部思考过程。你可以通过 `reasoning` 属性检查模型是否支持推理。把推理选项传给不支持推理的模型时，它们会被静默忽略。

### 统一接口（streamSimple/completeSimple）

```typescript
// 跨提供商的许多模型支持思考/推理
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
// 或 models.getModel('openai', 'gpt-5-mini');
// 或 models.getModel('google', 'gemini-2.5-flash');
// 或 models.getModel('xai', 'grok-4.7');

// 检查模型是否支持推理
if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

// 使用简化的推理选项
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// 访问思考和文本块
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('Thinking:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Response:', block.text);
  }
}
```

`xhigh` 和 `max` 是模型专属的可选级别。用 `getSupportedThinkingLevels(model)` 判断具体模型是否暴露这两个级别；GPT-5.6 等模型可以同时暴露两者。

### 提供商专属选项（stream/complete）

`models.stream()`/`complete()` 接受所属 API 的完整选项集。用 `hasApi()` 把动态查到的模型收窄到其 API，获得完整的选项类型：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

// OpenAI Reasoning（o1、o3、gpt-5）
const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'  // 仅 OpenAI Responses API
  });
}

// Anthropic Thinking
const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // 可选的 token 限制
  });
}

// Google Gemini Thinking
const googleModel = models.getModel('google', 'gemini-2.5-flash')!;
if (hasApi(googleModel, 'google-generative-ai')) {
  await models.complete(googleModel, context, {
    thinking: {
      enabled: true,
      budgetTokens: 8192  // -1 表示动态，0 表示禁用
    }
  });
}
```

### 流式思考内容

流式时，思考内容通过特定事件送达：

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // 流式输出思考内容
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## 停止原因

每个 `AssistantMessage` 都包含一个 `stopReason` 字段，说明生成是如何结束的：

- `"pending"` - 仅在部分消息中出现，表示我们还不知道停止原因会是什么
- `"stop"` - 这是模型本轮要产出的最终消息
- `"length"` - 输出达到了最大 token 限制
- `"toolUse"` - 模型正在调用工具并期待工具结果
- `"error"` - 生成过程中发生错误
- `"aborted"` - 请求通过 abort signal 被取消

当底层 API 暴露时，`AssistantMessage` 还可以包含 `responseId`，即提供商特定的上游响应或消息标识符。不要假设它在所有提供商上都存在。

## 错误处理

流返回之后的请求失败从不抛出：当请求以错误结束（包括中止和工具调用校验错误）时，流式 API 会发出一个 error 事件，最终消息携带细节。设置失败可能在不发出 `start` 的情况下发出 `error`；生成开始后的失败会发出 `start`、所有已观察到的更新，然后是 `error`。直接 API 的 `streamSimple()` 调用在请求认证缺失时同步抛出：

```typescript
// 流式调用中
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason 是 "error" 或 "aborted"
    // event.error 是带部分内容的 AssistantMessage
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

// 最终消息会带有错误细节
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
  // message.content 包含错误发生前收到的所有部分内容
  // message.usage 包含部分的 token 计数和成本
}
```

使用提供商集合时，认证失败（OAuth 刷新失败、未知提供商）会以带 `stopReason: "error"` 的流错误暴露。直接 API 的 `streamSimple()` 调用在所需认证缺失时改为同步抛出。

### 中止请求

abort signal 允许你取消进行中的请求。被中止的请求 `stopReason === 'aborted'`：

```typescript
const controller = new AbortController();

// 2 秒后中止
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: 'Write a long story', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason 告诉你是 "error" 还是 "aborted"
    console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
  }
}

// 获取结果（如果被中止可能是部分的）
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('Request was aborted:', response.errorMessage);
  console.log('Partial content received:', response.content);
  console.log('Tokens used:', response.usage);
}
```

### 中止后继续

被中止的消息可以加入对话上下文，并在后续请求中继续：

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Explain quantum computing in detail', timestamp: Date.now() }
  ]
};

// 第一个请求在 2 秒后被中止
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// 把部分响应加入上下文
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue', timestamp: Date.now() });

// 继续对话
const continuation = await models.complete(model, context);
```

### 调试提供商负载

用 `onPayload` 回调检查发送给提供商的请求负载。这对调试请求格式问题或提供商校验错误很有用。

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

`stream`、`complete`、`streamSimple` 和 `completeSimple` 都支持该回调。

### 观察提供商流事件

用 `onProviderStreamEvent` 检查 pi 未纳入 `AssistantMessage` 的提供商特定字段。回调收到的是适配器在 pi 规范化之前可用的已解析事件。请把事件视为只读，因为修改可能影响规范化。这不保证是原始 HTTP 字节或 SSE 帧。

```typescript
const openRouterModel = models.getModel('openrouter', 'openrouter/auto')!;
const response = await models.complete(openRouterModel, context, {
  headers: { "X-OpenRouter-Metadata": "enabled" },
  onProviderStreamEvent: (data) => {
    const chunk = data as Record<string, unknown>;
    if (chunk.openrouter_metadata) {
      console.log(chunk.openrouter_metadata);
    }
  },
});
```

回调按流顺序被 await，因此缓慢的回调会延迟流的消费，抛出的错误会使请求失败。基于 SDK 的适配器可能只暴露其 SDK 保留的字段。

## 自定义提供商

### createProvider()

`createProvider()` 从各个部分构建提供商：身份、认证、模型列表和 API 实现（聊天模型用 `api`，图片生成用 `images`，分类用 `classifiers`；至少需要一个，参见[图片生成](#图片生成)）。把它用于本地推理服务器、代理或任何 OpenAI/Anthropic 兼容端点：

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // 每个提供商都声明认证；无 key 的本地服务器解析为“已配置、无 key”。
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

对于有真实 key 的提供商，`envApiKeyAuth(displayName, envVars)` 提供标准行为（存储的凭据优先，然后是第一个已设置的环境变量）：

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

混合 API 的提供商传入以 `model.api` 为键的映射；每个模型分发到其 API 的实现：

```typescript
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* api 为 'anthropic-messages' 或 'openai-responses' 的模型 */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

提供商范围的端点或请求转换应放在提供商的 API 实现中：包装你作为 `api` 传入的 `ProviderStreams`，让每个请求在分发前都经过转换。Cloudflare 提供商就是这样从解析出的提供商环境变量中物化 account/gateway 端点占位符的：

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
  const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace('{tenant}', tenantId) });
  return {
    stream: (model, context, options) => streams.stream(withTenant(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
  };
}

const tenantGateway = createProvider({
  id: 'tenant-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* ... */],
  api: tenantStreams(openAICompletionsApi()),
});
```

动态模型列表使用 `fetchModels`，它可以返回所有类型的模型。`Models.refresh()` 刷新每个已配置的动态提供商，传入其有效的 API key 或刷新后的 OAuth 凭据。`ModelsStore` 持久化动态目录；两个存储默认都是内存实现。其 `read`、`write` 和 `delete` 操作接受可选的取消，`Models` 会把这些等待绑定到提供商刷新 signal。

```typescript
const models = createModels({ credentials, modelsStore });
const llamacpp = createProvider({
  id: 'llamacpp',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [],
  fetchModels: async ({ signal }) => fetchModelsFromServer('http://localhost:8080', signal),
  api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
const result = await models.refresh({ signal });
if (result.aborted) console.log('refresh cancelled');
for (const [provider, error] of result.errors) console.error(provider, error);
```

省略可选 signal 时，`Models.refresh()` 是无限制的。提供商总是收到具体的 `RefreshModelsContext.signal`，并且必须对网络请求和其他阻塞工作遵守它。当调用者提供 signal 时，即使自定义提供商不配合，`Models.refresh()` 也会在取消后及时返回 `aborted: true`；提供商仍必须遵守 signal 以停止其底层工作。

用 `models.refresh({ providers: ['openrouter'] })` 把工作限制在选定的提供商，用 `models.refresh({ allowNetwork: false })` 在无网络访问的情况下恢复持久化目录，或用 `models.refresh({ force: true })` 跳过提供商新鲜度检查。模型读取保持同步，返回最近恢复或刷新的列表。

`createProvider()` 自动处理动态发布和持久化。手写的 `Provider.refreshModels()` 实现会收到只读的 `context.stored` 快照，并通过 `context.publish({ persist?, update? })` 发布。省略 `persist` 保持存储不变，传入 `ModelsStoreEntry` 写入它，或传入 `persist: null` 删除它。`ModelsStoreEntry.models` 包含所有类型的模型。发布是按代数检查的；把同步的内存目录变更放入 `update`，而不是在发布前修改状态。

自定义模型可以携带 `headers`（例如位于机器人检测之后的代理）和 `compat` 标志。`Models.getAuth(model)` 会包含这些模型请求头，流方法会在显式请求头和 `transformHeaders` 之前合并它们。参见 [OpenAI 兼容性设置](#openai-兼容性设置)。

一些 OpenAI 兼容服务器不理解用于支持推理的模型的 `developer` 角色。对这些提供商，把 `compat.supportsDeveloperRole` 设为 `false`，让系统提示作为 `system` 消息发送。如果服务器还不支持 `reasoning_effort`，也把 `compat.supportsReasoningEffort` 设为 `false`。这常见于 Ollama、vLLM、SGLang 和类似的 OpenAI 兼容服务器。

用模型级的 `thinkingLevelMap` 描述模型专属的思考控制。键是 pi 的思考级别（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。到 `high` 为止缺失的标准级别使用提供商默认值；`xhigh` 和 `max` 是可选的，需要非 null 的映射条目。字符串值发送给提供商，`null` 表示不支持该级别，映射可以跳过某些级别。

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### 直接调用 API 实现

API 实现可以单独导入。每个模块恰好导出 `stream` 和 `streamSimple`，并带有该 API 的完整选项类型。直接调用绕过提供商认证和上下文规范化——请显式传入 `apiKey` 并用 `normalizeContext()` 包装上下文：

```typescript
import { normalizeContext } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';

const s = stream(claudeModel, normalizeContext(context), {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

内置 API 实现位于 `./api/<api-id>` 下：

| API id | 选项类型 |
|--------|--------------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |
| `openai-codex-responses` | `OpenAICodexResponsesOptions` |
| `azure-openai-responses` | `AzureOpenAIResponsesOptions` |
| `google-generative-ai` | `GoogleOptions` |
| `google-vertex` | `GoogleVertexOptions` |
| `mistral-conversations` | `MistralOptions` |
| `bedrock-converse-stream` | `BedrockOptions` |

导入实现模块会加载其 SDK。`./api/<id>.lazy` 包装器（提供商工厂使用）在运行时或打包工具支持动态导入分块时，把加载推迟到第一个请求。旧版本的原生 API 子路径（`./anthropic`、`./google`、`./mistral`、`./openai-completions` 等）已移除；请使用 `@earendil-works/pi-ai/api/<api-id>`。

### OpenAI 兼容性设置

`openai-completions` API 被许多提供商以细微差异实现。默认情况下，库会根据 `baseUrl` 为一小部分已知的 OpenAI 兼容提供商（Cerebras、xAI、Chutes、DeepSeek、NVIDIA NIM、Together AI、zAi、OpenCode、Cloudflare Workers AI 等）自动检测兼容性设置。对于自定义代理或未知端点，你可以通过 `compat` 字段覆盖这些设置。对 `openai-responses` 模型，compat 字段支持 Responses 专属的标志。

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // 提供商是否支持 `store` 字段（默认：true）
  supportsDeveloperRole?: boolean;   // 提供商支持 `developer` 角色还是 `system`（默认：true）
  supportsReasoningEffort?: boolean; // 提供商是否支持 `reasoning_effort`（默认：true）
  supportsUsageInStreaming?: boolean; // 提供商是否支持 `stream_options: { include_usage: true }`（默认：true）
  supportsStrictMode?: boolean;      // 提供商是否支持工具定义中的 `strict`（默认：false；对具备能力的内置模型在元数据中启用）
  supportsOpenAIGrammarTools?: boolean; // 是否发出 OpenAI 自定义 Lark/regex 文法工具；false 回退到普通函数工具（默认：false；生成的目录为具备能力的模型启用）
  supportsMidConvoSystemMessages?: boolean; // 模型是否接受对话开始后的系统消息；false 时把它们折叠进开头的提示（默认：false；生成的目录为已验证的模型启用）
  supportsMidConvoToolAdditions?: boolean; // 系统消息是否可以通过 Kimi 风格的 `tools` 系统消息在对话中途添加工具；需要 supportsMidConvoSystemMessages（默认：false）
  sendSessionAffinityHeaders?: boolean; // 从 `sessionId` 发送会话亲和数据（OpenRouter 默认 true，其他默认 false）
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // 会话亲和格式：'openai' 使用 `prompt_cache_key`、`session_id`、`x-client-request-id` 和 `x-session-affinity`；'openai-nosession' 使用 `prompt_cache_key`、`x-client-request-id` 和 `x-session-affinity`；'openrouter' 使用 `x-session-id`（默认：自动检测）
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // 使用哪个字段名（默认：max_completion_tokens）
  requiresToolResultName?: boolean;  // 工具结果是否需要 `name` 字段（默认：false）
  requiresAssistantAfterToolResult?: boolean; // 工具结果后是否必须跟一条助手消息（默认：false）
  requiresThinkingAsText?: boolean;  // 思考块是否必须转换为文本（默认：false）
  requiresReasoningContentOnAssistantMessages?: boolean; // 启用推理时，所有重放的助手消息是否必须包含空的 reasoning_content（默认：DeepSeek 自动检测）
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'baseten' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'; // 推理参数的格式：'openai' 使用 reasoning_effort，'openrouter' 使用 reasoning: { effort }，'deepseek' 使用 thinking: { type } 并在受支持时加上 reasoning_effort，'together' 使用 reasoning: { enabled } 并在受支持时加上 reasoning_effort，'baseten' 使用可配置的 chat_template_args 并在受支持时加上 reasoning_effort，'zai' 使用 thinking: { type }，'qwen' 使用 enable_thinking，'chat-template' 使用可配置的 chat_template_kwargs，'qwen-chat-template' 使用 chat_template_kwargs.enable_thinking 和 preserve_thinking，'string-thinking' 使用顶层 thinking，'ant-ling' 仅对映射的 effort 使用 reasoning: { effort }（默认：openai）
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_kwargs 值；用 $var 表示 pi 控制的思考值
  chatTemplateArgs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // thinkingFormat 为 'baseten' 时的 chat_template_args 值；用 $var 表示 pi 控制的思考值
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'; // 用 thinkingBudgets 封顶推理 token 的顶层字段（vLLM / Qwen / llama.cpp）。默认关闭。
  supportsThinkingTokenBudget?: boolean; // thinkingTokenBudgetField: 'thinking_token_budget'（vLLM）的别名。优先使用 thinkingTokenBudgetField。默认：false。
  cacheControlFormat?: 'anthropic';  // 系统提示、最后一个工具和最后一个 user/assistant 文本内容上的 Anthropic 风格 cache_control
  openRouterRouting?: OpenRouterRouting; // OpenRouter 路由偏好（默认：{}）
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway 路由偏好（默认：{}）
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // 提供商支持 `developer` 角色还是 `system`（默认：true）
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // 会话亲和请求头格式：'openai' 发送 `session_id` 和 `x-client-request-id`；'openai-nosession' 发送 `x-client-request-id`；'openrouter' 发送 `x-session-id`。不影响 `prompt_cache_key` 请求体参数（默认：自动检测）
  supportsLongCacheRetention?: boolean; // 提供商是否支持 `prompt_cache_retention: "24h"`（默认：true）
  supportsStrictMode?: boolean;      // 提供商是否支持严格 JSON-schema 函数工具（默认：false；对内置 OpenAI 模型在元数据中启用）
  supportsOpenAIGrammarTools?: boolean; // 是否发出 OpenAI 自定义 Lark/regex 文法工具；false 回退到普通函数工具（默认：false；生成的目录为具备能力的模型启用）
}
```

启用提示缓存时，OpenRouter 请求会从 `sessionId` 发送 `x-session-id`。除非 `sendSessionAffinityHeaders` 显式为 false，Chat Completions 和 Anthropic Messages 都会自动检测 OpenRouter 端点。在 Anthropic 兼容模型上，`sessionAffinityFormat: "openrouter"` 选择 `x-session-id`；未设置时使用现有的 `x-session-affinity` 格式。显式请求头优先于生成的请求头。

如果未设置 `compat`，库回退到基于 URL 的检测。如果 `compat` 部分设置，未指定的字段使用检测到的默认值。这对以下情况有用：

- **LiteLLM 代理**：可能不支持 `store` 字段
- **自定义推理服务器**：可能使用非标准字段名
- **自托管端点**：可能有不同的功能支持

## 用于测试的 Faux 提供商

`fauxProvider()` 构建一个内存中的提供商，用脚本化的响应服务测试和演示：

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const faux = fauxProvider({
  tokensPerSecond: 50 // 可选
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
  messages: [{ role: 'user', content: 'Summarize package.json and then call echo', timestamp: Date.now() }]
};

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Need to inspect package metadata first.'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await models.complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json contents here' }],
  isError: false,
  timestamp: Date.now()
});

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Now I can summarize the tool output.'),
    fauxText('Here is the summary.')
  ])
]);

const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// 可选：多个 faux 模型，用于模型切换测试
const multiModel = fauxProvider({
  provider: 'faux-multi',
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

说明：
- 响应按请求开始顺序从队列中消费。
- 队列为空时，faux 提供商返回一条带 `errorMessage: "No more faux responses queued"` 的助手错误消息。
- 用 `faux.setResponses([...])` 替换剩余队列，用 `faux.appendResponses([...])` 追加更多响应。
- `faux.models` 暴露所有 faux 模型。`faux.getModel()` 返回第一个，`faux.getModel(id)` 返回指定的一个。
- 用 `fauxAssistantMessage(...)` 编写脚本化的助手回复。用 `fauxText(...)`、`fauxThinking(...)` 和 `fauxToolCall(...)` 构建内容块，无需手动填写底层字段。
- usage 按大约每 4 个字符 1 个 token 估算。当存在 `sessionId` 且 `cacheRetention` 不是 `"none"` 时，会自动模拟提示缓存的读取和写入。
- 工具调用参数通过 `toolcall_delta` 块增量流式传输。
- 默认情况下，每个流式块在各自的微任务中发出。设置 `tokensPerSecond` 可实时控制块发送节奏。
- 预期用途是每个句柄一条确定性的脚本化流程。如果需要独立的并发流程，请创建具有不同 `provider` id 的独立 faux 提供商。

## 跨提供商交接

本库支持在同一对话中无缝地在不同 LLM 提供商之间交接。这让你可以在对话中途切换模型，同时保留上下文，包括文本、工具调用和工具结果。

当一个提供商的消息发送给另一个提供商时，库会自动转换它们以保证兼容性：

- **用户和工具结果消息**原样透传
- **来自相同提供商、API 和模型的助手消息**原样保留，包括思考块
- **来自不同模型的助手消息**会丢弃其思考块。签名和加密推理只对生成它们的模型有效，而以纯文本发送的可读思考会让新模型把它当作回复的一部分
- **工具调用和普通文本**原样保留

```typescript
import { createModels, type Context } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(googleProvider());

const context: Context = { messages: [] };

// 从 Claude 开始
const claude = models.getModel('anthropic', 'claude-sonnet-4-5')!;
context.messages.push({ role: 'user', content: 'What is 25 * 18?', timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: 'medium' }));

// 切换到 GPT-5 —— 它能看到 Claude 的回答，但看不到 Claude 的思考
const gpt5 = models.getModel('openai', 'gpt-5-mini')!;
context.messages.push({ role: 'user', content: 'Is that calculation correct?', timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));

// 切换到 Gemini
const gemini = models.getModel('google', 'gemini-2.5-flash')!;
context.messages.push({ role: 'user', content: 'What was the original question?', timestamp: Date.now() });
const geminiResponse = await models.complete(gemini, context);
```

所有提供商都能处理来自其他提供商的消息——文本、工具调用和结果（包括图片）、思考块（模型变化时丢弃）、以及带部分内容的中止消息。这带来了灵活的工作流：从快速模型开始，切换到更强的模型做复杂推理，或在提供商故障期间保持连续性。

## 系统消息

`Context.systemPrompt` 和 `Context.tools` 是开头一条系统消息的简写。公开入口（`Models.stream()`、`streamSimple()`、`complete()`、`completeSimple()`）接受 `Context` 并调用一次 `normalizeContext()`；其下的一切，包括 `Provider.stream()`、`ProviderStreams` 和 API 实现模块，收到的都是只有 `messages` 的 `TranscriptContext`。对话记录也可以在对话后段携带系统消息，用来更改提示或工具集而无需重写历史：

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];             // 开头：基础提示；后段：新增的指令
  sections?: Record<string, string | null>;    // 具名的提示段；后段消息按名称修补，null 表示移除
  toolsAdded?: Tool[];                         // 从此可用的工具
  toolsRemoved?: ToolReference[];              // 从此不可用的工具
  timestamp: number;
}
```

段是不透明文本，逐字渲染在 `content` 之后，以空行分隔。让每一段自带边界（一个标签、一个标题），模型才能把更新与原文对应起来。按顺序重放每条系统消息就得到当前的提示和工具；重放辅助函数接收消息列表：

```typescript
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

const messages: Message[] = [
  { role: "system", content: "You are helpful.", sections: { rules: "<rules>Be brief.</rules>" }, toolsAdded: [readTool], timestamp: 1 },
  { role: "user", content: "hi", timestamp: 2 },
  { role: "system", content: "", sections: { rules: "<rules>Be thorough.</rules>" }, toolsRemoved: [{ name: "read" }], timestamp: 3 },
];
getCurrentSystemPrompt(messages); // "You are helpful.\n\n<rules>Be thorough.</rules>"
getCurrentTools(messages);        // []
```

自定义的 `Provider` 或 `ProviderStreams` 实现以同样的方式从 `context.messages` 读取提示和工具；在这一层不存在 `context.systemPrompt` 和 `context.tools`。

接受对话中途系统消息的模型（compat 设置中的 `supportsMidConvoSystemMessages`，由生成的目录为已验证模型设置）会原位收到每条后段系统消息，因此缓存的前缀保持不变；段的变更会以名称形式呈现给模型。所有其他模型收到 `collapseSystemMessages(transcript)`：重放后的提示和当前工具作为开头的系统消息，后段系统消息被丢弃。同时设置了 `supportsMidConvoToolChanges` 的 Anthropic 模型以原生块发送工具变更（`inline-tools-2026-09-15` beta）：顶层工具列表持有初始工具加一个稳定的延迟占位符且从不变化，后续工具以值的形式定义在 `tool_addition` 块中（同名的定义会替换旧定义），移除则是 `tool_removal` 引用，因此工具变更不会使提示缓存失效。这需要至少一个初始工具；否则当前工具列表会连同系统文本一起在顶层发送。带 `supportsAdditionalTools` 或 `supportsToolSearch` 的 OpenAI Responses 模型在其消息处锚定增量工具变更；其他一切都把当前工具列表放在顶层发送。

## 上下文序列化

`Context` 对象可以用标准 JSON 方法轻松序列化和反序列化，因此很容易持久化对话、实现聊天历史，或在服务之间传输上下文：

```typescript
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is TypeScript?', timestamp: Date.now() }
  ]
};

const model = models.getModel('openai', 'gpt-4o-mini')!;
const response = await models.complete(model, context);
context.messages.push(response);

// 序列化整个上下文
const serialized = JSON.stringify(context);

// 保存到数据库、localStorage、文件等
localStorage.setItem('conversation', serialized);

// 之后：反序列化并继续对话
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: 'Tell me more about its type system', timestamp: Date.now() });

// 用任何模型继续
const newModel = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const continuation = await models.complete(newModel, restored);
```

模型本身也是普通的可序列化数据——不附带函数或实现——所以持久化“这个对话用的是哪个模型”只需一次 `JSON.stringify`。

> **注意**：如果上下文包含图片（按图片输入一节所示编码为 base64），它们也会被序列化。

## 浏览器使用

本库支持浏览器环境。核心入口和提供商工厂没有副作用，可以干净地打包。浏览器中没有环境变量，因此请显式传入 API key——或者注入一个 `CredentialStore`（例如基于 localStorage 的），让提供商认证从存储的凭据解析：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const response = await models.complete(model, {
  messages: [{ role: 'user', content: 'Hello!', timestamp: Date.now() }]
}, {
  apiKey: 'your-api-key'
});
```

> **安全警告**：在前端代码中暴露 API key 是危险的。任何人都可以提取并滥用你的 key。只对内部工具或演示使用这种方式。生产应用请使用把 API key 保护在后端的后端代理。

浏览器兼容性说明：

- Amazon Bedrock（`bedrock-converse-stream`）在浏览器环境中不受支持。它仍会出现在模型列表中；调用会在运行时失败。
- OAuth 登录流程仅限 Node。它们通过打包工具不透明的导入惰性加载，因此注册支持 OAuth 的提供商不会把 Node 专属代码拉进浏览器包——只有真正登录才会。
- 如果 Web 应用需要 Bedrock 或基于 OAuth 的认证，请使用服务端代理或后端服务。

## 打包与摇树优化

要获得小体积的包和低开销的非打包脚本，只导入模型运行时和你需要的提供商：

```typescript
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
```

规则：

- `@earendil-works/pi-ai/models` 导出模型运行时（`createModels`、`createProvider`、模型辅助函数及其类型），不包含 TypeBox、内置目录或 SDK 实现。其他类型仍可以从根入口用 `import type` 导入。
- `@earendil-works/pi-ai` 是核心入口，不导入内置目录、真实提供商工厂或 SDK 实现，但它会立即导入 TypeBox 和 schema 校验。非打包的 Node 脚本无法摇掉其未使用的导出；当你只需要这些时，优先使用 `./models`、`./providers/faux` 和特定的 `./utils/*` 子路径。
- `@earendil-works/pi-ai/providers/<provider>` 只导入该提供商的目录和惰性 API 包装器。
- `@earendil-works/pi-ai/providers/all` 导入每个内置提供商工厂和所有目录。只在想要完整内置集合时使用。
- 使用代码分割时，提供商 SDK 留在惰性 chunk 中，在首次请求时加载。
- 不使用代码分割时，打包工具会把可达的惰性 API 实现合并进单个包。单提供商的包会包含该提供商的 SDK；`providers/all` 会包含所有静态可见的 SDK。Bedrock 是例外：其 AWS SDK 实现通过打包工具不透明的 Node 专属导入加载。
- 直接导入 `@earendil-works/pi-ai/api/<api-id>` 会立即加载该 API 实现及其 SDK。

在新的打包应用中避免使用 `@earendil-works/pi-ai/compat`；它保留旧的全局 API，并导入完整的内置目录表面。

对于单文件 Node ESM 包，一些 SDK 依赖内部可能仍使用动态 CommonJS `require()`。如果你看到 `Dynamic require of "child_process" is not supported` 之类的错误，请在包中添加一个 Node `require` 垫片。使用 esbuild 时：

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

这只适用于 Node 包；它不是浏览器或 Cloudflare Workers 的变通方案。

Bedrock 仅限 Node。像其他提供商一样添加它：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';

const models = createModels();
models.setProvider(amazonBedrockProvider());
```

在正常的 Node 包使用和代码分割的包中，Bedrock 惰性加载其 AWS SDK 实现。对于必须包含 Bedrock 支持的独立单文件包，显式注册实现模块：

```typescript
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';

setBedrockProviderModule(bedrockProviderModule);
```

这个显式覆盖会把 AWS SDK 打包进去。没有它时，Bedrock 的不透明运行时导入期望该包的 Bedrock 实现文件在运行时可用。

### 提供商范围的环境变量覆盖

在流选项中传入 `env`，把提供商配置限定到单个请求。`env` 中的值会先于进程环境变量用于提供商认证和配置，例如 Cloudflare account ID、Azure OpenAI 设置、Vertex project/location、Bedrock 设置、`PI_CACHE_RETENTION` 以及 `HTTP_PROXY`/`HTTPS_PROXY`。

```typescript
const models = builtinModels();
const model = models.getModel('cloudflare-ai-gateway', 'workers-ai/@cf/moonshotai/kimi-k2.6')!;

const response = await models.complete(model, context, {
  env: {
    CLOUDFLARE_API_KEY: '...',
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
});
```

当一个进程需要按请求使用不同的提供商设置，或不希望环境变量泄漏进提供商调用时，使用这个能力。

## OAuth 提供商

多个提供商支持用 OAuth 认证代替静态 API key：

- **Anthropic**（Claude Pro/Max 订阅）
- **OpenAI**（Sign in with ChatGPT：用 ChatGPT 订阅访问 OpenAI API）
- **OpenAI Codex（旧版）**（ChatGPT Plus/Pro 订阅，访问 GPT-5.x Codex 模型）
- **GitHub Copilot**（Copilot 订阅）
- **OpenRouter**（OAuth PKCE，铸造一个用户控制的 API key）

这些提供商都在 `provider.auth.oauth` 上携带 `OAuthAuth`，包含三个操作：`login(interaction)` 使用与提供商无关的 `AuthInteraction.prompt()`/`notify()` 协议并返回凭据，`refresh(credential, signal)` 在适用时刷新即将过期的凭据，`toAuth(credential)` 派生请求认证（GitHub Copilot 的按账号 base URL 来自这里）。提供商登录交互和刷新调用总是携带具体的 abort signal。刷新是自动的：`models.getAuth(providerId)` 和请求路径在凭据存储锁下刷新过期 token，因此并发请求和进程不会重复刷新。OpenRouter 的 OAuth 流程返回的是永久 API key，因此其刷新操作是无操作。

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels({ credentials: myStore }); // 持久化的 CredentialStore
models.setProvider(anthropicProvider());

// 登录：Models 驱动流程并持久化凭据
await models.login('anthropic', 'oauth', {
  prompt: async (p) => {
    // p.type: 'text' | 'secret' | 'select' | 'manual_code'
    // manual_code 提示与本地回调服务器竞争；服务器抢先时 p.signal 会中止它们
    return await askUser(p.message);
  },
  notify: (event) => {
    // event.type: 'info' | 'auth_url' | 'device_code' | 'progress'
    if (event.type === 'info') {
      console.log(event.message);
      for (const link of event.links ?? []) console.log(`${link.label ?? 'More information'}: ${link.url}`);
    }
    if (event.type === 'auth_url') console.log(`Open: ${event.url}`);
    if (event.type === 'device_code') console.log(`Code: ${event.userCode} at ${event.verificationUri}`);
    if (event.type === 'progress') console.log(event.message);
  },
});

// 从此请求会自动解析并刷新 token
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
await models.complete(model, context);

// 注销
await models.logout('anthropic');
```

### Vertex AI

Vertex AI 模型支持 Google Cloud API key 或 Application Default Credentials（ADC）。其提供商自有的 API key 登录流程可以配置两者之一：

- **API key**：设置 `GOOGLE_CLOUD_API_KEY` 或在调用选项中传入 `apiKey`。
- **本地开发（ADC）**：运行 `gcloud auth application-default login`
- **CI/生产（ADC）**：设置 `GOOGLE_APPLICATION_CREDENTIALS` 指向服务账号 JSON key 文件

使用 ADC 时，还要设置 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）和 `GOOGLE_CLOUD_LOCATION`。你也可以在调用选项中传入 `project`/`location`。使用 `GOOGLE_CLOUD_API_KEY` 时不需要 `project` 和 `location`。

```bash
# 本地（使用你的用户凭据）
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI/生产（服务账号 key 文件）
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

官方文档：[Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)

### CLI 登录

最快的认证方式：

```bash
npx @earendil-works/pi-ai login              # 交互式选择提供商
npx @earendil-works/pi-ai login anthropic    # 登录指定提供商
npx @earendil-works/pi-ai list               # 列出可用提供商
```

凭据保存到当前目录的 `auth.json`。

### 编程式 OAuth

内置的登录和刷新流程是私有的提供商实现。请使用提供商自有的 `OAuthAuth`，它与 `CredentialStore` 组合，并通过 `Models` 获得加锁的自动刷新。`@earendil-works/pi-ai/oauth` 入口只保留 coding-agent 扩展 OAuth 兼容所需的类型声明。

提供商说明：

**OpenAI Codex（旧版）**：已被 OpenAI 提供商上的 Sign in with ChatGPT 取代。需要 ChatGPT Plus 或 Pro 订阅。提供对 GPT-5.x Codex 模型的访问，具备扩展的上下文窗口和推理能力。当流选项中提供 `sessionId` 时，库会自动处理基于会话的提示缓存，除非 `cacheRetention` 为 `"none"`。你可以在流选项中把 `transport` 设为 `"sse"`、`"websocket"` 或 `"auto"` 来选择 Codex Responses 传输方式。使用 WebSocket 且带 `sessionId` 并启用缓存保留时，连接按会话复用，闲置 5 分钟后过期。结束时调用 `cleanupSessionResources(sessionId)`，以免池化的连接让进程保持存活。

**Azure OpenAI (Responses)**：只使用 Responses API。设置 `AZURE_OPENAI_API_KEY` 以及 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME` 之一。`AZURE_OPENAI_BASE_URL` 同时支持 `https://<resource>.openai.azure.com` 和 `https://<resource>.cognitiveservices.azure.com`；根端点自动规范化为 `.../openai/v1`。需要时用 `AZURE_OPENAI_API_VERSION`（默认 `v1`）覆盖 API 版本。部署名默认被视为模型 ID，可用 `azureDeploymentName` 或 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`（逗号分隔的 `model-id=deployment` 对，例如 `gpt-4o-mini=my-deployment,gpt-4o=prod`）覆盖。有意不支持基于旧式部署的 URL。

**GitHub Copilot**：如果遇到 "The requested model is not supported" 错误，请在 VS Code 中手动启用该模型：打开 Copilot Chat，点击模型选择器，选择该模型（带警告图标），然后点击 "Enable"。

## 从旧全局 API 迁移

旧版本暴露了一个全局 API：通过全局注册表按 `model.api` 分发的 `stream()`/`complete()`、同步的 `getModel()`/`getModels()`/`getProviders()` 目录读取、`registerApiProvider()`、`getEnvApiKey()`，以及每个 API 的惰性流函数。这些接口原封不动地保留在 **compat 入口**上：

```typescript
// 之前
import { getModel, complete } from '@earendil-works/pi-ai';

// 之后（行为完全一致，只改导入路径）
import { getModel, complete } from '@earendil-works/pi-ai/compat';
```

Compat 是根入口的严格超集，因此一个文件可以整体切换导入路径。它将在未来的版本中移除；请迁移到 `createModels()` + 提供商工厂：

| 旧 | 新 |
|-----|-----|
| `getModel('openai', 'gpt-4o-mini')` | `models.getModel('openai', 'gpt-4o-mini')` 或来自 `providers/all` 的 `getBuiltinModel()` |
| `getModels('anthropic')` / `getProviders()` | `models.getModels('anthropic')` / `models.getProviders()` 或 `getBuiltin*` |
| `stream(model, ctx, opts)`（环境变量 key 注入） | `models.stream(model, ctx, opts)`（提供商认证解析） |
| `registerApiProvider({ api, stream, streamSimple })` | `createProvider({ id, auth, models, api })` + `models.setProvider()` |
| `getEnvApiKey('openai')` | `await models.getAuth(model.provider)` |
| `streamAnthropic(model, ctx, opts)` | 来自 `@earendil-works/pi-ai/api/anthropic-messages` 的 `stream`，或集合中的提供商 |
| `registerFauxProvider()` | `fauxProvider()` + `models.setProvider()` |
| `getImageModel('openrouter', id)` / `generateImages(model, ctx, { apiKey })` | `models.getModelOfType('image', 'openrouter', id)` / `models.generateImages(model, ctx)` |

曾经短暂存在的独立 `ImagesModels`/`ImagesProvider` 集合（`createImagesModels()`、`createImagesProvider()`、`openrouterImagesProvider()`、`builtinImagesModels()`）已移除：图片模型现在位于常规提供商上。把 `builtinImagesModels()` 替换为 `builtinModels()`，把 `imagesModels.getModel()` 替换为 `models.getModelOfType('image', ...)`，把 `createImagesProvider({ models, api })` 替换为 `createProvider({ models, images })`。旧的复数图片类型名已移除；请使用 `ImageModel` 和 `ImageApi`，并在图片模型字面量中加上 `type: "image"`。

## 开发

### 添加新提供商

添加新的 LLM 提供商需要修改多个文件。分层布局：API 实现位于 `src/api/`，提供商工厂位于 `src/providers/`，稳定的生成目录包装器位于 `src/providers/<id>.models.ts`，`src/models.generated.ts` 负责注册。这份清单涵盖所有必要步骤：

#### 1. 核心类型（`src/types.ts`）

- 如果是新 API，把 API 标识符加入 `KnownApi`（例如 `"bedrock-converse-stream"`）
- 把提供商名称加入 `KnownProvider`（例如 `"amazon-bedrock"`）
- 把选项类型加入 `ApiOptionsMap`

#### 2. API 实现（`src/api/<api-id>.ts`，仅新 API 需要）

创建新的 API 实现文件（例如 `bedrock-converse-stream.ts`），恰好导出 `stream` 和 `streamSimple`，外加：

- 一个扩展 `StreamOptions` 的选项接口（例如 `BedrockOptions`）
- 把 `TranscriptContext` 消息转换为提供商格式的消息转换函数；用 `getInitialSystemMessage()`、`getCurrentTools()` 和 `resolveTranscript()` 从对话记录中读取提示和工具
- 如果提供商支持工具，还需要工具转换
- 解析响应以发出标准化事件（`text`、`tool_call`、`thinking`、`usage`、`stop`）

添加惰性包装器 `src/api/<api-id>.lazy.ts`（通过 `lazyApi()` 提供 `<name>Api()`），让提供商可以引用实现而不导入其 SDK。在 `src/index.ts` 中添加需要继续从 `@earendil-works/pi-ai` 可用的根级 `export type` 再导出。

#### 3. 模型生成（`scripts/generate-models.ts`）

- 添加从提供商来源（例如 models.dev API）拉取并解析模型的逻辑
- 把支持聊天/工具的提供商数据映射为 `Model`，图片生成数据映射为 `ImageModel`，models.dev 的 `type: "decision"` 条目映射为 `ClassifierModel`；hydration 按 API 分组被忽略的 `src/providers/data/<id>.json` 值，而稳定的 `src/providers/<id>.models.ts` 包装器直接从这些 JSON 键派生精确的模型/API 类型
- 保持模型 id 在每个提供商和模型类型内唯一；当上游模型支持多个操作时发出独立条目
- 处理提供商特有的怪癖（定价格式、能力标志、模型 ID 转换）

#### 4. 提供商工厂（`src/providers/<id>.ts`）

- `createProvider()` 组装目录 + 认证 + 惰性 API 包装器
- 认证：标准 key 提供商用 `envApiKeyAuth`，环境式认证（AWS profile、ADC）用自定义 `ApiKeyAuth`，有 OAuth 流程的地方用 `lazyOAuth`
- 在 `src/providers/all.ts` 中注册工厂
- 如果是新 API：在 `src/compat.ts` 的内置列表中注册，并在 `package.json` 中添加包子路径导出

#### 5. 测试（`test/`）

创建或更新测试文件以覆盖新提供商：

- `stream.test.ts` - 基础流式和工具使用
- `tokens.test.ts` - token 用量报告
- `abort.test.ts` - 请求取消
- `empty.test.ts` - 空消息处理
- `context-overflow.test.ts` - 上下文限制错误
- `image-limits.test.ts` - 图片支持（如适用）
- `unicode-surrogate.test.ts` - Unicode 处理
- `tool-call-without-result.test.ts` - 孤立的工具调用
- `image-tool-result.test.ts` - 工具结果中的图片
- `total-tokens.test.ts` - token 计数准确性
- `cross-provider-handoff.test.ts` - 跨提供商上下文重放
- `providers.test.ts` - 提供商列表和认证解析

对 `cross-provider-handoff.test.ts`，至少添加一个提供商/模型对。如果提供商暴露多个模型家族（例如 GPT 和 Claude），每个家族至少添加一对。

对认证非标准的提供商（AWS、Google Vertex），创建一个类似 `bedrock-utils.ts` 的工具文件，包含凭据检测辅助函数。

#### 6. Coding Agent 集成（`../coding-agent/`）

更新 `src/core/model-resolver.ts`：

- 在 `DEFAULT_MODELS` 中为该提供商添加默认模型 ID

更新 `src/cli/args.ts`：

- 在帮助文本中添加环境变量文档

更新 `README.md`：

- 把该提供商加入提供商一节，并附上配置说明

#### 7. 文档

更新 `packages/ai/README.md`：

- 加入“支持的提供商”列表
- 记录任何提供商专属的选项或认证要求
- 在环境变量一节中加入环境变量

#### 8. 变更日志

在 `packages/ai/CHANGELOG.md` 的 `## [Unreleased]` 下添加条目：

```markdown
### Added
- Added support for [Provider Name] provider ([#PR](link) by [@author](link))
```

## 许可证

MIT
