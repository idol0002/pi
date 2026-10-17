# RPC 模式

RPC 模式把 Pi 作为长期运行的子进程，通过 stdin 和 stdout 上的 JSON 记录控制。适用于语言无关的集成、进程隔离、IDE 和自定义用户界面。

进程内的 Node.js 或 Bun 集成优先用 [SDK](sdk.zh-CN.md)。基于子进程的 TypeScript 集成优先用导出的 `RpcClient`：它启动 Pi、关联响应、暴露类型化的命令方法，并把事件投递给监听器。

| 界面 | 进程边界 | 控制模型 | 最适合 |
|---|---|---|---|
| [SDK](sdk.zh-CN.md) | 进程内 | 直接的 TypeScript 方法和事件 | 想要完整 API 访问的 Node.js 或 Bun 宿主 |
| RPC | 子进程 | JSONL 命令、响应和事件 | 其他语言、隔离进程、IDE 或自定义客户端 |

## 启动 RPC 模式

```bash
pi --mode rpc --no-session
```

常规 CLI 选项仍然选择工作文件夹、模型、工具、资源和会话行为。常见选择包括 `--provider`、`--model`、`--name`、`--no-session` 和 `--session-dir`。完整且随版本变化的接口见[命令行](cli.zh-CN.md)；`pi --help` 对已安装版本是权威的。

