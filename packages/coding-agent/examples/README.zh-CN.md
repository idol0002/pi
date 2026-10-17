# 示例

pi-coding-agent 的 SDK、进程集成和扩展示例代码。

## CLI 集成

[`rpc-client.ts`](rpc-client.ts) 使用带类型的 `RpcClient` 在子进程中运行 Pi、流式接收事件，并等待运行落定。

从仓库检出运行之前，先构建 coding-agent 包：

```bash
node examples/rpc-client.ts "Explain this repository"
```

## 目录

### [sdk/](sdk/)
通过 `createAgentSession()` 的编程式用法。展示如何自定义模型、提示词、工具、扩展和会话管理。

### [extensions/](extensions/)
示例扩展演示：
- 生命周期事件处理（工具拦截、安全门、上下文修改）
- 自定义工具（待办清单、提问、子代理、输出截断）
- 命令和键盘快捷键
- 自定义 UI（页脚、页眉、编辑器、覆盖层）
- Git 集成（检查点、自动提交）
- 系统提示词修改与自定义压缩
- 外部集成（SSH、文件监视、系统主题同步）
- 自定义提供者（带自定义流式的 Anthropic、GitLab Duo）

## 文档

- [SDK 示例](sdk/README.zh-CN.md)
- [CLI 集成](../docs/cli-integration.zh-CN.md)
- [扩展文档](../docs/extensions.zh-CN.md)
- [技能文档](../docs/skills.zh-CN.md)
