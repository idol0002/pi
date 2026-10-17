---
owner: davidbrai
---
# providers

pi-ai 如何与模型 API 通信。

包含：
- 请求构建与消息转换或重放：思考块、签名、工具调用 ID、角色。
- 工具 schema 转换（strict 模式、anyOf）。
- 流式传输、SSE 与 WebSocket 解析。
- 提供商错误分类、重试、上下文溢出检测。
- 从响应解析用量、prompt cache 头、缓存预热。
- 提供商认证：OAuth 登录流程、API key、auth.json、token 刷新。

不包含：
- 哪些模型存在、价格、上下文大小、模型选择：models。
- MCP OAuth：mcp。
- 压缩发送的内容：compaction。

示例：#9444, #10390, #9134, #10543, #10258, #8928, #9508.

通常不值得提交：新增提供商的请求（应作为扩展实现）、LiteLLM 等代理或网关的 bug、非标准提供商行为、无人遇到的理论性流边界情况。
