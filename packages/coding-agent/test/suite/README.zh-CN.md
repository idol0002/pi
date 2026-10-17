# Coding agent 套件测试

`test/suite/` 是围绕 `AgentSession` 和 `AgentSessionRuntime` 的基于 harness 的新测试套件。

规则：
- 使用 `test/suite/harness.ts`
- 使用 `packages/ai/src/providers/faux.ts` 中的 faux 提供者
- 不使用真实的提供者 API、真实 API 密钥、网络调用或付费 token
- 保持这些测试对 CI 安全且确定
- 除非缺失的能力迫使你这么做，否则不要使用或扩展旧的 `test/test-harness.ts` 路径
