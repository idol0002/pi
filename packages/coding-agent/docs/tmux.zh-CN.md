# 在 tmux 中运行 Pi

Pi 可以在 tmux 内工作，但 tmux 可能把 `Shift+Enter`、`Ctrl+Enter` 和普通 `Enter` 报告为同一个键。启用扩展键（extended keys），Pi 才能区分它们。

## 检查 tmux 版本

```bash
tmux -V
```

tmux 3.5 或更新版本，使用下方推荐的 CSI-u 配置。tmux 3.2 到 3.4，使用旧版本配置。

## 在 tmux 3.5 或更新版本中启用扩展键

在 `~/.tmux.conf` 中加入：

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

当终端不能直接提供 Kitty 键盘协议时，Pi 会请求扩展键上报。CSI-u 是经 tmux 转发组合键最可靠的格式。

## 重启 tmux

配置作用于 tmux 服务器。为确保其生效，关闭你的 tmux 会话并启动新的服务器。

如果选择从命令行停止服务器，先保存工作。这条命令会终止该服务器管理的所有会话：

```bash
tmux kill-server
tmux
```

## 验证组合键

在新的 tmux 会话中启动 Pi，检查：

1. `Shift+Enter` 在编辑器中插入换行。
2. `Enter` 提交 prompt。
3. `Alt+Enter` 在 macOS 和 Linux 上排队 follow-up。Windows 和 WSL 默认用 `Ctrl+Q`。

如果这些键仍然表现为普通 `Enter`，确认 tmux 外层的终端能上报组合键。见[配置终端](terminal-setup.zh-CN.md)。

## 使用 tmux 3.2 到 3.4

这些版本支持扩展键但不支持 `extended-keys-format csi-u`。只加：

```tmux
set -g extended-keys on
```

Pi 支持这些版本使用的 xterm `modifyOtherKeys` 格式。重启 tmux 并重复验证步骤。

更老的版本，请升级 tmux或在 tmux 外使用 Pi，不要依赖组合 Enter 快捷键。
