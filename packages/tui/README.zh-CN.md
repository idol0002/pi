# @earendil-works/pi-tui

极简终端 UI 框架，带差分渲染和同步输出，为交互式 CLI 应用提供无闪烁体验。

## 特性

- **可互换的渲染器**：共享的 `TUI` 接口，有主屏和备用屏两种实现
- **差分渲染**：只更新变化的行或视口行
- **应用自有的滚动**：备用屏视口支持鼠标、触控板和键盘导航
- **同步输出**：使用 CSI 2026 实现原子化的屏幕更新（无闪烁）
- **括号粘贴模式**：正确处理大段粘贴，超过 10 行的粘贴带标记
- **基于组件**：简单的 Component 接口，只有 render() 方法
- **主题支持**：组件接受主题接口，可自定义样式
- **内置组件**：Text、TruncatedText、Input、Editor、Markdown、Loader、SelectList、SettingsList、MouseRegion、Spacer、Image、Box、Container、VStack、HStack、ScrollView
- **内联图片**：在支持 Kitty 或 iTerm2 图形协议的终端中渲染图片
- **自动补全支持**：文件路径和斜杠命令

## 快速上手

```typescript
import { type TUI, Text, Editor, ProcessTerminal, TuiMainScreen, matchesKey } from "@earendil-works/pi-tui";

// 创建终端
const terminal = new ProcessTerminal();

// 通过共享的 TUI 接口创建默认的主屏渲染器
const tui: TUI = new TuiMainScreen(terminal);

// 添加组件
tui.addChild(new Text("Welcome to my app!"));

import { defaultEditorTheme as editorTheme } from './test/test-themes.ts';
const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
  console.log("Submitted:", text);
  tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// 聚焦编辑器，让它接收键盘输入
tui.setFocus(editor);

// raw 模式下 Ctrl+C 不会发送 SIGINT —— 在这里拦截以允许退出
tui.addInputListener((data) => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop();
    process.exit(0);
  }
});

// 启动
tui.start();
```

## 核心 API

### TUI 接口与渲染器

`TUI` 是共享接口，覆盖组件管理、焦点、覆盖层、输入、生命周期、终端查询和渲染。只在构建应用时选择具体渲染器：

- `TuiMainScreen` 渲染到主终端缓冲区，保留终端回滚（scrollback）。
- `TuiAltScreen` 在备用终端缓冲区渲染一个固定高度的视口，滚动由应用自有。停止时恢复主缓冲区，并打印完整的最终文档。

```typescript
import { type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

const tui: TUI = new TuiMainScreen(terminal);
// 改用备用终端缓冲区中应用自有的视口：
// const tui: TUI = new TuiAltScreen(terminal);

tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender(); // 请求重新渲染

// 全局调试按键处理（Shift+Ctrl+D）
tui.onDebug = () => console.log("Debug triggered");
```

### 颜色与终端样式

颜色是可以在终端渲染前转换或混合的值：

```typescript
import {
  colorToRgb,
  foregroundAnsi,
  getTerminalColorMode,
  mixColors,
  parseColor,
  rgbColor,
  styleText,
} from "@earendil-works/pi-tui";

const accent = parseColor("oklch(70% 0.12 220)");
const background = parseColor("#20242a");
const foreground = mixColors(accent, background, 0.2);

const text = styleText(
  "Ready",
  { fg: foreground, bg: background, bold: true },
  getTerminalColorMode(),
);
```

`Color` 可以是索引 ANSI 颜色、sRGB 颜色或 OKLCH 颜色。每种颜色都能转换为 sRGB，所以 `mixColors()` 之类的颜色运算总是可用。索引 0-15 跟随用户终端的调色板，它们的 sRGB 值是近似值。`styleText()` 根据请求的终端模式把颜色转换为真彩或 256 色输出。

`parseColor()` 也接受 OKHSL，例如 `okhsl(250 60% 55%)`；`okhslColor()` 在代码中构建它，`colorToOkhsl()` 读取任意颜色的 OKHSL 通道。OKHSL 的饱和度是相对于该色相和亮度下 sRGB 色域所能允许的最大值而言的，所以每个值都在色域内，相同饱和度在不同色相下看起来同样鲜艳。OKHSL 颜色在创建时就转换为 sRGB。

