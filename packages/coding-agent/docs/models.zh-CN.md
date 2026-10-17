# 选择模型

对内置提供商，从 `/login` 开始，然后用 `/model` 选择模型。只有当 Pi 尚未包含你需要的提供商或端点时才使用自定义模型配置。

## 选择连接方式

| 你拥有的 | 推荐配置 |
|---|---|
| 受支持的订阅 | 通过 `/login` 登录 |
| 提供商 API 密钥 | 通过 `/login` 存储或设置其环境变量 |
| 本地 GGUF 模型 | 把 Pi 连接到 llama.cpp 路由器 |
| OpenAI、Anthropic 或 Google 兼容端点 | 加入 `models.json` |
| 自定义协议或认证流程的提供商 | 构建或安装提供商扩展 |

浏览[模型目录](https://pi.dev/models)查看当前的提供商、模型 ID、能力、上下文限制和定价。Pi 以其内置目录启动，并可以用 pi.dev 的新目录数据叠加。缓存的目录数据离线仍可用；运行 `pi update --models` 强制刷新。

## 认证

运行 `/login` 并选择提供商。Pi 把凭据存入 [`auth.json`](configuration.zh-CN.md#agent-directory)。运行 `/logout` 移除某提供商的存储凭据。

你也可以通过提供商的环境变量提供 API 密钥。这在 CI 及其他不应由 Pi 写入凭据的环境中很有用。变量和提供商特定设置见[提供商](providers.zh-CN.md)。

配置了多个凭据来源时，Pi 依次使用运行时 `--api-key`、存储的 `auth.json` 凭据、`models.json` 中的 `apiKey`，最后是提供商的环境变量或环境中的云凭据。提供商扩展可以定义自己的认证行为。

保持 `auth.json` 和任何凭据命令私密。在你信任一个项目后，项目设置和扩展可以在 Pi 进程内执行。从不受信任的目录加载配置前请阅读[安全](security.zh-CN.md)。

## 选择模型

运行 `/model` 搜索可用模型。选择器显示其提供商有可用认证的模型。在模型上按 `Ctrl+S` 可保存为新会话的默认值。

运行 `/thinking` 为当前模型选择思考级别。在那里按 `Ctrl+S` 保存启动级别。Pi 把选项限制在所选模型支持的级别内。

`Ctrl+P` 在可用模型间循环。用 `/scoped-models` 控制该循环并保存选择，或通过[设置](settings.zh-CN.md#model-cycling)配置模型模式。

会话记录模型和思考级别的变更。恢复会话会还原它们，而不改变新会话的默认值。

## 连接本地模型

Pi 直接集成 llama.cpp 路由器。路由器发现 GGUF 文件并按需加载模型。Pi 的 `/llama` 命令管理路由器，`/model` 选择其加载的模型之一。

服务器启动、模型布局、下载和连接排障见[用 llama.cpp 使用本地模型](llama-cpp.zh-CN.md)。

对 Ollama、LM Studio、vLLM、SGLang 和其他兼容服务器，在 `models.json` 中[配置兼容端点](#configure-a-compatible-endpoint)。

## 配置兼容端点

当端点使用 Pi 已支持的 API 时使用 [`models.json`](configuration.zh-CN.md#agent-directory)。这包括大多数 Ollama、LM Studio、vLLM、SGLang 和代理部署。

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

占位密钥让模型对 Pi 可用；Ollama 忽略它。对需要认证的端点，`apiKey` 和头部值可以使用 `$NAME` 或 `${NAME}` 环境插值、字面量，或前导 `!command`。`$$` 和 `$!` 产生字面量 `$` 和 `!`。`models.json` 中的命令在请求时运行，且不被 Pi 缓存。

打开 `/model` 会重新加载文件。`models` 条目在该提供商上添加或替换同 ID 的模型。用 `modelOverrides` 更改现有内置或扩展提供模型的元数据，而不替换该提供商的模型列表。未知的覆盖 ID 被忽略。

要让内置提供商走代理，只设置其 `baseUrl`。其模型和认证保持不变：

```json
{
  "providers": {
    "anthropic": { "baseUrl": "https://proxy.example.com/v1" }
  }
}
```

每个字段见[模型配置](models-configuration.zh-CN.md)。

### 描述模型输入与缓存

用 `inputLimits.images.resize` 控制 Pi 在把新图片附件、`read` 结果和工具结果图像存入对话历史之前如何编码：

```json
{
  "id": "vision-model",
  "input": ["text", "image"],
  "inputLimits": {
    "images": {
      "resize": {
        "maxWidth": 1568,
        "maxHeight": 1568,
        "maxBytes": 524288,
        "jpegQuality": 75
      }
    }
  }
}
```

`maxBytes` 限制 base64 编码后的载荷。省略的 resize 字段使用保守默认值：2000×2000 像素、编码后 4.5 MiB、JPEG 质量 80。图像只编码一次；切换模型不会重写历史图像。目录还可以用 `inputLimits.maxRequestBytes`、`images.maxPerMessage` 和 `images.maxPerRequest` 描述硬性请求限制，但 Pi 尚未据此重写或拒绝历史。

<a id="prompt-cache-lifetimes"></a>

用 `promptCache` 以秒声明提供商对 `short` 或 `long` 保留层级的尽力缓存存活时间：

```json
{ "id": "claude-sonnet-5", "promptCache": { "short": 300, "long": 3600 } }
```

选择已公布范围的保守端。当前层级没有存活时间的模型不具备缓存温热资格。`modelOverrides` 条目可以为内置或扩展模型设置 `inputLimits` 或 `promptCache`，包括通过已验证代理访问的模型。见 [`cacheWarming`](settings.zh-CN.md#model-and-thinking)。

### 按思考级别配置采样

OpenAI 兼容 API 支持自由格式的 `samplingParams` 模型默认值和 `samplingParamsByThinkingLevel` 覆盖。后者使用 Pi 思考级别键（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`），不是 `thinkingLevelMap` 中的提供商值：

```json
{
  "id": "qwen-thinking-model",
  "reasoning": true,
  "samplingParams": {
    "temperature": 1.0,
    "top_p": 0.95
  },
  "samplingParamsByThinkingLevel": {
    "off": {
      "temperature": 0.7,
      "top_p": 0.8
    },
    "high": {
      "top_k": 20
    }
  }
}
```

Pi 先钳制不支持的思考级别，然后按顺序合并模型 `samplingParams`、当前级别覆盖和请求级 `samplingParams`。每个键以后值优先。缺失的级别继承模型默认值。`modelOverrides` 按键把每级条目与基础模型合并。这些字段只适用于 `openai-completions`、`openai-responses` 和 `azure-openai-responses`；其他 API 忽略它们。

兼容性设置应描述已验证的端点请求或响应行为差异。不要仅凭端点宣称 OpenAI 或 Anthropic 兼容就启用它们。

## 使用分类器模型

分类器模型不聊天。它们回答关于 JSON 状态的类型化问题：从多个选项中选一、答是或否、或打分，各带概率。Pi 包含这些提供商的 TypeSafe Jev 模型、Cloudflare 来自 Workers AI 的 Clef 和 Clef Flash 模型，以及通过 [Decisions API](https://developers.openai.com/api/docs/guides/decisions) 的 OpenAI GPT-6 Luna：

| 提供商 | 模型 ID | 认证 |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `typesafe/jev-1.13`、`~typesafe/jev-latest` | `OPENROUTER_API_KEY` 或 `/login` |
| `cloudflare-workers-ai` | `typesafe/jev`、`@cf/cloudflare/clef`、`@cf/cloudflare/clef-flash` | `CLOUDFLARE_API_KEY` 和 `CLOUDFLARE_ACCOUNT_ID` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `opencode` | `jev-1.13`、`jev-1.13-free` | `OPENCODE_API_KEY` |
| `openai` | `gpt-6-luna` | `OPENAI_API_KEY` |

[llama.cpp 路由器](llama-cpp.zh-CN.md#classification)上的聊天模型也会列为分类器模型。

OpenAI 的 Decisions API 需要 API 密钥。用 ChatGPT 凭据登录对它无效，因此当 `openai` 通过 `/login` 登录时，即使设置了 `OPENAI_API_KEY`，`gpt-6-luna` 也不会列为可用；要使用密钥请登出 `openai`。GPT-6 Luna 还能评判传入 `images` 的图像（见 [Codemode](codemode.zh-CN.md#classify)）；其他分类器模型对它们返回错误。该 API 拒绝超过 922K token 的输入，但运行超过约五秒（目前约 600K 输入 token 以上）的请求会因网关超时而失败。

分类器模型不出现在 `/model` 中。模型通过 [`codemode`](cli.zh-CN.md#enable-codemode) 工具访问它们，该工具默认关闭，除非 MCP 服务器打开了它。在[设置](settings.zh-CN.md#tools)中用 `"defaultTools": ["+codemode"]` 启用。之后脚本用 `models.getAvailableOfType("classifier")` 列出分类器模型，并调用 `models.classify(model, { state, questions })`：

```js
const jev = await models.getModelOfType("classifier", "typesafe", "jev-latest");
const result = await models.classify(jev, {
  state: { message: "The change works, thanks." },
  questions: {
    approved: {
      type: "bool",
      instructions: "Does the user approve of the result?",
      criteria: { true: "Approval", false: "No approval" },
    },
  },
});
return result.answers;
```

问题与答案类型见 [Codemode](codemode.zh-CN.md#classify)。

当服务报告 token 计数时（所有 System One 服务都如此），`result.usage` 携带计数及其成本。Pi 把脚本分类器调用的用量加到 `codemode` 工具结果中，因此计入页脚和 `/session` 中的会话成本。成本使用模型的目录价格；没有目录价格的模型（如 TypeSafe 的直连 `jev-latest`）报告 token 但不计成本。

扩展通过 `ctx.modelRegistry.classify()` 调用分类器，无需 codemode。[虚拟模型](virtual-models.zh-CN.md#route-requests)可以用它们路由请求；见 `jev-router.ts` 示例。

## 使用图像模型

图像模型从提示词和可选输入图像生成图像。Pi 在 `openrouter` 提供商下列出 OpenRouter 的图像模型，如 `google/gemini-2.5-flash-image` 和 `black-forest-labs/flux.2-pro`；它们与其聊天模型使用相同的 `OPENROUTER_API_KEY` 或 `/login` 凭据。

与分类器模型一样，图像模型不出现在 `/model` 中；模型通过 [`codemode`](cli.zh-CN.md#enable-codemode) 工具访问它们。脚本用 `models.getAvailableOfType("image")` 列出它们，并调用 `models.generateImages(model, { input })`。结果的 `output` 保存 base64 图像块，`image()` 把它们附加到 `codemode` 结果，模型因此看到图像：

```js
const painter = await models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
const result = await models.generateImages(painter, {
  input: [{ type: "text", text: "A red fox in the snow, watercolor" }],
});
if (result.stopReason !== "stop") return result.errorMessage;
for (const block of result.output) if (block.type === "image") image(block);
```

`input` 还可以包含 `{ type: "image", data, mimeType }` 块用于编辑或作参考。与分类器调用一样，Pi 把脚本图像调用的用量加到 `codemode` 工具结果中。生成的图像不保存到磁盘。[Codemode](codemode.zh-CN.md#generate-images) 描述完整 API。

扩展通过 `ctx.modelRegistry.generateImages()` 生成图像，无需 codemode。

## 添加自定义提供商

当提供商需要自定义流式、模型发现或认证行为时使用扩展。扩展工作流见[自定义提供商](custom-provider.zh-CN.md)。

## 排障

### 模型不出现

确认其提供商有可用认证。自定义模型可以从 `models.json` 加载，但在 Pi 能解析凭据之前在 `/model` 中不可用。对 llama.cpp，只有路由器当前加载的模型出现。

### 认证只在一个 shell 中有效

检查密钥是否来自环境变量而不是 `auth.json`。环境变量必须存在于启动 Pi 的进程中。

### 登录在远程机器上打开浏览器

可用时完成提供商的无头认证流程。一些提供商允许你把最终重定向 URL 或授权码粘贴回 Pi。见[交互式认证](providers.zh-CN.md#authenticate-interactively)。

### 兼容端点拒绝请求

检查其在 `models.json` 中的 API 类型和兼容性设置。上游服务器必须支持相应的请求字段和行为。
