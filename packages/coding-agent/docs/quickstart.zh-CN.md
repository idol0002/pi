# 快速开始

Pi 在你的终端中运行，并操作你机器上的文件。使用它需要通过受支持的提供商访问一个模型。可以是订阅、API key 或本地模型。

Windows 原生安装见 [Windows 设置](windows.zh-CN.md)。Android 见 [Termux 设置](termux.zh-CN.md)。

## 1. 安装 Pi

在 macOS 或 Linux 上，可以使用安装器：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

安装器会锁定所有依赖版本，并支持用 `pi update` 更新 Pi。也可以从 npm 安装 Pi，但这种方式不会锁定传递依赖。需要 Node.js 22.19 或更新版本：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

正常的 npm 安装不需要运行依赖的生命周期脚本。

在 macOS 或 Linux 上使用 Nix 时，从 Pi 的 flake 安装最新发布。Nix 从源码构建 Pi：

```bash
nix profile add github:earendil-works/pi/stable
```

较旧的 Nix 版本使用 `nix profile install`。用 `nix profile upgrade pi` 更新；`pi update` 无法更新 Nix 安装。要固定版本，使用形如 `github:earendil-works/pi/v1.0.0` 的标签。

验证安装：

```bash
pi --version
```

## 2. 启动 Pi

切换到你想让 Pi 处理的文件夹，然后启动：

```bash
cd /path/to/folder
pi
```

工作文件夹帮助 Pi 发现相关文件、指令和配置。Pi 也用它对保存的会话分组。

<p align="center"><img src="images/interactive-mode.png" alt="Pi 在终端中运行，显示对话、输入编辑器和状态页脚" width="750"></p>

界面显示你的对话、用于输入 prompt 和命令的编辑器，以及包含当前文件夹、模型和会话状态的页脚。学习添加文件、运行命令、指挥进行中的工作和管理结果，见[在终端中使用 Pi](usage.zh-CN.md)。

## 3. 选择模型

**模型**生成 Pi 的响应。**提供商**是 Pi 用来访问该模型的服务或账户。

在 Pi 中运行：

```text
/login
```

选择一个提供商，然后按提示使用订阅或保存 API key。之后如果想选择其他可用模型，运行 `/model`。

受支持的提供商、环境变量认证、本地模型和自定义端点见[选择模型和提供商](models.zh-CN.md)。

## 4. 给 Pi 下达任务

Pi 会显示它执行的每次文件读取、搜索、命令和编辑。它不会在每次工具调用前都询问。

输入一个符合你工作的任务，例如：

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

在编辑器中输入 `@` 可以搜索文件，而不必输入完整路径。Pi 完成后，检查它的响应和被修改的文件。重要工作请使用版本控制或备份。不受信任或无人值守的工作，请使用容器或其他沙箱。见[安全](security.zh-CN.md)。

## 稍后继续

Pi 自动保存会话。退出 Pi 后，在同一工作文件夹恢复最近的会话：

```bash
pi --continue
```

用 `/resume` 选择其他已保存的会话。会话命名、分支、压缩、导出和分享见[继续或分支会话](sessions.zh-CN.md)。

## 下一步

- [交互式使用 Pi](usage.zh-CN.md)：学习输入、命令、快捷键和排队消息。
- [添加指令](configuration.zh-CN.md#context-files)：让 Pi 在某个文件夹中工作时始终遵循。
- [选择模型和提供商](models.zh-CN.md)。

### 选择如何定制 Pi

从满足需求的最弱机制开始：

| 需求 | 从这里开始 |
|---|---|
| 给 Pi 一份针对某文件夹的持久指令 | [`AGENTS.md`](configuration.zh-CN.md#context-files) |
| 从 `/` 菜单复用一条提示词 | [提示词模板](prompt-templates.zh-CN.md) |
| 添加任务专属指令和配套文件 | [技能](skills.zh-CN.md) |
| 添加可执行工具、命令或事件处理器 | [扩展](extensions.zh-CN.md) |
| 构建自定义终端组件 | [终端 UI](tui.zh-CN.md) |
| 连接不受支持的模型服务 | [自定义提供商](custom-provider.zh-CN.md) |
| 安装或分发多个资源 | [Pi 包](packages.zh-CN.md) |

## 卸载 Pi

如果你用 npm 安装的 Pi，运行：

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

如果你用的是安装器，重新运行它并选择 **Uninstall Pi**：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

如果你用 Nix 安装的 Pi，运行：

```bash
nix profile remove pi
```

以上任何方式都不会删除 `~/.pi/agent/` 中的配置、凭据、会话或已安装的 Pi 包。
