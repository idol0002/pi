# 技能

技能（skill）为 Pi 提供针对特定工作类型的专门指令和配套文件。Pi 按名称和描述宣传每个可用技能，只在任务需要时才加载其完整指令。

当工作流需要的上下文超过提示词模板、但又不需要新的可执行集成点时，用技能。技能可以把脚本、参考资料和资产与指令打包在一起。

Pi 实现了 [Agent Skills 规范](https://agentskills.io/specification)。大多数无效字段只产生警告，不会阻止启动。

## 创建技能

技能是一个包含 `SKILL.md` 的目录：

```text
pdf-tools/
├── SKILL.md
├── scripts/
│   └── extract.sh
├── references/
│   └── formats.md
└── assets/
    └── template.json
```

`SKILL.md` 以 frontmatter 开头，后接直接指令：

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.
---

# PDF tools

Read `references/formats.md` before converting a document. Run scripts relative to this skill directory.
```

描述决定模型何时考虑加载该技能。要同时说明技能做什么、何时适用。避免"Helps with PDFs"这类描述——它们没有提供足够的路由信息。

引用打包文件时，使用相对技能目录的路径。Pi 会告诉模型技能的位置，让它能解析这些路径。

## 理解技能的加载方式

启动时，Pi 扫描配置的技能位置，把每个技能的名称、描述和路径加入系统提示词。它不会加入完整指令。

任务匹配时，模型读取 `SKILL.md` 并遵循其指令。这让详细指导在被需要之前不占用上下文。模型可能没能加载相关技能，需要强制时用 `/skill:name`。

`/skill:name` 之后的参数作为用户请求附加到已加载的指令之后：

```text
/skill:pdf-tools extract report.pdf
```

技能只应通过其显式命令使用时，在 frontmatter 中设置 `disable-model-invocation: true`。`enableSkillCommands` [设置](settings.zh-CN.md)控制技能命令是否出现在交互式命令发现中；手动输入的 `/skill:name` 命令仍然有效。

<a id="choose-where-it-loads"></a>

## 加入 Pi

把技能放到你的用户或项目技能目录。包含 `SKILL.md` 的目录会被递归发现。

Pi 还支持 Agent Skills 的位置 `~/.agents/skills/` 和 `.agents/skills/`。项目的 `.agents/skills/` 目录从工作目录沿祖先目录发现，遇到仓库根目录时停止。

Pi 也接受某些独立的 Markdown 技能，但包含 `SKILL.md` 的目录才是可移植的形式，应优先使用。其他位置见[设置](settings.zh-CN.md#resources)和 [Pi 包](packages.zh-CN.md)。

项目技能可以指示模型运行脚本或修改文件。授予项目信任之前，先审查不熟悉的技能及其配套文件。

## 编写可移植的 frontmatter

Agent Skills 规范定义了这些字段：

| 字段 | 用途 |
|---|---|
| `name` | 命令与显示名称 |
| `description` | 展示给模型的路由描述 |
| `license` | 许可证名称或打包的许可证文件 |
| `compatibility` | 环境要求 |
| `metadata` | 附加键值元数据 |
| `allowed-tools` | 实验性的预批准工具列表 |
| `disable-model-invocation` | 对自动模型选择隐藏该技能 |

名称使用小写字母、数字和连字符，不以连字符开头或结尾，也不允许连续连字符。最长 64 个字符；描述最长 1024。

声明的名称与父目录名不同时，Pi 既不要求一致也不警告。其他 Agent Skills 实现可能强制该要求，因此名称保持一致仍是可移植的选择。

格式错误的 `SKILL.md` 文件和没有描述的已声明技能不会被加载。名称冲突时保留第一个发现的技能并产生警告。

## 验证与分享技能

在技能可被发现的位置运行 Pi，然后检查启动诊断和 `/skill:name` 命令。活动会话中编辑技能后，运行 `/reload`。

用 [Pi 包](packages.zh-CN.md)通过 npm 或 git 分发一个或多个技能。环境设置放在技能内部，所需的运行时依赖在包中声明。

示例见 [Anthropic 技能集](https://github.com/anthropics/skills)和 [Pi 技能集](https://github.com/badlogic/pi-skills)。
