# 配置你的终端

大多数现代终端无需额外设置即可配合 Pi 工作。当修饰键、滚动、链接、图像、颜色或输入法编辑器（IME）定位不符合预期时，使用本页。

Pi 使用扩展键协议，让终端能把 `Shift+Enter` 和 `Alt+Enter` 这类组合与普通 `Enter` 区分开。终端代理、复用器和 IDE 内置终端可能更改或丢弃这些信息。

## 排障

| 症状 | 从这里开始 |
|---|---|
| `Shift+Enter` 提交而不是插入新行 | 下面对应你终端的章节；tmux 见[在 tmux 中运行 Pi](tmux.zh-CN.md) |
| `Alt+Enter` 不能排队 follow-up | [WezTerm](#wezterm)、[Alacritty](#alacritty) 或 [Windows Terminal](#windows-terminal) |
| 全屏滚动异常缓慢 | [iTerm2](#iterm2) |
| 链接可用但没有悬停预览 | [Ghostty](#ghostty) |
| 内联图像或颜色未被检测到 | [覆盖检测到的能力](#override-detected-capabilities) |
| IME 候选窗口出现在错误位置 | [WezTerm](#wezterm) 或 [IntelliJ IDEA](#intellij-idea-integrated-terminal) |
| 修饰键只在 tmux 中失效 | [在 tmux 中运行 Pi](tmux.zh-CN.md) |

用 `/hotkeys` 查看 Pi 当前生效的快捷键。更改快捷键见[快捷键](keybindings.zh-CN.md)。

## Kitty

Kitty 无需额外配置即支持所需的键盘协议。

## iTerm2

常规终端模式无需额外配置即可工作。

### 修复缓慢的全屏滚动

全屏模式下，Pi 拥有视口，因此 iTerm2 发送鼠标滚轮报告而不是滚动原生终端历史。快速触控板手势因此每次只能移动约一行。

要改变该行为：

1. 打开 **iTerm2 > Settings > Advanced**。
2. 搜索 **Trackpad scrolls fast?**。
3. 设为 **No**。

这是 iTerm2 全局设置，也可能改变原生触控板滚动。底层行为记录在 [iTerm2 issue 9619](https://gitlab.com/gnachman/iterm2/-/work_items/9619)。

## Apple Terminal

Pi 在可用时启用增强按键报告。如果 Terminal.app 仍对 `Shift+Enter` 发送普通 Return，Pi 使用本地 macOS 修饰键回退并把它视为 `Shift+Enter`。

该回退只在 Pi 与 Terminal.app 运行在同一台 Mac 上时有效。Pi 通过 SSH 运行在另一台机器上时，无法检查本地修饰键状态。

## Ghostty

如果 `Alt+Backspace` 不生效，把此映射加入 Ghostty 配置：

```text
keybind = alt+backspace=text:\x1b\x7f
```

配置文件在 macOS 上是 `~/Library/Application Support/com.mitchellh.ghostty/config`，在 Linux 上是 `~/.config/ghostty/config`。

较旧的 Claude Code 配置可能包含：

```text
keybind = shift+enter=text:\n
```

它发送原始换行符，Pi 无法把它与 `Ctrl+J` 区分。如果添加该映射只是因为旧版 Claude Code，请移除它。Pi 已把 `Ctrl+J` 绑定为换行的替代键，所以该映射看似有效，却仍阻止 Pi 和 tmux 收到真正的 `Shift+Enter` 事件。

### 在全屏模式打开链接

链接在全屏模式仍可点击，但当 Pi 捕获鼠标输入时，Ghostty 不显示其正常的悬停下划线或 URL 预览。按住 macOS 上的 `Shift+Command` 或 Linux 上的 `Shift+Ctrl` 可使用 Ghostty 的原生链接处理。

## WezTerm

WezTerm 通常通过 xterm 扩展键报告 `Shift+Enter`。要显式启用 Kitty 键盘协议，创建 `~/.wezterm.lua`：

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

### 在 macOS 上转发 Alt+Enter

在 macOS 上，WezTerm 默认把 `Option+Enter` 绑定为全屏。要把它用于 Pi 的 follow-up 队列，把此条目加入你的 `config.keys` 表：

```lua
{
  key = 'Enter',
  mods = 'ALT',
  action = wezterm.action.SendString('\x1b[13;3u'),
}
```

完整的最小配置：

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.keys = {
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}
return config
```

### 在 WSL 中定位 IME 候选窗口

如果 WSL 中 CJK IME 候选不跟随 Pi 的文本光标，显示硬件光标：

```bash
export PI_HARDWARE_CURSOR=1
pi
```

也可以在 Pi 设置中把 `showHardwareCursor` 设为 `true`。

## Alacritty

Alacritty 通常能报告 `Shift+Enter`。在 macOS 上，`Option+Enter` 可能以普通 `Enter` 到达。把下面内容加入 `~/.config/alacritty/alacritty.toml` 以转发给 Pi：

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

修改文件后重启 Alacritty。

## VS Code 集成终端

VS Code 1.109.5 及更新版本默认在集成终端启用 Kitty 键盘协议。

对较旧版本，在 `keybindings.json` 中添加 `Shift+Enter` 终端绑定：

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

用户 `keybindings.json` 通常位于：

- macOS：`~/Library/Application Support/Code/User/keybindings.json`
- Linux：`~/.config/Code/User/keybindings.json`
- Windows：`%APPDATA%\\Code\\User\\keybindings.json`

## Zed 集成终端

把以下绑定加入 Zed 的 `keymap.json`：

```json
{
  "context": "Terminal",
  "bindings": {
    "shift-enter": ["terminal::SendText", "\u001b[13;2u"],
    "ctrl--": ["terminal::SendText", "\u001b[45;5u"],
    "ctrl-alt-]": ["terminal::SendText", "\u001b[93;7u"]
  }
}
```

## Windows Terminal

Windows Terminal 使用 Pi 的 Windows 和 WSL 快捷键默认值。完整列表见[快捷键](keybindings.zh-CN.md)。

### 转发 Shift+Enter

用 `Ctrl+Shift+,` 或 **Settings > Open JSON file** 打开 Windows Terminal 的 `settings.json`。把此对象加入其 `actions` 数组：

```json
{
  "command": { "action": "sendInput", "input": "\u001b[13;2u" },
  "keys": "shift+enter"
}
```

完全关闭并重新打开 Windows Terminal，然后验证 `Shift+Enter` 在 Pi 中插入新行。

### 用 Alt+Enter 做 follow-up

Windows Terminal 默认把 `Alt+Enter` 绑定为全屏。因此 Pi 在 Windows 和 WSL 上用 `Ctrl+Q` 做 follow-up。

要改用 `Alt+Enter`，配置 Windows Terminal 转发该键，并在 Pi 的 `keybindings.json` 中把 `app.message.followUp` 绑定为 `alt+enter`。见[快捷键](keybindings.zh-CN.md#assign-keybindings)。

## xfce4-terminal 与 Terminator

这些终端无法可靠区分修饰的 Enter 键与普通 `Enter`。因此 `Ctrl+Enter` 或 `Shift+Enter` 这类自定义绑定可能不生效。

需要这些快捷键时，使用支持现代扩展键的终端，如 Kitty、Ghostty、WezTerm、iTerm2、Windows Terminal 或兼容的 Alacritty 构建。

## IntelliJ IDEA 集成终端

IntelliJ IDEA 内置终端无法可靠区分 `Shift+Enter` 与普通 `Enter`。用 `Ctrl+J` 换行，或在支持现代扩展键的终端中运行 Pi。

如果 IME 候选窗口不跟随文本光标，显示硬件光标：

```bash
export PI_HARDWARE_CURSOR=1
pi
```

## 覆盖检测到的能力

Pi 自动检测 OSC 8 超链接、内联图像协议和真彩色支持。终端代理或复用器可能使检测不准确。

| 能力 | 环境变量 | 设置 |
|---|---|---|
| 超链接 | `PI_HYPERLINKS=1\|0\|auto` | `terminal.hyperlinks: true\|false\|"auto"` |
| 内联图像 | `PI_IMAGE_PROTOCOL=kitty\|iterm2\|none\|auto` | `terminal.images: "kitty"\|"iterm2"\|false\|"auto"` |
| 真彩色 | `PI_TRUE_COLOR=1\|0\|auto` | `terminal.trueColor: true\|false\|"auto"` |

设置优先于环境变量。未设置或 `auto` 保留自动检测。

只强制完整终端路径支持的能力。不受支持的转义序列可能破坏渲染。权威值定义见[环境变量](environment-variables.zh-CN.md#pi-process-configuration)和[设置](settings.zh-CN.md)。

## 程序状态

Pi 用[程序状态协议（OSC 7501）](https://www.superlogical.com/rex/docs/build/program-status)报告其状态，终端和 agent 仪表盘因此可以显示它是在工作、等待你、完成还是失败：

| 状态 | 时机 |
|---|---|
| `working` | agent 运行或压缩进行中。消息是会话名。 |
| `blocked` | 扩展对话框或登录在等待你。消息是对话框标题。 |
| `done` | 一次运行完成。消息是会话名。 |
| `error` | 一次运行以不重试的错误结束。消息是错误的第一行。 |
| `idle` | Pi 启动，或你取消了运行。 |

报告绝不包含提示词或模型输出。Pi 只在终端应答协议的支持查询后才发送；tmux 和 screen 不转发它们。设置 `PI_PROGRAM_STATUS=1` 可以不询问直接发送，`PI_PROGRAM_STATUS=0` 关闭。
