# 在终端中使用 Pi

在你想要工作的文件夹中运行 `pi`。Pi 用该文件夹发现文件、指令和配置，并对保存的会话分组。如果尚未安装 Pi 或选择模型，先看[快速开始](quickstart.zh-CN.md)。

在加载项目资源之前，Pi 可能会询问你是否信任该工作文件夹。见[项目信任](security.zh-CN.md#understand-project-trust)。

<p align="center"><img src="images/interactive-mode.png" alt="Pi 交互模式，显示对话、编辑器和状态信息" width="750"></p>

记录区显示你的 prompt、Pi 的响应、工具调用、结果和错误。你在编辑器中输入 prompt 和命令。页脚显示当前文件夹、会话、模型、上下文用量以及累计用量和费用。

## 输入 prompt

输入请求并按 `Enter` 发送。用 `Shift+Enter` 换行，或按 `Ctrl+G` 在你配置的外部编辑器中编写较长的 prompt。

包含文件或图片：

- 输入 `@` 搜索文件并加入 prompt。
- 按 `Tab` 补全路径。
- 粘贴图片，或把图片拖进兼容的终端。

## 跟踪 Pi 的工作

Pi 工作时会显示每次工具调用和结果。按 `Ctrl+O` 展开或折叠工具输出。按 `Ctrl+T` 显示或隐藏思考块。

启动页头列出 Pi 加载的指令和资源。编辑器边框指示当前思考级别。页脚随模型使用上下文而更新，并报告用量。

Pi 不会在每次工具调用前询问。请检查命令和被修改的文件，不受信任或无人值守的工作使用沙箱。见[安全](security.zh-CN.md)。

## 调整方向

Pi 工作时你可以继续输入：

| 目的 | 操作 |
|---|---|
| 调整当前任务 | 输入消息并按 `Enter` |
| 在当前任务之后追加工作 | 输入消息并按 `Alt+Enter` |
| 把排队的消息退回编辑器 | 按 `Alt+Up` |
| 停止当前任务 | 按 `Escape` |

用 `Enter` 发送的消息会等到当前响应及其工具调用完成后，再引导下一次响应。`Alt+Enter` 发送的 follow-up 会等 Pi 完成当前任务。中止会把排队消息退回编辑器。

Windows Terminal 占用了一些 Alt 快捷键。Windows 替代键见[终端设置](terminal-setup.zh-CN.md)。

## 更换模型或设置

输入 `/` 搜索可用命令。最常用的命令：

- `/model` 选择模型。按 `Ctrl+L` 打开同样的选择器。
- `/thinking` 选择当前模型使用的推理量。按 `Shift+Tab` 在支持的级别间循环。
- `/login` 和 `/logout` 管理提供商访问。
- `/settings` 修改常用偏好。

提示词模板、技能和扩展可以在同一菜单中添加更多命令。见[选择模型](models.zh-CN.md)、[配置](configuration.zh-CN.md)或完整的[斜杠命令参考](slash-commands.zh-CN.md)。

## 继续或重新开始

除非禁用会话持久化，Pi 会自动保存会话。

- `/new` 开始新会话。
- `/resume` 打开另一个已保存的会话。
- `/name` 给当前会话起一个可识别的名字。
- `/session` 显示其文件、ID、消息数、token 用量和费用。

想在不丢失现有工作的情况下探索另一种方案时，用 `/tree`、`/fork` 或 `/clone`。用 `/compact` 减少发送给模型的对话历史。这些工作流见[会话与上下文](sessions.zh-CN.md)。

离开 Pi 后，在同一文件夹运行 `pi --continue` 恢复其最近的会话。

## 运行终端命令

给命令加 `!` 前缀来运行它，并把输出纳入对话：

```text
!git status
```

想运行命令但不把输出发给模型时，用 `!!`。

## 复制、导出或分享结果

按 `Ctrl+X` 或运行 `/copy` 复制最后一条助手响应。用 `/export` 把会话保存为 HTML 或 JSONL。

用 `/share` 上传会话并获得查看链接。默认情况下，Radius 认证让该产物对你的 Radius 组织可见；否则 Pi 通过 GitHub CLI 创建私有 GitHub gist。[`sessionShareDestination`](settings.zh-CN.md#sessions-and-context) 设置可以强制指定其中一种目的地。分享前先审查会话，因为它可能包含 prompt、工具输出、文件内容以及对话中暴露的凭据。

## 调整终端

默认的全屏模式让编辑器和状态区固定，记录区在终端窗口内滚动。常规模式使用终端的正常回滚缓冲。通过 `/settings` 或 `--tui-mode` 选择模式。

终端对鼠标输入、快捷键和内联图片的支持各不相同。平台相关配置见[终端设置](terminal-setup.zh-CN.md)，所有可配置快捷键见[按键绑定](keybindings.zh-CN.md)。运行 `/hotkeys` 查看当前会话生效的快捷键。

## 收集诊断信息

排查终端渲染或对话状态问题时，运行 `/debug`。Pi 会把渲染的终端行和当前会话消息写入你的 [agent 目录](configuration.zh-CN.md#agent-directory)中的 `pi-debug.log`。

分享前先审查该文件。它可能包含 prompt、模型响应、工具输出、文件内容和终端数据。