RPC 模式拒绝 `@file` prompt 参数。请改用 [`prompt`](rpc-commands.zh-CN.md#prompt) 命令发送 prompt。

## 协议记录

协议有四个记录族：

| 方向 | 记录 | 用途 |
|---|---|---|
| stdin | 命令 | 让 Pi 提问、检查状态、更改配置或管理会话 |
| stdout | `response` | 报告一条命令是否成功，并返回命令数据 |
| stdout | 会话事件 | 流式输出运行、消息、工具、队列、压缩和重试活动 |
| 双向 | 扩展 UI 记录 | 在 Pi 与客户端之间转发受支持的扩展交互 |

权威的记录定义见 [RPC 命令](rpc-commands.zh-CN.md)、[JSON 事件流](json.zh-CN.md)和 [RPC 扩展 UI](rpc-extension-ui.zh-CN.md)。

### 关联命令与响应

每条命令接受可选的字符串 `id`。匹配的响应会重复它：

```json
{"id":"req-1","type":"get_state"}
{"id":"req-1","type":"response","command":"get_state","success":true,"data":{"...":"..."}}
```

可能有多条命令同时未完成时，使用唯一 ID。命令处理是异步的，客户端应按 ID 关联而不是按响应顺序。

会话事件通常没有命令 ID，因为它们描述的是会话活动。`bash_execution_update` 是例外：发起它的 [`bash`](rpc-commands.zh-CN.md#bash) 命令有 ID 时，其输出事件会重复该 ID。

`extension_ui_response` 使用其 `extension_ui_request` 提供的 ID。它不产生普通的命令响应。

## 分帧

RPC 使用严格的 JSONL 分帧。每条记录写一个完整的 JSON 对象，以 LF（`\n`）结尾。把 stdout 当作字节或 UTF-8 流读取，只在 LF 处分割记录。剥离可选的前导回车符以接受 CRLF 输入。

不要使用把 Unicode 行分隔符或段落分隔符也当作记录边界的通用行读取器。特别是 Node.js 的 `readline` 还会按 `U+2028` 和 `U+2029` 分割，而它们在 JSON 字符串内是合法的。

持续读取 stdout。Pi 遵循 stdout 背压，但停止读取的客户端可能让进程停滞。写命令时遵循 stdin 背压。stdout 保留给协议记录；诊断和应用日志走 stderr。

## 运行生命周期

`prompt` 响应成功只表示 prompt 被接受、排队或处理，不表示模型工作已完成：

```json
{"id":"req-2","type":"prompt","message":"Review this repository"}
{"id":"req-2","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
```

`data.disposition` 报告 prompt 的去向。值为 `"handled"` 时，该 prompt 没有启动运行，因此不要等 `agent_settled`。所有取值见 [RPC 命令](rpc-commands.zh-CN.md#prompt)。

在该响应之后继续消费[事件](json.zh-CN.md)。`agent_end` 标记一次底层 agent 运行的结束，但重试、溢出恢复、压缩、steering 或 follow-up 工作仍可能随后发生。客户端需要知道 Pi 不会自动继续时，等待 `agent_settled`。

发送 prompt 之前先订阅，避免错过快速完成。`RpcClient.promptAndWait()` 内部就是这样做的。使用分开的 `RpcClient` 调用时，在 `prompt()` 之前安装事件监听器，并且只在运行活动期间调用 `waitForIdle()`。

## 错误

失败的命令返回一条 `success: false` 的响应：

```json
{"id":"req-3","type":"response","command":"set_model","success":false,"error":"Model not found: invalid/model"}
```

格式错误的 JSON 产生一条没有请求 ID 的 parse 响应：

```json
{"type":"response","command":"parse","success":false,"error":"Failed to parse command: Unexpected token..."}
```

成功响应只覆盖命令处理。prompt 被接受之后的提供商失败和中止出现在消息和事件流中。

客户端还必须处理子进程启动失败、意外退出、stderr 诊断、取消和自己的截止时间。不要把 stderr 当作协议数据解析。

## 关闭

关闭子进程的 stdin 即请求有序关闭。Pi 会在退出前销毁活动运行时。客户端仍应处理进程信号和意外退出。

扩展也可以通过其扩展上下文请求关闭。Pi 在当前命令完成后、或活动运行发出 `agent_settled` 后完成关闭。

## 最小客户端

这个 Python 示例使用二进制管道读取器，按 LF 分割且不把 Unicode 分隔符当作协议边界：

```python
import json
import subprocess

process = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
)

assert process.stdin is not None
assert process.stdout is not None

command = {"id": "prompt-1", "type": "prompt", "message": "Hello"}
process.stdin.write(json.dumps(command).encode("utf-8") + b"\n")
process.stdin.flush()

while line := process.stdout.readline():
    record = json.loads(line)
    if record.get("type") == "message_update":
        update = record["assistantMessageEvent"]
        if update["type"] == "text_delta":
            print(update["delta"], end="", flush=True)
    elif record.get("type") == "agent_settled":
        print()
        break

process.stdin.close()
process.wait()
```

维护中的 TypeScript 客户端，使用受检查的 [RPC 客户端示例](../examples/rpc-client.ts)。它需要已构建的 Pi CLI，因为仓库示例指向 `dist/cli.js`。

## 参考

- [RPC 命令](rpc-commands.zh-CN.md)：每条 stdin 命令和响应
- [JSON 事件流](json.zh-CN.md)：共享的 stdout 会话事件与流式重建
- [RPC 扩展 UI](rpc-extension-ui.zh-CN.md)：对话框、通知、响应和限制
- [消息类型](message-types.zh-CN.md)：响应和事件使用的消息与内容块
- [会话文件格式](session-format.zh-CN.md)：会话命令返回的条目
- [`rpc-types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts)：导出的 TypeScript 协议定义
- [`RpcClient`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-client.ts)：子进程客户端实现

## 迁移的参考锚点

本页原有的详细参考现在有独立页面。这些锚点保留既有链接。

<a id="prompt"></a>
<a id="steer"></a>
<a id="follow_up"></a>
<a id="abort"></a>
<a id="clear_queue"></a>
<a id="new_session"></a>
<a id="get_state"></a>
<a id="get_messages"></a>
<a id="set_model"></a>
<a id="cycle_model"></a>
<a id="get_available_models"></a>
<a id="set_thinking_level"></a>
<a id="cycle_thinking_level"></a>
<a id="get_available_thinking_levels"></a>
<a id="set_steering_mode"></a>
<a id="set_follow_up_mode"></a>
<a id="compact"></a>
<a id="set_auto_compaction"></a>
<a id="set_auto_retry"></a>
<a id="abort_retry"></a>
<a id="bash"></a>
<a id="abort_bash"></a>
<a id="get_session_stats"></a>
<a id="export_html"></a>
<a id="switch_session"></a>
<a id="fork"></a>
<a id="clone"></a>
<a id="get_fork_messages"></a>
<a id="get_entries"></a>
<a id="get_tree"></a>
<a id="get_last_assistant_text"></a>
<a id="set_session_name"></a>
<a id="get_commands"></a>

命令细节已移至 [RPC 命令](rpc-commands.zh-CN.md)。

<a id="message_update-streaming"></a>
<a id="bash_execution_update"></a>
<a id="compaction_start--compaction_end"></a>
<a id="summarization_retry_scheduled--summarization_retry_attempt_start--summarization_retry_finished"></a>

事件细节已移至 [JSON 事件流](json.zh-CN.md)。

<a id="extension-ui-protocol"></a>

扩展交互细节已移至 [RPC 扩展 UI](rpc-extension-ui.zh-CN.md)。
