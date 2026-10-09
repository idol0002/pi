import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { type AnswerEvidence, createAnswerModel } from "../src/answer-model.ts";
import { readModelConfig } from "../src/model-config.ts";

const evidence: AnswerEvidence[] = [
	{
		id: "chunk-one",
		documentId: "doc-one",
		knowledgeBaseId: "kb-one",
		versionId: "version-one",
		version: 1,
		title: "发布流程",
		filename: "release.md",
		position: 0,
		text: "发布负责人安排上线窗口。",
		heading: "发布",
		startLine: 1,
		endLine: 1,
		startOffset: 0,
		endOffset: 14,
		sourceUrl: "/api/documents/doc-one/source",
		number: 1,
		current: true,
	},
];

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function close(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
	});
}

it("validates explicit model configuration and never silently switches a broken real model to demo", () => {
	assert.equal(readModelConfig({}).mode, "demo");
	assert.throws(() => readModelConfig({ KNOWLEDGE_MODEL_MODE: "typo" }), /demo 或 openai/);
	assert.throws(() => readModelConfig({ KNOWLEDGE_MODEL_MODE: "openai" }), /MODEL_NAME/);
	const env = {
		KNOWLEDGE_MODEL_MODE: "openai",
		KNOWLEDGE_MODEL_NAME: "approved-chat",
		KNOWLEDGE_MODEL_API_KEY: "test-only-not-a-real-key",
	};
	for (const url of [
		"",
		"file:///etc/passwd",
		"http://remote.example/v1",
		"https://user:password@gateway.example/v1",
		"https://gateway.example/v1?key=test",
		"https://gateway.example/v1/chat/completions",
	]) {
		assert.throws(() => readModelConfig({ ...env, KNOWLEDGE_MODEL_BASE_URL: url }));
	}
	const config = readModelConfig({
		...env,
		KNOWLEDGE_MODEL_BASE_URL: "https://gateway.example/v1/",
		KNOWLEDGE_MODEL_MAX_TOKENS_FIELD: "max_completion_tokens",
		KNOWLEDGE_MODEL_STREAM_USAGE: "false",
	});
	assert.equal(config.model.baseUrl, "https://gateway.example/v1");
	assert.equal(config.model.compat?.maxTokensField, "max_completion_tokens");
	assert.equal(config.model.compat?.supportsUsageInStreaming, false);
	assert.throws(() => readModelConfig({ KNOWLEDGE_MODEL_TIMEOUT_MS: "10" }), /TIMEOUT_MS/);
	assert.throws(() => readModelConfig({ KNOWLEDGE_MODEL_MAX_TOKENS: "-1" }), /MAX_TOKENS/);
	assert.throws(() => readModelConfig({ KNOWLEDGE_MODEL_STREAM_USAGE: "sometimes" }), /STREAM_USAGE/);
});

it("runs the demo through Pi, streams real excerpts, and identifies the simulated answer", async () => {
	const model = createAnswerModel(readModelConfig({}));
	const deltas: string[] = [];
	const result = await model.generate({
		question: "谁安排上线？",
		history: [],
		evidence,
		signal: new AbortController().signal,
		onText: async (text) => {
			deltas.push(text);
		},
	});
	assert.ok(deltas.length > 1);
	assert.equal(deltas.join(""), result.content);
	assert.match(result.content, /演示模式/);
	assert.match(result.content, /发布负责人安排上线窗口/);
	assert.match(result.content, /\[1\]/);
	assert.equal(result.usage, null);
});

it("uses the OpenAI-compatible streaming API through Pi and keeps credentials out of public model info", async () => {
	let payload: Record<string, unknown> | undefined;
	let authorization: string | undefined;
	let path: string | undefined;
	const server = createServer((request, response) => {
		void (async () => {
			path = request.url;
			authorization = request.headers.authorization;
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			payload = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const text of ["发布负责人", "安排上线窗口。[1]"]) {
				response.write(
					`data: ${JSON.stringify({ id: "answer-test", model: "approved-chat", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
				);
			}
			response.write(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } })}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		})().catch(() => response.destroy());
	});
	try {
		const baseUrl = await listen(server);
		const model = createAnswerModel(
			readModelConfig({
				KNOWLEDGE_MODEL_MODE: "openai",
				KNOWLEDGE_MODEL_BASE_URL: baseUrl,
				KNOWLEDGE_MODEL_NAME: "approved-chat",
				KNOWLEDGE_MODEL_API_KEY: "contract-test-not-a-real-key",
			}),
		);
		const deltas: string[] = [];
		const result = await model.generate({
			question: "谁安排上线窗口？",
			history: [],
			evidence,
			signal: new AbortController().signal,
			onText: async (text) => {
				deltas.push(text);
			},
		});
		assert.equal(path, "/v1/chat/completions");
		assert.equal(authorization, "Bearer contract-test-not-a-real-key");
		assert.equal(payload?.model, "approved-chat");
		assert.equal(payload?.stream, true);
		assert.equal(payload?.max_tokens, 2048);
		assert.equal(payload?.store, undefined);
		assert.equal(payload?.tools, undefined);
		assert.match(JSON.stringify(payload?.messages), /发布负责人安排上线窗口/);
		assert.equal(result.content, "发布负责人安排上线窗口。[1]");
		assert.equal(result.content, deltas.join(""));
		assert.equal(result.usage?.totalTokens, 42);
		assert.deepEqual(model.info, { mode: "openai", name: "approved-chat" });
	} finally {
		await close(server);
	}
});

it("sanitizes provider errors and honors abort signals", async () => {
	const server = createServer((_request, response) => {
		response.writeHead(401, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ error: { message: "private-key-and-document-sentinel" } }));
	});
	try {
		const baseUrl = await listen(server);
		const model = createAnswerModel(
			readModelConfig({
				KNOWLEDGE_MODEL_MODE: "openai",
				KNOWLEDGE_MODEL_BASE_URL: baseUrl,
				KNOWLEDGE_MODEL_NAME: "approved-chat",
				KNOWLEDGE_MODEL_API_KEY: "test-only",
			}),
		);
		await assert.rejects(
			model.generate({
				question: "上线",
				evidence,
				history: [],
				signal: new AbortController().signal,
				onText: async () => {},
			}),
			(error: Error) => {
				assert.ok(!error.message.includes("private-key-and-document-sentinel"));
				assert.match(error.message, /模型未能完成/);
				return true;
			},
		);
	} finally {
		await close(server);
	}
	const controller = new AbortController();
	const demo = createAnswerModel(readModelConfig({}));
	await assert.rejects(
		demo.generate({
			question: "上线",
			evidence,
			history: [],
			signal: controller.signal,
			onText: async () => controller.abort(new Error("test cancelled")),
		}),
		/test cancelled/,
	);
});
