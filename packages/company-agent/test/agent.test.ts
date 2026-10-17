import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type JsonObject,
	type TextContent,
} from "@earendil-works/pi-ai";
import type { PGlite } from "@electric-sql/pglite";
import { Type } from "typebox";
import { type AnswerEvidence, createAnswerModel, MAX_AGENT_TURNS } from "../src/answer-model.ts";
import { ChatService } from "../src/chat.ts";
import { publicMessage } from "../src/chat-store.ts";
import { restoreHistory } from "../src/conversation-context.ts";
import { openDatabase, seedDemo } from "../src/database.ts";
import { DocumentService } from "../src/documents.ts";
import { ApiError } from "../src/errors.ts";
import { IngestionWorker } from "../src/ingestion.ts";
import { readModelConfig } from "../src/model-config.ts";
import { KnowledgeStore } from "../src/store.ts";
import type { ChatEvent, ChatMessage } from "../src/types.ts";

type Reply = { text: string } | { tools: { name: string; args: JsonObject }[] };

/** 只替换模型输出来测试真实 Pi 循环；工具、钩子、状态和业务数据库均执行实际实现。 */
function scriptedModel(reply: (request: number, messages: readonly AgentMessage[]) => Reply) {
	let requests = 0;
	const contexts: AgentMessage[][] = [];
	const streamFn: StreamFn = (model, context) => {
		contexts.push(structuredClone(context.messages));
		const result = reply(++requests, context.messages);
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "text" in result ? "stop" : "toolUse",
			timestamp: Date.now(),
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		stream.push({ type: "start", partial: message });
		if ("text" in result) {
			const block: TextContent = { type: "text", text: "" };
			message.content.push(block);
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			block.text = result.text;
			stream.push({ type: "text_delta", contentIndex: 0, delta: result.text, partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: result.text, partial: message });
			stream.push({ type: "done", reason: "stop", message });
		} else {
			for (const [index, call] of result.tools.entries()) {
				const toolCall = {
					type: "toolCall" as const,
					id: "call-" + requests + "-" + index,
					name: call.name,
					arguments: call.args,
				};
				message.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
			}
			stream.push({ type: "done", reason: "toolUse", message });
		}
		stream.end(message);
		return stream;
	};
	const model = createAnswerModel(
		readModelConfig({
			KNOWLEDGE_MODEL_MODE: "openai",
			KNOWLEDGE_MODEL_NAME: "contract-model",
			KNOWLEDGE_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
			KNOWLEDGE_MODEL_API_KEY: "local-contract-only",
		}),
		{ streamFn },
	);
	return { model, contexts };
}

