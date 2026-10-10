import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase, seedDemo } from "../src/database.ts";
import { DocumentService } from "../src/documents.ts";
import type { EmbeddingModel } from "../src/embeddings.ts";
import { ApiError } from "../src/errors.ts";
import { IngestionWorker } from "../src/ingestion.ts";
import { RetrievalService } from "../src/retrieval.ts";
import { meaningfulTerms, planSearch } from "../src/search-query.ts";
import { KnowledgeStore } from "../src/store.ts";
import { VectorIndex } from "../src/vector-index.ts";

it("removes question filler, bounds long queries and carries only explicit follow-up context", () => {
	assert.deepEqual(meaningfulTerms("请问我们如何申请报销呢？"), ["申请", "报销"]);
	const plan = planSearch("那多久能批？", "如何申请差旅报销？");
	assert.equal(plan.contextual, true);
	assert.ok(plan.terms.includes("报销"));
	assert.ok(plan.expandedTerms.includes("工作日"));
	assert.equal(planSearch("发布流程是什么？", "如何申请报销？").contextual, false);
	assert.ok(planSearch(`上线窗口 ${"背景资料 ".repeat(300)}`).keywordQuery.length <= 300);
});

describe("permission-filtered lexical and vector retrieval", { concurrency: false }, () => {
	let database: PGlite;
	let worker: IngestionWorker;
	let documents: DocumentService;
	let model: EmbeddingModel;
	let index: VectorIndex;
	let service: RetrievalService;
	let calls: string[][];
	let beforeEmbed: (() => Promise<void>) | undefined;
	before(async () => {
		database = await openDatabase();
	});
	beforeEach(async () => {
		await database.exec("TRUNCATE app_users, user_groups, knowledge_bases, embedding_profiles CASCADE");
		await seedDemo(database, "retrieval-local-password");
		documents = new DocumentService(database);
		worker = new IngestionWorker(database);
		await worker.start();
		calls = [];
		beforeEmbed = undefined;
		model = {
			profileId: "test-vectors-v1",
			name: "test vectors",
			minSimilarity: 0.7,
			embed: async (input, signal) => {
				calls.push(input);
				await beforeEmbed?.();
				signal.throwIfAborted();
				return input.map((text) =>
					/差旅|交通|打车|网约车/.test(text) ? [1, 0, 0] : /发布|上线|代码/.test(text) ? [0, 1, 0] : [0, 0, 1],
				);
			},
		};
		index = new VectorIndex(database, model);
		service = new RetrievalService(database, index);
	});
	afterEach(async () => {
		await index.stop();
		await worker.stop();
	});
	after(async () => {
		await database.close();
	});

	async function upload(text: string, base = "kb-engineering", documentId?: string) {
		const receipt = await documents.upload(
			base === "kb-finance" ? "user-bob" : "user-alice",
			documentId ? { documentId } : { knowledgeBaseId: base },
			{
				filename: "policy.md",
				title: text.split("\n")[0].replace(/^# /, ""),
				mediaType: "text/markdown",
				content: Buffer.from(text),
			},
		);
		worker.wake();
		await worker.waitForIdle();
		return receipt;
	}

	it("ranks query coverage ahead of generic matches and deduplicates copied excerpts", async () => {
		const correct = await upload("# 差旅报销\n差旅报销审批由财务负责人处理。");
		await upload("# 负责人\n发布负责人安排上线窗口。");
		await upload("# 差旅报销\n差旅报销审批由财务负责人处理。");
		const result = await new RetrievalService(database).search("user-alice", { query: "谁负责差旅报销审批？" });
		assert.ok(result.hits.some((hit) => hit.documentId === correct.documentId || hit.title === "差旅报销"));
		assert.equal(result.hits.length, 1);
		assert.equal(result.method, "keyword");
		const missing = await new RetrievalService(database).search("user-alice", { query: "谁负责年会场地布置？" });
		assert.deepEqual(missing.hits, []);
	});

	it("finds vector-only paraphrases and never returns another group's nearest matches", async () => {
		const allowed = await upload("# 差旅交通费\n差旅交通费可凭有效凭证报销。");
		await upload("# 财务交通预算\n财务组内部交通预算为 90000 元。", "kb-finance");
		await index.indexPending(new AbortController().signal);
		assert.deepEqual(await documents.search("user-alice", { query: "打车" }), []);
		const result = await service.search("user-alice", { query: "打车" });
		assert.equal(result.method, "hybrid");
		assert.equal(result.hits[0].documentId, allowed.documentId);
		assert.ok(result.hits.every((hit) => hit.knowledgeBaseId === "kb-engineering"));
		calls.length = 0;
		await assert.rejects(
			service.search("user-bob", { query: "打车", knowledgeBaseIds: ["kb-engineering"] }),
			(error: unknown) => error instanceof ApiError && error.status === 404,
		);
		assert.equal(calls.length, 0);
	});

	it("reports incomplete indexing instead of inventing a no-evidence result", async () => {
		await upload("# 差旅交通费\n差旅交通费可凭有效凭证报销。");
		const pending = await service.search("user-alice", { query: "差旅交通费" });
		assert.equal(pending.method, "keyword");
		assert.match(pending.note ?? "", /更新/);
		await assert.rejects(
			service.search("user-alice", { query: "打车" }),
			(error: unknown) => error instanceof ApiError && error.code === "semantic_index_pending",
		);
		await index.indexPending(new AbortController().signal);
		assert.equal((await service.search("user-alice", { query: "打车" })).method, "hybrid");
	});

	it("does not index unpublished drafts or resurrect a document deleted during embedding", async () => {
		const removed = await upload("# 差旅交通费\n交通费报销条件。");
		beforeEmbed = async () => {
			beforeEmbed = undefined;
			await documents.deleteDocument("user-alice", removed.documentId);
		};
		await index.indexPending(new AbortController().signal);
		const rows = await database.query(
			"SELECT e.chunk_id FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE c.version_id = $1",
			[removed.versionId],
		);
		assert.deepEqual(rows.rows, []);
		const draft = await upload("# 待复核交通费\n候选制度。");
		await database.query("UPDATE document_versions SET status = 'needs_review' WHERE id = $1", [draft.versionId]);
		await index.indexPending(new AbortController().signal);
		const unreviewed = await database.query(
			"SELECT e.chunk_id FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE c.version_id = $1",
			[draft.versionId],
		);
		assert.deepEqual(unreviewed.rows, []);
	});

	it("isolates embedding model revisions and rechecks grants after a provider call", async () => {
		await upload("# 差旅交通费\n交通费报销条件。");
		await index.indexPending(new AbortController().signal);
		const next = new VectorIndex(database, {
			...model,
			profileId: "test-vectors-v2",
			embed: async (input) => input.map(() => [1, 0]),
		});
		await next.indexPending(new AbortController().signal);
		assert.ok((await new RetrievalService(database, next).search("user-alice", { query: "打车" })).hits.length > 0);
		const store = new KnowledgeStore(database);
		await store.replaceGrants("user-alice", "kb-engineering", [
			{ groupId: "group-engineering", role: "admin" },
			{ groupId: "group-finance", role: "viewer" },
		]);
		beforeEmbed = async () => {
			beforeEmbed = undefined;
			await store.replaceGrants("user-alice", "kb-engineering", [{ groupId: "group-engineering", role: "admin" }]);
		};
		const result = await service.search("user-bob", { query: "打车", knowledgeBaseIds: ["kb-engineering"] });
		assert.deepEqual(result.hits, []);
		await next.stop();
	});

	it("pauses configuration failures without repeatedly sending the same document batch", async () => {
		let attempts = 0;
		const broken = new VectorIndex(database, {
			...model,
			embed: async () => {
				attempts++;
				throw new ApiError(502, "embedding_configuration", "配置错误");
			},
		});
		broken.start();
		await broken.waitForIdle();
		broken.wake();
		await broken.waitForIdle();
		assert.equal(attempts, 1);
		assert.match((await broken.coverage("user-alice", null)).failure ?? "", /暂停/);
		await broken.stop();
	});
});
