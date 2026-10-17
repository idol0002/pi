---
name: add-llm-provider
description: 向 packages/ai 新增 LLM 提供商的检查清单。涵盖核心类型、提供商实现、懒加载注册、模型生成、完整测试矩阵、coding-agent 接线和文档。
---

# 新增 LLM 提供商（packages/ai）

新增提供商会涉及多个文件。按顺序完成以下步骤。

## 1. 核心类型（`packages/ai/src/types.ts`）

- 在 `Api` 类型联合中加入 API 标识符（例如 `"bedrock-converse-stream"`）。
- 创建继承 `StreamOptions` 的选项接口。
- 在 `ApiOptionsMap` 中加入映射。
- 在 `KnownProvider` 类型联合中加入提供商名称。

## 2. 提供商实现（`packages/ai/src/providers/`）

创建提供商文件，导出：

- `stream<Provider>()`，返回 `AssistantMessageEventStream`。
- `streamSimple<Provider>()`，用于 `SimpleStreamOptions` 映射。
- 提供商专属的选项接口。
- 消息/工具转换函数。
- 发出标准化事件（`text`、`tool_call`、`thinking`、`usage`、`stop`）的响应解析。

## 3. 提供商导出与懒加载注册

- 在 `packages/ai/package.json` 中添加指向 `./dist/providers/<provider>.js` 的包子路径导出。
- 在 `packages/ai/src/index.ts` 中为需要从根入口保持可用的提供商选项类型添加 `export type` 再导出。
- 在 `packages/ai/src/providers/register-builtins.ts` 中通过懒加载包装器注册提供商；不要在那里静态导入提供商实现模块。
- 在 `packages/ai/src/env-api-keys.ts` 中添加凭据检测。

## 4. 模型生成（`packages/ai/scripts/generate-models.ts`）

- 添加从提供商来源拉取/解析模型的逻辑。
- 映射到标准化的 `Model` 接口。

## 5. 测试（`packages/ai/test/`）

- 始终把提供商加入 `stream.test.ts`，至少带一个代表性模型，即使它复用现有 API 实现（如 `openai-completions`）。
- 在适用的地方把提供商加入更广的测试矩阵：`tokens.test.ts`、`abort.test.ts`、`empty.test.ts`、`context-overflow.test.ts`、`unicode-surrogate.test.ts`、`tool-call-without-result.test.ts`、`image-tool-result.test.ts`、`total-tokens.test.ts`、`cross-provider-handoff.test.ts`。
- 对于 `cross-provider-handoff.test.ts`，至少添加一个提供商/模型组合。如果提供商有多个模型家族（例如 GPT 和 Claude），每个家族至少添加一个组合。
- 对于非标准认证，创建一个工具文件（例如 `bedrock-utils.ts`）处理凭据检测。

## 6. Coding Agent（`packages/coding-agent/`）

- `src/core/model-resolver.ts`：在 `defaultModelPerProvider` 中加入默认模型 ID。
- `src/core/provider-display-names.ts`：加入 API key 登录的显示名称，让 `/login` 及相关 UI 在内置 API key 认证时能显示该提供商。
- `src/cli/args.ts`：添加环境变量文档。
- `README.md`：添加提供商设置说明。
- `docs/providers.md`：添加设置说明、环境变量和 `auth.json` 键。

## 7. 文档

- `packages/ai/README.md`：加入提供商表格，说明选项/认证，添加环境变量。
- `packages/ai/CHANGELOG.md`：在 `## [Unreleased]` 下添加条目。
