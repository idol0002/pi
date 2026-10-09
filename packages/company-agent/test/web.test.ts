import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import type { ChatEvent, ChatMessage } from "../src/types.ts";
import { loadWebAssets } from "../src/web.ts";
import { readChatStream } from "../web/stream.ts";

const message: ChatMessage = {
	id: "message",
	runId: "run",
	role: "assistant",
	content: "发布窗口。[1]",
	status: "complete",
	model: "demo",
	usage: null,
	errorCode: null,
	redacted: false,
	sources: [],
	createdAt: "2026-01-01T00:00:00.000Z",
};

it("serves a fixed asset allowlist and browser modules that parse after type stripping", async () => {
	const assets = await loadWebAssets();
	assert.deepEqual([...assets.keys()].filter((path) => !path.startsWith("/assets/pdf")).sort(), [
		"/",
		"/assets/app.ts",
		"/assets/client.ts",
		"/assets/document-viewer.ts",
		"/assets/stream.ts",
		"/assets/styles.css",
	]);
	assert.match(String(assets.get("/")?.content ?? ""), /id="login-form"/);
	assert.match(String(assets.get("/")?.content ?? ""), /id="question-form"/);
	assert.equal(assets.get("/assets/pdf.mjs")?.contentType, "text/javascript; charset=utf-8");
	assert.equal(assets.get("/assets/pdfjs/wasm/openjpeg.wasm")?.contentType, "application/wasm");
	assert.ok(assets.has("/assets/pdf.worker.mjs"));
	assert.match(String(assets.get("/assets/document-viewer.ts")?.content), /from "\/assets\/pdf.mjs"/);
	assert.equal(assets.has("/../.env"), false);
	for (const [path, asset] of assets) {
		if (!path.endsWith(".ts")) continue;
		const checked = spawnSync(process.execPath, ["--input-type=module", "--check"], {
			input: asset.content,
			encoding: "utf8",
		});
		assert.equal(checked.status, 0, checked.stderr);
	}
});

it("decodes fragmented UTF-8 and CRLF SSE frames without losing citations or terminal state", async () => {
	const expected: ChatEvent[] = [
		{ type: "start", runId: "run", messageId: "message" },
		{ type: "delta", text: "发布窗口。[1]" },
		{ type: "done", message },
	];
	const bytes = new TextEncoder().encode(
		`: keepalive\r\n\r\n${expected.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("")}`,
	);
	let position = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (position >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(position, ++position));
		},
	});
	const actual: ChatEvent[] = [];
	await readChatStream(new Response(body, { headers: { "Content-Type": "text/event-stream" } }), (event) =>
		actual.push(event),
	);
	assert.deepEqual(actual, expected);
});

it("treats truncated or malformed streams as failures and accepts explicit server error events", async () => {
	const headers = { "Content-Type": "text/event-stream" };
	await assert.rejects(
		readChatStream(new Response('data: {"type":"delta","text":"partial"}\n\n', { headers }), () => {}),
		/连接中断/,
	);
	await assert.rejects(readChatStream(new Response("data: invalid\n\n", { headers }), () => {}));
	await assert.rejects(
		readChatStream(new Response('data: {"type":"unknown"}\n\n', { headers }), () => {}),
		/格式无效/,
	);
	const event: ChatEvent = { type: "error", code: "cancelled", message: "已停止生成", messageId: "message" };
	const actual: ChatEvent[] = [];
	await readChatStream(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers }), (item) => actual.push(item));
	assert.deepEqual(actual, [event]);
});
