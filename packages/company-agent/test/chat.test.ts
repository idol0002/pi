import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { PGlite } from "@electric-sql/pglite";
import type { AnswerInput, AnswerModel } from "../src/answer-model.ts";
import { ChatService } from "../src/chat.ts";
import { openDatabase, seedDemo } from "../src/database.ts";
import { DocumentService } from "../src/documents.ts";
import { IngestionWorker } from "../src/ingestion.ts";
import { createKnowledgeServer } from "../src/server.ts";
import { KnowledgeStore } from "../src/store.ts";
import type { ChatEvent, ChatMessage, Conversation, UploadReceipt } from "../src/types.ts";

const password = "chat-contract-test-password";

describe("grounded knowledge chat", { concurrency: false }, () => {
	let database: PGlite;
	let server: Server;
	let chat: ChatService;
	let ingestion: IngestionWorker;
	let url: string;
	let alice: string;
	let bob: string;
	let inputs: AnswerInput[];
	let model: AnswerModel;
	let generate: AnswerModel["generate"];
	let errors: unknown[];

	before(async () => {
		database = await openDatabase();
	});
	beforeEach(async () => {
		await database.exec("TRUNCATE app_users, user_groups, knowledge_bases CASCADE");
		await seedDemo(database, password);
		inputs = [];
		errors = [];
		generate = async (input) => {
			const content = `${input.evidence[0].text} [1]`;
			await input.onText(content.slice(0, 8));
			await input.onText(content.slice(8));
			return { content, usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30 } };
		};
		model = {
			info: { mode: "demo", name: "contract-model" },
			timeoutMs: 5000,
			generate: (input) => {
				inputs.push(input);
				return generate(input);
			},
		};
		chat = new ChatService(database, model);
		ingestion = new IngestionWorker(database, { onError: (error) => errors.push(error) });
		await ingestion.start();
		server = await createKnowledgeServer(database, { chat, ingestion, onError: (error) => errors.push(error) });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		[alice, bob] = await Promise.all([login("alice"), login("bob")]);
	});
	afterEach(async () => {
		await chat.stop();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			server.closeAllConnections();
		});
		await ingestion.stop();
		assert.deepEqual(errors, []);
	});
	after(async () => {
		await database.close();
	});

	async function request(
		path: string,
		method = "GET",
		body?: unknown,
		cookie = alice,
		signal?: AbortSignal,
	): Promise<Response> {
		return fetch(`${url}${path}`, {
			method,
			headers: {
				...(cookie ? { Cookie: cookie } : {}),
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
		});
	}

	async function login(username: string): Promise<string> {
		const response = await request("/api/auth/login", "POST", { username, password }, "");
		assert.equal(response.status, 200);
		await response.text();
		return response.headers.get("set-cookie")!.split(";")[0];
	}

	async function conversation(cookie = alice, scope = "kb-engineering"): Promise<Conversation> {
		const response = await request(
			"/api/conversations",
			"POST",
			{ title: "知识问答", knowledgeBaseIds: [scope] },
			cookie,
		);
		assert.equal(response.status, 201);
		return ((await response.json()) as { conversation: Conversation }).conversation;
	}

	async function ask(id: string, content: string, cookie = alice, signal?: AbortSignal): Promise<Response> {
		return request(`/api/conversations/${id}/messages`, "POST", { content }, cookie, signal);
	}

	async function events(response: Response): Promise<ChatEvent[]> {
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
		return (await response.text())
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => JSON.parse(line.slice(6)) as ChatEvent);
	}

	function completed(result: ChatEvent[]): ChatMessage {
		const event = result.at(-1);
		assert.equal(event?.type, "done", JSON.stringify(event));
		assert.ok(event?.type === "done");
		return event.message;
	}

	async function history(id: string, cookie = alice): Promise<ChatMessage[]> {
		const response = await request(`/api/conversations/${id}`, "GET", undefined, cookie);
		assert.equal(response.status, 200);
		return ((await response.json()) as { messages: ChatMessage[] }).messages;
	}

	async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
		const deadline = Date.now() + 5000;
		while (!(await predicate())) {
			assert.ok(Date.now() < deadline, "condition did not settle");
			await delay(10);
		}
	}

	async function upload(text: string, documentId?: string): Promise<UploadReceipt> {
		const documents = new DocumentService(database);
		const receipt = await documents.upload(
			"user-alice",
			documentId ? { documentId } : { knowledgeBaseId: "kb-engineering" },
			{ filename: "manual.md", mediaType: "text/markdown", content: Buffer.from(text) },
		);
		ingestion.wake();
		await ingestion.waitForIdle();
		assert.equal((await documents.getJob("user-alice", receipt.jobId)).status, "succeeded");
		return receipt;
	}

	it("serves the same-origin UI and exposes only non-secret model configuration", async () => {
		const root = await request("/", "GET", undefined, "");
		assert.equal(root.status, 200);
		assert.match(root.headers.get("content-security-policy") ?? "", /script-src 'self'/);
		assert.match(root.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
		assert.match(await root.text(), /id="root"/);
		for (const name of ["app.js", "styles.css"]) {
			const asset = await request(`/assets/${name}`, "GET", undefined, "");
			assert.equal(asset.status, 200);
			await asset.text();
		}
		for (const path of ["/.env", "/assets/..%2f.env", "/assets/model-config.ts"]) {
			const response = await request(path);
			assert.equal(response.status, 404);
			await response.text();
		}
		assert.deepEqual(await (await request("/api/model")).json(), { model: { mode: "demo", name: "contract-model" } });
		assert.equal((await request("/api/model", "GET", undefined, "")).status, 401);
		const groups = await request("/api/knowledge-bases/kb-engineering/groups");
		assert.equal(groups.status, 200);
		assert.equal(((await groups.json()) as { groups: unknown[] }).groups.length, 2);
	});

	it("streams authorized evidence, persists messages and usage, and resolves citations to versioned source text", async () => {
		const created = await conversation();
		const result = await events(await ask(created.id, "上线窗口"));
		assert.equal(result[0].type, "start");
		assert.ok(result.some((event) => event.type === "status" && event.stage === "retrieving"));
		assert.ok(result.filter((event) => event.type === "delta").length >= 2);
		const answer = completed(result);
		assert.equal(answer.sources.length, 1);
		assert.equal(answer.sources[0].documentId, "doc-engineering");
		assert.equal(answer.usage?.totalTokens, 30);
		assert.ok(inputs[0].evidence.every((source) => source.knowledgeBaseId === "kb-engineering"));
		assert.ok(!JSON.stringify(inputs[0]).includes("费用报销"));
		const source = await request(answer.sources[0].sourceUrl);
		assert.equal(source.status, 200);
		assert.match(await source.text(), /上线窗口/);
		assert.deepEqual(
			(await history(created.id)).map((message) => message.role),
			["user", "assistant"],
		);
		assert.deepEqual((await history(created.id))[1], answer);
		const originalUrl = answer.sources[0].sourceUrl;
		await upload("# 新版发布\n\n新版窗口由值班主管安排。", "doc-engineering");
		const old = await request(originalUrl);
		assert.match(await old.text(), /发布负责人/);
		assert.equal((await history(created.id))[1].redacted, false);
		completed(await events(await ask(created.id, "新版窗口")));
		assert.deepEqual(inputs[1].history, []);
		assert.ok(inputs[1].evidence.every((source) => source.version === 2));
	});

	it("accepts a long natural-language question while bounding the keyword query", async () => {
		const created = await conversation();
		const question = `上线窗口 ${Array.from({ length: 100 }, (_, index) => `背景词${index}`).join(" ")}`;
		assert.ok(question.length > 300 && question.length < 2000);
		const answer = completed(await events(await ask(created.id, question)));
		assert.equal(answer.sources[0].documentId, "doc-engineering");
		assert.equal(inputs[0].question, question);
	});

	it("does not call the model when no authorized evidence exists", async () => {
		const created = await conversation();
		const result = completed(await events(await ask(created.id, "zzmissingwordqv")));
		assert.equal(inputs.length, 0);
		assert.match(result.content, /未在所选知识库中找到/);
		assert.deepEqual(result.sources, []);
		assert.equal(result.usage, null);
	});

	it("retrieves an uncited section for a topic-free follow-up and records retrieval diagnostics", async () => {
		const created = await conversation();
		await upload("# 差旅报销申请\n提交发票和差旅说明。\n\n## 审批时限\n审批在 5 个工作日内完成。");
		completed(await events(await ask(created.id, "如何申请差旅报销？")));
		const answer = completed(await events(await ask(created.id, "那多久能批？")));
		assert.match(answer.content, /5 个工作日/);
		assert.equal(answer.retrieval?.contextual, true);
		assert.equal(answer.retrieval?.method, "keyword");
		assert.ok((answer.retrieval?.durationMs ?? -1) >= 0);
		const before = inputs.length;
		const unrelated = completed(await events(await ask(created.id, "明天火星天气")));
		assert.equal(inputs.length, before);
		assert.deepEqual(unrelated.sources, []);
	});

	it("isolates ownership, model scopes and group administration, and rejects forged question fields", async () => {
		const created = await conversation();
		assert.equal((await ask(created.id, "上线", bob)).status, 404);
		assert.equal((await ask(created.id, "上线", "")).status, 401);
		for (const body of [
			{ content: "上线", knowledgeBaseIds: ["kb-finance"] },
			{ content: "上线", userId: "user-bob" },
			{ content: " " },
			{ content: "x".repeat(2001) },
		]) {
			const response = await request(`/api/conversations/${created.id}/messages`, "POST", body);
			assert.equal(response.status, 400);
			await response.text();
		}
		assert.equal((await history(created.id)).length, 0);
		assert.equal(inputs.length, 0);
		const own = await conversation(bob, "kb-finance");
		const answer = completed(await events(await ask(own.id, "费用报销", bob)));
		assert.equal(answer.sources[0].documentId, "doc-finance");
		assert.ok(inputs[0].evidence.every((source) => source.knowledgeBaseId === "kb-finance"));
		const store = new KnowledgeStore(database);
		await store.replaceGrants("user-alice", "kb-engineering", [
			{ groupId: "group-engineering", role: "admin" },
			{ groupId: "group-finance", role: "viewer" },
		]);
		assert.equal((await request("/api/knowledge-bases/kb-engineering/groups", "GET", undefined, bob)).status, 403);
	});

	it("tracks all context evidence, including uncited prior sources, and hides dependent history after cleanup", async () => {
		const created = await conversation();
		completed(await events(await ask(created.id, "上线窗口")));
		const uploaded = await upload("# oncallmanual\n\noncallmanual 的值班电话是 12345。");
		completed(await events(await ask(created.id, "oncallmanual")));
		assert.equal(inputs[1].history.length, 1);
		assert.ok(inputs[1].evidence.some((source) => source.documentId === "doc-engineering"));
		assert.ok(inputs[1].evidence.some((source) => source.documentId === uploaded.documentId));
		const removed = await request("/api/documents/doc-engineering", "DELETE");
		assert.equal(removed.status, 204);
		await ingestion.waitForIdle();
		const stored = await history(created.id);
		for (const answer of stored.filter((message) => message.role === "assistant")) {
			assert.equal(answer.redacted, true);
			assert.equal(answer.content, "");
			assert.deepEqual(answer.sources, []);
		}
		const associations = await database.query<{ count: number }>(
			"SELECT count(*)::int AS count FROM message_sources WHERE document_id = 'doc-engineering'",
		);
		assert.equal(associations.rows[0].count, 2);
		completed(await events(await ask(created.id, "oncallmanual")));
		assert.deepEqual(inputs[2].history, []);
		assert.ok(inputs[2].evidence.every((source) => source.documentId !== "doc-engineering"));
	});

	it("rechecks grants during streaming and prevents revoked history or continuation", async () => {
		const store = new KnowledgeStore(database);
		await store.replaceGrants("user-alice", "kb-engineering", [
			{ groupId: "group-engineering", role: "admin" },
			{ groupId: "group-finance", role: "viewer" },
		]);
		const created = await conversation(bob);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		generate = async (input) => {
			await input.onText("开始整理");
			await gate;
			await input.onText("revoked-private-sentinel");
			return { content: "revoked-private-sentinel [1]", usage: null };
		};
		const response = await ask(created.id, "上线窗口", bob);
		await waitUntil(() => inputs.length > 0);
		await store.replaceGrants("user-alice", "kb-engineering", [{ groupId: "group-engineering", role: "admin" }]);
		release();
		const result = await events(response);
		assert.equal(result.at(-1)?.type, "error");
		assert.ok(!JSON.stringify(result).includes("revoked-private-sentinel"));
		assert.equal((await request(`/api/conversations/${created.id}`, "GET", undefined, bob)).status, 404);
		assert.equal((await ask(created.id, "再说一遍", bob)).status, 404);
	});

	it("stops delivering content after logout", async () => {
		const created = await conversation();
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		generate = async (input) => {
			await gate;
			await input.onText("after-logout-private-sentinel");
			return { content: "after-logout-private-sentinel [1]", usage: null };
		};
		const response = await ask(created.id, "上线窗口");
		await waitUntil(() => inputs.length > 0);
		assert.equal((await request("/api/auth/logout", "POST", {})).status, 204);
		release();
		const result = await events(response);
		assert.equal(result.at(-1)?.type, "error");
		assert.ok(!JSON.stringify(result).includes("after-logout-private-sentinel"));
	});

	it("serializes each conversation, bounds user concurrency, and cancels only the owner's exact run", async () => {
		const created = await conversation();
		const another = await conversation();
		generate = async (input) =>
			new Promise((_resolve, reject) =>
				input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }),
			);
		const response = await ask(created.id, "上线窗口");
		await waitUntil(() => inputs.length > 0);
		assert.equal((await ask(created.id, "重复请求")).status, 409);
		assert.equal((await ask(another.id, "并发请求")).status, 429);
		const running = (await history(created.id)).find((message) => message.status === "running");
		assert.ok(running);
		assert.equal(
			(await request(`/api/conversations/${created.id}/runs/${running.runId}/cancel`, "POST", {}, bob)).status,
			404,
		);
		assert.equal((await request(`/api/conversations/${created.id}/runs/wrong-run/cancel`, "POST", {})).status, 404);
		assert.equal(
			(await request(`/api/conversations/${created.id}/runs/${running.runId}/cancel`, "POST", {})).status,
			204,
		);
		const result = await events(response);
		const last = result.at(-1);
		assert.ok(last?.type === "error" && last.code === "cancelled");
		assert.equal((await history(created.id))[1].status, "cancelled");
		generate = async () => ({ content: "已恢复回答。[1]", usage: null });
		completed(await events(await ask(created.id, "上线窗口")));
	});

	it("bounds time even if a model ignores cancellation, and aborts a disconnected browser's run", async () => {
		const created = await conversation();
		model.timeoutMs = 60;
		generate = async () => new Promise(() => {});
		const timedOut = (await events(await ask(created.id, "上线窗口"))).at(-1);
		assert.ok(timedOut?.type === "error" && timedOut.code === "model_timeout");
		assert.equal((await history(created.id))[1].status, "error");
		model.timeoutMs = 5000;
		const controller = new AbortController();
		const response = await ask(created.id, "上线窗口", alice, controller.signal);
		await waitUntil(() => inputs.length >= 2);
		controller.abort();
		await response.text().catch(() => {});
		await waitUntil(async () => !(await history(created.id)).some((message) => message.status === "running"));
		assert.equal((await history(created.id)).at(-1)?.status, "cancelled");
	});

	it("rejects nonexistent or missing citations and never saves a provider failure as a completed answer", async () => {
		const created = await conversation();
		for (const answer of ["模型错误引用。[99]", "没有来源的断言", "", "x".repeat(24_001)]) {
			generate = async () => ({ content: answer, usage: null });
			const result = await events(await ask(created.id, "上线窗口"));
			assert.equal(result.at(-1)?.type, "error");
			const last = (await history(created.id)).at(-1);
			assert.equal(last?.status, "error");
			assert.equal(last?.content, "");
		}
		generate = async () => {
			throw new Error("private-upstream-credential-sentinel");
		};
		const failed = await events(await ask(created.id, "上线窗口"));
		assert.ok(!JSON.stringify(failed).includes("private-upstream-credential-sentinel"));
		assert.equal(failed.at(-1)?.type, "error");
		generate = async () => ({ content: "现有资料不足以回答，请补充相关制度。", usage: null });
		const refusal = completed(await events(await ask(created.id, "上线窗口")));
		assert.deepEqual(refusal.sources, []);
	});

	it("reports a failed retrieval as an error instead of claiming there is no evidence", async () => {
		const created = await conversation();
		await database.exec("ALTER TABLE document_chunks RENAME COLUMN search_vector TO unavailable_search_vector");
		try {
			const result = await events(await ask(created.id, "上线窗口"));
			assert.equal(result.at(-1)?.type, "error");
			assert.ok(!JSON.stringify(result).includes("未在所选知识库中找到"));
			assert.equal(inputs.length, 0);
		} finally {
			await database.exec("ALTER TABLE document_chunks RENAME COLUMN unavailable_search_vector TO search_vector");
		}
	});

	it("recovers interrupted messages without replaying model requests", async () => {
		const created = await conversation();
		completed(await events(await ask(created.id, "上线窗口")));
		await chat.store.begin("user-alice", created.id, "interrupted-run", "追问", "contract-model");
		await chat.store.recoverInterrupted();
		const stored = await history(created.id);
		assert.equal(stored[1].status, "complete");
		assert.equal(stored[3].status, "error");
		assert.equal(stored[3].errorCode, "interrupted");
		assert.equal(inputs.length, 1);
	});
});
