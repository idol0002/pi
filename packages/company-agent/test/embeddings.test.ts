import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { createEmbeddingModel, validateEmbeddings } from "../src/embeddings.ts";
import { ApiError } from "../src/errors.ts";

it("keeps embeddings off until explicitly configured and validates endpoint settings", () => {
	assert.equal(createEmbeddingModel({}), undefined);
	assert.equal(
		createEmbeddingModel({ KNOWLEDGE_EMBEDDING_MODE: "off", KNOWLEDGE_EMBEDDING_API_KEY: "unused" }),
		undefined,
	);
	const env = {
		KNOWLEDGE_EMBEDDING_MODE: "openai",
		KNOWLEDGE_EMBEDDING_NAME: "company-embedding",
		KNOWLEDGE_EMBEDDING_BASE_URL: "https://gateway.example/v1",
		KNOWLEDGE_EMBEDDING_API_KEY: "test-only-key",
	};
	assert.ok(createEmbeddingModel(env));
	for (const change of [
		{ KNOWLEDGE_EMBEDDING_API_KEY: "" },
		{ KNOWLEDGE_EMBEDDING_NAME: "" },
		{ KNOWLEDGE_EMBEDDING_BASE_URL: "http://unapproved.example/v1" },
		{ KNOWLEDGE_EMBEDDING_BASE_URL: "https://gateway.example/v1/embeddings" },
		{ KNOWLEDGE_EMBEDDING_BASE_URL: "https://gateway.example/v1?key=secret" },
		{ KNOWLEDGE_EMBEDDING_DIMENSIONS: "0" },
		{ KNOWLEDGE_EMBEDDING_TIMEOUT_MS: "10" },
	])
		assert.throws(() => createEmbeddingModel({ ...env, ...change }));
	assert.notEqual(
		createEmbeddingModel(env)?.profileId,
		createEmbeddingModel({ ...env, KNOWLEDGE_EMBEDDING_REVISION: "2" })?.profileId,
	);
	assert.equal(
		createEmbeddingModel(env)?.profileId,
		createEmbeddingModel({ ...env, KNOWLEDGE_EMBEDDING_API_KEY: "rotated-key" })?.profileId,
	);
	assert.ok(!JSON.stringify(createEmbeddingModel(env)).includes("test-only-key"));
});

it("reorders response indices, normalizes vectors and rejects invalid payloads", () => {
	assert.deepEqual(
		validateEmbeddings(
			{
				data: [
					{ index: 1, embedding: [0, 5] },
					{ index: 0, embedding: [3, 4] },
				],
			},
			2,
		),
		[
			[0.6, 0.8],
			[0, 1],
		],
	);
	for (const data of [
		[],
		[{ index: 0, embedding: [0, 0] }],
		[{ index: 0, embedding: [Number.NaN, 1] }],
		[{ index: 2, embedding: [1, 0] }],
		[{ index: 0, embedding: "base64" }],
		[
			{ index: 0, embedding: [1, 0] },
			{ index: 0, embedding: [1, 0] },
		],
	])
		assert.throws(() => validateEmbeddings({ data }, 1), ApiError);
	assert.throws(() => validateEmbeddings({ data: [{ index: 0, embedding: [1, 0] }] }, 1, 3), ApiError);
});

it("calls the compatible batch API, omits optional dimensions and sanitizes provider failures", async () => {
	let fail = false;
	let requests = 0;
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString()) as {
				input: string[];
				model: string;
				encoding_format: string;
				dimensions?: number;
			};
			requests++;
			assert.equal(request.url, "/v1/embeddings");
			assert.equal(request.headers.authorization, "Bearer local-provider-test-key");
			assert.equal(body.model, "company-vector");
			assert.equal(body.encoding_format, "float");
			assert.equal(body.dimensions, undefined);
			response.writeHead(fail ? 500 : 200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify(
					fail
						? { error: "private-provider-secret-and-document" }
						: {
								data: body.input
									.map((_text, index) => ({ index, embedding: index === 0 ? [3, 4] : [0, 5] }))
									.reverse(),
							},
				),
			);
		})().catch(() => {
			response.writeHead(500);
			response.end();
		});
	});
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	try {
		const model = createEmbeddingModel({
			KNOWLEDGE_EMBEDDING_MODE: "openai",
			KNOWLEDGE_EMBEDDING_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
			KNOWLEDGE_EMBEDDING_NAME: "company-vector",
			KNOWLEDGE_EMBEDDING_API_KEY: "local-provider-test-key",
		});
		assert.ok(model);
		assert.deepEqual(await model.embed(["first", "second"], new AbortController().signal), [
			[0.6, 0.8],
			[0, 1],
		]);
		fail = true;
		await assert.rejects(
			model.embed(["query"], new AbortController().signal),
			(error: unknown) =>
				error instanceof ApiError && error.code === "embedding_unavailable" && !error.message.includes("private"),
		);
		await assert.rejects(model.embed([""], new AbortController().signal), /输入/);
		await assert.rejects(model.embed(["query"], AbortSignal.abort(new Error("cancel-request"))), /cancel-request/);
		assert.equal(requests, 2);
	} finally {
		await new Promise<void>((ready) => {
			server.close(() => ready());
			server.closeAllConnections();
		});
	}
});