转换不做缓存。OKLCH 颜色（尤其是 sRGB 色域之外的）转换代价比 sRGB 或索引颜色高。对每次渲染都要用的颜色，转换一次并复用结果：

```typescript
const { r, g, b } = colorToRgb(mixColors(accent, background, 0.2));
const foreground = rgbColor(r, g, b); // 反复渲染开销低
const foregroundCode = foregroundAnsi(foreground, getTerminalColorMode());
```

### 备用屏视口布局

`TuiAltScreen` 可以渲染显式的终端高度布局。`VStack` 和 `HStack` 分配受约束的区域，`ScrollView` 为其中一个区域管理滚动。这些语义有意不在 `TuiMainScreen` 上提供，因为那里回滚由终端自有。

```typescript
import {
  Container,
  isViewportTUI,
  ScrollView,
  Text,
  VStack,
} from "@earendil-works/pi-tui";

const transcript = new Container();
transcript.addChild(new Text("History"));

const editorAndFooter = new VStack([
  editor,
  new Text("status"),
]);

if (isViewportTUI(tui)) {
  tui.setLayoutRoot(new VStack([
    {
      component: new ScrollView(transcript, {
        follow: "end",
        primary: true,
        overscroll: "chain",
      }),
      basis: 0,
      grow: 1,
      minSize: 1,
    },
    {
      component: editorAndFooter,
      basis: "auto",
      shrink: 1,
      minSize: 1,
    },
  ]));
}
```

堆叠条目支持 `basis`、`grow`、`shrink`、`minSize`、`maxSize` 和响应式的 `visible` 回调。鼠标滚轮输入默认指向指针下的滚动视图，未用完的增量链到外层滚动视图。主滚动视图接收备用屏的键盘导航动作以及非滚动区域上的滚轮输入。它还可以在 OSC 133 语义提示符标记之间跳转，对应常见终端的提示符导航快捷键。按 `Ctrl+Shift+F` 打开或关闭其带边框的搜索面板。面板显示配置的上一个/下一个快捷键，并提供可点击的箭头控件；默认情况下，`Enter`/`Ctrl+G` 和 `Shift+Enter`/`Ctrl+Shift+G` 在匹配项之间移动，`Escape` 也可关闭搜索。`TuiAltScreenOptions.searchMatchStyle` 和 `searchCurrentMatchStyle` 自定义匹配高亮，`searchNavigationButtonStyle` 为每个箭头按钮设置样式并接收其悬停状态。`TuiAltScreenOptions.scrollToEndIndicator` 在 `follow: "end"` 的主滚动视图滚离底部时，在最后一行居中渲染一个可点击的标签；点击它恢复跟随底部。

布局几何在每次请求的帧时重建。有状态的组件被保留，它们已有的渲染行缓存继续有效。直接对这些布局组件调用 `render(width)` 会产生一个无界文档，备用模式恢复主屏时也用它。

### 覆盖层

覆盖层在现有内容之上渲染组件，不替换它们。适用于对话框、菜单和模态 UI。

