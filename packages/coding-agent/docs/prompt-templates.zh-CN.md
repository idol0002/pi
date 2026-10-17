# 提示词模板

提示词模板把 Markdown 文件变成可复用的 `/` 命令。当你想复用同一条提示词、又不需要添加可执行行为或大量配套指令时，就用模板。

模板可以接受参数并出现在命令补全中。Pi 可以从个人配置、项目配置、显式路径或 Pi 包加载模板。项目配置只在获得项目信任后加载。

## 创建模板

创建 `~/.pi/agent/prompts/review.md`：

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness, security, and error handling}.
```

文件名就是命令名，所以该模板以 `/review` 可用。`description` 显示在命令补全中。省略时，Pi 使用第一个非空行。

`argument-hint` 可选。必需参数用 `<尖括号>`，可选参数用 `[方括号]`。

在活动会话中添加或修改模板后，运行 `/reload`。

<a id="invoke-a-template"></a>

## 使用模板

在编辑器中输入模板命令：

```text
/review
/review concurrency
```

Pi 在生成的文本进入 agent 之前展开模板。除非同名扩展命令先处理，否则扩展会先通过 `input` 事件收到原始输入。

模板支持以下替换：

| 语法 | 结果 |
|---|---|
| `$1`、`$2`、… | 单个位置参数 |
| `$@` 或 `$ARGUMENTS` | 所有参数用空格连接 |
| `${1:-default}` | 第一个参数，或默认值 |
| `${@:-default}` | 所有参数，或默认值 |
| `${@:N}` | 从位置 `N` 开始的参数 |
| `${@:N:L}` | 从位置 `N` 开始的 `L` 个参数 |

参数遵循类 shell 的引号规则，因此 `/review "API compatibility"` 提供一个含空格的参数。

<a id="choose-where-it-loads"></a>

## 加入 Pi

把模板放到你的用户或项目提示词目录。常规提示词目录只加载直接的 `.md` 子文件。

设置和包可以选择嵌套的 Markdown 文件；包清单可以用显式路径和 glob 收窄发现范围。这些选项见[设置](settings.zh-CN.md#resources)和 [Pi 包](packages.zh-CN.md)。

获得信任后，项目模板就会成为编辑器中的命令。信任不熟悉的项目之前，先审查其内容。见[安全](security.zh-CN.md#understand-project-trust)。
