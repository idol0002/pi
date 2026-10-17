# 用 NVIDIA RTX 和 llama.cpp 运行 Pi

[NVIDIA Local AI Inference Recipes](https://nvidia.github.io/local-ai-inference-recipes/index.html) 提供针对特定 NVIDIA 硬件和模型调优的 llama.cpp 设置。每个 recipe 给出一条单模型的 `llama-server` 命令。Pi 与 llama.cpp 路由器配合工作，路由器可以服务和管理多个模型，因此本指南把 recipe 命令转换为路由器预设。

以下示例使用 Windows PowerShell。Pi 的完整路由器与模型管理参考见[用 llama.cpp 运行本地模型](llama-cpp.zh-CN.md)。

## 开始之前

1. 打开 [recipe 目录](https://nvidia.github.io/local-ai-inference-recipes/index.html)，选择你的硬件、操作系统和模型，然后选择 **llama.cpp**。检查前置条件和内存需求。保留 recipe 的启动命令用于下面的转换。
2. 按 recipe 的安装说明安装 llama.cpp。recipe 的设置依赖其构建，例如 CUDA 支持或投机解码选项。
3. 运行 `llama-server --help`，确认列出了 `--models-preset`。没有它，该构建无法把 recipe 作为路由器预设加载。使用仍满足 recipe 要求的更新构建。
4. 按[快速开始](quickstart.zh-CN.md)安装 Pi。原生 Windows 还要看[在 Windows 上运行 Pi](windows.zh-CN.md)。

## 把 recipe 转换为预设

预设列出一个或多个模型的设置。每个 section 名就是 Pi 中显示的模型 ID。把预设保存在 `llama-server` 旁边，或在启动路由器时传入其完整路径。

把 recipe 命令中的每个选项转换为一条预设行：

- 去掉前导短横线：`--ctx-size 65536` 变成 `ctx-size = 65536`。
- 无值选项写成 `true`：`--jinja` 变成 `jinja = true`。
- 去掉值周围的引号和 PowerShell 续行反引号。
- 不写 `--host` 和 `--port`。它们属于路由器命令行。
- 加上 `load-on-startup = true`，让路由器启动时加载模型。
- 把短模型文件选项替换为对应的长预设键：

| Recipe 选项 | 预设键 |
|---|---|
| `-hf` | `hf-repo` |
| `-hff` | `hf-file` |
| `-hfrd` | `hf-repo-draft` |
| `--spec-draft-model` | `spec-draft-model` |

例如这条 recipe 命令：

```powershell
llama-server.exe -hf "unsloth/Qwen3.8-27B-GGUF" `
  -hff "Qwen3.8-27B-UD-Q4_K_M.gguf" `
  -hfrd "z-lab/Qwen3.8-27B-DFlash2-GGUF" `
  --spec-draft-model "Qwen3.8-27B-DFlash2-Q4_K_M.gguf" `
  --no-mmproj `
  --host 127.0.0.1 `
  --port 9931 `
  --batch-size 4096 `
  --ubatch-size 1024 `
  --ctx-size 65536 `
  --parallel 1 `
  -ngl 999 `
  --jinja `
  --chat-template-kwargs '{"preserve_thinking":true}' `
  --spec-type draft-dflash `
  --spec-draft-n-max 7 `
  --spec-draft-backend-sampling
```

转换为 `qwen3.8-27b.ini`：

```ini
version = 1

[qwen3.8-27b]
load-on-startup = true
hf-repo = unsloth/Qwen3.8-27B-GGUF
hf-file = Qwen3.8-27B-UD-Q4_K_M.gguf
hf-repo-draft = z-lab/Qwen3.8-27B-DFlash2-GGUF
spec-draft-model = Qwen3.8-27B-DFlash2-Q4_K_M.gguf
no-mmproj = true
batch-size = 4096
ubatch-size = 1024
ctx-size = 65536
parallel = 1
ngl = 999
jinja = true
chat-template-kwargs = {"preserve_thinking":true}
spec-type = draft-dflash
spec-draft-n-max = 7
spec-draft-backend-sampling = true
```

## 启动路由器

在 llama.cpp 文件夹打开 PowerShell 并运行：

```powershell
.\llama-server.exe --models-preset qwen3.8-27b.ini --host 127.0.0.1 --port 8080
```

recipe 需要 Hugging Face token 时，在同一 PowerShell 窗口启动路由器前设置 `$env:HF_TOKEN`。首次启动时，路由器会下载模型文件。

用[路由器健康检查](llama-cpp.zh-CN.md#troubleshooting)确认服务器就绪。Windows PowerShell 中用 `curl.exe` 而不是 `curl`——后者被 PowerShell 映射到另一个命令。`/models` 列出 `qwen3.8-27b` 且状态为 `loaded` 时，模型就绪。

## 在 Pi 中使用模型

跟随[配置 Pi](llama-cpp.zh-CN.md#configure-pi) 连接到 `http://127.0.0.1:8080`。预设 section 名就是模型 ID，所以本例在 `/model` 中选择 `qwen3.8-27b`。

NVIDIA recipe 的内存设置假定只有所选模型使用 GPU。如果 `/llama` 显示其他已加载模型，先卸载它们再使用 recipe 模型。
