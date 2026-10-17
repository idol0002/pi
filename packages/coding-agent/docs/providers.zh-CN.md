# 提供商

大多数托管提供商支持以下一种或两种认证方式：

- 通过浏览器或设备流程登录，底层是 OAuth。
- 提供 API 密钥。

用 `/login [provider]` 查看某个提供商支持的方式。Amazon Bedrock 和 Google Vertex AI 还可以使用环境中的云凭据。

## 交互式认证

运行 `/login` 并选择提供商。Pi 引导你完成其 OAuth 或 API 密钥流程，并把得到的凭据存入 [`auth.json`](configuration.zh-CN.md#agent-directory)。

在远程或无头机器上，OAuth 回调可能无法到达本地进程。出现提示时，把最终重定向 URL 或授权码粘贴回 Pi。

运行 `/logout` 并选择提供商可移除其存储的凭据。这不会取消设置环境变量、移除 `models.json` 中的认证，或在提供商处吊销凭据。

`auth.json` 可以包含 API 密钥和 OAuth 令牌。保持私密，不要提交。

## 使用环境变量中的 API 密钥

环境变量适用于 CI 及任何不应由 Pi 存储密钥的场合。启动 Pi 前设置变量：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

下表覆盖只有单一主 API 密钥变量的提供商。需要额外配置或支持环境凭据的提供商见[提供商特定配置](#provider-specific-config)。

| 提供商 | 环境变量 |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan（全球） | `ZAI_API_KEY` |
| ZAI Coding Plan（中国） | `ZAI_CODING_CN_API_KEY` |
| OpenCode Zen 和 Go | `OPENCODE_API_KEY` |
| Radius | `RADIUS_API_KEY` |
| TypeSafe（[分类器模型](models.zh-CN.md#use-classifier-models)） | `TYPESAFE_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Meta | `META_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| MiniMax（中国） | `MINIMAX_CN_API_KEY` |
| Moonshot AI（全球和中国） | `MOONSHOT_API_KEY` |
| Qwen Token Plan 与个人版 | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan（中国） | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan（中国） | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan（阿姆斯特丹） | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan（新加坡） | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |

Anthropic 还把 `ANTHROPIC_OAUTH_TOKEN` 识别为 API 凭据，把 `ANTHROPIC_AUTH_TOKEN` 识别为 bearer 认证。

没有密钥或令牌时，若设置了 `ANTHROPIC_FEDERATION_RULE_ID`、`ANTHROPIC_ORGANIZATION_ID` 和 `ANTHROPIC_IDENTITY_TOKEN_FILE`，Anthropic 使用工作负载身份联合：Anthropic SDK 用身份令牌换取短期访问令牌并自行刷新（会重新读取身份令牌文件，因此长会话请保持该文件更新）。设置了 `ANTHROPIC_SERVICE_ACCOUNT_ID` 和 `ANTHROPIC_WORKSPACE_ID` 时会透传。

## 从命令加载 API 密钥

要在不把解析出的密钥写入磁盘的情况下使用密钥管理器，把 `auth.json` 中提供商的 `key` 设为以 `!` 前缀的命令：

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "!security find-generic-password -ws 'anthropic'"
  }
}
```

Pi 在首次需要密钥时运行该命令，并把其标准输出缓存到进程生命周期结束。空输出、超时或非零退出使密钥保持未解析状态，直到 Pi 重启。

## 提供商特定配置

下面的提供商有额外设置、需要额外配置，或可以使用其平台提供的凭据。

存储的 API 密钥凭据可以包含 `env` 对象。其值对该提供商优先于进程环境：

```json
{
  "cloudflare-workers-ai": {
    "type": "api_key",
    "key": "...",
    "env": {
      "CLOUDFLARE_ACCOUNT_ID": "account-id"
    }
  }
}
```

### Radius

Radius 是由 Pi 的构建者 Earendil Works 为 Pi 打造的服务。它提供可定制的 AI 网关，内置组织级控制和分析，以及用于分享你用 Pi 创作成果的 artifacts。

开始使用：在 Pi 中运行 `/login radius`。这会把 Radius 添加为提供商，其模型像其他提供商一样出现在 `/model` 中。

Radius 还有 MCP 服务器，Pi 可以替你管理 Radius。

Radius 目前处于早期 alpha，变化很快。更多信息见 [radius.earendil.com](https://radius.earendil.com)。

Radius 认证使用其网关目录，并缓存刷新后的模型元数据供之后离线启动。在 `models.json` 中配置的自定义 Radius 网关使用自己的目录，不继承公共 `radius.pi.dev` 目录。

### OpenRouter

用 `/login openrouter` 或 `OPENROUTER_API_KEY` 认证。

使用密钥时，Pi 只列出该密钥可用的 OpenRouter 聊天模型，带密钥的上下文大小、最大输出和价格。这些来自 OpenRouter 的 `/models/user` 端点，反映 OpenRouter 中设置的护栏和提供商限制。图像和分类器模型不过滤。

Pi 在交互模式启动时、`/model` 打开时、`/login` 之后以及 `pi update --models` 时在后台刷新列表。最后一份列表被保存，供离线、`pi -p` 和 RPC 模式使用。在 `/login` 之外切换密钥后，前一个密钥的列表保持到下一次刷新。

区域端点把模型过滤到其区域。要使用某个区域端点，在 [`models.json`](models.zh-CN.md#configure-a-compatible-endpoint) 设置基础 URL：

```json
{
  "providers": {
    "openrouter": { "baseUrl": "https://us.openrouter.ai/api/v1" }
  }
}
```

如果基础 URL 在 `/models/user` 拒绝该密钥或没有该端点（例如被配置为 OpenRouter 基础 URL 的代理），Pi 列出每个 OpenRouter 模型。

### Azure OpenAI

提供商 ID 是 `azure`（原 `azure-openai-responses`）。在 `auth.json`、`models.json`、`settings.json` 以及模型引用（如 `--model azure/gpt-5.4`）中用它作为键。

`azure` 提供商通过 Responses API 提供 OpenAI 模型，通过 Chat Completions 提供 Microsoft Foundry 模型，如 `azure/deepseek-v4-pro`。

设置 API 密钥加基础 URL 或资源名：

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# 或：
export AZURE_OPENAI_RESOURCE_NAME=your-resource
```

`ai.azure.com`、`cognitiveservices.azure.com` 和 `openai.azure.com` 下的资源根 URL 会规范化为 OpenAI API 路径。

Pi 把模型 ID 作为部署名发送。如果部署名不同，用 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 映射：

```bash
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-5.4=my-gpt-deployment,deepseek-v4-pro=my-deepseek
```

`AZURE_OPENAI_API_VERSION` 覆盖 OpenAI 模型的 API 版本（默认 `v1`）。

要使用 Pi 未包含的 Foundry 模型，在 [`models.json`](models.zh-CN.md#configure-a-compatible-endpoint) 的 `azure` 下添加，带 `api: "openai-completions"`。自定义模型需要 `baseUrl`；设置了 `AZURE_OPENAI_BASE_URL` 和 `AZURE_OPENAI_RESOURCE_NAME` 时它们优先于该值：

```json
{
  "providers": {
    "azure": {
      "baseUrl": "https://your-resource.services.ai.azure.com",
      "models": [
        { "id": "your-deployment", "api": "openai-completions" }
      ]
    }
  }
}
```

### Amazon Bedrock

Bedrock 可以用 bearer 令牌或环境中的 AWS 凭据来源：

```bash
# 命名 profile
export AWS_PROFILE=your-profile

# IAM 密钥
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# 临时凭据必需
export AWS_SESSION_TOKEN=...

# Bedrock bearer 令牌
export AWS_BEARER_TOKEN_BEDROCK=...

# 区域（profile 或 AWS SDK 配置未提供时）
export AWS_REGION=us-west-2
# 也支持 AWS_DEFAULT_REGION
```

Pi 还通过标准 `AWS_CONTAINER_CREDENTIALS_*` 和 `AWS_WEB_IDENTITY_TOKEN_FILE` 变量支持 ECS 任务凭据和 IRSA。

### Cloudflare AI Gateway

网关需要令牌、账户 ID 和网关 ID：

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...
```

账户和网关 ID 可以来自进程环境或 `auth.json` 中凭据的 `env` 对象。

`CLOUDFLARE_API_KEY` 向网关认证 Pi。上游访问可以使用 Cloudflare 统一计费、存储在网关中的凭据，或在 `models.json` 中为该提供商配置的 `Authorization` 头。

### Cloudflare Workers AI

Workers AI 需要令牌和账户 ID：

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
```

账户 ID 也可以存储在凭据的 `env` 对象中。

### Google Vertex AI

使用 Google Cloud API 密钥：

```bash
export GOOGLE_CLOUD_API_KEY=...
```

要使用 Application Default Credentials，配置项目和位置：

```bash
export GOOGLE_CLOUD_PROJECT=your-project
# 也支持 GCLOUD_PROJECT
export GOOGLE_CLOUD_LOCATION=us-central1
```

然后认证：

```bash
gcloud auth application-default login
```

要改用服务账户密钥文件，在项目和位置之外设置 `GOOGLE_APPLICATION_CREDENTIALS`。
