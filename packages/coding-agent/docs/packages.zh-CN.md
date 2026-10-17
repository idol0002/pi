# Pi 包

Pi 包把扩展、技能、提示词模板和主题作为一个整体安装和分发。当某项定制需要通过 npm 或 git 共享，或多个资源需要捆绑在一起时，使用包。

包是一个普通目录或 npm 包。它可以暴露常规的资源目录、在 `package.json` 的 `pi` 键下声明显式路径，并携带自己的运行时依赖。

## 安装和管理包

从 npm、git 或本地路径安装：

```bash
pi install npm:@example/pi-tools@1.0.0
pi install git:github.com/example/pi-tools@v1
pi install ./local-package
```

`pi list` 显示已配置的包。用 `pi remove <source>` 移除一个包，用 `pi update --extensions` 对齐包安装。所有包命令和选项见[命令行](cli.zh-CN.md#package-commands)。

个人安装写入 `~/.pi/agent/settings.json`。加 `--local` 或 `-l` 把包声明写入 `.pi/settings.json`。Pi 只在授予项目信任后才读取该文件中的声明。

项目包只在项目信任解析之后安装和加载。包可以执行扩展代码，也可以包含指示模型运行程序的技能。安装第三方包之前先审查其源码。授予项目信任之前先审查项目包声明。

用 `--extension` 或 `-e` 在单次调用中试用一个包，而不加入设置：

```bash
pi -e npm:@example/pi-tools
```

## 选择来源

| 来源 | 示例 | 行为 |
|---|---|---|
| npm | `npm:@example/pi-tools@1.0.0` | 安装到 Pi 的 npm 目录下 |
| git | `git:github.com/example/pi-tools@v1` | 克隆并对齐到所选 ref |
| URL | `https://github.com/example/pi-tools` | 视为 git 来源 |
| 本地 | `./pi-tools` | 从解析后的路径加载，不复制 |

带版本的 npm 规格会被固定。git 标签和 commit 同样被固定；包更新会对齐检出，但不会移动已配置的 ref。

相对本地路径从包含它们的设置文件处解析。文件路径加载一个扩展。目录遵循正常的包发现规则。

## 创建包

最简单的包使用常规目录：

```text
my-pi-package/
├── package.json
├── extensions/
├── skills/
├── prompts/
└── themes/
```

没有 `pi` 清单时，Pi 从这些目录发现 TypeScript 和 JavaScript 扩展、技能目录、Markdown 提示词和 JSON 主题。

资源放在其他位置或需要过滤时，使用显式清单：

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"],
    "themes": ["./resources/themes/*.json"]
  }
}
```

路径相对于包根目录。数组接受 glob 模式和排除项。点前缀或符号链接的资源根目录无法被 glob 遍历发现时，直接列出。

`pi-package` 关键字让 npm 包有资格出现在 [Pi 包画廊](https://pi.dev/packages)。可选的 `pi.image` 和 `pi.video` 字段为画廊添加预览。

## 声明依赖

扩展导入的运行时包放在 `dependencies` 中。Pi 在安装 npm 或 git 来源时会安装包依赖。

Pi 向扩展和技能提供以下包：

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

把上面列出的宿主提供的包以 `"*"` 范围声明在 `peerDependencies` 中，并且不要打包它们。对受管理的 npm 包和用 npm、pnpm 或 Bun 安装的 git 包，Pi 会抑制自动的 peer 安装。本地包不会被安装或修改，因此其依赖树仍由包作者负责。

不要把宿主提供的包列进 `dependencies`。物理副本可能绕过 Pi 在编译后 ESM 中的扩展模块映射，造成重复的类、注册表和初始化工作。Pi 检测到这种清单配置时会报告扩展警告。作为依赖的其他 Pi 包必须包含在发布的 tarball 中，并通过其 `node_modules` 资源路径引用。

已安装的包以独立的模块根加载。不要依赖两个包共享同一个依赖实例，或一个包解析另一个包未声明的依赖。

## 选择包资源

设置中的对象形式可以收窄从包中加载哪些资源：

```json
{
  "packages": [
    {
      "source": "npm:@example/pi-tools",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

对每种资源类型：

- 省略该属性：加载包允许的全部。
- 用 `[]`：不加载该类型。
- 用 `!pattern`：排除 glob 匹配项。
- 用 `+path`：包含一个明确允许的路径。
- 用 `-path`：排除一个明确的路径。

过滤器只能收窄包清单。它们不会暴露包自身未声明的资源。

运行 `pi config` 启用或禁用发现的资源和 pi 的内置扩展。它从个人配置开始；按 Tab 切换作用域，或运行 `pi config --local` 从项目覆盖开始。

## 理解作用域与身份

同一个包可以同时出现在个人和项目设置中。项目条目通常替换个人条目。设置 `autoload: false` 时，项目条目改为作为个人包之上的过滤增量。

Pi 用包名标识 npm 包，用不含 ref 的仓库 URL 标识 git 包，用解析后的绝对路径标识本地包。这防止同一个包通过等价声明被加载两次。

先用[扩展](extensions.zh-CN.md)、[技能](skills.zh-CN.md)、[提示词模板](prompt-templates.zh-CN.md)和[主题](themes.zh-CN.md)设计每种资源，再打包。
