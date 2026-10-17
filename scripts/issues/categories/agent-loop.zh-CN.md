---
owner: vegarsti
---
# agent-loop

packages/agent 和 AgentSession 中的回合（turn）执行。

包含：
- 回合生命周期与结算。
- 工具调用分发、并行工具批次。
- 孤立或不匹配的工具调用，中止或崩溃后丢失的结果。
- 中止与取消。
- Steering 与 follow-up 队列、prompt() 语义。
- 会话级重试、循环永远无法完成的停滞。

不包含：
- 提供商流解析：providers。
- 上下文限制与摘要：compaction。
- "事件 X 未发出" 或 "钩子无法做 Y"：extensions。

示例：#7053, #9306, #9986, #8331, #10017, #10289, #9783。
