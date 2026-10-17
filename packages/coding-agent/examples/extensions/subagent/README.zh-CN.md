# Subagent 示例

把任务委托给专门的子代理，各自拥有隔离的上下文窗口。

## 特性

- **隔离上下文**：每个子代理在单独的 `pi` 进程中运行
- **流式输出**：实时看到工具调用和进度
- **并行流式**：所有并行任务同时流式更新
- **Markdown 渲染**：最终输出以规范格式渲染（展开视图）
- **用量跟踪**：显示每个代理的轮次、token、成本和上下文用量
- **中止支持**：Ctrl+C 会传播并杀掉子代理进程

## 结构

```
subagent/
├── README.md            # 本文件
├── index.ts             # 扩展（入口）
├── agents.ts            # 代理发现逻辑
├── agents/              # 示例代理定义
│   ├── scout.md         # 快速侦察，返回压缩后的上下文
│   ├── planner.md       # 制定实现计划
│   ├── reviewer.md      # 代码审查
│   └── worker.md        # 通用型（全部能力）
└── prompts/             # 工作流预设（提示词模板）
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner（不实现）
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## 安装

从仓库根目录对这些文件建立符号链接：

```bash
# 链接扩展（必须位于含 index.ts 的子目录中）
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# 链接代理
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# 链接工作流提示词
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## 安全模型

本工具用一个委托的系统提示词和工具/模型配置执行单独的 `pi` 子进程。

**项目级代理**（`.pi/agents/*.md`）是仓库控制的提示词，可以指示模型读文件、运行 bash 命令等。

**默认行为：**只从 `~/.pi/agent/agents` 加载**用户级代理**。

要启用项目级代理，传 `agentScope: "both"`（或 `"project"`）。只对你信任的仓库这么做。

交互运行时，工具在不受信任的项目中运行项目级代理前会提示确认。受信任的项目跳过额外提示。设置 `confirmProjectAgents: false` 可禁用确认。

## 用法

### 单个代理
```
Use scout to find all authentication code
```

### 并行执行
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### 链式工作流
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### 工作流提示词
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## 工具模式

| 模式 | 参数 | 说明 |
|------|-----------|-------------|
| 单个 | `{ agent, task }` | 一个代理，一个任务 |
| 并行 | `{ tasks: [...] }` | 多个代理并发运行（最多 8 个，同时 4 个） |
| 链式 | `{ chain: [...] }` | 顺序执行，带 `{previous}` 占位符 |

## 输出显示

**折叠视图**（默认）：
- 状态图标（✓/✗/⏳）和代理名
- 最近 5-10 条（工具调用和文本）
- 用量统计：`3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**展开视图**（Ctrl+O）：
- 完整任务文本
- 所有工具调用及格式化后的参数
- 最终输出以 Markdown 渲染
- 每个任务的用量（链式/并行模式）

**并行模式流式**：
- 显示所有任务及实时状态（⏳ 运行中、✓ 完成、✗ 失败）
- 每个任务有进展时更新
- 显示"2/3 done, 1 running"状态
- 把每个已完成任务的最终输出返回给父模型，每个任务上限 50 KB
- 子进程在产生输出前退出时，返回来自 stderr/错误信息的失败诊断

**工具调用格式化**（模仿内置工具）：
- bash 显示为 `$ command`
- read 显示为 `read ~/path:1-10`
- grep 显示为 `grep /pattern/ in ~/path`
- 等等

## 代理定义

代理是带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

代理的系统提示词写在这里。
```

省略 `model` 时，子代理继承发起会话的当前模型和思考级别。

**位置：**
- `~/.pi/agent/agents/*.md` - 用户级（始终加载）
- `.pi/agents/*.md` - 项目级（仅在 `agentScope: "project"` 或 `"both"` 时）

`agentScope: "both"` 时，项目级代理覆盖同名的用户级代理。

## 示例代理

| 代理 | 用途 | 模型 | 工具 |
|-------|---------|-------|-------|
| `scout` | 快速代码侦察 | Haiku | read, grep, find, ls, bash |
| `planner` | 实现计划 | Sonnet | read, grep, find, ls |
| `reviewer` | 代码审查 | Sonnet | read, grep, find, ls, bash |
| `worker` | 通用型 | Sonnet | （全部默认） |

## 工作流提示词

| 提示词 | 流程 |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## 错误处理

- **退出码非 0**：工具返回带 stderr/输出的错误
- **stopReason "error"**：LLM 错误连同错误信息传播
- **stopReason "aborted"**：用户中止（Ctrl+C）杀掉子进程并抛错
- **链式模式**：在第一个失败步骤停止，并报告哪个步骤失败

## 限制

- 折叠视图中输出截断为最近 10 条（展开可看全部）
- 并行模式下模型可见的输出每个任务上限 50 KB；完整结果保留在工具详情中
- 每次调用都重新发现代理（允许会话中途编辑）
- 并行模式最多 8 个任务，同时 4 个