```typescript
// 用默认选项显示覆盖层（居中，最多 80 列）
const handle = tui.showOverlay(component);

// 用自定义定位和尺寸显示覆盖层
// 值可以是数字（绝对值）或百分比字符串（如 "50%"）
const handle = tui.showOverlay(component, {
  // 尺寸
  width: 60,              // 固定宽度（列）
  width: "80%",           // 占终端宽度的百分比
  minWidth: 40,           // 最小宽度下限
  maxHeight: 20,          // 最大高度（行）
  maxHeight: "50%",       // 占终端高度的百分比

  // 基于锚点的定位（默认：'center'）
  anchor: 'bottom-right', // 相对锚点的位置
  offsetX: 2,             // 相对锚点的水平偏移
  offsetY: -1,            // 相对锚点的垂直偏移

  // 基于百分比的定位（锚点的替代方案）
  row: "25%",             // 垂直位置（0%=顶部，100%=底部）
  col: "50%",             // 水平位置（0%=左侧，100%=右侧）

  // 绝对定位（覆盖 anchor/百分比）
  row: 5,                 // 精确行位置
  col: 10,                // 精确列位置

  // 距终端边缘的边距
  margin: 2,              // 四边
  margin: { top: 1, right: 2, bottom: 1, left: 2 },

  // 响应式可见性
  visible: (termWidth, termHeight) => termWidth >= 100  // 窄终端上隐藏

  // 焦点行为
  nonCapturing: true       // 显示时不自动聚焦
});

// OverlayHandle 方法
handle.hide();              // 永久移除覆盖层
handle.setHidden(true);     // 临时隐藏（可再次显示）
handle.setHidden(false);    // 隐藏后再次显示
handle.isHidden();          // 检查是否临时隐藏
handle.focus();             // 聚焦并置于视觉最前
handle.unfocus();           // 释放焦点，回到正常回退
handle.unfocus({ target: baseComponent }); // 把焦点释放给指定组件
handle.unfocus({ target: null });   // 释放覆盖层并让焦点为空
handle.isFocused();         // 检查覆盖层是否持有焦点
handle.getBounds();         // 获取最后渲染的相对终端边界

handle.unfocus();
// 覆盖层失去焦点；TUI 回退到另一个可见的捕获型覆盖层或之前的焦点目标。

handle.unfocus({ target: null });
// 覆盖层失去焦点；在重新设置焦点前没有组件接收输入。

// 持有焦点的可见覆盖层会在临时替换 UI 释放焦点后重新拿回键盘输入。
// 如果你想在覆盖层仍可见时让特定组件接收输入，调用 handle.unfocus({ target: component })。

// 隐藏最上层的覆盖层
tui.hideOverlay();

// 检查是否有可见覆盖层处于活动状态
tui.hasOverlay();
```

**锚点取值**：`'center'`、`'top-left'`、`'top-right'`、`'bottom-left'`、`'bottom-right'`、`'top-center'`、`'bottom-center'`、`'left-center'`、`'right-center'`

**解析顺序**：
1. `minWidth` 在宽度计算后作为下限应用
2. 位置：绝对 `row`/`col` > 百分比 `row`/`col` > `anchor`
3. `margin` 把最终位置钳制在终端边界内
4. `visible` 回调控制覆盖层是否渲染（每帧调用）

### 组件接口

