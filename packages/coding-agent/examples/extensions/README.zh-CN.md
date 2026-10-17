# 扩展示例

pi-coding-agent 的扩展示例。

## 用法

```bash
# 用 --extension 标志加载扩展
pi --extension examples/extensions/permission-gate.ts

# 或复制到扩展目录以自动发现
cp permission-gate.ts ~/.pi/agent/extensions/
```

## 示例

### 生命周期与安全

| 扩展 | 说明 |
|-----------|-------------|
| `permission-gate.ts` | 在危险的 bash 命令（rm -rf、sudo 等）之前提示确认 |
| `project-trust.ts` | 演示面向用户/全局和 CLI 扩展的 `project_trust` 事件 |
| `protected-paths.ts` | 阻止对受保护路径（.env、.git/、node_modules/）的写入 |
| `confirm-destructive.ts` | 在破坏性会话操作（clear、switch、fork）之前确认 |
| `dirty-repo-guard.ts` | 存在未提交的 git 改动时阻止会话变更 |
| `sandbox/` | 使用 `@anthropic-ai/sandbox-runtime` 按 OS 级沙箱隔离，支持按项目配置 |
| `gondolin/` | 把内置工具和 `!` 命令路由进 Gondolin 微虚拟机 |

### 自定义工具

| 扩展 | 说明 |
|-----------|-------------|
| `todo.ts` | 待办清单工具 + `/todos` 命令，带自定义渲染和状态持久化 |
| `hello.ts` | 最小的自定义工具示例 |
| `question.ts` | 演示用 `ctx.ui.select()` 以自定义 UI 向用户提问 |
| `questionnaire.ts` | 多问题输入，问题之间用标签栏导航 |
| `tool-override.ts` | 覆盖内置工具（例如给 `read` 加日志/访问控制） |
| `dynamic-tools.ts` | 在启动后（`session_start`）和运行中通过命令注册工具，附带提示词片段和工具专属提示指引 |
| `structured-output.ts` | 最终结构化输出工具，返回 `terminate: true` 让代理在工具调用后结束 |
| `built-in-tool-renderer.ts` | 为内置工具（read、bash、edit、write）自定义紧凑渲染，同时保留原有行为 |
| `minimal-mode.ts` | 覆盖内置工具渲染做极简显示（折叠模式只显示工具调用，不显示输出） |
| `truncated-tool.ts` | 包装 ripgrep 并做适当的输出截断（50KB/2000 行） |
| `ssh.ts` | 通过 SSH 用可插拔操作把所有工具委托给远程机器 |
| `subagent/` | 把任务委托给专门的子代理，各自拥有隔离的上下文窗口 |

### 命令与 UI

| 扩展 | 说明 |
|-----------|-------------|
| `preset.ts` | 通过 `--preset` 标志和 `/preset` 命令使用命名预设：模型、思考级别、工具和指令 |
| `plan-mode/` | Claude Code 风格的计划模式，用于只读探索，带 `/plan` 命令和步骤跟踪 |
| `tools.ts` | 交互式 `/tools` 命令启用/禁用工具，带会话持久化 |
| `handoff.ts` | 通过 `/handoff <goal>` 把上下文转移到新的专注会话 |
| `qna.ts` | 通过 `ctx.ui.setEditorText()` 把上一条回复中的问题提取到编辑器 |
| `status-line.ts` | 通过 `ctx.ui.setStatus()` 在页脚显示轮次进度，带主题配色 |
| `github-issue-autocomplete.ts` | 通过叠加一个自定义自动补全提供者（预载 `gh issue list` 的开放 issue）添加 `#1234` issue 补全 |
| `widget-placement.ts` | 通过 `ctx.ui.setWidget()` 的放置选项在编辑器上方和下方显示小组件 |
| `hidden-thinking-label.ts` | 通过 `ctx.ui.setHiddenThinkingLabel()` 自定义折叠状态的思考标签 |
| `working-indicator.ts` | 通过 `ctx.ui.setWorkingIndicator()` 自定义流式工作指示器 |
| `model-status.ts` | 通过 `model_select` 钩子在状态栏显示模型变化 |
| `snake.ts` | 贪吃蛇游戏，带自定义 UI、键盘处理和会话持久化 |
| `tic-tac-toe.ts` | 与代理对弈井字棋，工具用 `executionMode: "sequential"` 防止共享光标状态的竞态 |
| `send-user-message.ts` | 演示用 `pi.sendUserMessage()` 从扩展发送用户消息 |
| `timed-confirm.ts` | 演示用 AbortSignal 自动关闭 `ctx.ui.confirm()` 和 `ctx.ui.select()` 对话框 |
| `rpc-demo.ts` | 演练所有支持 RPC 的扩展 UI 方法；配合 [`examples/rpc-extension-ui.ts`](../rpc-extension-ui.ts) 使用 |
| `modal-editor.ts` | 通过 `ctx.ui.setEditorComponent()` 实现类 vim 的模态编辑器 |
| `rainbow-editor.ts` | 通过自定义编辑器实现彩虹文字动画效果 |
| `notify.ts` | 代理完成时通过 OSC 777 发送桌面通知（Ghostty、iTerm2、WezTerm） |
| `titlebar-spinner.ts` | 代理工作时在终端标题显示盲文转轮动画 |
| `summarize.ts` | 用 GPT-5.2 总结对话并显示在瞬态 UI 中 |
| `custom-footer.ts` | 通过 `ctx.ui.setFooter()` 自定义页脚，显示 git 分支和 token 统计 |
| `custom-header.ts` | 通过 `ctx.ui.setHeader()` 自定义页眉 |
| `overlay-test.ts` | 测试覆盖层合成，含内联文本输入和边界情况 |
| `overlay-qa-tests.ts` | 全面的覆盖层 QA 测试：锚点、边距、堆叠、溢出、动画 |
| `doom-overlay/` | 以覆盖层方式运行 DOOM，35 FPS（演示实时游戏渲染） |
| `shutdown-command.ts` | 添加 `/quit` 命令，演示 `ctx.shutdown()` |
| `reload-runtime.ts` | 添加 `/reload-runtime` 命令和 `reload_runtime` 工具，展示安全的重载流程 |
| `interactive-shell.ts` | 通过 `user_bash` 钩子以完整终端运行交互式命令（vim、htop） |
| `inline-bash.ts` | 通过 `input` 事件转换展开提示词中的 `!{command}` 模式 |
| `input-transform-streaming.ts` | 通过 `streamingBehavior` 跳过昂贵的输入预处理以支持流中转向 |

