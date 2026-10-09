import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { documentFormat, validateDocument } from "../src/document-format.ts";
import { composeParsedDocument, createDocumentParser, decodeParsedDocument } from "../src/document-parser.ts";
import { ApiError } from "../src/errors.ts";
import type { DocumentMediaType, ParsedBlock, ParseProgress } from "../src/types.ts";

const localPython = fileURLToPath(
	new URL(
		"../../../.artifacts/company-agent/parser-venv/" +
			(process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
		import.meta.url,
	),
);
const python = process.env.KNOWLEDGE_PYTHON_PATH ?? localPython;
const configured = existsSync(python);
const page = { number: 1, width: 612, height: 792, method: "text" as const };
const block: ParsedBlock = {
	id: "one",
	text: "Deployment window Friday 14:30.",
	heading: null,
	kind: "paragraph",
	confidence: null,
	location: { blockId: "one", page: 1, box: [0.1, 0.1, 0.8, 0.2], method: "text", label: "第 1 页" },
};

it("rejects disguised binary uploads and inherited object keys as extensions", () => {
	assert.throws(() => documentFormat("file.constructor"), /支持 PDF/);
	assert.throws(() => validateDocument(Buffer.from("not PDF"), "application/pdf"), /扩展名不符/);
	assert.throws(() => validateDocument(Buffer.from("not DOCX"), documentFormat("file.docx")), /扩展名不符/);
	assert.equal(documentFormat("POLICY.PDF"), "application/pdf");
});

it("preserves page boundaries, source boxes, Unicode and exact normalized text offsets", () => {
	const blocks = [
		block,
		{
			...block,
			id: "two",
			text: "第二页窗口 😀\n负责人为研发组。",
			location: { ...block.location, blockId: "two", page: 2, label: "第 2 页" },
		},
	];
	const parsed = composeParsedDocument(blocks, [page, { ...page, number: 2 }], []);
	assert.equal(parsed.chunks.length, 2);
	for (const chunk of parsed.chunks) {
		assert.equal(parsed.text.slice(chunk.startOffset, chunk.endOffset), chunk.text);
		assert.equal(
			parsed.text
				.split("\n")
				.slice(chunk.startLine - 1, chunk.endLine)
				.join("\n"),
			chunk.text,
		);
		assert.equal(new Set(chunk.locations?.map((location) => location.page)).size, 1);
	}
	assert.equal(parsed.chunks[1].locations?.[0].page, 2);
});

it("rejects invalid parser source locations, duplicate block IDs and unbounded text", () => {
	for (const blocks of [
		[block, block],
		[{ ...block, location: { ...block.location, page: 3 } }],
		[{ ...block, location: { ...block.location, box: [-1, 0, 1, 1] } }],
		[{ ...block, location: { ...block.location, blockId: "forged" } }],
		[{ ...block, text: "x".repeat(1_048_577) }],
	])
		assert.throws(() => decodeParsedDocument({ pages: [page], blocks, warnings: [] }), ApiError);
});

async function parseFixture(name: string, mediaType: DocumentMediaType, ocr: "auto" | "off" = "auto") {
	const content = await readFile(new URL(`./fixtures/documents/${name}`, import.meta.url));
	const progress: ParseProgress[] = [];
	const parsed = await createDocumentParser({ python, ocr, timeoutMs: 120_000 })(content, mediaType, {
		signal: new AbortController().signal,
		progress: async (value) => {
			progress.push(value);
		},
	});
	for (const chunk of parsed.chunks) assert.equal(parsed.text.slice(chunk.startOffset, chunk.endOffset), chunk.text);
	return { parsed, progress };
}

it("extracts a real text PDF with page locations", { skip: !configured }, async () => {
	const { parsed, progress } = await parseFixture("text.pdf", "application/pdf");
	assert.match(parsed.text, /atlasnative/);
	assert.equal(parsed.pages?.[0].method, "text");
	assert.equal(parsed.warnings?.length, 0);
	assert.ok(parsed.chunks[0].locations?.[0].box);
	assert.equal(progress.at(-1)?.processedPages, 1);
});

it("extracts Word paragraphs and table rows with section positions", { skip: !configured }, async () => {
	const { parsed } = await parseFixture(
		"word.docx",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	);
	assert.match(parsed.text, /atlasdocx/);
	assert.ok(
		parsed.blocks?.some((block) => block.kind === "table" && block.text.includes("Engineering | Release approval")),
	);
	assert.ok(parsed.blocks?.every((block) => block.location.page === null));
});

it(
	"OCRs a real mixed PDF despite a native page-number text layer, with local Chinese and English recognition",
	{ skip: !configured, timeout: 150_000 },
	async () => {
		const { parsed, progress } = await parseFixture("mixed.pdf", "application/pdf");
		assert.deepEqual(
			parsed.pages?.map((page) => page.method),
			["text", "ocr"],
		);
		assert.match(parsed.text, /atlasnative/);
		assert.match(parsed.text, /14[:：.]30/);
		assert.match(parsed.text, /验收/);
		assert.ok(parsed.blocks?.some((block) => block.location.page === 2 && block.location.method === "ocr"));
		assert.ok(progress.some((value) => value.stage === "ocr" && value.totalPages === 2));
	},
);

it(
	"flags unrecognized scan pages when OCR is disabled instead of silently publishing partial text",
	{ skip: !configured },
	async () => {
		const { parsed } = await parseFixture("mixed.pdf", "application/pdf", "off");
		assert.ok(parsed.warnings?.some((warning) => warning.code === "ocr_required" && warning.page === 2));
		assert.match(parsed.text, /atlasnative/);
	},
);

it("recognizes sideways scans and embedded Word screenshots", { skip: !configured, timeout: 150_000 }, async () => {
	const scan = await parseFixture("rotated.pdf", "application/pdf");
	assert.match(scan.parsed.text, /14[:：.]30/);
	const word = await parseFixture(
		"word-images.docx",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	);
	assert.ok(word.parsed.blocks?.some((block) => block.location.method === "ocr"));
	assert.ok(word.parsed.warnings?.some((warning) => warning.code === "embedded_image"));
});

it("reports encrypted, corrupt and empty PDFs and enforces page limits", { skip: !configured }, async () => {
	await assert.rejects(parseFixture("encrypted.pdf", "application/pdf"), /加密|损坏/);
	await assert.rejects(parseFixture("blank.pdf", "application/pdf"), /正文/);
	const parse = createDocumentParser({ python, maxPages: 1 });
	const context = { signal: new AbortController().signal, progress: async () => {} };
	await assert.rejects(parse(Buffer.from("%PDF-broken"), "application/pdf", context), /加密|损坏/);
	await assert.rejects(
		parse(await readFile(new URL("./fixtures/documents/mixed.pdf", import.meta.url)), "application/pdf", context),
		/页数/,
	);
});

it("bounds a real parser process and honors already-cancelled requests", { skip: !configured }, async () => {
	const content = await readFile(new URL("./fixtures/documents/mixed.pdf", import.meta.url));
	await assert.rejects(
		createDocumentParser({ python, timeoutMs: 1000 })(content, "application/pdf", {
			signal: new AbortController().signal,
			progress: async () => {},
		}),
		(error: unknown) => error instanceof ApiError && error.code === "parse_timeout",
	);
	const controller = new AbortController();
	const promise = createDocumentParser({ python })(content, "application/pdf", {
		signal: controller.signal,
		progress: async () => controller.abort(new ApiError(499, "cancelled", "测试取消")),
	});
	await assert.rejects(promise, /测试取消/);
	await assert.rejects(
		createDocumentParser({ python })(content, "application/pdf", {
			signal: AbortSignal.abort(new Error("pre-cancelled")),
			progress: async () => {},
		}),
		/pre-cancelled/,
	);
});
