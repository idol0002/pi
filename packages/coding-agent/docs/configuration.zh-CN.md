# 配置

Pi 支持用户级和项目级配置。用户级配置位于 agent 目录，默认为 `~/.pi/agent`。项目配置位于工作目录下的 `.pi`，在授予[项目信任](security.zh-CN.md#understand-project-trust)之后加载。唯一的例外是 `sessionDir`，Pi 在解析信任之前就读取它，以便定位会话。

交互模式中，用 `/settings` 修改常用偏好。其他选项可以让 Pi 更新配置，或直接编辑相关文件。手动修改设置、按键绑定、指令或资源后，运行 `/reload`。

## Agent 目录

下文把 agent 目录记作 `<agent-dir>`。用 `PI_CODING_AGENT_DIR` 环境变量或 SDK 的 [`agentDir`](sdk.zh-CN.md) 选项设置其位置。

| 路径 | 职责 |
|---|---|
| `<agent-dir>/settings.json` | 用户级[设置](settings.zh-CN.md)，包括偏好、默认值、资源路径和 Pi 包声明。 |
| `<agent-dir>/keybindings.json` | 自定义终端 UI 和应用[按键绑定](keybindings.zh-CN.md)。 |
| `<agent-dir>/mcp.json` | 每个项目都可用的 [MCP 服务器](mcp.zh-CN.md)。 |
| `<agent-dir>/models.json` | [兼容端点、模型和模型覆盖](models.zh-CN.md#configure-a-compatible-endpoint)。 |
| `<agent-dir>/auth.json` | 保存的 API key 和 OAuth 凭据。 |
| `<agent-dir>/AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md` 或 `CLAUDE.MD` | 跨工作目录生效的用户指令。 |
| `<agent-dir>/SYSTEM.md` | 替换 Pi 的默认系统提示词。 |
| `<agent-dir>/APPEND_SYSTEM.md` | 向 Pi 的系统提示词追加指令。 |
| `<agent-dir>/extensions/` | 用户[扩展](extensions.zh-CN.md)。 |
| `<agent-dir>/skills/` | 用户[技能](skills.zh-CN.md)及配套文件。 |
| `<agent-dir>/prompts/` | 作为斜杠命令暴露的用户[提示词模板](prompt-templates.zh-CN.md)。 |
| `<agent-dir>/themes/` | 用户[主题](themes.zh-CN.md)文件。 |

## 项目 `.pi` 目录

| 路径 | 职责 |
|---|---|
| `.pi/settings.json` | 项目级[设置](settings.zh-CN.md)、资源路径和 Pi 包声明。 |
| `.pi/mcp.json` | 项目 [MCP 服务器](mcp.zh-CN.md)。 |
| `.pi/SYSTEM.md` | 替换该项目的系统提示词。 |
| `.pi/APPEND_SYSTEM.md` | 向系统提示词追加项目专属指令。 |
| `.pi/extensions/` | 项目扩展。 |
| `.pi/skills/` | 项目技能及配套文件。 |
| `.pi/prompts/` | 作为斜杠命令暴露的项目提示词模板。 |
| `.pi/themes/` | 项目主题文件。 |

对于 `SYSTEM.md` 和 `APPEND_SYSTEM.md`，受信任的项目文件优先于 agent 目录中的对应文件。同名文件不会合并。

## 上下文文件

上下文文件独立于项目 `.pi` 配置。Pi 从 agent 目录、工作目录及其父目录加载它们。只要 Pi 在其目录或其下层运行，上下文文件就生效。

`AGENTS.override.md` 只在同一目录中替代 `AGENTS.md` 或 `CLAUDE.md`。它不会屏蔽来自 agent 目录或其他目录的上下文文件。

上下文文件的发现不需要项目信任。