所有组件实现：

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  invalidate(): void;
}
```

| 方法 | 说明 |
|--------|-------------|
| `render(width)` | 返回字符串数组，每行一个。每行**不得超过 `width`**，否则 TUI 会报错。用 `truncateToWidth()` 或手动换行来保证这一点。 |
| `handleInput?(data)` | 组件持有焦点并收到键盘输入时调用。`data` 字符串包含原始终端输入（可能含 ANSI 转义序列）。 |
| `handleMouse?(event)` | 由 `TuiAltScreen` 调用，传入指向该组件的规范化指针输入。 |
| `invalidate()` | 必需。清除所有缓存的渲染状态，让下一次 `render()` 从零开始。没有缓存渲染状态的组件可以用空实现。 |

TUI 在每行渲染输出的末尾追加完整的 SGR 重置和 OSC 8 重置。样式不会跨行延续。如果你输出带样式的多行文本，请逐行重新应用样式，或使用 `wrapTextWithAnsi()` 让每一段换行后的文本都保留样式。

### 鼠标输入

`TuiAltScreen` 规范化 SGR 鼠标输入并对组件和覆盖层做命中测试。事件包含组件局部的 `x`/`y`、绝对的 `screenX`/`screenY`、边界、按钮、修饰键、点击次数和滚轮增量。`TuiMainScreen` 不捕获鼠标输入，因为回滚由终端自有。

```typescript
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
  if (event.type === "click" && event.button === "left") {
    this.expanded = !this.expanded;
    return { handled: true };
  }
  if (event.type === "press" && event.button === "left") {
    return { handled: true, capture: true, focus: true };
  }
  if (event.type === "drag") {
    this.updateFromPointer(event.x, event.y);
    return { handled: true, render: true };
  }
  return undefined;
}
```

返回 `handled` 会抑制渲染器层的回退行为。`capture` 让后续的拖动和释放事件继续路由到同一组件。`focus` 请求键盘焦点。可选的 `render` 标志控制重绘：press、click、drag 和 wheel 默认渲染；move 和 release 不。对于可见变化的悬停状态设 `render: true`，对已处理但无视觉变化的操作设 `render: false`。渲染请求会被合并，终端输出保持差分。

未处理的手势保留备用屏默认行为：滚轮输入滚动最近的 `ScrollView` 并把未用的增量链出去，主键拖动选择文本，OSC 8 链接在父级点击处理之前打开，未处理的右键点击保留配置的粘贴行为。只有 press/release 完成且没有发生拖动时才发出 click。

用 `MouseRegion` 给组件添加鼠标行为而不改变其渲染：

```typescript
const collapsible = new MouseRegion(content, (event) => {
  if (event.type !== "click" || event.button !== "left") return undefined;
  expanded = !expanded;
  return { handled: true };
});
```

`Container` 和 `Box` 使用上一帧渲染记录的几何信息把事件路由给嵌套子组件，因此指针移动不会为了命中测试而重渲染子组件。显式的 `VStack`、`HStack` 和 `ScrollView` 布局直接使用备用屏布局帧。

### Focusable 接口（IME 支持）

显示文本光标并需要 IME（输入法）支持的组件应实现 `Focusable` 接口：

```typescript
import { CURSOR_MARKER, type Component, type Focusable, renderFakeCursor } from "@earendil-works/pi-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // 焦点变化时由 TUI 设置
  
  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    // 在假光标之前输出标记
    return [`> ${beforeCursor}${marker}${renderFakeCursor(atCursor)}${afterCursor}`];
  }

  invalidate(): void {}
}
```

当 `Focusable` 组件持有焦点时，TUI：
1. 在组件上设置 `focused = true`
2. 在渲染输出中扫描 `CURSOR_MARKER`（一个零宽 APC 转义序列）
3. 把硬件终端光标定位到该位置
4. 仅在启用 `showHardwareCursor` 时显示硬件光标

`renderFakeCursor()` 把光标单元包进零宽标记。TUI 把它们渲染为反显。启用 `showHardwareCursor` 时，TUI 会移除紧跟 `CURSOR_MARKER` 的假光标，让聚焦组件只显示终端光标。没有前置 `CURSOR_MARKER` 的假光标保持可见。

硬件光标默认保持隐藏。这样既保留假光标渲染，又为那些在光标隐藏时跟踪 IME 候选窗口的终端定位硬件光标。有些终端需要可见的硬件光标才能定位 IME；用渲染器构造函数的 `showHardwareCursor` 参数或 `setShowHardwareCursor(true)` 启用。内置的 `Editor` 和 `Input` 组件已经实现了该接口。

**含内嵌输入的容器组件：**当容器组件（对话框、选择器等）包含 `Input` 或 `Editor` 子组件时，容器必须实现 `Focusable` 并把焦点状态传播给子组件：

```typescript
import { Container, type Focusable, Input } from "@earendil-works/pi-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;

  // 把焦点传播给子输入框，供 IME 光标定位
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }
}
```

没有这个传播，用 IME（中文、日文、韩文等）输入时候选窗口会出现在错误的位置。

## 内置组件

### Container

把子组件分组。

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Box

给所有子组件应用内边距和背景色的容器。

```typescript
const box = new Box(
  1,                              // paddingX（默认：1）
  1,                              // paddingY（默认：1）
  (text) => chalk.bgGray(text)   // 可选的背景函数
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text));  // 动态改变背景
```

### Text

显示多行文本，带自动换行和内边距。

```typescript
const text = new Text(
  "Hello World",                  // 文本内容
  1,                              // paddingX（默认：1）
  1,                              // paddingY（默认：1）
  (text) => chalk.bgGray(text)   // 可选的背景函数
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText

单行文本，截断以适应视口宽度。适用于状态行和页眉。

```typescript
const truncated = new TruncatedText(
  "This is a very long line that will be truncated...",
  0,  // paddingX（默认：0）
  0   // paddingY（默认：0）
);
```

### Input

单行文本输入，带水平滚动。

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

在备用屏模式下，点击会定位光标并把键盘焦点交给输入框。

**按键绑定：**
- `Enter` - 提交
- `Ctrl+A` / `Ctrl+E` - 行首/行尾
- `Ctrl+W` 或 `Alt+Backspace` - 向前删除一个词
- `Ctrl+U` - 删除到行首
- `Ctrl+K` - 删除到行尾
- `Ctrl+Left` / `Ctrl+Right` - 按词导航
- `Alt+Left` / `Alt+Right` - 按词导航
- 方向键、Backspace、Delete 按预期工作

### Editor

多行文本编辑器，带自动补全、文件补全、粘贴处理，以及内容超过终端高度时的垂直滚动。

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
}

