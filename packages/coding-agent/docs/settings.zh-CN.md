# 设置参考

本参考列出用户可配置的设置、其类型、默认值和用途。项目设置覆盖 agent 目录设置。资源列表会合并。文件位置和信任行为见[配置](configuration.zh-CN.md)。

在 `settings.json` 中加 `"$schema": "https://pi.dev/schemas/settings.schema.json"` 可获得编辑器校验和补全。

## 模型与思考

<a id="model-cycling"></a>

| 设置 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `defaultProvider` | string | 自动 | 启动 AI 提供商。 |
| `defaultModel` | string | 自动 | 启动模型 ID。 |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"medium"` | 启动思考级别。 |
| `modelThinkingLevels` | object | 无 | 按精确 `provider/modelId` 的每模型启动思考级别。 |
| `thinkingBudgets` | object | 内置预算 | `minimal`、`low`、`medium` 和 `high` 思考级别的 token 预算。 |
| `enabledModels` | `string[]` | 所有可用模型 | 用于启动选择和模型循环的模型模式。格式与 `--models` 相同。 |
| `hideThinkingBlock` | boolean | `false` | 在转录中隐藏思考块。 |
| `showCacheMissNotices` | boolean | `false` | 显示显著缓存未命中、成功缓存温热、压缩用量和提供商恢复的通知。 |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"streaming"` | 在活动运行期间或（用 `"idle"`）运行之间保持符合条件的提供商提示词缓存温热。仅全局设置。 |

