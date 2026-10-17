# 自定义提供商

提供商扩展把 Pi 连接到需要自定义认证、模型发现、请求处理或流式传输的模型服务。如果服务已经支持某个受支持的 API，请在 `models.json` 中配置即可。

提供商扩展运行在 Pi 内部，可以查看凭据、提示词、工具定义、模型响应和用量。把它们当作受信任的代码，避免记录密钥或提供商载荷。

## 选择最小的集成方式

| 需求 | 方式 |
|---|---|
| 在受支持的 API 后添加模型 | [`models.json`](models.zh-CN.md#configure-a-compatible-endpoint) |
| 更改现有提供商的端点或请求头 | `models.json` 或一个小型提供商扩展 |
| 动态发现模型 | 带 `refreshModels` 的提供商 |
| 添加 `/login` 流程 | 带原生或旧版 OAuth 配置的提供商 |
| 实现不受支持的线上协议 | 带 `stream` 或 `streamSimple` 的提供商 |

提供商扩展是一种[扩展](extensions.zh-CN.md)，因此遵循相同的加载、信任、重载和错误行为。

## 注册提供商

在扩展工厂中调用 `pi.registerProvider()`。Pi 会等待异步工厂完成后再继续启动，因此在其中注册的提供商可用于启动时的模型选择和 `pi --list-models`。

有两种注册形式：

- 注册来自 `@earendil-works/pi-ai` 的完整 `Provider`，获得原生认证、过滤、发现、刷新和流式行为。
- 用 `ProviderConfig` 注册提供商名称，即现有扩展使用的旧版配置形式。

对于拥有静态端点和模型元数据之外更多能力的新集成，优先选择完整 Provider。Pi 把 `models.json` 的覆盖组合在已注册的原生提供商之上。

为现有提供商只注册 `baseUrl` 或 `headers` 会保留其内置模型。在旧版形式中提供 `models` 会替换该提供商在聊天、图像和分类器操作中的全部模型。省略 `type` 表示 `"chat"`；图像和分类器模型需要显式判别字段，并通过 `images` 和 `classifiers` 字段按其 `api` 值提供实现。

例如，一个混合操作的提供商可以同时注册非聊天模型及其实现：

```typescript
pi.registerProvider("media-tools", {
  apiKey: "$MEDIA_TOOLS_API_KEY",
  models: [
    {
      type: "image",
      id: "image-v1",
      name: "Image V1",
      api: "media-images",
      baseUrl: "https://media.example.com/v1",
      input: ["text"],
      output: ["image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      type: "classifier",
      id: "classifier-v1",
      name: "Classifier V1",
      api: "media-classifier",
      baseUrl: "https://media.example.com/v1",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64000,
    },
  ],
  images: {
    "media-images": { generateImages: async (model, context, options) => result },
  },
  classifiers: {
    "media-classifier": { classify: async (model, context, options) => result },
  },
});
```

模型级 `baseUrl` 优先于提供商端点。若不提供 `models` 列表，所有操作的内置模型保持注册。不同操作中相同的模型 ID 保持相互独立，包括其模型级请求头。

初始扩展加载之后的调用会立即生效。用 `pi.unregisterProvider()` 移除动态提供商，并恢复其替换的内置行为。

完整注册并把流式传输委托给内置 API 实现的例子见受检查的 [GitLab Duo 提供商](../examples/extensions/custom-provider-gitlab-duo/)。

## 提供认证

静态提供商可以从字面量、环境变量插值或命令解析 API 密钥。这些值使用与 `models.json` 相同的语法：

- `$NAME` 和 `${NAME}` 读取环境变量。
- 前导 `!command` 使用命令输出。
- `$$` 输出字面量 `$`。
- `$!` 输出字面量的前导 `!`。

当集成需要存储凭据、自定义解析、提供商作用域的环境或多种登录方式时，使用原生提供商认证。

OAuth 提供商提供显示名称、登录流程、令牌刷新和访问令牌解析。注册后它会出现在 `/login` 中，Pi 把返回的凭据存入 `~/.pi/agent/auth.json`。

OAuth 回调与 UI 无关。它们可以打开授权 URL、显示设备码、报告进度、请求输入，或让用户选择登录方式。在网络请求期间要尊重取消操作和提供的 abort signal。

绝不要把访问令牌、刷新令牌、授权头或完整的提供商响应写入普通日志。

## 提供和刷新模型

每个模型需要 ID、显示名称、输入能力和成本元数据。聊天和分类器模型还需要上下文窗口；聊天模型需要输出上限和推理支持；图像模型声明其输出模态。除非某个模型需要覆盖，否则在提供商级别选择 API 实现。

当 Pi 应保持空闲提示词缓存温热时，把 `promptCache.short` 或 `promptCache.long` 设为该提供商尽力而为的缓存存活秒数。不设置则对该保留层级禁用缓存温热。

兼容性标志描述的是某个受支持 API 中已验证的差异。不要仅凭端点声称兼容就启用它们。

对照实际服务器确认请求字段和响应行为。

当可用目录来自在线服务时使用 `refreshModels`。把 `context.signal` 传给阻塞 I/O，以便调用者取消刷新。

两种注册形式有不同的刷新契约：

- 完整 `Provider` 不返回值。它调用 `context.publish({ update })` 安装提供商拥有的模型状态，之后其同步的 `getModels()` 暴露最新列表。
- 旧版 `ProviderConfig.refreshModels` 返回混合操作的模型定义。Pi 用返回的列表替换该注册的活跃模型，并应用任何请求的持久化。

仅当数据需要跨运行保留时才发布持久化的目录数据。像 llama.cpp 这样的在线服务可以只更新内存列表而不持久化；远程目录可以保留快照供离线启动。

## 复用受支持的流式 API

只要提供商协议与之匹配，就使用 Pi AI 的某个 API 实现。

受支持的实现覆盖 Anthropic Messages、OpenAI Chat Completions 和 Responses、Google Generative AI 与 Vertex、Azure OpenAI Responses、Mistral Conversations 和 Bedrock Converse。

提供商仍可自定义认证、基础 URL、请求头、模型过滤和发现，同时把请求转换和流式传输委托给现有 API 实现。

这比复制一个 stream 实现更安全，因为它保留了 Pi 的消息转换、工具处理、用量核算、取消和兼容性行为。

## 实现自定义流式传输

只有当没有现有 API 实现能表示该服务时才实现 `streamSimple`。先研究 [`packages/ai/src/api`](https://github.com/earendil-works/pi/tree/main/packages/ai/src/api) 下的实现。

流接收规范化的 `TranscriptContext`。系统提示词和工具声明位于转录的系统消息中，因此用 `getCurrentSystemPrompt(context.messages)` 和 `getCurrentTools(context.messages)` 读取，不要指望 `context.systemPrompt` 或 `context.tools`。支持对话中途系统消息的模型可以原位接收；否则调用 `collapseSystemMessages(context)` 把后面的系统消息折叠进第一条。

自定义流必须：

1. 创建带提供商、模型、时间戳、待定停止原因、内容和归零用量的助手消息。
2. 请求设置成功后，在内容事件之前发出一个 `start` 事件。
3. 在发出配对的文本、思考和工具调用事件时更新消息。
4. 定稿用量、成本、内容和停止原因。
5. 恰好发出一个终止 `done` 或 `error` 事件并关闭流。
6. 把取消转换为 aborted 结果。

请求设置可能在 `start` 之前失败；此时流可以直接以 `error` 终止。缺少请求认证也可能在返回流之前同步抛出。

内容索引指向助手消息中的块。在发出 `partial` 字段暴露该状态的事件之前更新每个块。到 `toolcall_end` 时工具调用参数必须包含有效的已解析输入。

流还必须遵守通过 `SimpleStreamOptions` 提供的请求插桩：

- 在发送提供商请求之前调用 `options.onPayload`，并使用它返回的任何替换载荷。
- 在收到响应之后、消费其 body 之前调用 `options.onResponse`。
- 对每个解析出的提供商事件，在规范化之前 await `options.onProviderStreamEvent?.(providerEvent, model)`。
- 透传 abort signal 和提供商作用域的环境。

这些钩子支撑扩展的请求检查、响应头事件和提供商流观察。省略它们会使该提供商的行为与 Pi 内置提供商不同。

## 报告失败与用量

设置具体的终止停止原因。错误和中止的消息需要 `errorMessage`；成功的消息需要准确的输入、输出、缓存、总 token 和成本值。

Pi 可以在识别出的上下文溢出错误后压缩并重试。如果服务使用未知消息，只在受保护的 `message_end` 处理器中把该提供商的溢出响应规范化为 `context_length_exceeded`。

不要把限流或瞬态提供商失败改写为上下文溢出。这些失败使用 Pi 的正常重试行为。

## 测试集成

至少测试：

- 普通和空文本响应
- 工具调用和工具结果
- 受支持时的图像输入和图像工具结果
- 用量与成本核算
- 中止行为
- 上下文溢出
- 畸形或不完整的流
- Unicode 边界
- 跨提供商会话交接
- 认证刷新与取消

[`packages/ai/test`](https://github.com/earendil-works/pi/tree/main/packages/ai/test) 下的提供商测试定义了内置提供商的预期行为。改编相关测试套件，而不是只依赖手动提示词。

开发时直接运行扩展，然后把它移到可发现的扩展位置，或通过 [Pi 包](packages.zh-CN.md)分发。在活动会话中修改可发现的提供商扩展后使用 `/reload`。
