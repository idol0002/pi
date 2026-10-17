# Pi

Pi 是一个可扩展的 AI agent，在你的终端中工作。给它一个目标和一个工作文件夹，它就能检查文件、运行命令、编辑内容，并完成多步任务。

用 Pi 做软件开发、研究笔记、写作项目、数据文件或业余工作。你可以原样使用 Pi，用提示词让它适应你的工作流，或者用 SDK 构建由 Pi 驱动的其他应用。

## 开始使用 Pi

刚接触 Pi？跟随[快速开始](quickstart.zh-CN.md)安装 Pi、连接模型并完成第一个任务。

如果 Pi 已安装，选择你想做的事：

- [交互式使用 Pi](usage.zh-CN.md)：添加文件、运行命令、指挥进行中的工作并导出结果。
- [选择模型](models.zh-CN.md)，或连接订阅、API key、本地模型或兼容端点。
- [继续或分支会话](sessions.zh-CN.md)：恢复工作，或在不丢失历史的情况下探索另一种方案。
- [配置 Pi](configuration.zh-CN.md)：设置你的偏好、工作文件夹、指令和可复用资源。
- [理解 Pi 的工作原理](how-pi-works.zh-CN.md)：包括工具、上下文、会话和 agent 循环。

## 定制 Pi

Pi 可以复用提示词、加载专门指令、添加可执行集成、更换终端界面、连接模型服务，并把这些资源作为包分发。
使用[快速开始的定制选择器](quickstart.zh-CN.md#choose-how-to-customize-pi)选出满足需求的最小机制。

## 自动化或嵌入 Pi

- 用[打印模式](cli.zh-CN.md#invocation-and-output)处理一次性任务和脚本任务。
- 用 [JSON 事件流模式](json.zh-CN.md)消费单次运行的结构化事件。
- 用 [RPC 模式](rpc.zh-CN.md)控制一个独立的 Pi 进程。
- 用 [TypeScript SDK](sdk.zh-CN.md) 在应用内运行 Pi。

## 查阅参考与设置信息

用参考页查询 [CLI 选项](cli.zh-CN.md)、[设置](settings.zh-CN.md)、[提供商](providers.zh-CN.md)、[按键绑定](keybindings.zh-CN.md)和[环境变量](environment-variables.zh-CN.md)。

平台相关的帮助见[终端设置](terminal-setup.zh-CN.md)、[Windows](windows.zh-CN.md)、[tmux](tmux.zh-CN.md)、[Android 上的 Termux](termux.zh-CN.md)或[容器化](containerization.zh-CN.md)。

## 安全工作

Pi 的工具和扩展以 Pi 进程的权限运行。项目信任控制 Pi 加载哪些项目资源，但不会沙箱化工具调用。使用不受信任的文件、仓库、扩展或无人值守的自动化之前，请先阅读[安全](security.zh-CN.md)。