缓存温热只在模型声明了缓存存活时间且 Pi 估算可避免至少 $0.05 缓存未命中成本时运行。刷新用量计入会话总额但不进入模型上下文。`/session` 显示下一次决策；扩展可以用 `cache_warming_decision` 覆盖它。见[提示词缓存存活时间](models.zh-CN.md#prompt-cache-lifetimes)。

模型选择与思考控制见[选择模型](models.zh-CN.md)。

## 交互

| 设置 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `steeringMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | 排队 steering 消息的投递方式。 |
| `followUpMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | 排队 follow-up 消息的投递方式。 |
| `externalEditor` | string | `$VISUAL`、`$EDITOR`，然后平台默认 | 外部编辑器快捷键打开的命令。 |
| `doubleEscapeAction` | `"tree" \| "fork" \| "none"` | `"tree"` | 编辑器为空时双击 Escape 的动作。 |
| `treeFilterMode` | `"default" \| "no-tools" \| "user-only" \| "labeled-only" \| "all"` | `"default"` | `/tree` 使用的初始过滤器。 |
| `defaultProjectTrust` | `"ask" \| "always" \| "never"` | `"ask"` | 回退的项目信任行为。**只能在 agent 目录设置中设置。** |

## 工具

| 设置 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `defaultTools` | `string[]` | `read`、`bash`、`edit`、`write` | 启动时启用的工具。普通名称替换默认值；`+name` 添加工具，`-name` 移除工具。空数组禁用所有内置工具，但不禁用扩展或 SDK 工具。 |
| `codemode.mode` | `"on"` \| `"only"` | `"on"` | `codemode` 工具活跃时如何呈现工具。`on`：已声明工具的描述后附加从脚本调用的说明，`codemode` 只列出未声明的工具。`only`：`codemode` 列出脚本可调用的每个工具，活动的内置和扩展工具对模型隐藏，模型通过 `codemode` 访问它们。 |
| `codemode.inlineBudget` | number | `3000` | `codemode` 工具描述可用于工具声明的估算 token（字符 / 4）。放不下的工具被略去，用 `searchTools()` 找到。`0` 只列出命名空间。 |

可用的内置工具是 `read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find` 和 `ls`。`defaultTools` 也可以点名 `codemode` 和 `tool_search`（内置扩展以不活跃状态注册），以及其他以不活跃状态注册的扩展工具。

仅含 `+name` 和 `-name` 条目的列表改变继承的选择而不是替换它。例如，下面在默认工具旁启用 `codemode`：

```json
{
  "defaultTools": ["+codemode"]
}
```

`["-bash", "+powershell", "+grep"]` 用 `powershell` 替换 `bash` 并启用 `grep`。项目设置叠加在用户设置之上：仅含 `+name` 和 `-name` 条目的项目列表改变用户的选择，含普通名称的项目列表替换它。在单个列表中，普通名称构成选择，然后 `+name` 和 `-name` 按顺序应用。

`/reload` 启用新加入 `defaultTools` 的工具。它不禁用从中移除的工具，也不重新启用你关闭过的未变工具。带普通名称的 `--tools`、`--no-tools` 和 `--no-builtin-tools` 覆盖 `defaultTools`，重载时同样如此。

CLI 工具选项对单次调用覆盖此设置。仅含 `+name` 和 `-name` 条目的 `--tools` 改变解析后的 `defaultTools` 选择，例如 `pi --tools +codemode`。在 `/reload` 时，这些条目也应用于重载后的设置，因此用 `-name` 移除的工具保持移除。见[命令行](cli.zh-CN.md#tools)。

## 会话与上下文

| 设置 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `sessionDir` | string | agent 会话目录 | 会话存储目录。相对路径从工作目录解析。`PI_CODING_AGENT_SESSION_DIR` 和 `--session-dir` 覆盖此设置。 |
| `sessionShareDestination` | `"auto" \| "gist" \| "radius"` | `"auto"` | `/share` 使用的目标。`auto` 在已认证时用 Radius，否则创建 GitHub gist。`gist` 总是用 gist。`radius` 需要 Radius 认证且不回退到 gist。 |

### 压缩

| 设置 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `compaction.enabled` | boolean | `true` | 启用自动压缩。 |
| `compaction.reserveTokens` | number | `16384` | 低于该空闲上下文 token 数时自动压缩启动。 |
| `compaction.keepRecentTokens` | number | `20000` | 不做摘要而保留的近期 token 数。 |
| `compaction.modelOverrides` | object | 无 | 按精确 `provider/modelId` 的每模型 token 设置。 |

<a id="per-model-compaction-overrides"></a>

压缩 token 值必须是非负安全整数。每个值独立解析：先匹配的模型覆盖，然后普通压缩设置，然后内置默认。项目与用户对象在模型查找前合并。

触发、摘要和验证行为见[压缩参考](compaction.zh-CN.md)。

### 分支摘要

| 设置 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `branchSummary.reserveTokens` | number | `16384` | 摘要分支历史时保留的 token 数。 |
| `branchSummary.skipPrompt` | boolean | `false` | 跳过分支摘要询问，默认不摘要。 |

## 终端与显示

| 设置 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `theme` | string | `"system"` | 内置或自定义主题名。`system` 从终端主题派生颜色。 |
| `quietStartup` | boolean \| `"header"` | `false` | `true` 隐藏启动头和已加载资源列表。`"header"` 保留头部（版本和按键提示）但隐藏模型范围行和已加载资源列表。 |
| `tuiMode` | `"regular" \| "fullscreen"` | `"fullscreen"` | 交互终端 UI 模式。 |
| `fullscreenExitOutput` | `"transcript" \| "resume-hint"` | `"transcript"` | 全屏模式退出时打印的输出。 |
| `fullscreenScrollbar` | `"auto" \| "always" \| "hidden"` | `"auto"` | 全屏转录滚动条行为。 |
| `fullscreenCopyOnSelect` | boolean | `true` | 全屏模式下自动复制选中文本。 |
| `fullscreenWheelScrollLines` | `"auto"` \| number | `"auto"` | 全屏模式下每个鼠标滚轮事件的行数，1 到 100。`"auto"` 在本地 macOS 终端（已对滚轮和触控板输入加速）每事件移动一行；其他地方以及通过 SSH 时，把快速滚动加速到每事件最多 6 行。Alt+滚轮移动五倍距离。 |
| `editorPaddingX` | number | `0` | 编辑器水平内边距，0 到 3 格。 |
| `outputPad` | `0 \| 1` | `1` | 消息、工具输出、`!` 命令输出和摘要块的水平转录内边距。 |
| `autocompleteMaxVisible` | number | `5` | 可见的自动补全条目数，3 到 20。 |
| `showHardwareCursor` | boolean | `false` | 使用终端光标而不是 Pi 绘制的光标。Pi 仍为输入法定位它。 |
| `terminal.showImages` | boolean | `true` | 受支持时显示内联图像。 |
| `terminal.imageWidthCells` | number | `60` | 内联图像的首选宽度（终端格数）。 |
| `terminal.clearOnShrink` | boolean | `false` | 渲染内容缩小时清除空行。 |
| `terminal.showTerminalProgress` | boolean | `false` | 在终端标签页显示 OSC 9;4 进度。 |
| `terminal.hyperlinks` | `boolean \| "auto"` | `"auto"` | 覆盖 OSC 8 超链接检测。 |
| `terminal.images` | `"kitty" \| "iterm2" \| "auto" \| false` | `"auto"` | 覆盖内联图像协议检测。 |
| `terminal.trueColor` | `boolean \| "auto"` | `"auto"` | 覆盖真彩色检测。 |
| `images.autoResize` | boolean | `true` | 发送给模型前把图像缩放到至多 2000×2000 像素。 |
| `images.blockImages` | boolean | `false` | 阻止图像发送给模型。 |
| `markdown.codeBlockIndent` | string | `"  "` | 用于缩进渲染代码块的前缀。 |
| `markdown.mermaid` | `"off" \| "final" \| "streaming"` | `"streaming"` | Mermaid 渲染模式。 |

格式与平台细节见[主题](themes.zh-CN.md)和[终端设置](terminal-setup.zh-CN.md)。

## 网络与重试

| 设置 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `transport` | `"auto" \| "sse" \| "websocket" \| "websocket-cached"` | `"auto"` | 支持多种传输的 AI 提供商的首选传输方式。 |
| `httpProxy` | string | 无 | 作为 `HTTP_PROXY` 和 `HTTPS_PROXY` 应用于 Pi 管理的 HTTP 客户端的代理 URL。**只能在 agent 目录设置中设置。** |
| `httpIdleTimeoutMs` | number | `300000` | HTTP 头与正文空闲超时（毫秒）。设为 `0` 禁用。 |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket 连接超时（毫秒）。设为 `0` 禁用。 |
| `retry.enabled` | boolean | `true` | 为瞬态失败启用 agent 级自动重试。 |
| `retry.maxRetries` | number | `3` | agent 级最大重试次数。 |
| `retry.baseDelayMs` | number | `2000` | 初始指数退避延迟（毫秒）。 |
| `retry.maxAgentDelayMs` | number | `60000` | agent 级最大重试延迟（毫秒）。 |
| `retry.provider.timeoutMs` | number | `httpIdleTimeoutMs` | 提供商请求超时（毫秒）。 |
| `retry.provider.maxRetries` | number | `0` | 提供商级重试次数。 |
| `retry.provider.maxRetryDelayMs` | number | `60000` | 服务器请求的最大延迟（毫秒）。设为 `0` 禁用该限制。 |

除非需要提供商级重试，否则保持 `retry.provider.maxRetries` 为 `0`。提供商重试会延迟 Pi 自行处理配额和用量限制错误。

## Shell

| 设置 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `shellPath` | string | 平台默认 | 自定义 shell 可执行文件路径。支持前导 `~`。 |
| `shellCommandPrefix` | string | 无 | 前置到每个 shell 命令的前缀。 |
| `npmCommand` | `string[]` | `npm` | 用于 npm 包查找和安装的命令与参数。 |

shell 配置见 [Shell 别名](shell-aliases.zh-CN.md)，包管理器行为见 [Pi 包](packages.zh-CN.md)。

## 资源

用户设置中的资源路径相对 agent 目录解析。项目设置中的路径相对项目 `.pi` 目录解析。支持绝对路径和 `~`。

| 设置 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `packages` | array | `[]` | npm、git 或本地 Pi 包来源。见 [Pi 包](packages.zh-CN.md)。 |
| `extensions` | `string[]` | `[]` | 扩展文件或目录。 |
| `skills` | `string[]` | `[]` | 技能文件或目录。 |
| `prompts` | `string[]` | `[]` | 提示词模板文件或目录。 |
| `themes` | `string[]` | `[]` | 主题文件或目录。 |
| `enableSkillCommands` | boolean | `true` | 把技能注册为 `/skill:name` 命令。 |

资源数组支持用 `!pattern` 做 glob 排除、`+path` 精确包含、`-path` 精确排除。Pi 加载同时列在用户级和项目设置中的资源。

内置扩展在 `extensions` 中名为 `builtin:mcp`、`builtin:llama.cpp`、`builtin:codemode` 和 `builtin:tool-search`。它们默认加载；`-builtin:mcp` 禁用一个。项目设置中的 `+builtin:<name>` 或 `-builtin:<name>` 条目覆盖用户设置。`pi config` 在 Built-in 下列出它们。`--no-extensions` 也禁用它们，`-e builtin:<name>` 显式加载一个。

## 更新、遥测与警告

| 设置 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `collapseChangelog` | boolean | `false` | 更新后显示精简的更新日志。 |
| `enableInstallTelemetry` | boolean | `true` | 启用匿名安装/更新报告和选定的提供商归属头。不控制更新检查。 |
| `enableAnalytics` | boolean | `false` | 选择加入分析数据共享。目前仅由实验性的首次运行设置使用。 |
| `warnings.anthropicExtraUsage` | boolean | `true` | 当 Anthropic 订阅认证可能使用付费额外用量时警告。 |
