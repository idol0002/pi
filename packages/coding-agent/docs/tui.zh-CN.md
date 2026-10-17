# 终端 UI

`@earendil-works/pi-tui` 提供 Pi 使用的终端组件系统。当内置对话框、通知、状态文本和部件不足以满足所需交互时，扩展使用它。

从[扩展](extensions.zh-CN.md#interact-with-the-user)的 `ctx.ui` 方法开始。只有当 UI 需要自己的渲染、键盘或鼠标输入、焦点、布局或生命周期时才构建自定义组件。

## 选择集成点

| 需求 | 使用 |
|---|---|
| 选择、确认、输入或多行编辑器 | `ctx.ui.select()`、`confirm()`、`input()` 或 `editor()` |
| 非阻塞反馈 | `ctx.ui.notify()` 或 `setStatus()` |
| 编辑器附近的持久内容 | `ctx.ui.setWidget()` |
| 替换头部、页脚或编辑器 | 对应的 `ctx.ui` 组件工厂 |
| 临时交互屏幕或覆盖层 | `ctx.ui.custom()` |
| 工具或会话条目的自定义渲染 | 扩展渲染器 |

这些 API 在需要时接收 Pi 的活动主题和快捷键。不要在扩展内创建第二个终端渲染器。

## 理解组件模型

组件为可用宽度渲染一组终端行。它可以选择处理键盘和鼠标输入，并且必须在其状态或依赖主题的内容变化时使缓存的输出失效。

每个渲染行必须适配提供的宽度。测量可见终端列数而不是字符串长度，因为 ANSI 转义、宽字符、emoji 和组合字符会改变显示宽度。

使用 `visibleWidth()`、`truncateToWidth()`、`sliceByColumn()` 和 `wrapTextWithAnsi()`，而不是自己实现终端宽度处理。Pi 在每行之后重置样式和超链接，因此在每个渲染行上重新应用样式。

更改组件状态后，使受影响的组件失效并调用注入的 `tui.requestRender()`。TUI 合并渲染请求并更新终端。

## 组合内置组件

该包包含常见布局和控件的组件：

- `Text`、`Markdown`、`Image` 和 `TruncatedText` 渲染内容。
- `Container`、`VStack`、`HStack`、`Box` 和 `Spacer` 组合布局。
- `Input` 和 `Editor` 接受文本。
- `SelectList` 和 `SettingsList` 实现可搜索的选择和设置流程。
- `ScrollView` 提供有界的可滚动视口。
- `Loader` 和 `CancellableLoader` 报告进行中的工作。
- `MouseRegion` 为另一个组件添加指针行为。

优先使用这些组件，而不是重新实现选择、滚动、文本编辑或宽度处理。扩展示例展示了如何把它们与 Pi 的边框和主题结合。

## 处理键盘输入与焦点

终端键盘输入使用 `matchesKey()` 和 `Key`。解析器考虑受支持的终端协议和按键修饰符。扩展组件应使用注入的 `KeybindingsManager` 处理可配置的应用程序动作。

显示文本光标的组件应实现 `Focusable`，并把 `CURSOR_MARKER` 放在其可视光标紧之前。把光标单元包在 `renderFakeCursor()` 中，让 TUI 以反色绘制它，或在显示硬件光标时在 `CURSOR_MARKER` 之后隐藏它。TUI 用该标记为输入法编辑器定位硬件光标。

包裹 `Input` 或 `Editor` 的容器必须把其 `focused` 状态传播给该子组件。没有传播时，中文、日文、韩文等 IME 候选窗口可能出现在错误的屏幕位置。

替换主编辑器时扩展 Pi 的 `CustomEditor`。它保留应用程序快捷键和 agent 控件。

把你的编辑器不拥有的键转发给基类实现，并通过清除自定义编辑器工厂恢复默认值。

## 处理鼠标输入

全屏模式把规范化后的鼠标事件路由给组件。处理器可以标记事件已处理、捕获拖拽序列、请求焦点或请求渲染。

未处理的滚轮事件滚动最近的 `ScrollView`。未处理的主键拖拽仍可用于转录选择。OSC 8 链接优先于包围它的点击区域。

常规模式把鼠标输入留给终端，因为终端拥有回滚历史。即使全屏鼠标输入可用，也要为每个交互设计键盘路径。

## 使用自定义屏幕与覆盖层

`ctx.ui.custom()` 临时让一个组件接管交互区域，并在该组件调用提供的完成回调时 resolve。

传 `overlay: true` 在现有内容之上绘制。覆盖层选项控制大小、锚点、偏移、边距和响应式可见性。覆盖层句柄可以在交互保持活跃时更改焦点，或用 `setHidden()` 临时隐藏和显示覆盖层。

获得焦点的覆盖层在普通渲染之间保持输入所有权。如果覆盖层仍可见时另一个组件应接收输入，通过句柄显式释放或重定向焦点。

把每个自定义组件实例视为属于一次交互。再次开始该交互时创建新实例。

用提供给组件工厂的完成回调结束交互。它 resolve `ctx.ui.custom()` 的 promise 并销毁组件。不要对 `ctx.ui.custom()` 创建的覆盖层调用 `OverlayHandle.hide()`。

定位、堆叠、焦点、响应式可见性和动画行为见 [`overlay-qa-tests.ts`](../examples/extensions/overlay-qa-tests.ts)。

## 正确应用主题

使用传递给扩展或组件回调的主题。主题辅助函数为语义颜色（如 accent、弱化文本、成功、警告、错误、工具输出和 Markdown）生成带 ANSI 样式的字符串。

用 `theme.style()` 把前景和背景颜色与文本属性组合：

```typescript
return new Text(
  theme.style("Done!", {
    fg: "success",
    bg: "toolSuccessBg",
    bold: true,
  }),
  0,
  0,
);
```

样式颜色可以是语义主题 token 或具体的 `Color`。前景 token 作为 `fg` 接受，背景 token 作为 `bg` 接受；要在另一位置使用 token 的颜色，传入其具体颜色，例如 `{ fg: theme.colors.userMessageBg }`。通过 `theme.colors` 访问具体颜色，需要颜色运算时使用 `@earendil-works/pi-tui` 的 `mixColors()` 等工具。主题设为终端默认值的 token 以终端自己的颜色渲染；`theme.colors` 报告终端为它们宣布的颜色，未宣布时报告猜测值。用 `theme.appearance`（`"dark"` 或 `"light"`）决定，例如，把颜色变亮还是变暗。Pi 根据终端能力把结果转换为真彩色或 256 色输出。主题 token 每个主题只转换一次；尽量在渲染路径之外计算具体颜色。

现有的 `theme.fg()` 和 `theme.bg()` 辅助函数仍可用于应用单个语义颜色。

除非 `invalidate()` 会重建它们，否则不要永久存储带主题颜色的字符串。主题更改会清除渲染缓存，但无法移除嵌入在应用程序状态中的旧 ANSI 颜色。

渲染期间求值的主题回调不需要特殊重建。无状态组件也可以在每次渲染时计算带主题的输出。

创建终端调色板见[主题](themes.zh-CN.md)。渲染应匹配当前应用主题的 Markdown 时使用 Pi 的 `getMarkdownTheme()`。

## 保持渲染响应迅速

渲染在交互路径上运行。按宽度和内容缓存昂贵的布局和高亮工作，然后在 `invalidate()` 中清除该缓存。

保持默认视图紧凑，通过展开或专用屏幕显示细节。对自定义工具渲染，处理部分结果，并在可以安全更新时复用上一个组件。

诊断渲染问题时用 `PI_TUI_WRITE_LOG` 捕获原始 ANSI 流。测试窄宽度、宽字符、resize 事件、主题更改、焦点转换，以及常规和全屏两种模式。

## 示例与源码

受检查的扩展示例覆盖主要模式：

- [`preset.ts`](../examples/extensions/preset.ts) 和 [`tools.ts`](../examples/extensions/tools.ts) 使用选择和设置列表。
- [`qna.ts`](../examples/extensions/qna.ts) 使用可取消的异步 UI。
- [`modal-editor.ts`](../examples/extensions/modal-editor.ts) 替换编辑器。
- [`custom-footer.ts`](../examples/extensions/custom-footer.ts) 替换页脚。
- [`widget-placement.ts`](../examples/extensions/widget-placement.ts) 在编辑器周围放置持久内容。
- [`doom-overlay/`](../examples/extensions/doom-overlay/) 演示持续渲染的覆盖层。

公开导出定义在 [`packages/tui/src/index.ts`](https://github.com/earendil-works/pi/blob/main/packages/tui/src/index.ts)。扩展生命周期、状态、工具、事件和模式行为见[扩展](extensions.zh-CN.md)。
