# 用主题定制 Pi

主题控制 Pi 在交互模式和 HTML 导出中使用的颜色。Pi 内置 `system`、`dark` 和 `light` 主题。你可以选择一个主题、跟随终端的亮色或暗色外观，或创建自己的配色。

## 使用终端的颜色

`system` 主题是默认值。它基于终端的主题构建 Pi 的颜色，让 Pi 匹配终端而不是自带配色：

- Pi 查询终端的默认前景色、背景色和 16 个 ANSI 颜色。
- 每个 Pi 颜色从一个 ANSI 颜色取色相，例如错误取红色、链接取蓝色。
- Pi 设置每个颜色的亮度，使其与背景保持最小对比度。正文文本在背景和每个面板上保持至少 4.5:1 的 WCAG 对比度。
- 终端在亮色和暗色之间切换时，Pi 重新查询颜色并重建主题。

主题根据终端报告的内容自适应：

| 终端报告 | 结果 |
|---|---|
| 背景色和 ANSI 颜色 | 来自终端调色板的颜色，按实际背景放置。 |
| 仅背景色 | Pi 自己的色相，按实际背景放置。 |
| 什么都没有 | ANSI 颜色索引和终端默认颜色，由终端自己渲染。次要文本变暗淡，面板无背景色。 |

Pi 在启动时向终端询问颜色。终端通常在几毫秒内回答，Pi 最多等待 100 毫秒就显示启动页头。终端没有及时回答时，Pi 使用 ANSI 颜色回退，颜色稍后到达时（例如通过慢速 SSH 连接）仍会应用。`system` 是保留名称：使用该名称的自定义主题会被忽略。

<a id="selecting-a-theme"></a>

## 选择主题

打开 `/settings` 并选择 **Theme**。你可以让所有终端外观使用一个主题，或为亮色和暗色终端选择不同主题。

