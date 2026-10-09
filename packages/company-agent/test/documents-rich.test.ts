import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase, seedDemo } from "../src/database.ts";
import { composeParsedDocument, type DocumentParser } from "../src/document-parser.ts";
import { IngestionWorker } from "../src/ingestion.ts";
import { createKnowledgeServer } from "../src/server.ts";
import type { ParsedDocument } from "../src/text-processing.ts";
import type { ChatEvent, DocumentPreview, IngestionJob, ParseWarning, SearchHit, UploadReceipt } from "../src/types.ts";

function parsed(text: string, warnings: ParseWarning[] = []): ParsedDocument {
	return composeParsedDocument(
		[
			{
				id: "p1",
				text,
				heading: "Release policy",
				kind: "paragraph",
				confidence: warnings.length ? 0.6 : null,
				location: {
					blockId: "p1",
					page: 1,
					box: [0.1, 0.1, 0.9, 0.3],
					method: warnings.length ? "ocr" : "text",
					label: "第 1 页",
				},
			},
		],
		[{ number: 1, width: 612, height: 792, method: warnings.length ? "ocr" : "text" }],
		warnings,
	);
}

describe("rich document ingestion, review and protected previews", { concurrency: false }, () => {
	let database: PGlite;
	let server: Server;
	let worker: IngestionWorker;
	let url: string;
	let alice: string;
	let bob: string;
	let parse: DocumentParser;
	let content: Uint8Array;
	let next: ParsedDocument;
	const errors: unknown[] = [];

	before(async () => {
		database = await openDatabase();
		content = await readFile(new URL("./fixtures/documents/text.pdf", import.meta.url));
	});
	beforeEach(async () => {
		await database.exec("TRUNCATE app_users, user_groups, knowledge_bases CASCADE");
		await seedDemo(database, "local-rich-document-password");
		errors.length = 0;
		next = parsed("atlasrich release window Friday 14:30.");
		parse = async (_content, _type, context) => {
			await context.progress({ stage: "extracting", processedPages: 1, totalPages: 1 });
			return next;
		};
		worker = new IngestionWorker(database, {
			parse: (bytes, type, context) => parse(bytes, type, context),
			onError: (error) => errors.push(error),
		});
		await worker.start();
		server = await createKnowledgeServer(database, { ingestion: worker, onError: (error) => errors.push(error) });
		await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		for (const name of ["alice", "bob"]) {
			const result = await request("/api/auth/login", "", "POST", {
				username: name,
				password: "local-rich-document-password",
			});
			assert.equal(result.status, 200);
			const cookie = result.headers.get("set-cookie")?.split(";")[0] ?? "";
			if (name === "alice") alice = cookie;
			else bob = cookie;
			await result.text();
		}
	});
	afterEach(async () => {
		await worker.stop();
		await new Promise<void>((ready) => {
			server.close(() => ready());
			server.closeAllConnections();
		});
		assert.deepEqual(errors, []);
	});
	after(async () => {
		await database.close();
	});

	function request(path: string, cookie = alice, method = "GET", body?: unknown): Promise<Response> {
		return fetch(url + path, {
			method,
			headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}
	async function upload(documentId?: string): Promise<UploadReceipt> {
		const form = new FormData();
		form.set("file", new File([content], "release.pdf", { type: "application/pdf" }));
		const response = await fetch(
			url + (documentId ? `/api/documents/${documentId}/versions` : "/api/knowledge-bases/kb-engineering/documents"),
			{
				method: "POST",
				headers: { Cookie: alice },
				body: form,
			},
		);
		assert.equal(response.status, 202, response.status === 202 ? "" : await response.text());
		const receipt = (await response.json()) as UploadReceipt;
		await worker.waitForIdle();
		return receipt;
	}
	async function job(receipt: UploadReceipt): Promise<IngestionJob> {
		const response = await request(`/api/ingestion-jobs/${receipt.jobId}`);
		return ((await response.json()) as { job: IngestionJob }).job;
	}
	async function search(query: string): Promise<SearchHit[]> {
		const response = await request("/api/search", alice, "POST", { query });
		assert.equal(response.status, 200);
		return ((await response.json()) as { hits: SearchHit[] }).hits;
	}
	async function grant(viewer: boolean): Promise<void> {
		const response = await request("/api/knowledge-bases/kb-engineering/grants", alice, "PUT", {
			grants: [
				{ groupId: "group-engineering", role: "admin" },
				...(viewer ? [{ groupId: "group-finance", role: "viewer" }] : []),
			],
		});
		assert.equal(response.status, 200);
		await response.text();
	}

	it("publishes PDF text with progress, protected page previews, and page-aware chat citations", async () => {
		const receipt = await upload();
		assert.equal((await job(receipt)).stage, "complete");
		assert.equal((await job(receipt)).processedPages, 1);
		const hit = (await search("atlasrich"))[0];
		assert.equal(hit.locations?.[0].page, 1);
		const response = await request(`/api/documents/${receipt.documentId}/preview?versionId=${receipt.versionId}`);
		const preview = (await response.json()) as DocumentPreview;
		assert.equal(preview.pages.length, 1);
		assert.equal(preview.blocks[0].location.blockId, "p1");
		assert.ok(preview.pdfUrl);
		const original = await request(preview.pdfUrl);
		assert.equal(original.headers.get("content-type"), "application/pdf");
		assert.deepEqual(Buffer.from(await original.arrayBuffer()), Buffer.from(content));
		const created = await request("/api/conversations", alice, "POST", {
			title: "PDF question",
			knowledgeBaseIds: ["kb-engineering"],
		});
		const { conversation } = (await created.json()) as { conversation: { id: string } };
		const answer = await request(`/api/conversations/${conversation.id}/messages`, alice, "POST", {
			content: "atlasrich release window",
		});
		const events = (await answer.text())
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => JSON.parse(line.slice(6)) as ChatEvent);
		const done = events.find((event) => event.type === "done");
		assert.equal(done?.type, "done");
		assert.deepEqual(done?.message.sources[0].locations, hit.locations);
		const saved = await request(`/api/conversations/${conversation.id}`);
		assert.match(await saved.text(), /"page":1/);
	});

	it("holds an OCR draft out of search, restricts review to editors, and publishes corrected text atomically", async () => {
		next = parsed("oldrichmarker");
		const first = await upload();
		next = parsed("uncorrectedmarker 14:3O", [{ page: 1, code: "low_ocr_confidence", message: "请核对时间" }]);
		const draft = await upload(first.documentId);
		assert.equal((await job(draft)).status, "needs_review");
		assert.equal((await search("oldrichmarker")).length, 1);
		assert.deepEqual(await search("uncorrectedmarker"), []);
		const path = `/api/documents/${first.documentId}`;
		const draftQuery = `?versionId=${draft.versionId}`;
		await grant(true);
		for (const route of ["/preview", "/pdf", "/download"]) {
			const denied = await request(path + route + draftQuery, bob);
			assert.equal(denied.status, 403);
			await denied.text();
		}
		const invalid = await request(`${path}/review`, alice, "POST", {
			versionId: draft.versionId,
			confirmed: true,
			changes: [{ blockId: "forged", text: "changed" }],
		});
		assert.equal(invalid.status, 400);
		await invalid.text();
		assert.equal((await job(draft)).status, "needs_review");
		const forbidden = await request(`${path}/review`, bob, "POST", {
			versionId: draft.versionId,
			confirmed: true,
			changes: [],
		});
		assert.equal(forbidden.status, 403);
		await forbidden.text();
		const approved = await request(`${path}/review`, alice, "POST", {
			versionId: draft.versionId,
			confirmed: true,
			changes: [{ blockId: "p1", text: "correctedmarker Friday 14:30" }],
		});
		assert.equal(approved.status, 204);
		assert.equal((await job(draft)).status, "succeeded");
		assert.deepEqual(await search("oldrichmarker"), []);
		const hit = (await search("correctedmarker"))[0];
		assert.equal(hit.version, 2);
		assert.equal(hit.locations?.[0].page, 1);
		const previous = await request(`${path}/source?versionId=${first.versionId}`);
		assert.match(await previous.text(), /oldrichmarker/);
		const reviewed = await database.query<{ reviewed_by: string }>(
			"SELECT reviewed_by FROM document_versions WHERE id = $1",
			[draft.versionId],
		);
		assert.equal(reviewed.rows[0].reviewed_by, "user-alice");
	});

	it("rechecks permissions for every PDF/preview read and hides deleted originals", async () => {
		const receipt = await upload();
		const base = `/api/documents/${receipt.documentId}`;
		for (const route of ["/preview", "/pdf"]) {
			const denied = await request(base + route, bob);
			assert.equal(denied.status, 404);
			await denied.text();
		}
		await grant(true);
		const shared = await request(`${base}/pdf`, bob);
		assert.equal(shared.status, 200);
		await shared.arrayBuffer();
		await grant(false);
		const revoked = await request(`${base}/pdf`, bob);
		assert.equal(revoked.status, 404);
		await revoked.text();
		const removed = await request(base, alice, "DELETE");
		assert.equal(removed.status, 204);
		await worker.waitForIdle();
		const deleted = await request(`${base}/preview?versionId=${receipt.versionId}`);
		assert.equal(deleted.status, 404);
		await deleted.text();
	});

	it("rejects approval of a superseded draft and leaves the current published version untouched", async () => {
		next = parsed("draftmarker", [{ page: 1, code: "low_ocr_confidence", message: "请复核" }]);
		const draft = await upload();
		next = parsed("newrichmarker");
		await upload(draft.documentId);
		const obsolete = await request(`/api/documents/${draft.documentId}/review`, alice, "POST", {
			versionId: draft.versionId,
			confirmed: true,
			changes: [],
		});
		assert.equal(obsolete.status, 409);
		await obsolete.text();
		assert.equal((await search("newrichmarker")).length, 1);
		assert.deepEqual(await search("draftmarker"), []);
	});
});
