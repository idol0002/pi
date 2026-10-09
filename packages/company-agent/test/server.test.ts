import assert from "node:assert/strict";
import { get as httpGet, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { SESSION_COOKIE, SESSION_TTL_MS } from "../src/auth.ts";
import { openDatabase, seedDemo } from "../src/database.ts";
import { IngestionWorker } from "../src/ingestion.ts";
import { createKnowledgeServer } from "../src/server.ts";
import type { Conversation, DocumentMetadata, KnowledgeBase } from "../src/types.ts";

const password = "local-test-password-only";

describe("knowledge API authorization", { concurrency: false }, () => {
	let database: PGlite;
	let server: Server | undefined;
	let ingestion: IngestionWorker;
	let baseUrl: string;
	let now: number;
	let unexpectedErrors: unknown[];

	before(async () => {
		database = await openDatabase();
	});
	beforeEach(async () => {
		await database.exec("TRUNCATE app_users, user_groups, knowledge_bases CASCADE");
		await seedDemo(database, password);
		now = Date.now();
		unexpectedErrors = [];
		ingestion = new IngestionWorker(database, { onError: (error) => unexpectedErrors.push(error) });
		await ingestion.start();
		server = await createKnowledgeServer(database, {
			ingestion,
			now: () => now,
			onError: (error) => unexpectedErrors.push(error),
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterEach(async () => {
		if (server?.listening) {
			const activeServer = server;
			await new Promise<void>((resolve, reject) => {
				activeServer.close((error) => (error ? reject(error) : resolve()));
				activeServer.closeAllConnections();
			});
		}
		await ingestion?.stop();
		assert.deepEqual(unexpectedErrors, []);
	});
	after(async () => {
		await database?.close();
	});

	async function request(
		path: string,
		options: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
	): Promise<Response> {
		const headers = new Headers(options.headers);
		if (options.cookie) headers.set("Cookie", options.cookie);
		if (options.body !== undefined) headers.set("Content-Type", "application/json");
		return fetch(`${baseUrl}${path}`, {
			method: options.method ?? "GET",
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
	}

	async function login(username: string): Promise<string> {
		const response = await request("/api/auth/login", { method: "POST", body: { username, password } });
		assert.equal(response.status, 200, await response.text());
		const cookie = response.headers.get("set-cookie");
		assert.ok(cookie);
		return cookie.split(";")[0];
	}

	it("requires a server-issued session and ignores forged identity headers", async () => {
		for (const path of [
			"/api/me",
			"/api/knowledge-bases",
			"/api/documents/doc-finance/source",
			"/api/conversations",
		]) {
			const response = await request(path, {
				headers: { "X-User-Id": "user-bob", "X-User-Groups": "group-finance" },
			});
			assert.equal(response.status, 401, path);
			assert.equal(response.headers.get("cache-control"), "no-store");
			await response.text();
		}
	});

	it("uses salted password hashes, opaque session cookies, and hashed stored tokens", async () => {
		const response = await request("/api/auth/login", { method: "POST", body: { username: "alice", password } });
		assert.equal(response.status, 200);
		const setCookie = response.headers.get("set-cookie");
		assert.ok(setCookie);
		assert.match(setCookie, /HttpOnly/);
		assert.match(setCookie, /SameSite=Strict/);
		const token = setCookie.split(";")[0].slice(SESSION_COOKIE.length + 1);
		assert.match(token, /^[A-Za-z0-9_-]{43}$/);
		const text = await response.text();
		assert.ok(!text.includes(password));
		assert.ok(!text.includes(token));
		assert.ok(!text.includes("passwordHash"));
		const users = await database.query<{ password_hash: string }>("SELECT password_hash FROM app_users");
		assert.notEqual(users.rows[0].password_hash, users.rows[1].password_hash);
		assert.ok(
			users.rows.every((user) => user.password_hash.startsWith("scrypt$") && !user.password_hash.includes(password)),
		);
		const sessions = await database.query<{ token_hash: string }>("SELECT token_hash FROM auth_sessions");
		assert.match(sessions.rows[0].token_hash, /^[a-f0-9]{64}$/);
		assert.notEqual(sessions.rows[0].token_hash, token);
	});

	it("returns the same credential error for an unknown account and an incorrect password", async () => {
		const errors: unknown[] = [];
		for (const username of ["alice", "does-not-exist"]) {
			const response = await request("/api/auth/login", {
				method: "POST",
				body: { username, password: "incorrect" },
			});
			assert.equal(response.status, 401);
			assert.equal(response.headers.get("set-cookie"), null);
			errors.push(await response.json());
		}
		assert.deepEqual(errors[0], errors[1]);
		const forged = await request("/api/me", { cookie: `${SESSION_COOKIE}=${"x".repeat(43)}` });
		assert.equal(forged.status, 401);
		await forged.text();
	});

	it("returns only each employee's knowledge base, documents, and source text", async () => {
		for (const [username, suffix] of [
			["alice", "engineering"],
			["bob", "finance"],
		]) {
			const cookie = await login(username);
			const response = await request("/api/knowledge-bases", { cookie });
			assert.equal(response.status, 200);
			const body = (await response.json()) as { knowledgeBases: KnowledgeBase[] };
			assert.deepEqual(
				body.knowledgeBases.map((base) => base.id),
				[`kb-${suffix}`],
			);
			assert.equal(body.knowledgeBases[0].role, "admin");
			const documents = await request(`/api/knowledge-bases/kb-${suffix}/documents`, { cookie });
			assert.equal(documents.status, 200);
			const result = (await documents.json()) as { documents: DocumentMetadata[] };
			assert.deepEqual(
				result.documents.map((document) => document.id),
				[`doc-${suffix}`],
			);
			assert.ok(!JSON.stringify(result).includes("source_text"));
			const source = await request(`/api/documents/doc-${suffix}/source`, { cookie });
			assert.equal(source.status, 200);
			assert.match(source.headers.get("content-type") ?? "", /^text\/plain/);
			assert.match(await source.text(), /合成示例/);
		}
	});

	it("blocks direct unauthorized IDs, source reads, and SQL-shaped IDs without revealing existence", async () => {
		const cookie = await login("alice");
		const missing = await request("/api/documents/does-not-exist", { cookie });
		const missingBody: unknown = await missing.json();
		for (const path of [
			"/api/knowledge-bases/kb-finance",
			"/api/knowledge-bases/kb-finance/documents",
			"/api/knowledge-bases/kb-finance/grants",
			"/api/documents/doc-finance",
			"/api/documents/doc-finance/source",
			`/api/documents/${encodeURIComponent("' OR '1'='1")}`,
		]) {
			const response = await request(path, { cookie });
			assert.equal(response.status, 404, path);
			assert.deepEqual(await response.json(), missingBody);
		}
	});

	it("enforces viewer permissions and revokes document and conversation access on existing sessions", async () => {
		const alice = await login("alice");
		const bob = await login("bob");
		const adminGrant = { groupId: "group-engineering", role: "admin" };
		const shared = await request("/api/knowledge-bases/kb-engineering/grants", {
			method: "PUT",
			cookie: alice,
			body: { grants: [adminGrant, { groupId: "group-finance", role: "viewer" }] },
		});
		assert.equal(shared.status, 200);
		assert.deepEqual(await shared.json(), { permissionVersion: 2 });
		const allowed = await request("/api/documents/doc-engineering/source", { cookie: bob });
		assert.equal(allowed.status, 200);
		await allowed.text();
		const forbidden = await request("/api/knowledge-bases/kb-engineering/grants", {
			method: "PUT",
			cookie: bob,
			body: { grants: [{ groupId: "group-finance", role: "admin" }] },
		});
		assert.equal(forbidden.status, 403);
		await forbidden.text();
		const grants = await request("/api/knowledge-bases/kb-engineering/grants", { cookie: bob });
		assert.equal(grants.status, 403);
		await grants.text();
		const created = await request("/api/conversations", {
			method: "POST",
			cookie: bob,
			body: { title: "研发资料", knowledgeBaseIds: ["kb-engineering"] },
		});
		assert.equal(created.status, 201);
		const { conversation } = (await created.json()) as { conversation: Conversation };
		const revoked = await request("/api/knowledge-bases/kb-engineering/grants", {
			method: "PUT",
			cookie: alice,
			body: { grants: [adminGrant] },
		});
		assert.equal(revoked.status, 200);
		await revoked.text();
		for (const path of [
			"/api/documents/doc-engineering",
			"/api/documents/doc-engineering/source",
			`/api/conversations/${conversation.id}`,
		]) {
			const response = await request(path, { cookie: bob });
			assert.equal(response.status, 404, path);
			await response.text();
		}
		const history = await request("/api/conversations", { cookie: bob });
		assert.deepEqual(await history.json(), { conversations: [] });
	});

	it("rejects invalid grants atomically and preserves a usable administrator", async () => {
		const cookie = await login("alice");
		for (const [grants, status] of [
			[[], 409],
			[[{ groupId: "group-engineering", role: "viewer" }], 409],
			[[{ groupId: "unknown", role: "admin" }], 400],
			[[{ groupId: "group-engineering", role: "superuser" }], 400],
			[
				[
					{ groupId: "group-engineering", role: "admin" },
					{ groupId: "group-engineering", role: "viewer" },
				],
				400,
			],
		] as const) {
			const response = await request("/api/knowledge-bases/kb-engineering/grants", {
				method: "PUT",
				cookie,
				body: { grants },
			});
			assert.equal(response.status, status);
			await response.text();
		}
		const response = await request("/api/knowledge-bases/kb-engineering", { cookie });
		assert.equal(response.status, 200);
		const { knowledgeBase } = (await response.json()) as { knowledgeBase: KnowledgeBase };
		assert.equal(knowledgeBase.permissionVersion, 1);
		assert.equal(knowledgeBase.role, "admin");
	});

	it("isolates conversation ownership and rejects untrusted ownership or knowledge scope", async () => {
		const alice = await login("alice");
		const bob = await login("bob");
		const response = await request("/api/conversations", {
			method: "POST",
			cookie: alice,
			body: { title: "发布流程", knowledgeBaseIds: ["kb-engineering"] },
		});
		assert.equal(response.status, 201);
		const { conversation } = (await response.json()) as { conversation: Conversation };
		const own = await request(`/api/conversations/${conversation.id}`, { cookie: alice });
		assert.equal(own.status, 200);
		await own.text();
		const other = await request(`/api/conversations/${conversation.id}`, { cookie: bob });
		assert.equal(other.status, 404);
		await other.text();
		const list = await request("/api/conversations", { cookie: bob });
		assert.deepEqual(await list.json(), { conversations: [] });
		for (const [body, expected] of [
			[{ title: "财务", knowledgeBaseIds: ["kb-finance"] }, 404],
			[{ title: "冒充员工", knowledgeBaseIds: ["kb-engineering"], userId: "user-bob" }, 400],
			[{ title: "重复范围", knowledgeBaseIds: ["kb-engineering", "kb-engineering"] }, 400],
		] as const) {
			const result = await request("/api/conversations", { method: "POST", cookie: alice, body });
			assert.equal(result.status, expected);
			await result.text();
		}
	});

	it("rechecks disabled users, group membership, and deleted documents", async () => {
		const alice = await login("alice");
		const bob = await login("bob");
		await database.query("UPDATE documents SET deleted = TRUE WHERE id = $1", ["doc-engineering"]);
		const deleted = await request("/api/documents/doc-engineering/source", { cookie: alice });
		assert.equal(deleted.status, 404);
		await deleted.text();
		await database.query("DELETE FROM user_group_memberships WHERE user_id = $1", ["user-bob"]);
		const bases = await request("/api/knowledge-bases", { cookie: bob });
		assert.deepEqual(await bases.json(), { knowledgeBases: [] });
		const removed = await request("/api/documents/doc-finance/source", { cookie: bob });
		assert.equal(removed.status, 404);
		await removed.text();
		await database.query("UPDATE app_users SET active = FALSE WHERE id = $1", ["user-alice"]);
		const disabled = await request("/api/me", { cookie: alice });
		assert.equal(disabled.status, 401);
		await disabled.text();
	});

	it("expires and revokes sessions", async () => {
		const cookie = await login("alice");
		const logout = await request("/api/auth/logout", { method: "POST", cookie, body: {} });
		assert.equal(logout.status, 204);
		assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
		const loggedOut = await request("/api/me", { cookie });
		assert.equal(loggedOut.status, 401);
		await loggedOut.text();
		const another = await login("alice");
		now += SESSION_TTL_MS + 1;
		const expired = await request("/api/me", { cookie: another });
		assert.equal(expired.status, 401);
		await expired.text();
	});

	it("rejects cross-origin calls, forged hosts, malformed JSON, and oversized input", async () => {
		const crossOrigin = await request("/api/auth/login", {
			method: "POST",
			body: { username: "alice", password },
			headers: { Origin: "https://untrusted.example" },
		});
		assert.equal(crossOrigin.status, 403);
		await crossOrigin.text();
		// fetch controls Host itself; use the HTTP client to exercise the actual wire header.
		const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
			const call = httpGet(`${baseUrl}/healthz`, { headers: { Host: "untrusted.example" } }, (response) => {
				response.resume();
				response.once("end", () => resolve(response.statusCode));
			});
			call.once("error", reject);
		});
		assert.equal(badHostStatus, 421);
		const malformed = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{",
		});
		assert.equal(malformed.status, 400);
		await malformed.text();
		const oversized = await request("/api/auth/login", {
			method: "POST",
			body: { username: "x".repeat(20_000), password },
		});
		assert.equal(oversized.status, 413);
		await oversized.text();
		const cookie = await login("alice");
		const valid = await request("/api/me", { cookie, headers: { Origin: baseUrl } });
		assert.equal(valid.status, 200);
		await valid.text();
	});

	it("limits concurrent failed login attempts", async () => {
		const responses = await Promise.all(
			Array.from({ length: 6 }, () =>
				request("/api/auth/login", {
					method: "POST",
					body: { username: "alice", password: "incorrect" },
				}),
			),
		);
		assert.deepEqual(responses.map((response) => response.status).sort(), [401, 401, 401, 401, 401, 429]);
		await Promise.all(responses.map((response) => response.text()));
		now += 600_001;
		await login("alice");
	});
});
