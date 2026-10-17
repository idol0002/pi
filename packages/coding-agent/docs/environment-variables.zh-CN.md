# 环境变量

Pi 以三种方式使用环境变量：

- `PI_OFFLINE` 之类的变量配置 Pi 进程。
- Pi 设置进程标记，让子进程能识别 Pi 是启动它的 agent。
- LLM 可调用的 shell 工具运行的命令会收到描述当前会话的 `PI_*` 变量。

提供商 API key 变量单独记录在[提供商](providers.zh-CN.md#use-an-api-key-from-the-environment)中。

## 进程标记

CLI 和 RPC 入口设置两个进程标记：

- `AI_AGENT=pi` 是通用标记，让工具链识别 Pi 是启动该进程的 agent。
- `PI_CODING_AGENT=true` 是 Pi 专属标记，让子进程检测到自己运行在 Pi 内。

子进程继承这两个标记。它们不是会话专属的，通过 SDK 嵌入 Pi 时也不会自动设置。

## Shell 工具会话环境

`bash` 和 `powershell` 工具运行的命令会收到当前 Pi 会话状态：

| 变量 | 说明 |
|----------|-------------|
| `PI_SESSION_ID` | 当前会话 ID |
| `PI_SESSION_FILE` | 当前会话 JSONL 文件的绝对路径；临时会话未设置 |
| `PI_PROVIDER` | 当前选中的模型提供商 |
| `PI_MODEL` | 当前选中的模型 ID |
| `PI_REASONING_LEVEL` | 当前生效的推理级别：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |

这些值在每条命令启动时解析。因此切换模型或更改推理级别会影响下一条 shell 命令，无需重启 Pi。`PI_PROVIDER` 和 `PI_MODEL` 标识选中的 Pi 模型，而不是路由器内部可能选择的其他上游模型。

被问到当前运行的是哪个模型或提供商时，检查这些变量，而不是从系统提示词推断答案：

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
```

会话为持久化时，可以直接检查会话文件：

```bash
if [ -n "$PI_SESSION_FILE" ]; then
  tail -n 1 "$PI_SESSION_FILE"
fi
```

这些变量注入到 LLM 可调用的 `bash` 和 `powershell` 工具中。它们不会注入到用户输入的 `!` 或 `!!` 命令。

### 自定义 Shell 工具

用 `createBashTool()` 或 `createPowerShellTool()` 创建、并注册到 Pi 的工具默认暴露会话环境。注入发生在 `spawnHook` 之前，因此钩子在 `ctx.env` 中收到这些变量：

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

独立于 spawn 钩子禁用会话元数据：

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

禁用时，Pi 会移除这些变量的继承值，避免嵌套的 Pi 进程暴露过期的父会话元数据。

## Pi 进程配置

这些变量由 Pi 自身读取：

| 变量 | 说明 |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | 覆盖配置目录；默认为 `~/.pi/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖会话存储；`--session-dir` 又可覆盖它 |
| `PI_PACKAGE_DIR` | 覆盖包目录，用于 Nix/Guix store 路径 |
| `PI_OFFLINE` | 禁用自动网络活动，包括模型目录刷新 |
| `PI_SKIP_VERSION_CHECK` | 禁用 `pi.dev` 最新版本请求 |
| `PI_TELEMETRY` | 覆盖安装/更新遥测和提供商归因头：`1`/`true`/`yes` 或 `0`/`false`/`no` |
| `PI_CACHE_RETENTION` | 设为 `long` 以在受支持时使用扩展的提供商提示词缓存 |
| `PI_SHARE_VIEWER_URL` | 覆盖 `/share` 使用的基 URL |
| `PI_RADIUS_GATEWAY` | 覆盖 `/bug` 上传使用的 Radius 网关 origin |
| `PI_HARDWARE_CURSOR` | 设为 `1` 显示硬件光标；见[终端设置](terminal-setup.zh-CN.md) |
| `PI_CLIPBOARD_OSC52` | 设为 `1` 在本地剪贴板写入之后，像 Pi 在 SSH 下那样用 OSC 52 把复制的文本发给终端。当远程客户端在没有 SSH 变量的情况下访问 Pi 时使用，例如从另一台机器连接的多路复用器或远程 IDE 守护进程 |
| `PI_HYPERLINKS` | 用 `1`、`0` 或 `auto` 覆盖 OSC 8 超链接检测 |
| `PI_PROGRAM_STATUS` | 覆盖 OSC 7501 程序状态检测：`1` 总是上报，`0` 从不上报；否则 Pi 只在终端确认支持后上报。见[终端设置](terminal-setup.zh-CN.md#program-status) |
| `PI_IMAGE_PROTOCOL` | 用 `kitty`、`iterm2`、`none` 或 `auto` 覆盖内联图片检测 |
| `PI_TRUE_COLOR` | 用 `1`、`0` 或 `auto` 覆盖真彩色检测 |
| `PI_TUI_ESC_TIMEOUT` | 单独的 ESC 之后等待多久才判定为 Escape 键，单位毫秒；SSH 下默认 `100`，其他默认 `10`。Alt 键输入被误读为 Escape 时调大 |
| `VISUAL`、`EDITOR` | `externalEditor` 未设置时的外部编辑器回退 |
| `HTTP_PROXY`、`HTTPS_PROXY` | 代理出站 HTTP 请求 |

`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等提供商凭据和提供商专属配置见[提供商](providers.zh-CN.md#use-an-api-key-from-the-environment)。
