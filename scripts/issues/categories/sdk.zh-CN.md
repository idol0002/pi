---
owner:
---
# sdk

嵌入 pi 与非交互模式。

包含：
- createAgentSession、AgentSession 公共 API、ModelRuntime。
- RPC 模式与 RpcClient。
- 打印与 JSON 模式（-p）、stdin 处理。
- pi-ai 与 agent-core 作为库使用：导出、子路径、打包、对宿主进程的全局副作用。

示例：#9787, #10470, #9718, #10415, #9537, #10315.

通常不值得提交：没有通用用例的宿主专属嵌入需求。
