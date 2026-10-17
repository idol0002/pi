# CLI 集成

默认情况下，运行 `pi` 会打开交互式终端界面。当输入或输出被管道或重定向时，Pi 改用 print 模式。你也可以为脚本和应用程序显式选择 print、JSON 或 RPC 模式。

所有四种模式使用相同的 agent、会话、资源和工具。模式决定输入如何进入 Pi、输出如何暴露，以及进程是否保持可用以接收更多命令。

SDK 不是 CLI 模式。它把 agent 直接嵌入 Node.js 或 Bun 进程。当直接 TypeScript 访问比进程边界更合适时，见 [SDK](sdk.zh-CN.md)。

## 选择模式

| 模式 | 界面 | 生命周期 | 适用场景 |
|---|---|---|---|
| 交互 | 终端 UI | 直到用户退出 | 一个人直接使用 Pi |
| Print | stdout 上的最终文本 | 单次调用 | 脚本只需要最终的助手响应 |
| JSON | stdout 上的 JSONL 事件 | 单次调用 | 进程需要一次运行的结构化进度 |
| RPC | JSONL 命令、响应和事件 | 长期运行 | 进程需要双向控制 |

CLI 选项仍然独立于模式选择工作目录、模型、工具、资源和会话持久化。完整的启动选项见[命令行](cli.zh-CN.md)。

## 输出到 stdout

Print 模式运行提供的提示词，把最终的助手文本写到 stdout，然后退出：

```bash
pi --print "Summarize the changes in this repository"
```

只需要最终文本时使用 print 模式，包括命令替换、管道和一次性任务。中间事件不会暴露。

Print 模式把错误写到 stderr。最终助手响应的停止原因是 `error` 或 `aborted` 时，退出状态非零。在模型输出 token 上限处被截断的响应（`length` 停止原因）仍会把部分文本打印到 stdout，向 stderr 写警告，并以非零状态退出。

未显式选择模式时，非 TTY 的 stdin 或 stdout 也会选择 print 模式。这样管道输入输出无需加 `--print`。

## 流式输出 JSON 事件

JSON 模式先写一个会话头，然后以换行分隔的 JSON 写出 agent 和会话事件：

```bash
pi --mode json "Review this repository" > events.jsonl
```

这是结构化的事件输出，不是单个 JSON 结果，也不约束模型响应的格式。

所有提示词在进程启动时提供。进程为该次运行流式输出事件然后退出；不接受后续命令。

失败或中止的助手响应会出现在事件流中，但本身不会导致非零退出状态。关心成败时请检查事件。调用本身抛出错误时 Pi 仍以非零状态退出。

流式 `message_update` 记录包含增量（delta）而非不断增长的消息快照。从增量事件组装实时输出，然后用 `message_end` 中的权威消息替换。

`agent_end` 之后可能还有自动恢复或排队的工作。`agent_settled` 标志当前运行自动工作的结束。

stdout 保留给 JSONL。诊断和应用程序日志写到 stderr。帧格式、事件结构和重建规则见 [JSON 事件流](json.zh-CN.md)。

## 用 RPC 控制 Pi

RPC 模式让 Pi 保持运行，另一个进程发送命令并接收响应和事件：

```bash
pi --mode rpc --no-session
```

命令是写入 stdin 的 JSON 对象。响应和事件是写入 stdout 的 JSON 对象。每条记录占一行。

需要关联的命令加 `id`。匹配的响应会重复该 ID。事件通常没有命令 ID，因为它们描述的是会话活动而非单个请求。

`prompt` 响应成功只表示提示词被接受、排队或处理，不表示运行完成。关心完成时请继续消费事件直到 `agent_settled`。

RPC 命令可以切换模型、检查状态、管理会话、运行 shell 命令以及应答扩展 UI 请求。

扩展对话框构成一个请求-响应子协议。其他扩展 UI 更新是通知，客户端可以显示或忽略。仅 TUI 的扩展能力在交互模式之外不可用或被降级。

对 Node.js 或 TypeScript 集成，优先使用 `@earendil-works/pi-coding-agent` 的 `RpcClient`。它启动 Pi RPC 子进程、关联请求、暴露带类型的命令方法，并把会话事件投递给监听器。

[RPC 客户端示例](../examples/rpc-client.ts)发送一条提示词、流式接收文本和工具活动、等待 `agent_settled`，然后关闭子进程。它包含在仓库的 TypeScript 检查中。

`RpcClient.promptAndWait()` 在发送提示词之前安装事件监听器，避免与快速完成产生竞态。对于分离的操作，在调用 `prompt()` 之前订阅，并且只在运行进行中时调用 `waitForIdle()`。

客户端需要可运行的 Pi CLI 路径。仓库示例指向 `dist/cli.js`，因此在检出目录中运行该示例前必须先构建包。

如果要在没有 `RpcClient` 的情况下构建客户端，从 [RPC 协议](rpc.zh-CN.md)开始，然后用 [RPC 命令](rpc-commands.zh-CN.md)和 [JSON 事件流](json.zh-CN.md)作为线上协议参考。

## 分叉与重塑 Pi 品牌

源码分叉可以通过 `package.json` 更改 CLI 名称和配置目录：

```json
{
  "piConfig": {
    "name": "my-agent",
    "configDir": ".my-agent"
  }
}
```

修改顶层 `bin` 字段可设置可执行文件名。这些设置影响 CLI 横幅、配置路径和派生的环境变量名。

## 示例与参考

- [RPC 客户端](../examples/rpc-client.ts)：带类型的 Node.js 集成
- [RPC 扩展 UI](../examples/rpc-extension-ui.ts)：带扩展对话框的自定义终端客户端
- [命令行](cli.zh-CN.md)：启动选项与模式选择
- [JSON 事件流](json.zh-CN.md)：JSON 事件参考
- [RPC 协议](rpc.zh-CN.md)：RPC 生命周期、帧格式、错误与关闭
- [RPC 命令](rpc-commands.zh-CN.md)：命令与响应参考
- [RPC 扩展 UI](rpc-extension-ui.zh-CN.md)：扩展交互子协议
- [SDK 示例](../examples/sdk/)：进程内 TypeScript 集成
