import assert from "node:assert/strict";
import { it } from "node:test";
import { ApiError } from "../src/errors.ts";
import { MAX_CHUNKS, MAX_DOCUMENT_BYTES, parseTextDocument, searchTerms } from "../src/text-processing.ts";

it("normalizes UTF-8 text and keeps headings, exact offsets, and line locations", () => {
	const source =
		"\uFEFF# 发布手册\r\n\r\n前言。\r\n\r\n## 上线窗口\r\n发布负责人安排上线。\r\n```sh\r\n# not a heading\r\n```\r\n\r\n## 回滚\r\n执行 rollback。\r\n";
	const parsed = parseTextDocument(Buffer.from(source), "text/markdown");
	assert.ok(!parsed.text.includes("\r"));
	assert.ok(!parsed.text.startsWith("\uFEFF"));
	assert.deepEqual(
		parsed.chunks.map((chunk) => chunk.heading),
		["发布手册", "发布手册 / 上线窗口", "发布手册 / 回滚"],
	);
	assert.deepEqual(
		parsed.chunks.map((chunk) => chunk.startLine),
		[1, 5, 11],
	);
	for (const chunk of parsed.chunks) {
		assert.equal(parsed.text.slice(chunk.startOffset, chunk.endOffset), chunk.text);
		assert.ok(
			parsed.text
				.split("\n")
				.slice(chunk.startLine - 1, chunk.endLine)
				.join("\n")
				.includes(chunk.text.trimEnd()),
		);
	}
	assert.match(parsed.chunks[1].text, /# not a heading/);
});

it("splits long paragraphs with bounded overlap without dropping or breaking Unicode characters", () => {
	const source = `开头说明。\n\n${"员工𠀀发布𐐀检查步骤。".repeat(30)}\n\n末尾。`;
	const parsed = parseTextDocument(Buffer.from(source), "text/plain", { chunkSize: 32, overlap: 6 });
	assert.ok(parsed.chunks.length > 5);
	let covered = 0;
	let previousEnd = 0;
	for (const chunk of parsed.chunks) {
		assert.ok(chunk.text.length <= 32);
		assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.text));
		assert.equal(chunk.text, parsed.text.slice(chunk.startOffset, chunk.endOffset));
		assert.ok(chunk.startOffset <= covered, `Gap before ${chunk.startOffset}`);
		assert.ok(chunk.endOffset > previousEnd);
		if (previousEnd) assert.ok(previousEnd - chunk.startOffset <= 6);
		covered = chunk.endOffset;
		previousEnd = chunk.endOffset;
	}
	assert.equal(covered, parsed.text.length);
});

it("does not carry overlap across sections or treat TXT headings as Markdown", () => {
	const source = "# First\nOnly apples.\n\n# Second\nOnly oranges.\n";
	const markdown = parseTextDocument(Buffer.from(source), "text/markdown");
	assert.equal(markdown.chunks.length, 2);
	assert.ok(!markdown.chunks[1].text.includes("apples"));
	assert.equal(markdown.chunks[0].endOffset, markdown.chunks[1].startOffset);
	assert.deepEqual(
		parseTextDocument(Buffer.from(source), "text/plain").chunks.map((chunk) => chunk.heading),
		[null],
	);
});

it("rejects empty, binary, invalid UTF-8, oversized, and excessively fragmented documents", () => {
	for (const [content, code] of [
		[Buffer.from(" \r\n\t"), "empty_document"],
		[Buffer.from([0xc3, 0x28]), "invalid_utf8"],
		[Buffer.from("binary\u0000data"), "invalid_text"],
		[Buffer.alloc(MAX_DOCUMENT_BYTES + 1, "a"), "file_too_large"],
		[Buffer.from("# Section\ntext\n".repeat(MAX_CHUNKS + 1)), "too_many_chunks"],
	] as const) {
		assert.throws(
			() => parseTextDocument(content, "text/markdown"),
			(error: unknown) => error instanceof ApiError && error.code === code,
		);
	}
});

it("indexes English case and width variants and Chinese word boundaries consistently", () => {
	const indexed = searchTerms("ＲＡＧ rollback 发布负责人安排上线窗口");
	for (const term of searchTerms("RAG ROLLBACK 负责人 上线")) assert.ok(indexed.includes(term), term);
	assert.deepEqual(searchTerms("'); | & ! --"), []);
	assert.ok(searchTerms("foo-bar").includes("foo"));
	assert.ok(searchTerms("foo-bar").includes("bar"));
});
