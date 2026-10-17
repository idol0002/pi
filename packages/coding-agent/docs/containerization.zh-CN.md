# 在隔离环境中运行 Pi

使用隔离环境限制生成命令能访问或影响的文件、凭据、进程和网络服务。

你可以隔离完整的 Pi 进程，也可以让 Pi 留在宿主机上，把选定的工具路由进隔离环境。

## 选择隔离方式

| 方式 | Pi 运行位置 | 隔离内容 | 凭据处理 | 最适合 |
|---|---|---|---|---|
| 纯 Docker | 容器 | Pi、内置工具、`!` 命令和扩展 | 凭据传入容器 | 简单直接的本地容器边界 |
| Docker Sandboxes | 托管沙箱 | Pi、内置工具、`!` 命令和扩展 | 提供商凭据留在宿主机，由代理替换 | 托管的本地隔离，不暴露真实提供商 key |
| OpenShell | 本地或远程沙箱 | Pi、内置工具、`!` 命令和扩展 | 策略控制的凭据与推理路由 | 文件系统、进程、网络和凭据策略 |
| Gondolin 扩展 | 宿主机 | 内置工具和 `!` 命令 | Pi 存储的凭据留在宿主机，但命令继承宿主环境变量 | 本地微虚拟机执行工具，同时保留宿主界面 |

该方式决定扩展运行在哪里。完整 Pi 进程运行在隔离环境内时，其扩展也在其中运行。宿主 Pi 通过 Gondolin 委托内置工具时，其他扩展工具仍在宿主机运行，除非它们也委托自己的工作。

## 决定 Pi 能访问什么

被隔离的进程仍能影响你暴露给它的资源：

- 读写挂载让 Pi 能修改那些宿主文件。
- 挂载 `~/.pi/agent` 会暴露你的 Pi 凭据、设置、扩展和会话。
- 传入容器的环境变量对容器内进程可用。
- 网络访问可能让代码或工具输出离开该环境。
- 仅工具隔离不约束宿主 Pi 进程，也不约束不使用隔离后端的扩展工具。

只暴露任务所需的工作文件夹、凭据和网络目的地。不希望写入影响宿主时，使用只读挂载，或在环境内外复制文件。

## 在纯 Docker 中运行 Pi

纯 Docker 提供最简单的整进程容器边界。

### 构建镜像

创建 `Dockerfile.pi`：

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

在该文件所在目录构建：

```bash
docker build -t pi-sandbox -f Dockerfile.pi .
```

### 启动 Pi

从你想让 Pi 访问的工作文件夹运行：

```bash
docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  pi-sandbox
```

把 `ANTHROPIC_API_KEY` 替换为你的提供商所需的凭据。具名卷 `pi-agent-home` 在多次运行之间保留容器本地的设置、凭据和会话。

除非容器应当访问你宿主的 Pi 配置和凭据，否则不要挂载宿主的 `~/.pi/agent`。

### 验证工作区

在 Pi 内运行：

```text
!pwd
```

该命令应报告 `/workspace`。`/workspace` 下的变更会写透到挂载的宿主文件夹。不可接受时，移除 bind mount 或使用只读挂载。

## 用 Docker Sandboxes 运行 Pi

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) 在托管沙箱内运行完整的 Pi 进程。其代理可以把真实的提供商凭据留在宿主机，并在请求离开沙箱时替换它。

创建沙箱之前配置好凭据。不要在沙箱内运行 `/login`，因为那会把真实凭据写进沙箱。

### 使用 Claude Pro 或 Max token

在装有 Claude Code 的机器上用 `claude setup-token` 生成 token。如果已配置 `anthropic` secret，先移除它，以免代理在 bearer token 之外再加一个 API-key 头：

```bash
sbx secret rm anthropic

sbx secret set-custom \
  --host api.anthropic.com \
  --env ANTHROPIC_OAUTH_TOKEN \
  --placeholder 'sk-ant-oat01-{rand}'
```

`sbx secret set-custom` 从标准输入读取真实 token。沙箱收到 OAuth 形状的占位符，代理只对发往所配置主机的请求替换它。

Anthropic API key 则改用 `sbx secret set anthropic`。

### 启动 Pi

在你想挂载的工作文件夹运行：

```bash
sbx run --kit "docker.io/sbx/pi-kit:latest" pi
```

已有沙箱时，用以下命令非交互运行 Pi：

```bash
sbx exec <sandbox-name> -- pi -p "list the failing tests"
```

其他提供商、故障排查和镜像固定见 [Pi kit 文档](https://github.com/docker/sbx-kits-contrib/tree/main/pi)。

## 用 OpenShell 运行 Pi

[NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) 提供带文件系统、进程、网络、凭据和推理策略的本地或远程沙箱。

### 选择网关

每个沙箱都需要一个活动网关：

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

### 创建沙箱

```bash
openshell sandbox create --name pi-sandbox --from pi -- pi
```

Pi、其内置工具、`!` 命令和扩展工具都运行在 OpenShell 边界内。

### 向远程沙箱传输文件

远程网关不会 bind-mount 你的宿主工作文件夹。在沙箱内克隆仓库，或显式传输文件：

```bash
openshell sandbox upload pi-sandbox ./working-folder /workspace
openshell sandbox download pi-sandbox /workspace/working-folder ./working-folder-out
```

OpenShell 的推理路由可以把原始模型凭据挡在沙箱之外。配置后，把 Pi 指向网关暴露的相应 OpenAI 兼容或 Anthropic 兼容端点。

## 通过 Gondolin 路由工具

[Gondolin](https://github.com/earendil-works/gondolin) 是本地 Linux 微虚拟机。其示例扩展让 Pi 进程和基于文件的提供商凭据留在宿主机，同时把内置工具和用户 `!` 命令路由进虚拟机。

虚拟机内的命令继承宿主进程环境。因此通过环境变量提供的提供商 key 在虚拟机内可见。除非你移除敏感变量或修改该扩展的环境处理，否则不要把这个模式当作凭据边界。

Gondolin 需要 Node.js 23.6 或更新版本，以及通过操作系统包管理器安装的 QEMU。

### 安装扩展

从 Pi 源码检出：

```bash
mkdir -p ~/.pi/agent/extensions
cp -R packages/coding-agent/examples/extensions/gondolin ~/.pi/agent/extensions/gondolin
cd ~/.pi/agent/extensions/gondolin
npm install --ignore-scripts
```

### 启动 Pi

从你想挂载的工作文件夹运行：

```bash
cd /path/to/working-folder
pi -e ~/.pi/agent/extensions/gondolin
```

该扩展把宿主工作文件夹挂载到虚拟机的 `/workspace`，并覆盖 `read`、`write`、`edit`、`bash`、`grep`、`find` 和 `ls`。`/workspace` 下的文件变更会写透到宿主。

其他扩展工具仍在宿主机运行，除非它们显式委托自己的操作。添加可能绕过虚拟机边界的工具之前，先审查 [Gondolin 示例](../examples/extensions/gondolin/)。