### Git 集成

| 扩展 | 说明 |
|-----------|-------------|
| `git-checkpoint.ts` | 每轮创建 git stash 检查点，供 fork 时恢复代码 |
| `auto-commit-on-exit.ts` | 退出时自动提交，用最后一条助手消息作为提交信息 |

### 系统提示词与压缩

| 扩展 | 说明 |
|-----------|-------------|
| `pirate.ts` | 演示用 `systemPromptAppend` 动态修改系统提示词 |
| `claude-rules.ts` | 扫描 `.claude/rules/` 目录并在系统提示词中列出规则 |
| `custom-compaction.ts` | 自定义压缩，总结整个对话 |
| `trigger-compact.ts` | 上下文用量超过 100k token 时触发压缩，并添加 `/trigger-compact` 命令 |

### 系统集成

| 扩展 | 说明 |
|-----------|-------------|
| `mac-system-theme.ts` | 让 pi 主题与 macOS 深色/浅色模式同步 |

### 资源

| 扩展 | 说明 |
|-----------|-------------|
| `dynamic-resources/` | 用 `resources_discover` 加载技能、提示词和主题 |

### 消息与通信

| 扩展 | 说明 |
|-----------|-------------|
| `message-renderer.ts` | 通过 `registerMessageRenderer` 自定义消息渲染，带颜色和可展开详情 |
| `entry-renderer.ts` | 仅 TUI 的会话条目渲染，通过 `appendEntry` 和 `registerEntryRenderer` |
| `debug-provider.ts` | 用 `/debug-provider` 切换原始提供者流的捕获，并在仅 TUI 的会话条目中检查每条助手消息 |
| `event-bus.ts` | 通过 `pi.events` 实现扩展间通信 |

### 会话元数据

| 扩展 | 说明 |
|-----------|-------------|
| `session-name.ts` | 通过 `setSessionName` 为会话选择器命名会话 |
| `bookmark.ts` | 通过 `setLabel` 给条目加标签书签，便于 `/tree` 导航 |

### 自定义提供者

| 扩展 | 说明 |
|-----------|-------------|
| `custom-provider-anthropic/` | 自定义 Anthropic 提供者，带 OAuth 支持和自定义流式实现 |
| `custom-provider-gitlab-duo/` | GitLab Duo 提供者，通过代理使用 pi-ai 内置的 Anthropic/OpenAI 流式实现 |
| `jev-router.ts` | 通过 `registerVirtualModel` 的虚拟模型：在 Codex Sol 或 Terra 上规划（由 Jev 分类器选择），首次编辑后切换到 Luna |

### 外部依赖

| 扩展 | 说明 |
|-----------|-------------|
| `with-deps/` | 带自己的 package.json 和依赖的扩展（演示 jiti 模块解析） |
| `file-trigger.ts` | 监视一个触发文件并把其内容注入对话 |

## 编写扩展

完整文档见 [docs/extensions.md](../../docs/extensions.zh-CN.md)。

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 订阅生命周期事件
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // 注册自定义工具
  pi.registerTool({
    name: "greet",
    label: "Greeting",
    description: "Generate a greeting",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // 注册命令
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify("Hello!", "info");
    },
  });
}
```

## 关键模式

**字符串参数使用 StringEnum**（Google API 兼容所必需）：
```typescript
import { StringEnum } from "@earendil-works/pi-ai";

// 好
action: StringEnum(["list", "add"] as const)

// 不好 - 在 Google 上不工作
action: Type.Union([Type.Literal("list"), Type.Literal("add")])
```

**通过 details 持久化状态：**
```typescript
// 把状态存进工具结果的 details，以正确支持 fork
return {
  content: [{ type: "text", text: "Done" }],
  details: { todos: [...todos], nextId },  // 持久化在会话中
};

// 在会话事件中重建
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.toolName === "my_tool") {
      const details = entry.message.details;
      // 从 details 重建状态
    }
  }
});
```
