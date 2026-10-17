# 用 llama.cpp 运行本地模型

Pi 支持 [llama.cpp](https://github.com/ggml-org/llama.cpp) 路由服务器。路由器发现多个 GGUF 模型，并按需加载或卸载它们。

使用带路由器支持的较新 llama.cpp 构建。按[构建说明](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)构建，或安装适合你平台的[预编译版本](https://github.com/ggml-org/llama.cpp/releases)。

## 启动路由器

不带 `--model` 或 `-m` 启动 `llama-server`。传入模型会启动单模型模式而不是路由器模式。

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

重要选项：

- `--models-dir ~/models` 发现本地 GGUF 文件。
- `--no-models-autoload` 让加载只通过 `/llama` 显式进行。
- `--jinja` 启用兼容的聊天模板和工具调用。
- `-ngl 999` 把尽可能多的层卸载到 GPU。
- `-c 32768` 为每个已加载模型设置上下文窗口。省略则使用模型的原生上下文，可能需要显著更多内存。

单文件模型可以直接放在模型目录中。多模态和多分片模型放在单独的子目录：

```text
~/models/
├── llama-3.2-1b-Q4_K_M.gguf
├── gemma-3-4b-it-Q4_K_M/
│   ├── gemma-3-4b-it-Q4_K_M.gguf
│   └── mmproj-F16.gguf
└── large-model-Q4_K_M/
    ├── large-model-Q4_K_M-00001-of-00003.gguf
    ├── large-model-Q4_K_M-00002-of-00003.gguf
    └── large-model-Q4_K_M-00003-of-00003.gguf
```

手动添加文件后重启路由器。按模型的上下文大小和其他选项，使用 [llama.cpp 模型预设](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets)。针对特定 NVIDIA GPU 和模型调优的设置见[用 NVIDIA RTX 和 llama.cpp 运行 Pi](nvidia-rtx-llama-cpp.zh-CN.md)。

## 配置 Pi

启动 Pi 并配置提供商：

```text
/login llama.cpp
```

输入路由器 URL 和可选的 API key。默认 URL 是 `http://127.0.0.1:8080`。

如果路由器以 `--no-models-autoload` 启动，`/login llama.cpp` 只保存连接。运行 `/llama` 加载模型，然后 `/model` 为当前会话选择已加载的模型。

环境变量可以不通过 `/login` 配置同样的值：

```bash
export LLAMA_BASE_URL=http://127.0.0.1:8080
export LLAMA_API_KEY=optional-secret
pi
```

服务器使用 API key 时，用匹配的 `--api-key` 值启动 `llama-server`。保持 `--host 127.0.0.1` 以限制为本地访问。

## 管理模型

运行：

```text
/llama
```

- 选择未加载的模型加载它。
- 选择已加载的模型卸载它。
- 选择 **Download model…**，搜索 Hugging Face，然后选择仓库和量化。精确的 `owner/repository[:quant]` 值也可以。
- 加载或下载期间按 Escape 确认取消。

Hugging Face 搜索在设置了 `HF_TOKEN` 时使用它，否则依次检查 `$HF_TOKEN_PATH`、`$HF_HOME/token`、`$XDG_CACHE_HOME/huggingface/token` 和 `~/.cache/huggingface/token`。未认证也可以搜索，但速率限制更低。Pi 在下载受限（gated）仓库前会警告并链接到其访问页。下载由 llama.cpp 服务器执行，因此所选仓库需要访问权限时，其进程也必须有 `HF_TOKEN`。

如果已有其他模型加载，Pi 会询问先卸载它们还是保持加载。Pi 不会静默卸载模型，也从不删除模型文件。路由器可能与其他客户端共享，所以 `/llama` 总是显示路由器的当前状态。

已加载和休眠的模型出现在 `/model` 中。休眠模型被选中时自动唤醒。启用路由器自动加载时，未加载的预设模型也会出现并在选中时加载。使用 `--no-models-autoload` 时，先通过 `/llama` 加载模型再选择。

路由器断开连接时，`/llama` 显示 **Retry** 和 **Close**。Retry 重新连接并刷新模型状态，不会重放被中断的操作。

## 分类

分类器模型回答针对 JSON 状态的类型化 `choice`、`bool` 和 `score` 问题，类似 TypeSafe 的 Jev 模型。模型通过 [`codemode`](cli.zh-CN.md#enable-codemode) 脚本和扩展的 `ctx.modelRegistry.classify()` 访问它们；见[分类器模型](models.zh-CN.md#use-classifier-models)。Pi 以两种方式把 llama.cpp 模型列为分类器：

- **决策模型**，如 [Julia-1、Laya、Kev、lev 和 OpenJev](https://huggingface.co/collections/ggml-org/decision-models-6abf80cca3c83f127060a769)，通过 llama.cpp 的 `/v1/systemone` 端点原生回答。它们只作为分类器出现（使用 `typesafe-system-one` API），不出现在 `/model` 中。
- **聊天模型**也以相同 ID 和 `llama-cpp-classify` API 被列为分类器，该 API 从下一个 token 的概率中读取答案，如下所述。

llama.cpp 0.6.0 及以后版本会在路由器的模型列表中报告决策模型：其 `architecture.output_modalities` 包含 `decisions`。路由器从 GGUF 元数据读取该信息而无需加载模型，所以 Pi 也能识别未加载和休眠的决策模型。更旧的 llama.cpp 构建不报告它，Pi 会把其决策模型列为聊天模型。

### 聊天模型作为分类器

模型不生成答案。每个问题变成一条聊天 prompt：状态、请求的每个问题、再次的状态，然后是带单 token 标签答案的问题。标签对 choice 是字母（最多 62 个选项），对 bool 是 `Yes`/`No`，对 score 是数字（最多 10 级）。状态的第二份副本带着问题一起阅读，这在小模型的 JevBench 上提高了准确率。Pi 读取标签作为下一个 token 的概率并归一化。choice 返回每个选项的概率和 `(n * peak - 1) / (n - 1)` 的置信度；score 返回期望级别。

- 原始标签概率通常过度自信。每请求的 `temperature` 选项在归一化前缩放标签 logits；大于 1 的值让分布更平缓。它不改变答案。
- 问题依次运行。请求中所有问题之前的内容都相同，因此服务器的提示词缓存只计算一次。状态出现两次，因此需要两倍大小的上下文。
- 小模型可能遵循写在状态内的指令。prompt 告诉模型把状态当作数据判断，但这不是保证。
- Qwen3.5 等混合模型在没有上下文检查点时无法回退部分缓存的 prompt。如果每个问题都要重新处理整个状态，用 `--ctx-checkpoints 32 --checkpoint-min-step 0` 启动路由器。

## 故障排查

检查路由器是否可达：

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

- **`/llama` 中没有模型：**检查 `--models-dir`、目录布局，并重启路由器。
- **`--no-models-autoload` 时模型不在 `/model` 中：**先用 `/llama` 加载。
- **加载失败或内存占用过高：**调低 `-c` 或卸载其他模型。
- **服务器不在路由器模式：**不带 `--model`、`-m` 或 `-hf` 启动。

移除 `llama.cpp` 提供商和 `/llama`：在 `pi config` 的 Built-in 下禁用 `llama.cpp`，或在[设置](settings.zh-CN.md#resources)中设 `"extensions": ["-builtin:llama.cpp"]`。