describe("Pi knowledge agent", { concurrency: false }, () => {
	let database: PGlite;
	before(async () => {
		database = await openDatabase();
	});
	beforeEach(async () => {
		await database.exec("TRUNCATE app_users, user_groups, knowledge_bases CASCADE");
		await seedDemo(database, "agent-contract-local-only");
	});
	after(async () => {
		await database.close();
	});

	async function conversation(userId = "user-alice") {
		return new KnowledgeStore(database).createConversation(userId, "Agent integration", ["kb-engineering"]);
	}
	async function execute(
		chat: ChatService,
		id: string,
		question = "上线窗口",
		userId = "user-alice",
		onEvent?: (event: ChatEvent) => Promise<void>,
	) {
		const events: ChatEvent[] = [];
		const run = await chat.prepare(userId, id, question, async () => {});
		await run.execute(async (event) => {
			events.push(event);
			await onEvent?.(event);
		});
		return events;
	}
	function answer(events: ChatEvent[]): ChatMessage {
		const done = events.at(-1);
		assert.ok(done?.type === "done", JSON.stringify(done));
		return done.message;
	}
	async function seedTurn(chat: ChatService, id: string, run: string, question: string, text: string) {
		const hits = await new DocumentService(database).search("user-alice", { query: "上线窗口" });
		const evidence = hits.map((source, index) => ({ ...source, number: index + 1, current: true }));
		const messageId = await chat.store.begin("user-alice", id, run, question, "history");
		await chat.store.complete("user-alice", id, messageId, text, null, evidence, new Set([1]));
	}
	async function upload(text: string, documentId?: string) {
		const documents = new DocumentService(database);
		const receipt = await documents.upload(
			"user-alice",
			documentId ? { documentId } : { knowledgeBaseId: "kb-engineering" },
			{ filename: "agent.md", mediaType: "text/markdown", content: Buffer.from(text) },
		);
		const worker = new IngestionWorker(database);
		try {
			await worker.start();
			await worker.waitForIdle();
		} finally {
			await worker.stop();
		}
		assert.equal((await documents.getJob("user-alice", receipt.jobId)).status, "succeeded");
		return receipt;
	}

	it("runs real Pi search/read turns in demo, persists the tool transcript, and exposes only a summary", async () => {
		const chat = new ChatService(database, createAnswerModel(readModelConfig({})));
		const created = await conversation();
		const events = await execute(chat, created.id);
		const result = answer(events);
		assert.equal(result.agent?.providerTurns, 3);
		assert.equal(result.agent?.toolCalls, 2);
		assert.deepEqual(
			result.agent?.steps.map((step) => step.tool),
			["knowledge_search", "knowledge_read"],
		);
		assert.equal(result.usage, null);
		assert.ok(events.some((event) => event.type === "agent" && event.phase === "tool_start"));
		const stored = (await chat.store.history("user-alice", created.id)).at(-1)!;
		assert.equal(stored.transcript?.filter((message) => message.role === "toolResult").length, 2);
		assert.equal(Object.hasOwn(publicMessage(stored), "transcript"), false);
		assert.equal(Object.hasOwn(publicMessage(stored), "evidence"), false);
		await assert.rejects(
			chat.store.history("user-bob", created.id),
			(error: unknown) => error instanceof ApiError && error.status === 404,
		);
	});

	it("restores more than two eligible turns as standard role messages without replaying old tools", async () => {
		const fake = scriptedModel(() => ({ text: "发布负责人安排。[1]" }));
		const chat = new ChatService(database, fake.model);
		const created = await conversation();
		for (let index = 0; index < 5; index++)
			await seedTurn(chat, created.id, "history-" + index, "先前约束 " + index, "有效回答 " + index + " [1]");
		const result = answer(await execute(chat, created.id));
		assert.equal(result.agent?.restoredTurns, 5);
		assert.equal(fake.contexts[0].filter((message) => message.role === "user").length, 6);
		assert.equal(fake.contexts[0].filter((message) => message.role === "assistant").length, 5);
		assert.match(JSON.stringify(fake.contexts[0]), /先前约束 0/);
		assert.equal(
			fake.contexts[0].some((message) => message.role === "toolResult"),
			false,
		);
	});

	it("continues search and read through Pi, totals usage across turns, and tracks uncited tool evidence", async () => {
		const extra = await upload("# emergency\n应急联系电话是 12345。");
		const fake = scriptedModel((request) =>
			request === 1
				? { tools: [{ name: "knowledge_search", args: { query: "emergency" } }] }
				: request === 2
					? { tools: [{ name: "knowledge_read", args: { numbers: [2] } }] }
					: { text: "应急联系电话为 12345。[2]" },
		);
		const chat = new ChatService(database, fake.model);
		const created = await conversation();
		const result = answer(await execute(chat, created.id));
		assert.equal(result.usage?.totalTokens, 36);
		assert.equal(result.sources[0].documentId, extra.documentId);
		assert.equal(result.sources[0].number, 2);
		assert.ok(
			fake.contexts[2].some((message) => message.role === "toolResult" && message.toolName === "knowledge_read"),
		);
		await new DocumentService(database).deleteDocument("user-alice", "doc-engineering");
		const hidden = (await chat.store.history("user-alice", created.id)).at(-1)!;
		assert.equal(hidden.redacted, true);
		assert.equal(hidden.transcript, undefined);
		assert.equal(hidden.agent, null);
		assert.equal(hidden.content, "");
	});

	it("uses Pi schema validation to reject forged knowledge scope before executing the tool", async () => {
		const fake = scriptedModel((request) =>
			request === 1
				? {
						tools: [
							{
								name: "knowledge_search",
								args: { query: "预算", knowledgeBaseIds: ["kb-finance"], userId: "user-bob" },
							},
						],
					}
				: { text: "按当前已有发布资料回答。[1]" },
		);
		const chat = new ChatService(database, fake.model);
		const result = answer(await execute(chat, (await conversation()).id));
		assert.equal(result.agent?.steps[0].status, "error");
		assert.ok(fake.contexts[1].some((message) => message.role === "toolResult" && message.isError));
		assert.doesNotMatch(JSON.stringify(fake.contexts), /费用报销流程/);
		assert.equal(result.sources[0].documentId, "doc-engineering");
	});

	it("recalls older eligible turns beyond the automatic context budget", async () => {
		const fake = scriptedModel((request) =>
			request === 1
				? { tools: [{ name: "conversation_recall", args: { query: "pastformat" } }] }
				: { text: "沿用之前约定的格式。[1]" },
		);
		const chat = new ChatService(database, fake.model);
		const created = await conversation();
		for (let index = 0; index < 6; index++)
			await seedTurn(
				chat,
				created.id,
				"recall-" + index,
				index === 0 ? "pastformat 的要求" : "后来讨论 " + index,
				(index === 0 ? "EARLY_FORMAT_VALUE " : "其他内容 ") + "说明".repeat(1200) + " [1]",
			);
		const result = answer(await execute(chat, created.id));
		assert.ok((result.agent?.restoredTurns ?? 0) < 6);
		assert.doesNotMatch(JSON.stringify(fake.contexts[0]), /EARLY_FORMAT_VALUE/);
		assert.match(JSON.stringify(fake.contexts[1]), /EARLY_FORMAT_VALUE/);
		assert.equal(result.agent?.steps[0].tool, "conversation_recall");
	});

	it("excludes superseded history both during restoration and explicit recall", async () => {
		const fake = scriptedModel((request) =>
			request === 1
				? { tools: [{ name: "conversation_recall", args: { query: "pastformat" } }] }
				: { text: "新版由值班主管负责。[1]" },
		);
		const chat = new ChatService(database, fake.model);
		const created = await conversation();
		await seedTurn(chat, created.id, "old-version", "pastformat 旧问题", "OLD_PRIVATE_FORMAT [1]");
		await upload("# 新版发布流程\n上线窗口由值班主管负责。", "doc-engineering");
		const result = answer(await execute(chat, created.id));
		assert.equal(result.agent?.restoredTurns, 0);
		assert.doesNotMatch(JSON.stringify(fake.contexts), /OLD_PRIVATE_FORMAT/);
		assert.equal(result.sources[0].version, 2);
	});

	it("rechecks permission before the next provider turn after a tool event", async () => {
		const knowledge = new KnowledgeStore(database);
		await knowledge.replaceGrants("user-alice", "kb-engineering", [
			{ groupId: "group-engineering", role: "admin" },
			{ groupId: "group-finance", role: "viewer" },
		]);
		const fake = scriptedModel(() => ({ tools: [{ name: "knowledge_read", args: { numbers: [1] } }] }));
		const chat = new ChatService(database, fake.model);
		const created = await conversation("user-bob");
		const result = await execute(chat, created.id, "上线窗口", "user-bob", async (event) => {
			if (event.type === "agent" && event.phase === "tool_end")
				await knowledge.replaceGrants("user-alice", "kb-engineering", [
					{ groupId: "group-engineering", role: "admin" },
				]);
		});
		assert.equal(result.at(-1)?.type, "error");
		assert.equal(fake.contexts.length, 1);
		assert.ok(!result.some((event) => event.type === "done"));
	});

	it("ends repeated tool requests at the provider-turn budget and frees the conversation", async () => {
		const fake = scriptedModel(() => ({ tools: [{ name: "knowledge_read", args: { numbers: [1] } }] }));
		const chat = new ChatService(database, fake.model);
		const created = await conversation();
		const result = await execute(chat, created.id);
		const failure = result.at(-1);
		assert.ok(failure?.type === "error" && failure.code === "agent_turn_limit");
		assert.equal(fake.contexts.length, MAX_AGENT_TURNS);
		const stored = (await chat.store.history("user-alice", created.id)).at(-1)!;
		assert.equal(stored.status, "error");
		assert.equal(stored.transcript, undefined);
		const next = await chat.prepare("user-alice", created.id, "上线窗口", async () => {});
		next.abort();
		await next.execute(async () => {});
	});

	it("ends a large batch at the tool-call budget", async () => {
		const fake = scriptedModel(() => ({
			tools: Array.from({ length: 4 }, () => ({ name: "knowledge_read", args: { numbers: [1] } })),
		}));
		const result = await execute(new ChatService(database, fake.model), (await conversation()).id);
		const failure = result.at(-1);
		assert.ok(failure?.type === "error" && failure.code === "agent_tool_limit");
		assert.equal(fake.contexts.length, 3);
	});

	it("never calls Pi or a provider for an independent question without authorized evidence", async () => {
		const fake = scriptedModel(() => {
			throw new Error("must not call provider");
		});
		const chat = new ChatService(database, fake.model);
		const result = answer(await execute(chat, (await conversation()).id, "zzmissingwordqv"));
		assert.match(result.content, /未在所选知识库/);
		assert.equal(fake.contexts.length, 0);
	});

	it("preserves the entire provenance set when an old answer cannot fit", async () => {
		const chat = new ChatService(database, createAnswerModel(readModelConfig({})));
		const created = await conversation();
		await seedTurn(chat, created.id, "oversized-history", "旧问题", "长".repeat(8001) + " [1]");
		const evidence: AnswerEvidence[] = [];
		assert.deepEqual(restoreHistory(await chat.store.history("user-alice", created.id), evidence), []);
		assert.deepEqual(evidence, []);
	});
});

it("propagates cancellation into a running Pi tool without another provider request", async () => {
	const controller = new AbortController();
	let cancelled = false;
	const parameters = Type.Object({}, { additionalProperties: false });
	const tool: AgentTool<typeof parameters> = {
		name: "knowledge_read",
		label: "阻塞测试",
		description: "local cancellation test",
		parameters,
		execute: async (_id, _parameters, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener(
					"abort",
					() => {
						cancelled = true;
						reject(new Error("tool stopped"));
					},
					{ once: true },
				);
				controller.abort(new Error("user cancelled"));
			}),
	};
	const fake = scriptedModel(() => ({ tools: [{ name: "knowledge_read", args: {} }] }));
	await assert.rejects(
		fake.model.generate({
			question: "cancel",
			history: [],
			evidence: [],
			tools: [tool],
			signal: controller.signal,
			onText: async () => {},
		}),
		/user cancelled/,
	);
	assert.equal(cancelled, true);
	assert.equal(fake.contexts.length, 1);
});
