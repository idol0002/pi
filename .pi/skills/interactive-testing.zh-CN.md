---
name: interactive-testing
description: 在受控的 tmux 终端中测试和调试 pi 的交互模式。用于 TUI 行为检查和交互式发布冒烟测试。
---

# 用 tmux 测试 pi 交互模式

在受控终端中运行 TUI（从仓库根目录执行，即本技能上两级目录）：

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # 启动后捕获画面
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # 特殊按键（C-o 表示 ctrl+o，以此类推）
tmux kill-session -t pi-test
```

发布冒烟测试时，用 `-c /tmp` 启动 tmux 会话，并把 `./pi-test.sh` 替换为发布二进制的绝对路径。Node 和 Bun 二进制要分别测试，提交一条 prompt 并等待模型回复；仅启动成功不算冒烟测试通过。
