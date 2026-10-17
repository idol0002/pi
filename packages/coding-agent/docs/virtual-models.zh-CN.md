# 虚拟模型

虚拟模型是一个可选模型，它为每个请求挑选一个物理模型。用它按任务、成本或会话状态路由。例如，路由器可以把简单问题发给小模型、把难题发给大模型，而用户只选择一个模型。

从[扩展](extensions.zh-CN.md)注册虚拟模型。它们像其他模型一样出现在 `/model`、`--model`、范围模型和设置中。虚拟模型可以列在任何提供商下，包括有物理模型的提供商，如 `openai-codex/auto`。

## 选择与分发

虚拟模型选择一个模型和一个思考级别。路由器把该组合映射为每个请求的物理组合：

```
selected (virtual model, virtual level)  ->  dispatched (physical model, physical level)
jev/auto:low                             ->  anthropic/claude-sonnet-4-5:high
```

虚拟思考级别是路由器的输入。其含义由路由器决定；不必对应推理预算。

Pi 把两个组合分开保存：

| | 选择 | 分发 |
|---|---|---|
| 记录在 | `model_change` 和 `thinking_level_change` 条目 | 每条助手消息：`provider`、`api`、`model`、`thinkingLevel` |
| 可见于 | `ctx.model`、`ctx.thinkingLevel`、`PI_MODEL`、`PI_REASONING_LEVEL`、`/model` | 每个响应的助手消息 |

提供商只收到物理模型。助手消息标注物理模型，因此在不同物理模型之间重放对话与手动切换模型后的行为相同。恢复会话从其最新的 `model_change` 条目还原虚拟选择。如果虚拟模型不再注册，Pi 回退到最后回答的物理模型。

交互模式中，页脚在选择旁显示路由到的模型，例如 `auto • high → gpt-5.6-luna • medium`。`/session` 列出每个物理模型的成本。

上下文用量使用产生最新响应的物理模型的限制，即使该响应发生在切换到虚拟模型之前。没有这样的响应时，使用虚拟模型上声明的限制（如有）。压缩检查相同的限制，也检查每个请求被路由到的模型的限制。如果该模型的上下文窗口对对话太小，Pi 在发送请求前压缩；路由保持路由器的选择。

## 注册虚拟模型

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerVirtualModel({
    provider: "router",
    id: "auto",
    name: "Auto",
    thinkingLevels: ["low", "high"],
    route(request, ctx) {
      // 工具 follow-up 和重试保持在处理该轮次的模型上。
      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && sticky) {
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
      }
      const id = request.thinkingLevel === "high" ? "claude-sonnet-4-5" : "claude-haiku-4-5";
      return { model: ctx.modelRegistry.find("anthropic", id)!, thinkingLevel: "medium" };
    },
  });
}
```

- `provider` 是模型列出的提供商。可以是任何提供商 ID。一个提供商可以在其物理模型旁列出多个虚拟模型。在物理提供商上，该提供商有凭据时虚拟模型可用。在没有提供商使用的 ID 下，它始终可用。
- `id` 不得是该提供商某个物理模型的 ID。如果之后的目录刷新添加了同 ID 的物理模型，虚拟模型会隐藏它。
- `thinkingLevels` 列出可选的级别。默认 `["off"]`。
- `contextWindow` 和 `maxTokens` 在第一次响应前显示。未设置的限制为未知。
- `input` 列出可选的输入类型。默认为文本和图像；不支持图像的物理模型收到占位符。

注册遵循与 `pi.registerProvider()` 相同的排队和重载规则。再次注册相同提供商和 ID 会替换虚拟模型。`pi.unregisterVirtualModel(provider, id)` 移除它；`pi.unregisterProvider()` 不会。SDK 代码无需扩展即可注册：`modelRuntime.registerVirtualModel(definition)`。

## 路由请求

`route(request, ctx)` 在使用虚拟模型的每个请求之前运行，返回 `{ model, thinkingLevel }`。模型可以是目录中其提供商有凭据的任何物理模型；用 `ctx.modelRegistry` 查找。虚拟模型不能路由到另一个虚拟模型。Pi 把思考级别钳制到返回的模型。

| 字段 | 含义 |
|---|---|
| `model`、`thinkingLevel` | 所选虚拟模型和级别 |
| `reason` | 请求原因，见下 |
| `previous` | `messages` 中最新成功响应的物理模型和思考级别 |
| `failed` | `retry` 时：失败请求的物理模型、思考级别和助手 `message`，`messages` 已不含该消息。消息带 `stopReason` 和 `errorMessage`。路由本身失败时缺失 |
| `state` | 该会话分支上次返回的路由器状态，见下 |
| `messages` | 该请求的对话，包括系统消息 |
| `signal` | 请求的 abort signal |

| `reason` | 请求 |
|---|---|
| `user` | 用户写下的消息之后的第一条请求，包括 steering 和 follow-up 消息 |
| `continuation` | agent 循环中的其他请求，例如工具结果或扩展消息之后 |
| `retry` | 失败请求后的自动重试，包括上下文溢出压缩之后 |
| `direct` | agent 循环之外的请求，例如压缩摘要或扩展调用 `ctx.modelRegistry.streamSimple()` |

对 `continuation` 返回 `previous`、对 `retry` 返回 `failed` 可以保持提示词缓存和思考签名有效。允许在轮次间切换模型，但会失去提示词缓存。重试也可以切换到另一个模型，例如 `failed.message.errorMessage` 报告提供商过载或上下文溢出时。

如果 `route()` 抛出异常，或返回虚拟模型或没有凭据的模型，请求以错误响应结束。

## 保存路由状态

`route()` 可以在模型旁返回 `state`。Pi 把它存在会话分支上，并在后续请求中作为 `request.state` 传回。用于转录未记录的决策，如分类器结果或路由阶段：

```typescript
pi.registerVirtualModel<{ phase: "plan" | "build" }>({
  provider: "router",
  id: "phased",
  name: "Phased",
  route(request, ctx) {
    const state = request.state ?? { phase: "plan" };
    const id = state.phase === "plan" ? "claude-opus-4-5" : "claude-haiku-4-5";
    return { model: ctx.modelRegistry.find("anthropic", id)!, thinkingLevel: "medium", state };
  },
});
```

- 状态必须可 JSON 序列化。返回 `undefined` 或 `request.state` 本身保持当前状态。
- Pi 在请求发送前把返回的任何其他对象存为新状态，即使它等于当前状态。只在状态变化时返回新对象。请求之后失败时状态保持已存储。
- 状态跟随会话树，因此分叉和 `/tree` 导航看到其分支的状态。它在压缩后保留。
- `direct` 请求没有状态，Pi 忽略它们返回的状态。

转录已记录选择和每个分发模型，`ctx.sessionManager.getBranch()` 暴露两者。

路由器可以通过 `ctx.modelRegistry` 调用其他模型，例如用 `ctx.modelRegistry.findOfType("classifier", provider, id)` 得到的分类器模型调用 `ctx.modelRegistry.classify()`。该调用在轮次首个 token 之前增加延迟。

完整路由器见 [`jev-router.ts`](../examples/extensions/jev-router.ts)。它在 Jev 分类器选定的强 OpenAI Codex 模型上做计划，让该模型完成第一次编辑，然后一次性切换到更便宜的模型，接受一次提示词缓存未命中。它把阶段保存为路由器状态。
