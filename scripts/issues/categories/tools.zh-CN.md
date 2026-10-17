---
owner: vegarsti
---
# tools

内置工具。

包含：
- read、write、edit、bash、grep、find、ls，以及用户 `!` 命令。
- 输出截断。
- shell 选择与启动、进程清理、超时。
- 工具结果中的图片（缩放、限制）。

不包含：
- 工具调用如何渲染：tui。
- MCP 工具：mcp。
- Codemode 与 tool_search：codemode。

示例：#6817, #9129, #9276, #10015, #10482, #9361, #10527.

通常不值得提交：模糊编辑匹配的期望（#10207, #10340）。