interface EditorOptions {
  paddingX?: number;  // 水平内边距（默认：0）
}

const editor = new Editor(tui, theme, options?);  // tui 必需，用于高度感知的滚动
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // 临时禁用提交
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s); // 动态改变边框颜色
editor.setPaddingX(1); // 动态更新水平内边距
editor.getPaddingX();  // 获取当前内边距
```

**特性：**
- 备用屏模式下点击定位光标，自动补全行可点击
- 多行编辑，带自动换行
- 斜杠命令自动补全（输入 `/`）
- 文件路径自动补全（按 `Tab`）
- 大段粘贴处理（超过 10 行创建 `[paste #1 +50 lines]` 标记）
- 编辑器上下的水平线
- 假光标渲染（隐藏真实光标）

**按键绑定：**
- `Enter` - 提交
- `Shift+Enter`、`Ctrl+Enter` 或 `Alt+Enter` - 换行（取决于终端，Alt+Enter 最可靠）
- `Tab` - 自动补全
- `Ctrl+K` - 删除到行尾
- `Ctrl+U` - 删除到行首
- `Ctrl+W` 或 `Alt+Backspace` - 向前删除一个词
- `Alt+D` 或 `Alt+Delete` - 向后删除一个词
- `Ctrl+A` / `Ctrl+E` - 行首/行尾
- `Ctrl+]` - 向前跳到字符（等待下一次按键，然后移动光标到第一个出现处）
- `Ctrl+Alt+]` - 向后跳到字符
- 方向键、Backspace、Delete 按预期工作

### Markdown

渲染 Markdown，带语法高亮和主题支持。

```typescript
interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
}

interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

const md = new Markdown(
  "# Hello\n\nSome **bold** text",
  1,              // paddingX
  1,              // paddingY
  theme,          // MarkdownTheme
  defaultStyle    // 可选的 DefaultTextStyle
);
md.setText("Updated markdown");
```

**特性：**
- 标题、粗体、斜体、代码块、列表、链接、引用块
- HTML 标签按纯文本渲染
- 通过 `highlightCode` 可选语法高亮
- 内边距支持
- 为性能做渲染缓存

### Loader

动画加载转轮。

```typescript
const loader = new Loader(
  tui,                              // 用于渲染更新的 TUI 实例
  (s) => chalk.cyan(s),            // 转轮颜色函数
  (s) => chalk.gray(s),            // 消息颜色函数
  "Loading..."                      // 消息（默认："Loading..."）
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader

扩展 Loader，带 Escape 键处理和一个用于取消异步操作的 AbortSignal。

```typescript
const loader = new CancellableLoader(
  tui,                              // 用于渲染更新的 TUI 实例
  (s) => chalk.cyan(s),            // 转轮颜色函数
  (s) => chalk.gray(s),            // 消息颜色函数
  "Working..."                      // 消息
);
loader.onAbort = () => done(null); // 用户按 Escape 时调用
doAsyncWork(loader.signal).then(done);
```

**属性：**
- `signal: AbortSignal` - 用户按 Escape 时中止
- `aborted: boolean` - 加载器是否已被中止
- `onAbort?: () => void` - 用户按 Escape 时的回调

### SelectList

交互式选择列表，带键盘导航。

```typescript
interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

const list = new SelectList(
  [
    { value: "opt1", label: "Option 1", description: "First option" },
    { value: "opt2", label: "Option 2", description: "Second option" },
  ],
  5,      // maxVisible
  theme   // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt"); // 过滤条目
```

**操作：**
- 鼠标移动/滚轮：备用屏模式下高亮行
- 点击：选择一行
- 方向键：导航
- Enter：选择
- Escape：取消

### SettingsList

设置面板，带值循环和子菜单。

```typescript
interface SettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];  // 提供时，Enter/Space 在这些值之间循环
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

const settings = new SettingsList(
  [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
  ],
  10,      // maxVisible
  theme,   // SettingsListTheme
  (id, newValue) => console.log(`${id} changed to ${newValue}`),
  () => console.log("Cancelled")
);
settings.updateValue("theme", "light");
```

**操作：**
- 鼠标移动/滚轮：备用屏模式下高亮行
- 点击：激活一行
- 方向键：导航
- Enter/Space：激活（循环值或打开子菜单）
- Escape：取消

### Spacer

用于垂直间距的空行。

```typescript
const spacer = new Spacer(2); // 2 个空行（默认：1）
```

### Image

为支持 Kitty 图形协议（Kitty、Ghostty、WezTerm）或 iTerm2 内联图片的终端内联渲染图片。在不支持的终端上退回到文本占位符。

```typescript
interface ImageTheme {
  fallbackColor: (str: string) => string;
}

interface ImageOptions {
  maxWidthCells?: number;
  maxHeightCells?: number;
  filename?: string;
}

const image = new Image(
  base64Data,       // base64 编码的图片数据
  "image/png",      // MIME 类型
  theme,            // ImageTheme
  options           // 可选的 ImageOptions
);
tui.addChild(image);
```

支持的格式：PNG、JPEG、GIF、WebP。尺寸自动从图片头解析。

#### 备用屏图片兼容性

`TuiAltScreen` 在实现 Kitty 图形协议的终端（包括 Kitty 和 Ghostty）中支持内联图片和部分视口裁剪。iTerm2 的内联图片协议没有提供删除已有放置、或在滚动时裁剪其源的操作。为防止残留的旧图片盖在重绘的内容上，`TuiAltScreen` 在 iTerm2 中把图片组件渲染为文本占位符。`TuiMainScreen` 继续正常渲染 iTerm2 内联图片。

## 自动补全

### CombinedAutocompleteProvider

同时支持斜杠命令和文件路径。

```typescript
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

const provider = new CombinedAutocompleteProvider(
  [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear screen" },
    { name: "delete", description: "Delete last message" },
  ],
  process.cwd() // 文件补全的基准路径
);

editor.setAutocompleteProvider(provider);
```

**特性：**
- 输入 `/` 查看斜杠命令
- 按 `Tab` 补全文件路径
- 支持 `~/`、`./`、`../` 和 `@` 前缀
- `@` 前缀时过滤为可附加的文件

## 按键检测

用 `matchesKey()` 配合 `Key` 辅助对象检测键盘输入（支持 Kitty 键盘协议）：

```typescript
import { matchesKey, Key } from "@earendil-works/pi-tui";

if (matchesKey(data, Key.ctrl("c"))) {
  process.exit(0);
}

if (matchesKey(data, Key.enter)) {
  submit();
} else if (matchesKey(data, Key.escape)) {
  cancel();
} else if (matchesKey(data, Key.up)) {
  moveUp();
}
```

**按键标识符**（用 `Key.*` 可获得自动补全，或用字符串字面量）：
- 基本按键：`Key.enter`、`Key.escape`、`Key.tab`、`Key.space`、`Key.backspace`、`Key.delete`、`Key.home`、`Key.end`
- 方向键：`Key.up`、`Key.down`、`Key.left`、`Key.right`
- 带修饰键：`Key.ctrl("c")`、`Key.shift("tab")`、`Key.alt("left")`、`Key.ctrlShift("p")`
- 字符串格式也可以：`"enter"`、`"ctrl+c"`、`"shift+tab"`、`"ctrl+shift+p"`

## 渲染模式

`TuiMainScreen` 使用三种渲染策略：

1. **首次渲染**：输出所有行，不清除回滚
2. **宽度变化或视口上方有变化**：清屏并完全重渲染
3. **常规更新**：把光标移到第一个变化的行，清除到末尾，渲染变化的行

`TuiAltScreen` 自有一个终端高度的视口。没有显式布局根时，它保留旧的单文档滚动行为。使用 `setLayoutRoot()` 后，`VStack`、`HStack` 和嵌套的 `ScrollView` 组件可以保留固定区域，并独立滚动受约束的区域。它原地更新变化的视口行，在底部时跟随流式输出，内容增长时保留手动选择的滚动位置。鼠标滚轮和可配置的键盘导航滚动时不修改终端回滚，包括在 OSC 133 语义提示符标记之间跳转。滚动条支持悬停展开、拖动滑块和点击轨道跳转。点击 OSC 8 超链接会用配置的 URL 处理器打开它。按住主键拖动选择文本，并且除非 `TuiAltScreenOptions.copyOnSelect` 为 `false`，会通过 OSC 52 复制到剪贴板；在滚动视图顶部或底部边缘按住拖动会自动滚动并把选区扩展到屏幕外内容。Kitty 图片支持垂直视口裁剪；iTerm2 内联图片退回到文本，因为 iTerm2 协议无法在视口重绘期间删除或裁剪放置。

两个渲染器都用**同步输出**（`\x1b[?2026h` ... `\x1b[?2026l`）包装更新，实现原子化、无闪烁渲染。

## 终端接口

TUI 可以与任何实现 `Terminal` 接口的对象配合：

```typescript
interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
}
```

**内置实现：**
- `ProcessTerminal` - 使用 `process.stdin/stdout`
- `VirtualTerminal` - 用于测试（使用 `@xterm/headless`）

## 工具函数

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// 获取字符串的可见宽度（忽略 ANSI 代码）
const width = visibleWidth("\x1b[31mHello\x1b[0m"); // 5

// 按宽度截断字符串（保留 ANSI 代码，加省略号）
const truncated = truncateToWidth("Hello World", 8); // "Hello..."

// 不带省略号截断
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, ""); // "Hello Wo"

// 按宽度换行（跨换行保留 ANSI 代码）
const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
// ["This is a long line", "that needs wrapping"]
```

## 创建自定义组件

创建自定义组件时，**`render()` 返回的每一行都不得超过 `width` 参数**。任何一行宽于终端时 TUI 都会报错。

### 处理输入

用 `matchesKey()` 配合 `Key` 辅助对象处理键盘输入：

```typescript
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

class MyInteractiveComponent implements Component {
  private selectedIndex = 0;
  private items = ["Option 1", "Option 2", "Option 3"];
  
  public onSelect?: (index: number) => void;
  public onCancel?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.selectedIndex);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    return this.items.map((item, i) => {
      const prefix = i === this.selectedIndex ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
  }

  invalidate(): void {}
}
```

### 处理行宽

用提供的工具函数确保行宽合适：

```typescript
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

class MyComponent implements Component {
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    // 方案一：截断长行
    return [truncateToWidth(this.text, width)];

    // 方案二：检查并填充到精确宽度
    const line = this.text;
    const visible = visibleWidth(line);
    if (visible > width) {
      return [truncateToWidth(line, width)];
    }
    // 填充到精确宽度（可选，用于背景）
    return [line + " ".repeat(width - visible)];
  }

  invalidate(): void {}
}
```

### ANSI 代码注意事项

`visibleWidth()` 和 `truncateToWidth()` 都能正确处理 ANSI 转义代码：

- `visibleWidth()` 计算宽度时忽略 ANSI 代码
- `truncateToWidth()` 保留 ANSI 代码，并在截断时正确闭合它们

```typescript
import chalk from "chalk";

const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled); // 11（不计 ANSI 代码）
const truncated = truncateToWidth(styled, 8); // 红色 "Hello" + " W..."，带正确的重置
```

### 缓存

为了性能，组件应缓存渲染输出，只在必要时重渲染：

```typescript
class CachedComponent implements Component {
  private text: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = [truncateToWidth(this.text, width)];

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

## 示例

完整聊天界面示例见 `test/chat-simple.ts`，包含：
- 带自定义背景色的 Markdown 消息
- 响应期间的加载转轮
- 带自动补全和斜杠命令的编辑器
- 消息之间的间隔

运行：
```bash
node test/chat-simple.ts
```

## 开发

```bash
# 安装依赖（在 monorepo 根目录）
npm install

# 运行类型检查
npm run check

# 运行演示
node test/chat-simple.ts
```

### 调试日志

设置 `PI_TUI_WRITE_LOG` 以捕获写入 stdout 的原始 ANSI 流。

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log node test/chat-simple.ts
```
