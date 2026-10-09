import assert from "node:assert/strict";
import { File } from "node:buffer";
import { createHash } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase, seedDemo } from "../src/database.ts";
import { DocumentService, MAX_PENDING_JOBS } from "../src/documents.ts";
import { ApiError } from "../src/errors.ts";
import { type IngestionOptions, IngestionWorker } from "../src/ingestion.ts";
import { createKnowledgeServer } from "../src/server.ts";
import { MAX_DOCUMENT_BYTES, parseTextDocument } from "../src/text-processing.ts";
import type {
	DocumentChunk,
	DocumentMetadata,
	DocumentVersion,
	IngestionJob,
	SearchHit,
	UploadReceipt,
} from "../src/types.ts";

const password = "local-test-password-only";
const engineeringUpload = "/api/knowledge-bases/kb-engineering/documents";
const adminGrant = { groupId: "group-engineering", role: "admin" };

describe("document ingestion and retrieval", { concurrency: false }, () => {
	let database: PGlite;
	let server: Server;
	let ingestion: IngestionWorker;
	let baseUrl: string;
	let alice: string;
	let bob: string;
	let parse: NonNullable<IngestionOptions["parse"]>;
	let releaseProcessing: (() => void) | undefined;
	let errors: unknown[];

	before(async () => {
		database = await openDatabase();
	});
	beforeEach(async () => {
		await database.exec("TRUNCATE app_users, user_groups, knowledge_bases CASCADE");
		await seedDemo(database, password);
		parse = (content, mediaType) => parseTextDocument(content, mediaType);
		releaseProcessing = undefined;
		errors = [];
		ingestion = new IngestionWorker(database, {
			parse: (content, mediaType, context) => parse(content, mediaType, context),
			onError: (error) => errors.push(error),
		});
		await ingestion.start();
		server = await createKnowledgeServer(database, { ingestion, onError: (error) => errors.push(error) });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		alice = await login("alice");
		bob = await login("bob");
	});
	afterEach(async () => {
		releaseProcessing?.();
		if (server?.listening) {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
		}
		await ingestion?.stop();
		assert.deepEqual(errors, []);
	});
	after(async () => {
		await database?.close();
	});

	async function request(
		path: string,
		options: { method?: string; cookie?: string; body?: unknown; form?: FormData } = {},
	): Promise<Response> {
		const headers = new Headers();
		if (options.cookie) headers.set("Cookie", options.cookie);
		if (options.body !== undefined) headers.set("Content-Type", "application/json");
		return fetch(`${baseUrl}${path}`, {
			method: options.method ?? "GET",
			headers,
			body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
		});
	}

	async function login(username: string): Promise<string> {
		const response = await request("/api/auth/login", { method: "POST", body: { username, password } });
		assert.equal(response.status, 200, await response.text());
		const cookie = response.headers.get("set-cookie");
		assert.ok(cookie);
		return cookie.split(";")[0];
	}

	function uploadForm(
		content: string | Uint8Array = "# 手册\n发布负责人安排上线窗口。",
		filename = "guide.md",
		title?: string,
	): FormData {
		const form = new FormData();
		form.append(
			"file",
			new File([content], filename, { type: filename.endsWith(".txt") ? "text/plain" : "text/markdown" }),
		);
		if (title !== undefined) form.append("title", title);
		return form;
	}

	async function upload(form = uploadForm(), path = engineeringUpload, cookie = alice): Promise<UploadReceipt> {
		const response = await request(path, { method: "POST", cookie, form });
		assert.equal(response.status, 202, response.status === 202 ? undefined : await response.text());
		return (await response.json()) as UploadReceipt;
	}

	async function search(query: string, cookie = alice, knowledgeBaseIds?: string[]): Promise<SearchHit[]> {
		const response = await request("/api/search", { method: "POST", cookie, body: { query, knowledgeBaseIds } });
		assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
		const result = (await response.json()) as { method: string; hits: SearchHit[] };
		assert.equal(result.method, "keyword");
		return result.hits;
	}

	async function getJob(receipt: UploadReceipt): Promise<IngestionJob> {
		const response = await request(`/api/ingestion-jobs/${receipt.jobId}`, { cookie: alice });
		assert.equal(response.status, 200);
		return ((await response.json()) as { job: IngestionJob }).job;
	}

	async function shareEngineering(role: "viewer" | "editor" | null): Promise<void> {
		const response = await request("/api/knowledge-bases/kb-engineering/grants", {
			method: "PUT",
			cookie: alice,
			body: { grants: role ? [adminGrant, { groupId: "group-finance", role }] : [adminGrant] },
		});
		assert.equal(response.status, 200, await response.text());
	}

	function pauseParser(): { entered: Promise<void>; resume: () => void } {
		const entered = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>();
		releaseProcessing = paused.resolve;
		parse = async (content, mediaType) => {
			entered.resolve();
			await paused.promise;
			return parseTextDocument(content, mediaType);
		};
		return { entered: entered.promise, resume: paused.resolve };
	}

	it("uploads, indexes, searches, locates normalized text, and downloads the exact original", async () => {
		const original =
			"\uFEFF# 发布手册\r\n\r\n发布负责人安排上线窗口。\r\n\r\n## 回滚步骤\r\n运行 ROLLBACK 命令。\r\n";
		const receipt = await upload(uploadForm(original, "发布流程.md", "发布规范"));
		assert.equal(receipt.status, "queued");
		await ingestion.waitForIdle();
		assert.equal((await getJob(receipt)).status, "succeeded");
		assert.equal((await getJob(receipt)).attempts, 1);
		const metadataResponse = await request(`/api/documents/${receipt.documentId}`, { cookie: alice });
		const { document } = (await metadataResponse.json()) as { document: DocumentMetadata };
		assert.equal(document.status, "ready");
		assert.equal(document.version, 1);
		assert.equal(document.currentVersionId, receipt.versionId);
		assert.equal(document.latestJobId, receipt.jobId);
		assert.ok(!JSON.stringify(document).includes("上线窗口"));
		const versionsResponse = await request(`/api/documents/${receipt.documentId}/versions`, { cookie: alice });
		const { versions } = (await versionsResponse.json()) as { versions: DocumentVersion[] };
		assert.equal(versions[0].filename, "发布流程.md");
		assert.equal(versions[0].sha256, createHash("sha256").update(original).digest("hex"));
		assert.equal(versions[0].sizeBytes, Buffer.byteLength(original));
		assert.equal(versions[0].chunkCount, 2);
		assert.ok(!JSON.stringify(versions).includes("运行 ROLLBACK"));
		const hits = await search("上线窗口");
		assert.equal(hits[0].documentId, receipt.documentId);
		assert.equal(hits[0].versionId, receipt.versionId);
		assert.equal(hits[0].heading, "发布手册");
		assert.equal(hits[0].startLine, 1);
		assert.ok(hits[0].score > 0);
		const rollback = (await search("rollback"))[0];
		assert.equal(rollback.heading, "发布手册 / 回滚步骤");
		assert.equal(rollback.startLine, 5);
		const source = await request(rollback.sourceUrl, { cookie: alice });
		assert.equal(source.status, 200);
		assert.equal(source.headers.get("x-document-version"), receipt.versionId);
		assert.equal((await source.text()).trimEnd(), rollback.text.trimEnd());
		const full = await request(`/api/documents/${receipt.documentId}/source`, { cookie: alice });
		const normalized = await full.text();
		assert.equal(normalized.slice(rollback.startOffset, rollback.endOffset), rollback.text);
		const chunk = await request(`/api/document-chunks/${rollback.id}`, { cookie: alice });
		assert.equal(((await chunk.json()) as { chunk: DocumentChunk }).chunk.text, rollback.text);
		const download = await request(`/api/documents/${receipt.documentId}/download`, { cookie: alice });
		assert.equal(download.status, 200);
		assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
		assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(original));
	});

	it("persists queued uploads without making unprocessed content readable", async () => {
		await ingestion.stop();
		const receipt = await upload(uploadForm("pendinguniqueword", "pending.txt"));
		assert.equal((await getJob(receipt)).status, "queued");
		const result = await request(`/api/documents/${receipt.documentId}`, { cookie: alice });
		const { document } = (await result.json()) as { document: DocumentMetadata };
		assert.equal(document.version, null);
		assert.equal(document.currentVersionId, null);
		assert.equal(document.status, "queued");
		const source = await request(`/api/documents/${receipt.documentId}/source`, { cookie: alice });
		assert.equal(source.status, 404);
		await source.text();
		assert.deepEqual(await search("pendinguniqueword"), []);
		await ingestion.start();
		await ingestion.waitForIdle();
		assert.equal((await search("pendinguniqueword"))[0].documentId, receipt.documentId);
	});

	it("filters retrieval by current permissions and rechecks every source after revocation", async () => {
		const receipt = await upload(uploadForm("# 机密工程\nsharedsearchmarker 研发资料。"));
		const finance = await upload(
			uploadForm("sharedsearchmarker 财务资料。", "finance.txt"),
			"/api/knowledge-bases/kb-finance/documents",
			bob,
		);
		await ingestion.waitForIdle();
		assert.deepEqual(
			(await search("sharedsearchmarker")).map((hit) => hit.documentId),
			[receipt.documentId],
		);
		assert.deepEqual(
			(await search("sharedsearchmarker", bob)).map((hit) => hit.documentId),
			[finance.documentId],
		);
		const hit = (await search("sharedsearchmarker"))[0];
		const resources = [
			`/api/documents/${receipt.documentId}`,
			`/api/documents/${receipt.documentId}/versions`,
			`/api/documents/${receipt.documentId}/download?versionId=${receipt.versionId}`,
			`/api/ingestion-jobs/${receipt.jobId}`,
			`/api/document-chunks/${hit.id}`,
			hit.sourceUrl,
		];
		for (const path of resources) {
			const denied = await request(path, { cookie: bob });
			assert.equal(denied.status, 404, path);
			await denied.text();
		}
		await shareEngineering("viewer");
		assert.equal((await search("sharedsearchmarker", bob)).length, 2);
		assert.deepEqual(
			(await search("sharedsearchmarker", bob, ["kb-engineering"])).map((result) => result.documentId),
			[receipt.documentId],
		);
		await shareEngineering(null);
		for (const path of resources) {
			const denied = await request(path, { cookie: bob });
			assert.equal(denied.status, 404, path);
			await denied.text();
		}
		assert.deepEqual(
			(await search("sharedsearchmarker", bob)).map((result) => result.documentId),
			[finance.documentId],
		);
		const scope = await request("/api/search", {
			method: "POST",
			cookie: bob,
			body: { query: "sharedsearchmarker", knowledgeBaseIds: ["kb-finance", "kb-engineering"] },
		});
		assert.equal(scope.status, 404);
		await scope.text();
		await database.query("UPDATE knowledge_bases SET active = FALSE WHERE id = 'kb-finance'");
		assert.deepEqual(await search("sharedsearchmarker", bob), []);
	});

	it("requires editor access for uploads, updates, retries, and deletion", async () => {
		const receipt = await upload();
		await ingestion.waitForIdle();
		for (const cookie of [undefined, bob]) {
			const denied = await request(engineeringUpload, { method: "POST", cookie, form: uploadForm() });
			assert.equal(denied.status, cookie ? 404 : 401);
			await denied.text();
		}
		await shareEngineering("viewer");
		for (const [path, method, form, body] of [
			[engineeringUpload, "POST", uploadForm(), undefined],
			[`/api/documents/${receipt.documentId}/versions`, "POST", uploadForm(), undefined],
			[`/api/documents/${receipt.documentId}`, "DELETE", undefined, undefined],
			[`/api/ingestion-jobs/${receipt.jobId}/retry`, "POST", undefined, {}],
		] as const) {
			const denied = await request(path, { method, cookie: bob, form, body });
			assert.equal(denied.status, 403, path);
			await denied.text();
		}
		await shareEngineering("editor");
		const allowed = await upload(uploadForm("editorword"), engineeringUpload, bob);
		await ingestion.waitForIdle();
		assert.equal((await search("editorword", bob))[0].documentId, allowed.documentId);
	});

	it("keeps the old version live until an update commits, while historical citations stay stable", async () => {
		const first = await upload(uploadForm("# 原制度\noldversionmarker", "policy.md", "原制度"));
		await ingestion.waitForIdle();
		const oldHit = (await search("oldversionmarker"))[0];
		const paused = pauseParser();
		const second = await upload(
			uploadForm("# 新制度\nnewversionmarker", "policy.md", "新制度"),
			`/api/documents/${first.documentId}/versions`,
		);
		await paused.entered;
		const pending = await request(`/api/documents/${first.documentId}`, { cookie: alice });
		const metadata = ((await pending.json()) as { document: DocumentMetadata }).document;
		assert.equal(metadata.status, "processing");
		assert.equal(metadata.version, 1);
		assert.equal(metadata.currentVersionId, first.versionId);
		assert.equal(metadata.latestVersionId, second.versionId);
		assert.equal(metadata.title, "原制度");
		assert.equal((await search("oldversionmarker")).length, 1);
		assert.deepEqual(await search("newversionmarker"), []);
		const concurrent = await request(`/api/documents/${first.documentId}/versions`, {
			method: "POST",
			cookie: alice,
			form: uploadForm("third"),
		});
		assert.equal(concurrent.status, 409);
		await concurrent.text();
		paused.resume();
		await ingestion.waitForIdle();
		assert.deepEqual(await search("oldversionmarker"), []);
		const newHit = (await search("newversionmarker"))[0];
		assert.equal(newHit.version, 2);
		assert.equal(newHit.title, "新制度");
		const oldSource = await request(oldHit.sourceUrl, { cookie: alice });
		assert.match(await oldSource.text(), /oldversionmarker/);
		const oldChunk = await request(`/api/document-chunks/${oldHit.id}`, { cookie: alice });
		assert.equal(oldChunk.status, 200);
		await oldChunk.text();
		const wrongDocument = await request(`/api/documents/doc-engineering/source?versionId=${first.versionId}`, {
			cookie: alice,
		});
		assert.equal(wrongDocument.status, 404);
		await wrongDocument.text();
	});

	it("records failures, retries the same version, and retains the working source", async () => {
		const first = await upload(uploadForm("workingmarker"));
		await ingestion.waitForIdle();
		parse = () => {
			throw new ApiError(422, "temporary_failure", "模拟解析失败");
		};
		const failed = await upload(uploadForm("replacementmarker"), `/api/documents/${first.documentId}/versions`);
		await ingestion.waitForIdle();
		assert.equal((await getJob(failed)).status, "failed");
		assert.equal((await getJob(failed)).error, "模拟解析失败");
		assert.equal((await search("workingmarker")).length, 1);
		assert.deepEqual(await search("replacementmarker"), []);
		const failedSource = await request(`/api/documents/${first.documentId}/source?versionId=${failed.versionId}`, {
			cookie: alice,
		});
		assert.equal(failedSource.status, 404);
		await failedSource.text();
		parse = (content, mediaType) => parseTextDocument(content, mediaType);
		const retry = await request(`/api/ingestion-jobs/${failed.jobId}/retry`, {
			method: "POST",
			cookie: alice,
			body: {},
		});
		assert.equal(retry.status, 202);
		assert.equal(((await retry.json()) as UploadReceipt).versionId, failed.versionId);
		await ingestion.waitForIdle();
		assert.equal((await getJob(failed)).attempts, 2);
		assert.equal((await getJob(failed)).status, "succeeded");
		assert.equal((await search("replacementmarker")).length, 1);
		assert.deepEqual(await search("workingmarker"), []);
		const duplicateRetry = await request(`/api/ingestion-jobs/${failed.jobId}/retry`, {
			method: "POST",
			cookie: alice,
			body: {},
		});
		assert.equal(duplicateRetry.status, 409);
		await duplicateRetry.text();
	});

	it("bounds retries for invalid UTF-8 and rejects retries of superseded failures", async () => {
		const failed = await upload(uploadForm(new Uint8Array([0xc3, 0x28]), "bad.txt"));
		await ingestion.waitForIdle();
		for (let attempt = 2; attempt <= 3; attempt++) {
			const retry = await request(`/api/ingestion-jobs/${failed.jobId}/retry`, {
				method: "POST",
				cookie: alice,
				body: {},
			});
			assert.equal(retry.status, 202);
			await retry.text();
			await ingestion.waitForIdle();
			assert.equal((await getJob(failed)).attempts, attempt);
			assert.match((await getJob(failed)).error ?? "", /UTF-8/);
		}
		const exhausted = await request(`/api/ingestion-jobs/${failed.jobId}/retry`, {
			method: "POST",
			cookie: alice,
			body: {},
		});
		assert.equal(exhausted.status, 409);
		assert.equal(((await exhausted.json()) as { error: { code: string } }).error.code, "retry_limit");
		await upload(uploadForm("repairedmarker", "fixed.txt"), `/api/documents/${failed.documentId}/versions`);
		await ingestion.waitForIdle();
		assert.equal((await search("repairedmarker"))[0].version, 2);
		const obsolete = await request(`/api/ingestion-jobs/${failed.jobId}/retry`, {
			method: "POST",
			cookie: alice,
			body: {},
		});
		assert.equal(obsolete.status, 409);
		assert.equal(((await obsolete.json()) as { error: { code: string } }).error.code, "invalid_retry");
	});

	it("rolls back all chunks and the active version when index publication fails", async () => {
		const first = await upload(uploadForm("workingmarker"));
		await ingestion.waitForIdle();
		parse = (content, mediaType) => {
			const parsed = parseTextDocument(content, mediaType);
			return { text: parsed.text, chunks: [parsed.chunks[0], parsed.chunks[0]] };
		};
		const failed = await upload(uploadForm("rollbackmarker"), `/api/documents/${first.documentId}/versions`);
		await ingestion.waitForIdle();
		assert.equal(errors.length, 1);
		errors.length = 0;
		assert.equal((await getJob(failed)).error, "文档处理失败，请重试");
		assert.deepEqual(
			(await database.query("SELECT id FROM document_chunks WHERE version_id = $1", [failed.versionId])).rows,
			[],
		);
		assert.equal((await search("workingmarker")).length, 1);
		assert.deepEqual(await search("rollbackmarker"), []);
	});

	it("immediately hides deleted content and cannot resurrect it when parsing finishes", async () => {
		const first = await upload(uploadForm("deletedmarker"));
		await ingestion.waitForIdle();
		const hit = (await search("deletedmarker"))[0];
		const paused = pauseParser();
		const update = await upload(uploadForm("resurrectionmarker"), `/api/documents/${first.documentId}/versions`);
		await paused.entered;
		const removed = await request(`/api/documents/${first.documentId}`, { method: "DELETE", cookie: alice });
		assert.equal(removed.status, 204);
		assert.deepEqual(await search("deletedmarker"), []);
		for (const path of [
			hit.sourceUrl,
			`/api/document-chunks/${hit.id}`,
			`/api/documents/${first.documentId}/download`,
			`/api/ingestion-jobs/${update.jobId}`,
		]) {
			const response = await request(path, { cookie: alice });
			assert.equal(response.status, 404);
			await response.text();
		}
		paused.resume();
		await ingestion.waitForIdle();
		assert.deepEqual(await search("resurrectionmarker"), []);
		assert.deepEqual(
			(await database.query("SELECT id FROM document_versions WHERE document_id = $1", [first.documentId])).rows,
			[],
		);
		assert.deepEqual(
			(await database.query("SELECT id FROM ingestion_jobs WHERE document_id = $1", [first.documentId])).rows,
			[],
		);
		const tombstone = await database.query<{ deleted: boolean; source_text: string }>(
			"SELECT deleted, source_text FROM documents WHERE id = $1",
			[first.documentId],
		);
		assert.deepEqual(tombstone.rows, [{ deleted: true, source_text: "" }]);
	});

	it("rejects malformed, unsupported, oversized uploads and untrusted query fields", async () => {
		const duplicate = uploadForm();
		duplicate.append("file", new File(["another"], "another.md"));
		const forged = uploadForm();
		forged.append("userId", "user-bob");
		const duplicateTitle = uploadForm("text", "test.md", "one");
		duplicateTitle.append("title", "two");
		const html = new FormData();
		html.append("file", new File(["<html>text</html>"], "page.md", { type: "text/html" }));
		for (const [form, expected] of [
			[uploadForm("", "empty.txt"), 400],
			[uploadForm("PDF", "document.pdf"), 415],
			[uploadForm("text", "test.md", " "), 400],
			[uploadForm("text", "test.md", "x".repeat(201)), 400],
			[uploadForm(new Uint8Array(MAX_DOCUMENT_BYTES + 1), "huge.txt"), 413],
			[duplicate, 400],
			[forged, 400],
			[duplicateTitle, 400],
			[html, 415],
		] as const) {
			const response = await request(engineeringUpload, { method: "POST", cookie: alice, form });
			assert.equal(response.status, expected);
			await response.text();
		}
		const malformed = await fetch(`${baseUrl}${engineeringUpload}`, {
			method: "POST",
			headers: { Cookie: alice, "Content-Type": "multipart/form-data; boundary=absent" },
			body: "not multipart",
		});
		assert.equal(malformed.status, 400);
		await malformed.text();
		for (const body of [
			{ query: "" },
			{ query: "   " },
			{ query: "---" },
			{ query: "x".repeat(301) },
			{ query: "发布", limit: 0 },
			{ query: "发布", limit: 21 },
			{ query: "发布", limit: "5" },
			{ query: "发布", knowledgeBaseIds: [] },
			{ query: "发布", knowledgeBaseIds: ["kb-engineering", "kb-engineering"] },
			{ query: "发布", knowledgeBaseIds: [1] },
			{ query: "发布", userId: "user-bob" },
		]) {
			const response = await request("/api/search", { method: "POST", cookie: alice, body });
			assert.equal(response.status, 400, JSON.stringify(body));
			await response.text();
		}
		assert.deepEqual(await search("'); DROP TABLE documents; --"), []);
		const invalidLines = await request("/api/documents/doc-engineering/source?startLine=2&endLine=1", {
			cookie: alice,
		});
		assert.equal(invalidLines.status, 400);
		await invalidLines.text();
	});

	it("enforces streamed request limits without trusting Content-Length", async () => {
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const call = httpRequest(
				`${baseUrl}${engineeringUpload}`,
				{
					method: "POST",
					headers: { Cookie: alice, "Content-Type": "multipart/form-data; boundary=large" },
				},
				(response) => {
					response.resume();
					response.once("end", () => resolve(response.statusCode));
				},
			);
			call.once("error", reject);
			call.write(Buffer.alloc(MAX_DOCUMENT_BYTES, "x"));
			call.end(Buffer.alloc(17 * 1024, "x"));
		});
		assert.equal(status, 413);
	});

	it("bounds the durable queue and rejects overflow without leaving an orphan document", async () => {
		await ingestion.stop();
		const documents = new DocumentService(database);
		for (let index = 0; index < MAX_PENDING_JOBS; index++) {
			await documents.upload(
				"user-alice",
				{ knowledgeBaseId: "kb-engineering" },
				{ filename: `${index}.txt`, mediaType: "text/plain", content: Buffer.from("queued") },
			);
		}
		const overflow = await request(engineeringUpload, { method: "POST", cookie: alice, form: uploadForm() });
		assert.equal(overflow.status, 429);
		await overflow.text();
		const count = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM documents");
		assert.equal(count.rows[0].count, MAX_PENDING_JOBS + 2);
	});
});
