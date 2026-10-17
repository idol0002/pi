# 模型配置

<!-- 本文件由 TypeScript 源生成。不要手动编辑；运行 npm run generate:references。 -->

本参考列出 `models.json` 的字段。示例见[配置兼容端点](models.zh-CN.md#configure-a-compatible-endpoint)，文件位置见[配置](configuration.zh-CN.md#agent-directory)。

在 `models.json` 中加 `"$schema": "https://pi.dev/schemas/models.schema.json"` 可获得编辑器校验和补全。

## 提供商

`providers` 下的每个键是一个提供商 ID。内置提供商 ID 会修改该提供商。其他任何 ID 添加一个提供商，它需要在提供商或模型级别提供 `baseUrl` 和 `api`。

| 字段 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `name` | string |  | 显示名称。 |
| `baseUrl` | string |  | API 基础 URL。也适用于该提供商的内置模型。 |
| `apiKey` | string |  | 字面量密钥、"$NAME" 环境插值，或 "!command" 输出。 |
| `api` | string |  | 该提供商模型使用的 API，如 "openai-completions"、"openai-responses"、"anthropic-messages" 或 "google-generative-ai"。 |
| `oauth` | `"radius"` |  | OAuth 登录流程。需要 baseUrl。 |
| `headers` | object |  | 请求头。值的解析方式与 apiKey 相同。 |
| `compat` | [对象](#compatibility) |  | 提供商与模型兼容性覆盖。 |
| `authHeader` | boolean | `false` | 是否把解析出的 API 密钥作为 Authorization: Bearer 发送。 |
| `models` | [`object[]`](#models) |  |  |
| `modelOverrides` | [对象](#model-overrides) |  |  |

## 模型

每个 `models` 条目向该提供商添加一个模型。`id` 与现有模型匹配的条目会替换它。

| 字段 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `id` | string |  | 必需。发送给 API 的模型 ID。 |
| `name` | string |  | 显示名称，也被 --model 模式匹配。 |
| `api` | string |  | 覆盖提供商 api。 |
| `baseUrl` | string |  | 覆盖提供商 baseUrl。 |
| `reasoning` | boolean | `false` | 模型是否支持思考。 |
| `thinkingLevelMap` | object |  | 每个思考级别发送的提供商值。null 标记该级别不受支持。模型未映射的级别使用提供商到 high 的默认值；xhigh 和 max 不受支持。 |
| `input` | `("text" \| "image")[]` | `["text"]` |  |
| `inputLimits` | [对象](#input-limits) |  |  |
| `cost` | object |  |  |
| `cost.input` | number |  | 必需。每百万 token 的输入成本（美元）。 |
| `cost.output` | number |  | 必需。每百万 token 的输出成本（美元）。 |
| `cost.cacheRead` | number |  | 必需。每百万 token 的缓存读取成本（美元）。 |
| `cost.cacheWrite` | number |  | 必需。每百万 token 的缓存写入成本（美元）。 |
| `cost.tiers` | `object[]` |  | 按请求范围的定价分层。最高的匹配输入阈值适用于整个请求。 |
| `cost.tiers[].inputTokensAbove` | number |  | 必需。请求总输入超过该 token 数时使用此层。 |
| `cost.tiers[].input` | number |  | 必需。每百万 token 的输入成本（美元）。 |
| `cost.tiers[].output` | number |  | 必需。每百万 token 的输出成本（美元）。 |
| `cost.tiers[].cacheRead` | number |  | 必需。每百万 token 的缓存读取成本（美元）。 |
| `cost.tiers[].cacheWrite` | number |  | 必需。每百万 token 的缓存写入成本（美元）。 |
| `promptCache` | object |  | short 和 long 保留层级的尽力提示词缓存存活秒数。Pi 只温热已知存活时间的层级。 |
| `contextWindow` | number | `128000` | 上下文窗口（token）。 |
| `maxTokens` | number | `16384` | 最大输出 token。 |
| `samplingParams` | object |  | 合并进每个请求体的字段。只适用于 OpenAI 兼容 API。 |
| `samplingParamsByThinkingLevel` | object |  | 每个思考级别的 samplingParams，合并到 samplingParams 之上。 |
| `headers` | object |  | 请求头。值的解析方式与 apiKey 相同。 |
| `compat` | [对象](#compatibility) |  | 提供商与模型兼容性覆盖。 |

## 模型覆盖

每个 `modelOverrides` 键是内置或扩展模型的 ID。未知 ID 被忽略。对象字段（如 `cost`）与模型值逐字段合并；其他字段替换它。

| 字段 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `name` | string |  | 显示名称，也被 --model 模式匹配。 |
| `reasoning` | boolean |  | 模型是否支持思考。 |
| `thinkingLevelMap` | object |  | 每个思考级别发送的提供商值。null 标记该级别不受支持。模型未映射的级别使用提供商到 high 的默认值；xhigh 和 max 不受支持。 |
| `input` | `("text" \| "image")[]` |  |  |
| `inputLimits` | [对象](#input-limits) |  |  |
| `cost` | object |  |  |
| `cost.input` | number |  | 每百万 token 的输入成本（美元）。 |
| `cost.output` | number |  | 每百万 token 的输出成本（美元）。 |
| `cost.cacheRead` | number |  | 每百万 token 的缓存读取成本（美元）。 |
| `cost.cacheWrite` | number |  | 每百万 token 的缓存写入成本（美元）。 |
| `cost.tiers` | `object[]` |  | 按请求范围的定价分层。最高的匹配输入阈值适用于整个请求。 |
| `cost.tiers[].inputTokensAbove` | number |  | 必需。请求总输入超过该 token 数时使用此层。 |
| `cost.tiers[].input` | number |  | 必需。每百万 token 的输入成本（美元）。 |
| `cost.tiers[].output` | number |  | 必需。每百万 token 的输出成本（美元）。 |
| `cost.tiers[].cacheRead` | number |  | 必需。每百万 token 的缓存读取成本（美元）。 |
| `cost.tiers[].cacheWrite` | number |  | 必需。每百万 token 的缓存写入成本（美元）。 |
| `promptCache` | object |  | short 和 long 保留层级的尽力提示词缓存存活秒数。Pi 只温热已知存活时间的层级。 |
| `contextWindow` | number |  | 上下文窗口（token）。 |
| `maxTokens` | number |  | 最大输出 token。 |
| `samplingParams` | object |  | 合并进每个请求体的字段。只适用于 OpenAI 兼容 API。 |
| `samplingParamsByThinkingLevel` | object |  | 每个思考级别的 samplingParams，合并到 samplingParams 之上。 |
| `headers` | object |  | 请求头。值的解析方式与 apiKey 相同。 |
| `compat` | [对象](#compatibility) |  | 提供商与模型兼容性覆盖。 |

## 输入限制

见[描述模型输入与缓存](models.zh-CN.md#describe-model-input-and-caching)。

| 字段 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `maxRequestBytes` | integer |  | 序列化提供商请求的最大字节数。 |
| `images` | object |  |  |
| `images.resize` | object |  | 在新图像进入对话历史之前应用的缓存安全缩放配置。 |
| `images.resize.maxWidth` | integer |  |  |
| `images.resize.maxHeight` | integer |  |  |
| `images.resize.maxBytes` | integer |  | base64 编码载荷的最大字节数。 |
| `images.resize.jpegQuality` | integer |  |  |
| `images.maxPerMessage` | integer |  | 单个提供商消息接受的最大图像数。 |
| `images.maxPerRequest` | integer |  | 单个提供商请求接受的最大图像数。 |

## 兼容性

`compat` 描述与某 API 标准请求和响应行为之间已验证的差异。模型值逐字段覆盖提供商值。适用的字段取决于模型的 `api`。

### `openai-completions`

| 字段 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `supportsStore` | boolean |  | 提供商是否支持 store 字段。默认：从 URL 自动检测。 |
| `supportsDeveloperRole` | boolean |  | 提供商是否支持 developer 角色而非 system。默认：从 URL 自动检测。 |
| `supportsReasoningEffort` | boolean |  | 提供商是否支持 reasoning_effort。默认：从 URL 自动检测。 |
| `supportsUsageInStreaming` | boolean | `true` | 提供商是否支持 stream_options.include_usage 以在流式响应中获得 token 用量。 |
| `supportsFinishReason` | boolean | `true` | 流式响应是否包含 finish_reason。为 false 时，pi 在流结束时推断 stop 或 toolUse。 |
| `maxTokensField` | `"max_completion_tokens" \| "max_tokens"` |  | 最大 token 使用哪个字段。默认：从 URL 自动检测。 |
| `requiresToolResultName` | boolean |  | 工具结果是否需要 name 字段。默认：从 URL 自动检测。 |
| `requiresAssistantAfterToolResult` | boolean |  | 工具结果后的用户消息之间是否需要助手消息。默认：从 URL 自动检测。 |
| `requiresThinkingAsText` | boolean |  | 思考块是否必须转换为带 &lt;thinking> 分隔符的文本块。默认：从 URL 自动检测。 |
| `requiresReasoningContentOnAssistantMessages` | boolean |  | 启用推理时，所有回放的助手消息是否必须包含空的 reasoning_content 字段。默认：从 URL 自动检测。 |
| `thinkingFormat` | `"openai" \| "openrouter" \| "deepseek" \| "together" \| "baseten" \| "zai" \| "qwen" \| "chat-template" \| "qwen-chat-template" \| "string-thinking" \| "ant-ling"` |  | 推理或思考参数的格式。省略时 Pi 从提供商 URL 自动检测格式。"openai" 使用 reasoning_effort，"openrouter" 使用 reasoning.effort，"deepseek" 使用 thinking.type 加上受支持时的 reasoning_effort，"together" 使用 reasoning.enabled 加上受支持时的 reasoning_effort，"baseten" 使用可配置的 chat_template_args 加上受支持时的 reasoning_effort，"zai" 使用 thinking.type，"qwen" 使用顶层 enable_thinking，"qwen-chat-template" 使用 chat_template_kwargs.enable_thinking 和 preserve_thinking，"chat-template" 使用可配置的 chat_template_kwargs，"string-thinking" 使用顶层 thinking，"ant-ling" 仅在映射的 effort 非 null 时使用 reasoning.effort。 |
| `chatTemplateKwargs` | object |  | thinkingFormat 为 "chat-template" 时作为 chat_template_kwargs 发送的参数。用 $var 配合 "thinking.enabled"、"thinking.effort" 或 "thinking.budget" 表示 pi 控制的值。 |
| `chatTemplateArgs` | object |  | thinkingFormat 为 "baseten" 时作为 chat_template_args 发送的参数。用 $var 配合 "thinking.enabled"、"thinking.effort" 或 "thinking.budget" 表示 pi 控制的值。 |
| `openRouterRouting` | object |  | OpenRouter 提供商路由偏好。控制 OpenRouter 将请求路由到哪些上游提供商。作为 OpenRouter API 请求体中的 provider 字段发送。见 https://openrouter.ai/docs/guides/routing/provider-selection。 |
| `vercelGatewayRouting` | object |  | Vercel AI Gateway 路由偏好。控制网关将请求路由到哪些上游提供商。见 https://vercel.com/docs/ai-gateway/models-and-providers/provider-options。 |
| `zaiToolStream` | boolean | `false` | z.ai 是否支持顶层 tool_stream 以流式传输工具调用增量。 |
| `thinkingTokenBudgetField` | `"thinking_token_budget" \| "thinking_budget" \| "thinking_budget_tokens"` |  | 用于限制 thinkingBudgets 推理 token 的顶层请求字段。这些端点上推理与回答共享 max_tokens。"thinking_token_budget" 是 vLLM，"thinking_budget" 是 Qwen、DashScope 或 SGLang，"thinking_budget_tokens" 是 llama.cpp。默认关闭，生成的目录上不设置。 |
| `supportsThinkingTokenBudget` | boolean | `false` | thinkingTokenBudgetField 的别名："thinking_token_budget"（vLLM）。优先用 thinkingTokenBudgetField。 |
| `supportsOpenAIGrammarTools` | boolean | `false` | 提供商是否支持带 Lark 或正则 grammar 格式的 OpenAI 自定义工具。为 false 时，grammar 约束的工具回退为普通函数工具。生成的目录为有能力的模型启用它。 |
| `supportsMidConvoSystemMessages` | boolean | `false` | 精确模型是否接受对话开始后的 system 或 developer 消息。为 false 时，后续系统消息折叠进前导系统消息。生成的目录为已验证模型启用它。 |
| `supportsMidConvoToolAdditions` | boolean | `false` | 系统消息是否可以在对话中途引入额外工具。需要 supportsMidConvoSystemMessages。生成的目录为有能力的模型启用它。 |
| `supportsStrictMode` | boolean | `false` | 提供商是否支持工具定义中的 strict 字段。生成的有能力的模型显式启用它。 |
| `cacheControlFormat` | `"anthropic"` |  | 提示词缓存的缓存控制约定。Anthropic 把 cache_control 标记应用于系统提示词、最后一个工具定义和最后一个用户、助手或工具结果文本内容。 |
| `sendSessionAffinityHeaders` | boolean |  | 是否从 options.sessionId 发送会话亲和数据。默认：OpenRouter 端点为 true，其他为 false。 |
| `sessionAffinityFormat` | `"openai" \| "openai-nosession" \| "openrouter"` |  | 会话亲和头格式。openai 发送 session_id、x-client-request-id 和 x-session-affinity；openai-nosession 发送 x-client-request-id 和 x-session-affinity；openrouter 发送 x-session-id。不影响 prompt_cache_key。默认：自动检测。 |
| `supportsLongCacheRetention` | boolean |  | 提供商是否支持长提示词缓存保留（依格式为 prompt_cache_retention: "24h" 或 Anthropic 风格的 cache_control.ttl: "1h"）。默认：从提供商和 URL 自动检测。 |
| `vllmPriority` | number |  | 作为顶层 priority 请求字段发送的 vLLM 调度器优先级。值越小越早处理，服务器默认为 0。只在 --scheduling-policy priority 下有意义。默认关闭，生成的目录上不设置。 |

### `openai-responses`

也适用于 `azure-openai-responses` 和 `openai-codex-responses`。

| 字段 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `supportsDeveloperRole` | boolean | `true` | 提供商是否支持 developer 角色而非 system。 |
| `supportsMidConvoSystemMessages` | boolean | `false` | 精确模型是否接受对话开始后的 developer 或 system 消息。为 false 时，后续系统消息折叠进前导系统消息。生成的目录为已验证模型启用它。 |
| `sessionAffinityFormat` | `"openai" \| "openai-nosession" \| "openrouter"` |  | 会话亲和头格式。openai 发送 session_id 和 x-client-request-id；openai-nosession 发送 x-client-request-id；openrouter 发送 x-session-id。不影响 prompt_cache_key。默认：自动检测。 |
| `supportsLongCacheRetention` | boolean | `true` | 提供商是否支持长提示词缓存保留。在 GPT-5.6+ 上使用 prompt_cache_options.ttl: "30m"，在更早模型上使用 prompt_cache_retention: "24h"。 |
| `supportsStrictMode` | boolean |  | 提供商是否支持严格 JSON-schema 函数工具。默认值因 API 而异；生成的 OpenAI 模型显式启用它。 |
| `supportsOpenAIGrammarTools` | boolean | `false` | 是否发出带 Lark 或正则 grammar 格式的 OpenAI 自定义工具。为 false 时，grammar 约束的工具回退为普通函数工具。生成的目录为有能力的模型启用它。 |
| `supportsAdditionalTools` | boolean | `false` | 模型是否支持以消息为锚点的 additional_tools 输入项。 |
| `supportsToolSearch` | boolean | `false` | 模型是否支持客户端执行的工具搜索（以转录为锚点的添加）。 |
| `supportsExplicitPromptCacheMode` | boolean | `false` | 模型是否接受 prompt_cache_options。较旧的 OpenAI 模型拒绝该参数。 |
| `supportsMidConvoEffort` | boolean | `false` | 思考级别变更是否作为 configuration_update 输入项发送而不是更改 reasoning.effort，使变更保持提示词缓存。仅 openai-responses API 使用；openai 提供商上与"使用 ChatGPT 登录"组合时被忽略。 |
| `supportsMaxOutputTokens` | boolean | `true` | 提供商是否接受 max_output_tokens。一些 Codex 协议网关拒绝它。 |

### `anthropic-messages`

| 字段 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `supportsEagerToolInputStreaming` | boolean | `true` | 提供商是否接受逐工具的 eager_input_streaming。为 false 时，Anthropic 提供商省略 tools[].eager_input_streaming，并对启用工具的请求发送旧版 fine-grained-tool-streaming-2025-05-14 beta 头。 |
| `supportsLongCacheRetention` | boolean | `true` | 提供商是否通过 cache_control.ttl 支持 Anthropic 长缓存保留。 |
| `sendSessionAffinityHeaders` | boolean |  | 启用缓存时是否从 options.sessionId 发送 x-session-affinity。Fireworks 这类使用会话亲和做提示词缓存路由的提供商需要它；发往同一副本的请求最大化缓存命中。默认：OpenRouter 端点为 true，其他为 false。 |
| `sessionAffinityFormat` | `"openrouter"` |  | 会话亲和格式。openrouter 发送 x-session-id；未设置时发送 x-session-affinity。 |
| `supportsCacheControlOnTools` | boolean | `true` | 提供商是否支持工具定义上的 Anthropic 风格 cache_control 标记。为 false 时，cache_control 从工具参数中省略。一些 Anthropic 兼容提供商（如 Fireworks）不支持工具上的该字段，可能拒绝或忽略它。 |
| `supportsTemperature` | boolean | `true` | 模型是否接受 Anthropic temperature 请求字段。Claude Opus 4.7+ 拒绝非默认值。 |
| `forceAdaptiveThinking` | boolean | `false` | 是否强制自适应思考（thinking.type: adaptive 加 output_config.effort），不管模型 ID 如何。需要自适应思考的内置模型在生成的元数据中设置它。自定义 Anthropic 兼容提供商可以为上游要求自适应格式的任何模型设为 true。在被覆盖的内置模型上设为 false 可退出。 |
| `allowEmptySignature` | boolean | `false` | 是否回放空思考签名，而不是把思考转换为文本。 |
| `supportsStrictTools` | boolean | `false` | 提供商是否支持 Anthropic 严格工具 schema。生成的 Anthropic 模型显式启用它。 |
| `supportsMidConvoEffort` | boolean | `false` | 精确模型传输是否支持仅 effort 的系统消息和思考绑定控制。 |
| `supportsMidConvoSystemMessages` | boolean | `false` | 精确模型是否接受对话内的 system 角色消息。为 false 时，后续系统消息折叠进顶层系统提示词。 |
| `supportsMidConvoToolChanges` | boolean | `false` | 精确模型是否接受对话中途的 tool_addition 和 tool_removal 块。需要 supportsMidConvoSystemMessages。 |
| `allowedFallbackModels` | `object[]` |  | Anthropic 接受用于服务端拒绝回退的模型，带返回回退响应的本地定价元数据。缺失或为空时，调用者必须省略回退；对没有允许回退目标的模型，Anthropic 拒绝该字段。 |

### `bedrock-converse-stream`

| 字段 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `supportsStrictMode` | boolean | `false` | 模型是否支持 Bedrock 严格工具 schema。 |

### `mistral-conversations`

| 字段 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `supportsMidConvoSystemMessages` | boolean | `false` | 精确模型是否接受对话开始后的 system 消息。为 false 时，后续系统消息折叠进前导系统消息。 |
