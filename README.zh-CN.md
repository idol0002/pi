<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 新贡献者提交的 issue 和 PR 默认会被自动关闭。维护者每天审查被自动关闭的 issue。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

# Pi

Pi 是一个极简、可扩展的 agent 基座（harness），你可以把它改造成自己的工具。

让 Pi 适应你的工作流，而不是反过来。你可以通过[扩展](packages/coding-agent/docs/extensions.zh-CN.md)、[技能（skills）](packages/coding-agent/docs/skills.zh-CN.md)、[提示词模板](packages/coding-agent/docs/prompt-templates.zh-CN.md)和[主题](packages/coding-agent/docs/themes.zh-CN.md)定制 Pi。把它们打包成 [Pi 包](packages/coding-agent/docs/packages.zh-CN.md)，通过 npm 或 git 分享。

Pi 自带强大的默认配置，但刻意不包含子代理（sub-agent）和计划模式（plan mode）等特性。你可以让 Pi 自己实现你想要的功能，或者安装一个按你的方式运作的包。

你可以[交互式地](packages/coding-agent/docs/usage.zh-CN.md)使用 Pi，在[打印或 JSON 模式](packages/coding-agent/docs/cli.zh-CN.md)下自动化它，通过 [RPC](packages/coding-agent/docs/rpc.zh-CN.md) 控制它，或者用 [Pi TypeScript SDK](packages/coding-agent/docs/sdk.zh-CN.md) 构建应用。真实世界的集成案例参见 [OpenClaw](https://github.com/OpenClaw/OpenClaw)。

## 快速开始

安装命令行界面：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Windows 系统：

```shell
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

安装器会锁定所有依赖版本，并支持用 `pi update` 更新 Pi。你也可以直接用 npm 安装，但这种方式不会锁定传递依赖：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi 需要 Node.js 22.19 或更高版本。macOS、Linux 和 Windows 安装器可以在需要时自动安装 Node.js。正常的 npm 安装不需要运行依赖的生命周期脚本。

在你希望 Pi 工作的目录中启动它：

```bash
cd /path/to/project
pi
```

对于内置的 AI 提供商，在 Pi 中运行 `/login` 连接订阅或 API key，然后给 Pi 下达任务。

完整设置和使用说明见[文档](https://pi.dev/docs/latest)，或访问 [pi.dev](https://pi.dev) 查看演示。

## 通过 Nix 运行

```bash
nix run github:earendil-works/pi/stable
```

`stable` 指向最新发布版本。用 `nix profile add github:earendil-works/pi/stable` 安装，用 `nix profile upgrade pi` 更新。也可以固定到某个发布标签，例如 `github:earendil-works/pi/v1.0.0`，或者用 `github:earendil-works/pi` 获取 main 分支上未发布的改动。Nix 会从源码构建 Pi。

支持 Linux、macOS 和 Windows 上的 ARM64 与 x86-64 架构。使用 `nix build .` 或 `nix run .` 从本地检出构建或运行。

Nix 构建是离线的，因此内置的模型数据来自 `nix/model-catalog.json` 中固定的 pi.dev 模型目录修订版。运行时，Pi 仍会照常从 pi.dev 叠加更新的目录数据。当固定版本不再匹配当前检出（例如新增了提供商或新的模型类型）时，Nix 工作流会在 main 分支上更新该固定版本。手动刷新：

```bash
npm run update:model-catalog-pin
```

## 包

本 monorepo 包含 Pi CLI 及其支持库。

| 包 | 说明 |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | 类型化的宿主运行时，支持热重载插件、契约（contracts）、复制状态和基于 JSON 链路的 RPC |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | 供应商中立的遥测契约、参考适配器、一致性测试和类型化 schema |
| **[@earendil-works/pi-ai](packages/ai)** | 统一的多提供商 LLM API（OpenAI、Anthropic、Google 等） |
| **[@earendil-works/pi-durable](packages/durable)** | 持久化的对话、任务和文档运行时 |
| **[@earendil-works/pi-agent-core](packages/agent)** | 具备工具调用和状态管理的 agent 运行时 |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | 交互式编码 agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | 支持差分渲染的终端 UI 库 |

Slack/聊天自动化与工作流见 [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat)。

## 权限与容器化

Pi 没有内置的权限系统来限制文件系统、进程、网络或凭据访问。默认情况下，它以启动它的用户和进程的权限运行。

如果需要更强的边界，请将 Pi 容器化或沙箱化。参见 [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.zh-CN.md) 了解三种模式：

- **Gondolin 扩展**：让 `pi` 和提供商认证留在宿主机上，同时把内置工具和 `!` 命令路由到本地 Linux 微虚拟机（micro-VM）中。
- **纯 Docker**：把整个 `pi` 进程跑在本地容器中，实现简单隔离。
- **OpenShell**：把整个 `pi` 进程跑在策略可控的沙箱中。

## 参与贡献

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，项目专属规则（面向人类和 agent）见 [AGENTS.md](AGENTS.zh-CN.md)。Pi 的长期规划也可以在 [RFC](https://rfc.earendil.com/keyword/pi/) 中找到。

## 开发

```bash
npm install --ignore-scripts  # 安装全部依赖，不运行生命周期脚本
npm run build         # 刷新模型数据，然后构建所有包
npm run build:offline # 使用现有模型数据离线重新构建
npm run check         # Lint、格式化和类型检查
./test.sh            # 运行测试（没有 API key 时跳过依赖 LLM 的测试）
./pi-test.sh         # 从源码运行 pi（可在任意目录执行）
```

### 在 monorepo 之外使用本地包

把所有公开包构建成一套连贯的本地产物：

```bash
npm run pack:packages -- --out .artifacts/pi-packages
```

这会在构建 `pi-ai` 之前刷新模型数据。如果模型数据已就绪、想避免网络访问，传 `--offline-model-data`。

然后配置外部项目使用其中一个包，并让所有 Pi 依赖都从同一套产物解析。默认使用 npm：

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-durable \
  --package @earendil-works/pi-agent-core
cd ../my-project
npm install --ignore-scripts
```

对于 pnpm 项目，把 `--consumer` 指向 workspace 根目录：

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-agent-core \
  --package-manager pnpm
cd ../my-project
pnpm install --ignore-scripts
```

每个直接依赖都重复一次 `--package`。该命令会把内容寻址的本地 `file:` 引用更新到 consumer 的 `package.json` 中，并为 npm 写入 `package.json` 的传递 overrides（pnpm 则写入 `pnpm-workspace.yaml`）。在安装或更新 consumer 期间，请保持产物目录可用。修改 Pi 源码后，重新执行这两条命令。

## 从发布源码构建独立二进制

GitHub releases 提供带版本的源码压缩包，附有对应的 `SHA256SUMS` 文件。解压后运行与官方独立二进制相同的构建脚本：

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

压缩包含有发布版模型数据和原生预编译产物。`--offline-model-data` 使用压缩包内的模型数据，不刷新提供商目录。该脚本会安装依赖并用运行时资源构建可执行文件；如果依赖已就绪，传 `--skip-install`。

## 供应链加固

我们把 npm 依赖变更视为经过评审的代码变更。

- 直接外部依赖固定到精确版本。内部 workspace 包保持版本区间。
- `.npmrc` 设置 `save-exact=true` 和 `min-release-age=2`，避免 npm 解析时命中当天发布的依赖。
- `package-lock.json` 是依赖的唯一事实来源。预提交钩子会阻止意外的 lockfile 提交，除非设置 `PI_ALLOW_LOCKFILE_CHANGE=1`。
- `npm run check` 会校验固定版本的直接依赖、原生 TypeScript 导入兼容性，以及生成的 coding-agent 安装锁。
- pi.dev 安装器从 `packages/coding-agent/install-lock/` 安装（由根 lockfile 生成），以锁定传递依赖。npm 包不锁定传递依赖。
- 本地发布冒烟测试和 npm 发布使用同一个 tarball 打包器；npm 发布的是经过验证的 tarball，而不是重新打包 workspace 目录。
- 本地发布安装、文档中的 npm 安装以及 `pi update --self` 在支持时都使用 `--ignore-scripts`。
- CI 使用 `npm ci --ignore-scripts` 安装，并且一个定时 GitHub workflow 会运行 `npm audit --omit=dev` 和 `npm audit signatures --omit=dev`。
- 安装锁生成脚本对依赖生命周期脚本有显式允许列表；新增带生命周期脚本的依赖会让检查失败，必须经过评审。

## 分享你的开源编码 agent 会话

如果你在开源工作中使用 Pi 或其他编码 agent，请分享你的会话。

公开的开源会话数据有助于改进编码 agent——包含真实任务、工具使用、失败与修复，而不是玩具基准测试。

完整说明见 [X 上的这篇帖子](https://x.com/badlogicgames/status/2037811643774652911)。

发布会话请使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。阅读其 README.md 了解设置步骤。你只需要一个 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

你也可以观看[这个视频](https://x.com/badlogicgames/status/2041151967695634619)，我会演示如何发布我的 `pi-mono` 会话。

我会定期在这里发布我自己的 `pi-mono` 工作会话：

- Hugging Face 上的 [badlogicgames/pi-mono](https://huggingface.co/datasets/badlogicgames/pi-mono)

## 许可证

MIT

<p align="center">
  <a href="pi.dev">pi.dev</a> 域名由
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy 吉祥物" width="48" /><br />exe.dev</a>
  慷慨捐赠
</p>