选择保存为 `theme` [设置](settings.zh-CN.md#terminal-and-display)：

```json
{
  "theme": "dark"
}
```

没有 `theme` 设置时，Pi 使用 `system`。

自动模式先存亮色主题，再存暗色主题：

```json
{
  "theme": "light/dark"
}
```

Pi 根据终端报告的背景色和前景色判断它是亮色还是暗色。终端不报告背景色时，Pi 依次尝试终端的亮/暗通知、`COLORFGBG` 环境变量，最后默认暗色。同一个判定既选择亮/暗配对的主题，也选择 `system` 的外观。自动模式激活时，终端报告外观变化时 Pi 会切换主题。主题名不能包含 `/`，因为 Pi 把它保留给该设置格式。

用 `--use-theme` 为单次调用选择初始主题，而不修改已保存的设置：

```bash
pi --use-theme light
pi --use-theme light/dark
```

命令行选项见 [CLI 资源](cli.zh-CN.md#resources)。

## 创建自定义主题

复制一个[内置主题](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/modes/interactive/theme)，或创建一个符合该 [schema](https://pi.dev/schemas/theme.schema.json) 的新 JSON 文件。内置主题使用 OKHSL 颜色，多个角色共享的颜色用变量表示，因此你可以直接调整色相、饱和度或亮度。

1. 把文件保存为 `<agent-dir>/themes/my-theme.json`。agent 目录默认为 `~/.pi/agent`。
2. 把 `name` 设为 `my-theme`。
3. 修改 `vars` 和 `colors` 中的值。
4. 通过 `/settings` 选择 `my-theme`。

用主题名作为文件名。Pi 只从 `<agent-dir>/themes/<name>.json` 热重载活动的用户主题。从任何其他来源添加或修改主题后，运行 `/reload`。

## 理解主题文件

| 属性 | 必需 | 职责 |
|---|---|---|
| `$schema` | 否 | 启用编辑器按 Pi 发布的 schema 进行校验和补全。 |
| `name` | 是 | 在选择器和设置中标识主题。必须唯一，不能含 `/`，不能是 `system`。 |
| `appearance` | 否 | `"dark"` 或 `"light"`：主题设计所面向的背景。省略时 Pi 从主题颜色检测。 |
| `vars` | 否 | 定义可复用的颜色值。变量可以引用其他变量。 |
| `colors` | 是 | 为终端 UI 角色分配颜色。schema 标明必需和可选角色。 |
| `export` | 否 | 覆盖 HTML 导出中的页面和面板背景。 |

主题对象是严格的：只接受文档记载的顶层字段和颜色 token。可复用的自定义颜色定义在 `vars` 下；`colors` 或 `export` 下的自定义键和额外的顶层元数据会被拒绝。

颜色有六种写法：

| 形式 | 示例 | 含义 |
|---|---|---|
| RGB 十六进制 | `"#0af"` 或 `"#00aaff"` | 三位或六位 sRGB 颜色。 |
| OKLCH | `"oklch(62% 0.1 200)"` | 感知亮度、色度（chroma）和色相。 |
| OKHSL | `"okhsl(250 60% 55%)"` | 色相、饱和度和亮度。饱和度相对于 sRGB 色域在该色相和亮度下的最大值，因此每个值都在色域内，相同的饱和度看起来同样鲜艳。 |
| 256 色索引 | `39` | `0` 到 `255` 的 ANSI 调色板索引。 |
| 变量引用 | `"primary"` | `vars` 中某个条目的值。 |
| 终端默认 | `""` | 终端的默认前景色或背景色。 |

终端默认颜色按终端自己的颜色渲染。Pi 需要具体值时（例如 HTML 导出或扩展颜色计算），使用终端报告的默认颜色，或根据主题外观猜测黑白。

Pi 解析链式变量引用。缺失变量或循环引用会使主题无效。可用时 Pi 使用真彩色，把 OKLCH 色域映射到 sRGB，并为 256 色终端近似颜色。HTML 导出把 OKHSL 值转换为十六进制，因为 CSS 不支持它们。如果颜色与源值不同，检查终端的真彩色检测和对比度设置。见[配置终端](terminal-setup.zh-CN.md#override-detected-capabilities)。

精确的属性、必需颜色和接受的值类型见[主题 JSON schema](https://pi.dev/schemas/theme.schema.json)。

Pi 在启动和 `/reload` 时报告无效的主题文件。

## 找到要修改的颜色

主题颜色描述的是界面角色，而不是单个组件。用这些分组找到 schema 中的相关部分：

| 区域 | 颜色名 |
|---|---|
| 通用界面 | `accent`、`border*`、`text`、`muted`、`dim`、`success`、`error`、`warning` |
| 选择与全屏 | `selectedBg`、`searchMatch*`、`scrollbar*` |
| 消息 | `userMessage*`、`customMessage*`、`thinkingText` |
| 工具执行 | `toolPendingBg`、`toolSuccessBg`、`toolErrorBg`、`toolTitle`、`toolOutput` |
| Markdown | `md*` |
| 工具 diff | `toolDiff*` |
| 语法高亮 | `syntax*` |
| 编辑器模式 | `thinking*`、`bashMode` |
| HTML 导出 | `export.pageBg`、`export.cardBg`、`export.infoBg` |

schema 是格式参考。内置主题提供了完整的值，可以复制后调整。

五个颜色是可选的，省略时继承另一个颜色：

| 可选颜色 | 回退 |
|---|---|
| `scrollbarTrack` | `muted` |
| `scrollbarThumb` | `text` |
| `searchMatchBg` | `selectedBg` |
| `searchMatchText` | `text` |
| `thinkingMax` | `thinkingXhigh` |

省略 `export` 颜色时，Pi 从 `userMessageBg` 推导 HTML 页面和面板背景。

## 从项目或包加载主题

把项目主题放在 `.pi/themes/` 下。项目主题只在授予[项目信任](security.zh-CN.md#understand-project-trust)后加载。

也可以通过 `themes` 设置加载主题文件和目录，或在 Pi 包中分发。见[配置](configuration.zh-CN.md)、[设置](settings.zh-CN.md#resources)和 [Pi 包](packages.zh-CN.md)。

每个已加载的主题必须有唯一的名称。重复名称会被 Pi 报告为资源冲突。
