# 配置 shell 命令

Pi 为每条 Bash 命令启动一个独立的非交互 shell 进程。非交互 Bash 默认不展开别名，通常也不会加载与交互终端相同的启动文件。

用 `shellPath` 选择 Bash 可执行文件，用 `shellCommandPrefix` 在每条命令前运行设置。

## 理解 Pi 使用哪个 shell

| 命令来源 | Shell |
|---|---|
| 模型调用内置 `bash` 工具 | Pi 解析出的 Bash 可执行文件 |
| 你输入 `!command` 或 `!!command` | 同一个解析出的 Bash 可执行文件 |
| 模型调用可选的 `powershell` 工具 | PowerShell 7（`pwsh.exe`）或 Windows PowerShell |
| 扩展提供或替换 shell 工具 | 该扩展实现的操作 |

Pi 通常以 `bash -c` 调用 Bash。在 Unix 系统上，它依次尝试 `/bin/bash`、`PATH` 上的 `bash`，Bash 不可用时最后用 `sh`。原生 Windows 先检查配置的路径，然后 Git Bash，再 `PATH` 上的 `bash.exe`。

## 选择 Bash 可执行文件

需要 Pi 使用特定可执行文件时，在 `~/.pi/agent/settings.json` 中设置 `shellPath`：

```json
{
  "shellPath": "~/.local/bin/bash"
}
```

Windows 上使用正斜杠或转义反斜杠：

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

修改设置后运行 `/reload`。原生 Windows 的默认行为见[在 Windows 上运行 Pi](windows.zh-CN.md)。

## 在每条 Bash 命令前运行设置

设置 `shellCommandPrefix` 可以把 shell 设置前置于内置 `bash` 工具和用户输入的 `!` 或 `!!` 命令：

```json
{
  "shellCommandPrefix": "export CI=1"
}
```

Pi 用换行连接前缀和请求的命令。每条命令都会重新运行前缀，所以保持它快速且无交互提示。

## 启用 Bash 别名

把 Pi 需要的别名存放在一个 Bash 兼容的文件里，而不是解析整个交互 shell 配置。

创建 `~/.bash_aliases`：

```bash
alias ll='ls -la'
alias gs='git status --short'
```

然后配置 Pi 启用别名展开并加载该文件：

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\nsource ~/.bash_aliases"
}
```

运行 `/reload`，然后通过 Pi 验证别名：

```text
!ll
```

该命令应产生与 `ls -la` 相同的列表。

别名必须使用 Bash 兼容语法。不要把任意 `.zshrc` source 进 Bash，因为 zsh 的选项、函数和插件在 Bash 中可能无法解析或行为不正确。

## 故障排查

### 前缀对 `!` 生效但对扩展工具不生效

`shellCommandPrefix` 配置的是 Pi 内置的 Bash 执行。替换 `bash` 工具或提供自己 shell 操作的扩展控制自己的设置。查看该扩展的文档。

### 找不到 `shopt`

Pi 回退到了 `sh`，或 `shellPath` 指向非 Bash shell。安装 Bash，或把 `shellPath` 设为 Bash 可执行文件，再使用 `shopt` 这类 Bash 专属设置。

### 某条设置命令等待输入

从 `shellCommandPrefix` 中移除交互式命令。前缀在每条 Bash 命令之前的非交互进程中运行。

完整的设置定义见 [Shell 设置](settings.zh-CN.md#shell)。
