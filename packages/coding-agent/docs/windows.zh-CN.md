# 在 Windows 上运行 Pi

Pi 可以作为原生 Windows 进程运行，也可以在 Windows Subsystem for Linux（WSL）内运行。原生 Windows 默认用 Git Bash 执行 Bash 命令，并可选地把 PowerShell 暴露给模型。WSL 中的 Pi 使用 Linux 环境及其 Bash 安装。

安装和认证 Pi 跟随主[快速开始](quickstart.zh-CN.md)。本页用于选择和配置命令环境。

## 选择原生 Windows 还是 WSL

| 环境 | 命令环境 | 适用场景 |
|---|---|---|
| 原生 Windows + Git Bash | 内置 `bash` 工具和 `!` 命令使用 Git Bash | 文件和开发工具主要在 Windows 上 |
| 原生 Windows + `powershell` 工具 | 模型工具调用使用 PowerShell；`!` 命令仍可用 Bash | 任务依赖 PowerShell 模块或 Windows 原生命令 |
| WSL | 所选 WSL 发行版内的 Linux Bash 和工具 | 文件和工具链已经在 Linux 或 WSL 中 |

## 在原生 Windows 上使用 Git Bash

对大多数原生 Windows 用户，安装 [Git for Windows](https://git-scm.com/download/win) 就够了。

Pi 按以下顺序解析 Bash：

1. `~/.pi/agent/settings.json` 中的 `shellPath`
2. `Program Files` 或 `Program Files (x86)` 下的 Git Bash
3. `PATH` 上的 `bash.exe`，包括 Cygwin、MSYS2 或旧版 WSL Bash

启动 Pi 并输入这条命令验证 shell：

```text
!printf 'Bash is working\n'
```

Pi 找不到 Bash 时，会报告它检查过的位置。安装 Git for Windows、把其他 Bash 可执行文件加入 `PATH`，或配置 `shellPath`。

## 让模型使用 PowerShell

可选的 `powershell` 工具优先通过 `pwsh.exe` 运行命令，可用时回退到 Windows PowerShell。它以 `-NoProfile -NonInteractive -ExecutionPolicy Bypass` 启动 PowerShell。管理员强制执行的策略仍可能优先。

要把面向模型的 `bash` 工具替换为 `powershell`，在 `~/.pi/agent/settings.json` 中加入：

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

`["-bash", "+powershell"]` 效果相同，且保留你配置的其他默认工具。

重启 Pi，然后让它运行一条无害的 PowerShell 命令。`!` 和 `!!` 编辑器命令继续使用 Bash。`powershell` 工具只在 Pi 以原生 Windows 进程运行时可用。

其他工具组合见[设置](settings.zh-CN.md#tools)。

## 使用自定义 Bash 可执行文件

Bash 安装在 Pi 无法自动发现的位置时，设置 `shellPath`：

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

JSON 中反斜杠是转义字符。写含反斜杠的 Windows 路径时，每个反斜杠写两次，如上所示。

命令前缀、别名和完整的 shell 解析行为见[配置 shell 命令](shell-aliases.zh-CN.md)。

## 配置 Windows Terminal

Windows Terminal 会保留或重写一些组合键。配置 `Shift+Enter` 和 `Alt+Enter` 见 [Windows Terminal](terminal-setup.zh-CN.md#windows-terminal)，Pi 在 Windows 和 WSL 上的快捷键默认值见[按键绑定](keybindings.zh-CN.md)。
