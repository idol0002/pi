import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { ChatStore } from "../src/chat-store.ts";
import { migrate, openDatabase, seedDemo } from "../src/database.ts";
import { DocumentService } from "../src/documents.ts";
import { IngestionWorker } from "../src/ingestion.ts";
import { migrations } from "../src/migrations.ts";
import { KnowledgeStore } from "../src/store.ts";

const password = "local-test-password-only";

it("persists completed answers and source associations while recovering interrupted answers on restart", async () => {
	const temporaryRoot = resolve(tmpdir());
	const directory = await mkdtemp(join(temporaryRoot, "pi-knowledge-chat-persistence-"));
	assert.equal(dirname(directory), temporaryRoot);
	let database: PGlite | undefined;
	try {
		database = await openDatabase(join(directory, "pgdata"));
		await seedDemo(database, password);
		const conversation = await new KnowledgeStore(database).createConversation("user-alice", "发布流程", [
			"kb-engineering",
		]);
		const store = new ChatStore(database);
		const hits = await new DocumentService(database).search("user-alice", { query: "上线窗口" });
		const evidence = hits.map((source, index) => ({ ...source, number: index + 1, current: true }));
		const messageId = await store.begin("user-alice", conversation.id, "completed-run", "谁负责上线？", "demo");
		await store.complete(
			"user-alice",
			conversation.id,
			messageId,
			"由发布负责人安排上线窗口。[1]",
			null,
			evidence,
			new Set([1]),
		);
		await store.begin("user-alice", conversation.id, "unfinished-run", "还有哪些准备？", "demo");
		await database.close();
		database = undefined;
		database = await openDatabase(join(directory, "pgdata"));
		const reopened = new ChatStore(database);
		await reopened.recoverInterrupted();
		const history = await reopened.history("user-alice", conversation.id);
		assert.equal(history[1].content, "由发布负责人安排上线窗口。[1]");
		assert.equal(history[1].sources[0].chunkId, evidence[0].id);
		assert.equal(history[1].status, "complete");
		assert.equal(history[3].status, "error");
		assert.equal(history[3].errorCode, "interrupted");
	} finally {
		await database?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

it("persists data and never restores bootstrap permissions or passwords on restart", async () => {
	const temporaryRoot = resolve(tmpdir());
	const directory = await mkdtemp(join(temporaryRoot, "pi-knowledge-test-"));
	assert.equal(dirname(directory), temporaryRoot);
	try {
		const database = await openDatabase(join(directory, "pgdata"));
		let originalHash: string;
		try {
			assert.equal(await seedDemo(database, password), true);
			const users = await database.query<{ password_hash: string }>(
				"SELECT password_hash FROM app_users WHERE id = $1",
				["user-alice"],
			);
			originalHash = users.rows[0].password_hash;
			await database.query("DELETE FROM knowledge_base_grants WHERE knowledge_base_id = $1", ["kb-engineering"]);
			await database.query("UPDATE documents SET title = $1 WHERE id = $2", ["已修改的标题", "doc-engineering"]);
		} finally {
			await database.close();
		}
		const reopened = await openDatabase(join(directory, "pgdata"));
		try {
			await migrate(reopened);
			assert.equal(await seedDemo(reopened, "different-local-password"), false);
			const grants = await reopened.query("SELECT * FROM knowledge_base_grants WHERE knowledge_base_id = $1", [
				"kb-engineering",
			]);
			assert.equal(grants.rows.length, 0);
			const documents = await reopened.query<{ title: string }>("SELECT title FROM documents WHERE id = $1", [
				"doc-engineering",
			]);
			assert.equal(documents.rows[0].title, "已修改的标题");
			const users = await reopened.query<{ password_hash: string }>(
				"SELECT password_hash FROM app_users WHERE id = $1",
				["user-alice"],
			);
			assert.equal(users.rows[0].password_hash, originalHash);
			const migrations = await reopened.query<{ version: number }>(
				"SELECT version FROM schema_migrations ORDER BY version",
			);
			assert.deepEqual(migrations.rows, [
				{ version: 1 },
				{ version: 2 },
				{ version: 3 },
				{ version: 4 },
				{ version: 5 },
				{ version: 6 },
			]);
		} finally {
			await reopened.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("rejects a newer database schema and invalid bootstrap credentials", async () => {
	const database = await openDatabase();
	try {
		await assert.rejects(seedDemo(database, "short"), /12 到 256/);
		const users = await database.query("SELECT id FROM app_users");
		assert.equal(users.rows.length, 0);
		await database.query("INSERT INTO schema_migrations (version) VALUES ($1)", [999]);
		await assert.rejects(migrate(database), /数据库版本比应用新/);
	} finally {
		await database.close();
	}
});

it("upgrades phase-one documents to versioned searchable sources without changing grants", async () => {
	const database = new PGlite({ extensions: { vector } });
	try {
		await database.waitReady;
		await database.exec(migrations[0].sql);
		await database.exec(`
			CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
			INSERT INTO schema_migrations (version) VALUES (1);
			INSERT INTO app_users (id, username, display_name, password_hash) VALUES ('legacy-user', 'legacy', 'Legacy', 'unused');
			INSERT INTO user_groups (id, name) VALUES ('legacy-group', 'Legacy');
			INSERT INTO user_group_memberships VALUES ('legacy-user', 'legacy-group');
			INSERT INTO knowledge_bases (id, name, permission_version) VALUES ('legacy-kb', 'Legacy', 7);
			INSERT INTO knowledge_base_grants VALUES ('legacy-kb', 'legacy-group', 'viewer');
		`);
		const original = "# 历史发布流程\r\n\r\n升级后继续检索 releasearchive。\r\n";
		await database.query(
			"INSERT INTO documents (id, knowledge_base_id, title, version, source_text) VALUES ('legacy-doc', 'legacy-kb', '历史发布流程', 4, $1)",
			[original],
		);
		await migrate(database);
		const documents = new DocumentService(database);
		const hit = (await documents.search("legacy-user", { query: "releasearchive" }))[0];
		assert.equal(hit.documentId, "legacy-doc");
		assert.equal(hit.version, 4);
		const source = await new KnowledgeStore(database).readDocument("legacy-user", "legacy-doc");
		assert.equal(source.text, original.replaceAll("\r\n", "\n"));
		assert.deepEqual(
			Buffer.from((await documents.readOriginal("legacy-user", "legacy-doc", null)).content),
			Buffer.from(original),
		);
		await migrate(database);
		assert.equal((await documents.search("legacy-user", { query: "releasearchive" }))[0].id, hit.id);
		assert.equal((await documents.listVersions("legacy-user", "legacy-doc")).length, 1);
		const knowledgeBase = await new KnowledgeStore(database).getKnowledgeBase("legacy-user", "legacy-kb");
		assert.equal(knowledgeBase.permissionVersion, 7);
		assert.equal(knowledgeBase.role, "viewer");
	} finally {
		await database.close();
	}
});

it("recovers queued and interrupted uploads after restart while bounding retries and completing deletion", async () => {
	const temporaryRoot = resolve(tmpdir());
	const directory = await mkdtemp(join(temporaryRoot, "pi-knowledge-recovery-"));
	assert.equal(dirname(directory), temporaryRoot);
	let database: PGlite | undefined;
	let ingestion: IngestionWorker | undefined;
	try {
		database = await openDatabase(join(directory, "pgdata"));
		await seedDemo(database, password);
		const documents = new DocumentService(database);
		const receipts = [];
		for (const name of ["queued", "interrupted", "exhausted", "deleted"]) {
			receipts.push(
				await documents.upload(
					"user-alice",
					{ knowledgeBaseId: "kb-engineering" },
					{
						filename: `${name}.txt`,
						mediaType: "text/plain",
						content: Buffer.from(`durable${name}`),
					},
				),
			);
		}
		for (const [receipt, attempts] of [
			[receipts[1], 1],
			[receipts[2], 3],
		] as const) {
			await database.query("UPDATE ingestion_jobs SET status = 'processing', attempts = $2 WHERE id = $1", [
				receipt.jobId,
				attempts,
			]);
			await database.query("UPDATE document_versions SET status = 'processing' WHERE id = $1", [receipt.versionId]);
		}
		await documents.deleteDocument("user-alice", receipts[3].documentId);
		await database.close();
		database = undefined;
		database = await openDatabase(join(directory, "pgdata"));
		const errors: unknown[] = [];
		ingestion = new IngestionWorker(database, { onError: (error) => errors.push(error) });
		await ingestion.start();
		await ingestion.waitForIdle();
		assert.deepEqual(errors, []);
		const reopened = new DocumentService(database);
		const queued = await reopened.getJob("user-alice", receipts[0].jobId);
		assert.equal(queued.status, "succeeded");
		assert.equal(queued.attempts, 1);
		const recovered = await reopened.getJob("user-alice", receipts[1].jobId);
		assert.equal(recovered.status, "succeeded");
		assert.equal(recovered.attempts, 2);
		assert.equal((await reopened.getJob("user-alice", receipts[2].jobId)).status, "failed");
		assert.equal(
			(await reopened.search("user-alice", { query: "durableinterrupted" }))[0].versionId,
			receipts[1].versionId,
		);
		assert.deepEqual(await reopened.search("user-alice", { query: "durableexhausted durabledeleted" }), []);
		assert.equal(
			Buffer.from((await reopened.readOriginal("user-alice", receipts[1].documentId, null)).content).toString(),
			"durableinterrupted",
		);
		assert.deepEqual(
			(await database.query("SELECT id FROM document_versions WHERE document_id = $1", [receipts[3].documentId]))
				.rows,
			[],
		);
	} finally {
		await ingestion?.stop();
		await database?.close();
		await rm(directory, { recursive: true, force: true });
	}
});
