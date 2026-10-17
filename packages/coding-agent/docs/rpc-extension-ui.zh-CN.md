# RPC 扩展 UI

扩展可以通过 `ctx.ui` 请求用户交互。在 RPC 模式中，受支持的调用变成一个请求/响应子协议，与正常的 [RPC 命令](rpc-commands.zh-CN.md)和[会话事件](json.zh-CN.md)并存。

扩展 UI 方法分两类：

- **对话框方法**（`select`、`confirm`、`input`、`editor`）：在 stdout 上发出 `extension_ui_request` 并阻塞，直到客户端在 stdin 上发回具有匹配 `id` 的 `extension_ui_response`。
- **即发即忘方法**（`notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`）：在 stdout 上发出 `extension_ui_request` 但不期待响应。客户端可以显示该信息或忽略它。

对话框方法带 `timeout` 字段时，超时到期后 agent 侧会用默认值自动 resolve。客户端不需要跟踪超时。

## 限制

一些 `ExtensionUIContext` 方法在 RPC 模式中不受支持或被降级，因为它们需要直接访问终端 UI：

- `custom()` 返回 `undefined`。
- `onTerminalInput()` 返回一个空操作的取消订阅函数。
- `setWorkingMessage()`、`setWorkingVisible()`、`setWorkingIndicator()`、`setHiddenThinkingLabel()`、`setFooter()`、`setHeader()`、`addAutocompleteProvider()`、`setEditorComponent()` 和 `setToolsExpanded()` 是空操作。
- `getEditorText()` 返回 `""`，`getEditorComponent()` 返回 `undefined`。
- `getToolsExpanded()` 返回 `false`。
- `pasteToEditor()` 委托给 `setEditorText()`，没有终端粘贴处理。
- `getAllThemes()` 返回 `[]`，`getTheme()` 返回 `undefined`。
- `setTheme()` 返回 `{ success: false, error: "Theme switching not supported in RPC mode" }`。

注意：RPC 模式中 `ctx.mode` 是 `"rpc"` 且 `ctx.hasUI` 为 `true`，因为对话框和即发即忘方法可以通过扩展 UI 子协议工作。用 `ctx.mode === "tui"` 保护需要真实终端的 TUI 专属功能（如 `custom()`）。

## 来自 Pi 的请求

所有请求都有 `type: "extension_ui_request"`、唯一的 `id` 和 `method` 字段。

### select

让用户从列表中选择。带 `timeout` 字段的对话框方法包含以毫秒计的超时；客户端未及时响应时，agent 用 `undefined` 自动 resolve。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

期望响应：带 `value`（所选选项字符串）或 `cancelled: true` 的 `extension_ui_response`。

### confirm

让用户做是/否确认。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

期望响应：带 `confirmed: true/false` 或 `cancelled: true` 的 `extension_ui_response`。

### input

让用户输入自由文本。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

期望响应：带 `value`（输入的文本）或 `cancelled: true` 的 `extension_ui_response`。

### editor

打开多行文本编辑器，可带预填内容。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

期望响应：带 `value`（编辑后的文本）或 `cancelled: true` 的 `extension_ui_response`。

### notify

显示通知。即发即忘，不期待响应。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

`notifyType` 字段是 `"info"`、`"warning"` 或 `"error"`。省略时默认 `"info"`。

### setStatus

设置或清除页脚/状态栏中的状态条目。即发即忘。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

发送 `statusText: undefined`（或省略）清除该 key 的状态条目。

### setWidget

设置或清除显示在编辑器上方或下方的部件（widget，一组文本行）。即发即忘。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

发送 `widgetLines: undefined`（或省略）清除部件。`widgetPlacement` 字段是 `"aboveEditor"`（默认）或 `"belowEditor"`。RPC 模式只支持字符串数组；组件工厂会被忽略。

### setTitle

设置终端窗口/标签页标题。即发即忘。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "pi - my project"
}
```

### set_editor_text

设置输入编辑器中的文本。即发即忘。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

## 发给 Pi 的响应

只有对话框方法（`select`、`confirm`、`input`、`editor`）发送响应。`id` 必须与请求匹配。

### 值响应（select、input、editor）

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

### 确认响应（confirm）

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

### 取消响应（任何对话框）

关闭任何对话框方法。扩展收到 `undefined`（select/input/editor）或 `false`（confirm）。

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## 示例

见受检查的 [RPC 扩展 UI 客户端](../examples/rpc-extension-ui.ts)及其[演示扩展](../examples/extensions/rpc-demo.ts)。

导出的请求和响应联合类型定义在 [`rpc-types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts)。与模式无关的扩展指导见[扩展](extensions.zh-CN.md#ui-and-modes)。
