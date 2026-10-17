<p align="center">
  <a href="https://pi.dev">
    <img alt="Pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

> 新贡献者提交的 issue 和 PR 会被自动关闭。维护者每天审查被关闭的提交。见 [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md)。

# Pi

Pi 是一个极简、可扩展的 agent 基座（harness），你可以把它改造成自己的工具。

让 Pi 适应你的工作流，而不是反过来。通过[扩展](docs/extensions.zh-CN.md)、[技能（skills）](docs/skills.zh-CN.md)、[提示词模板](docs/prompt-templates.zh-CN.md)和[主题](docs/themes.zh-CN.md)定制 Pi。把它们打包成 [Pi 包](docs/packages.zh-CN.md)，通过 npm 或 git 分享。

Pi 自带强大的默认配置，但刻意不包含子代理（sub-agent）和计划模式（plan mode）等特性。你可以让 Pi 自己实现你想要的功能，或者安装一个按你的方式运作的包。

你可以[交互式地](docs/usage.zh-CN.md)使用 Pi，在[打印或 JSON 模式](docs/cli.zh-CN.md)下自动化它，通过 [RPC](docs/rpc.zh-CN.md) 控制它，或者用 [Pi TypeScript SDK](docs/sdk.zh-CN.md) 构建应用。真实世界的集成案例参见 [OpenClaw](https://github.com/OpenClaw/OpenClaw)。

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

在 macOS 和 Linux 上，Nix 用户可以用 `nix profile add github:earendil-works/pi/stable` 安装最新发布。更新和固定版本见[快速开始](docs/quickstart.zh-CN.md#1-install-pi)。

在你希望 Pi 工作的目录中启动它：

```bash
cd /path/to/project
pi
```

对于内置的 AI 提供商，在 Pi 中运行 `/login` 连接订阅或 API key，然后给 Pi 下达任务。

完整设置和使用说明见[文档](docs/index.zh-CN.md)。

## 分享你的开源编码 agent 会话

如果你在开源工作中使用 Pi，请分享你的编码 agent 会话。

公开的开源会话数据有助于用真实开发工作流改进模型、提示词、工具和评估。

完整说明见 [X 上的这篇帖子](https://x.com/badlogicgames/status/2037811643774652911)。

发布会话请使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)，需要一个 Hugging Face 账号和 Hugging Face CLI。

- 发布 Pi 会话的[演示视频](https://x.com/badlogicgames/status/2041151967695634619)
- 已发布的 Pi 开发会话：Hugging Face 上的 [`badlogicgames/pi-mono`](https://huggingface.co/datasets/badlogicgames/pi-mono)。

## 开发

克隆仓库、安装依赖，然后从源码运行 Pi：

```bash
git clone https://github.com/earendil-works/pi
cd pi
npm install --ignore-scripts
./pi-test.sh
```

`pi-test.sh` 可以从任意目录调用，并保留调用者的工作目录。

提交变更之前，运行：

```bash
npm run check
./test.sh
```

开 issue 或 pull request 之前，先阅读 [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md)。它定义了贡献门槛、issue 质量标准和必需的检查。仓库专属的实现、测试、依赖和发布规则见 [AGENTS.md](https://github.com/earendil-works/pi/blob/main/AGENTS.md)。

## 许可证

MIT
