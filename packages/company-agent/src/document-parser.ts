/**
 * Node 与 Python 文档解析器之间的适配层。
 * 输入原件字节，输出统一 ParsedDocument；管理临时文件、进度、超时、取消和结果校验。
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "./errors.ts";
import {
	MAX_CHUNKS,
	MAX_DOCUMENT_BYTES,
	MAX_TEXT_BYTES,
	type ParsedDocument,
	parseTextDocument,
} from "./text-processing.ts";
import type {
	DocumentMediaType,
	DocumentPage,
	ParsedBlock,
	ParseProgress,
	ParseWarning,
	SourceLocation,
} from "./types.ts";

export interface ParseContext {
	signal: AbortSignal;
	progress: (progress: ParseProgress) => Promise<void>;
}
export type DocumentParser = (
	content: Uint8Array,
	mediaType: DocumentMediaType,
	context: ParseContext,
) => ParsedDocument | Promise<ParsedDocument>;
export interface ParserOptions {
	python?: string;
	timeoutMs?: number;
	maxPages?: number;
	ocr?: "auto" | "always" | "off";
	libreoffice?: string;
}

export function createDocumentParser(
	options: ParserOptions = {},
): (...args: Parameters<DocumentParser>) => Promise<ParsedDocument> {
	// 此处读取的是解析配置，与问答模型/向量模型配置相互独立。
	const python = (options.python ?? process.env.KNOWLEDGE_PYTHON_PATH)?.trim() || "python";
	const timeoutMs = options.timeoutMs ?? Number(process.env.KNOWLEDGE_PARSE_TIMEOUT_MS || 300_000);
	const maxPages = options.maxPages ?? Number(process.env.KNOWLEDGE_MAX_DOCUMENT_PAGES || 120);
	const ocr = options.ocr ?? process.env.KNOWLEDGE_OCR_MODE ?? "auto";
	const libreoffice = options.libreoffice ?? process.env.KNOWLEDGE_LIBREOFFICE_PATH;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1000 ||
		timeoutMs > 900_000 ||
		!Number.isSafeInteger(maxPages) ||
		maxPages < 1 ||
		maxPages > 500 ||
		!["auto", "always", "off"].includes(ocr)
	) {
		throw new Error("文档解析配置无效：时限为 1000–900000 ms，页数为 1–500，OCR 为 auto/always/off");
	}
	return async (content, mediaType, context) => {
		// 小型文本直接走 TypeScript 解析；PDF/Word 才需要隔离的 Python 进程。
		if (mediaType === "text/plain" || mediaType === "text/markdown") return parseTextDocument(content, mediaType);
		context.signal.throwIfAborted();
		// 每个任务单独建临时目录，确认它在预期根下；无论成功失败都在 finally 清理。
		const temporaryRoot = resolve(tmpdir());
		const directory = await mkdtemp(join(temporaryRoot, "company-document-"));
		if (dirname(directory) !== temporaryRoot) throw new Error("Invalid parser temporary directory");
		try {
			const extension =
				mediaType === "application/pdf" ? "pdf" : mediaType === "application/msword" ? "doc" : "docx";
			const input = join(directory, `source.${extension}`);
			await writeFile(input, content);
			// 参数逐项交给 spawn，不拼接 Shell 命令；上传者的文件名不参与进程命令构造。
			const args = [
				"-u",
				fileURLToPath(new URL("../parser/parse_document.py", import.meta.url)),
				"--input",
				input,
				"--output",
				directory,
				"--type",
				mediaType,
				"--max-pages",
				String(maxPages),
				"--ocr",
				ocr,
			];
			if (libreoffice) args.push("--libreoffice", libreoffice);
			await new Promise<void>((accept, reject) => {
				const child = (() => {
					try {
						return spawn(python, args, {
							windowsHide: true,
							stdio: ["ignore", "pipe", "pipe"],
							detached: process.platform !== "win32",
						});
					} catch {
						throw new ApiError(503, "parser_unavailable", "无法启动解析器，请检查 Python 路径和进程运行权限");
					}
				})();
				let buffer = "";
				let received = 0;
				let done = false;
				let failure: unknown;
				let delivery = Promise.resolve();
				const kill = () => {
					// 解析器可能还启动 LibreOffice，因此需要结束进程树，而不只是父进程。
					if (!child.pid || child.exitCode !== null) return;
					if (process.platform === "win32") {
						const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
							windowsHide: true,
							stdio: "ignore",
						});
						killer.on("error", () => child.kill());
						killer.on("exit", (code) => {
							if (code !== 0) child.kill();
						});
					} else {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill();
						}
					}
				};
				const abort = () => {
					failure = context.signal.reason ?? new ApiError(499, "parse_cancelled", "解析已停止");
					kill();
				};
				const timer = setTimeout(() => {
					failure = new ApiError(504, "parse_timeout", "文档处理超时，请拆分文件或调整解析时限");
					kill();
				}, timeoutMs);
				context.signal.addEventListener("abort", abort, { once: true });
				if (context.signal.aborted) abort();
				// stdout 是逐行 JSON 协议；一个 data 块可能只有半行，先缓冲到换行再处理。
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (data: string) => {
					received += Buffer.byteLength(data);
					buffer += data;
					if (received > 2_000_000) {
						failure = new ApiError(502, "invalid_parser_output", "解析器输出超过限制");
						kill();
						return;
					}
					let boundary = buffer.indexOf("\n");
					while (boundary >= 0) {
						const line = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 1);
						boundary = buffer.indexOf("\n");
						try {
							const event = record(JSON.parse(line));
							if (event.type === "error")
								failure = new ApiError(422, shortText(event.code, 80), shortText(event.message, 240));
							else if (event.type === "done") done = true;
							else if (event.type === "progress") {
								if (
									(event.stage !== "extracting" && event.stage !== "ocr") ||
									!Number.isSafeInteger(event.processedPages) ||
									!Number.isSafeInteger(event.totalPages) ||
									Number(event.processedPages) < 0 ||
									Number(event.processedPages) > Number(event.totalPages) ||
									Number(event.totalPages) > maxPages
								)
									throw new Error("Invalid progress");
								const progress: ParseProgress = {
									stage: event.stage,
									processedPages: Number(event.processedPages),
									totalPages: Number(event.totalPages),
								};
								// 串行写入进度，保持顺序；进度持久化失败时也停止解析任务。
								delivery = delivery
									.then(() => context.progress(progress))
									.catch((error: unknown) => {
										failure = error;
										kill();
									});
							} else throw new Error("Invalid event");
						} catch {
							failure = new ApiError(502, "invalid_parser_output", "解析器返回了无效结果");
							kill();
						}
					}
					if (buffer.length > 32_000) {
						failure = new ApiError(502, "invalid_parser_output", "解析器输出超过限制");
						kill();
					}
				});
				// 消费但不转发诊断输出，避免第三方异常把文档正文或本地路径带给用户。
				child.stderr.resume();
				child.on("error", () => {
					failure = new ApiError(
						503,
						"parser_unavailable",
						"无法启动解析器，请配置 KNOWLEDGE_PYTHON_PATH 并安装解析依赖",
					);
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					context.signal.removeEventListener("abort", abort);
					void delivery.then(() => {
						if (failure) reject(failure);
						else if (code !== 0 || !done)
							reject(new ApiError(503, "parser_unavailable", "解析器未完成，请检查 Python 环境和解析依赖"));
						else accept();
					}, reject);
				});
			});
			context.signal.throwIfAborted();
			// 进程正常退出且收到 done 之后，仍需检查结果文件大小和全部结构。
			const resultPath = join(directory, "result.json");
			if ((await stat(resultPath)).size > 16 * 1024 * 1024)
				throw new ApiError(422, "document_too_complex", "解析结果过大");
			const parsed = decodeParsedDocument(JSON.parse(await readFile(resultPath, "utf8")), maxPages);
			if (mediaType === "application/msword") {
				const previewPath = join(directory, "preview.pdf");
				if ((await stat(previewPath)).size > MAX_DOCUMENT_BYTES)
					throw new ApiError(413, "file_too_large", "转换后的 PDF 超过限制");
				parsed.previewPdf = await readFile(previewPath);
			}
			return parsed;
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	};
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
	return value as Record<string, unknown>;
}
function shortText(value: unknown, limit: number): string {
	if (typeof value !== "string" || value.length > limit) throw new Error("Invalid text");
	return value;
}

export function decodeParsedDocument(value: unknown, maxPages = 120): ParsedDocument {
	// 子进程输出也视为边界数据：验证页码、块 ID、坐标范围、置信度和数组上限。
	try {
		const result = record(value);
		if (
			!Array.isArray(result.blocks) ||
			result.blocks.length > 12000 ||
			!Array.isArray(result.pages) ||
			result.pages.length > maxPages ||
			!Array.isArray(result.warnings) ||
			result.warnings.length > 2000
		)
			throw new Error("Invalid arrays");
		const pages: DocumentPage[] = result.pages.map((raw, index) => {
			const page = record(raw);
			if (
				page.number !== index + 1 ||
				!["text", "ocr", "blank"].includes(String(page.method)) ||
				!Number.isFinite(page.width) ||
				!Number.isFinite(page.height) ||
				Number(page.width) <= 0 ||
				Number(page.height) <= 0
			)
				throw new Error("Invalid page");
			return {
				number: index + 1,
				width: Number(page.width),
				height: Number(page.height),
				method: page.method as DocumentPage["method"],
			};
		});
		const ids = new Set<string>();
		const blocks: ParsedBlock[] = result.blocks.map((raw) => {
			const block = record(raw);
			const location = record(block.location);
			const id = shortText(block.id, 80);
			if (!id || ids.has(id)) throw new Error("Invalid block ID");
			ids.add(id);
			const page = location.page;
			if (page !== null && (!Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > pages.length))
				throw new Error("Invalid location");
			const box = location.box;
			if (
				box !== null &&
				(!Array.isArray(box) ||
					box.length !== 4 ||
					!box.every(
						(coordinate) =>
							typeof coordinate === "number" &&
							Number.isFinite(coordinate) &&
							coordinate >= 0 &&
							coordinate <= 1,
					) ||
					box[0] > box[2] ||
					box[1] > box[3])
			)
				throw new Error("Invalid box");
			if (
				!["paragraph", "heading", "table"].includes(String(block.kind)) ||
				!["text", "ocr", "docx"].includes(String(location.method)) ||
				location.blockId !== id ||
				(block.confidence !== null &&
					(!Number.isFinite(block.confidence) || Number(block.confidence) < 0 || Number(block.confidence) > 1))
			)
				throw new Error("Invalid block");
			return {
				id,
				text: shortText(block.text, MAX_TEXT_BYTES),
				heading: block.heading === null ? null : shortText(block.heading, 2000),
				kind: block.kind as ParsedBlock["kind"],
				confidence: block.confidence === null ? null : Number(block.confidence),
				location: {
					blockId: id,
					page: page === null ? null : Number(page),
					label: shortText(location.label, 200),
					box: box as SourceLocation["box"],
					method: location.method as SourceLocation["method"],
				},
			};
		});
		const warnings: ParseWarning[] = result.warnings.map((raw) => {
			const warning = record(raw);
			if (
				warning.page !== null &&
				(!Number.isSafeInteger(warning.page) || Number(warning.page) < 1 || Number(warning.page) > pages.length)
			)
				throw new Error("Invalid warning page");
			return {
				page: warning.page === null ? null : Number(warning.page),
				code: shortText(warning.code, 80),
				message: shortText(warning.message, 400),
			};
		});
		return composeParsedDocument(blocks, pages, warnings);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError(502, "invalid_parser_output", "解析器返回了无效的正文或来源位置");
	}
}

export function composeParsedDocument(
	blocks: ParsedBlock[],
	pages: DocumentPage[],
	warnings: ParseWarning[],
): ParsedDocument {
	// 规范化后的 text 是行号/偏移的共同基准，人工复核后也复用此函数重新建立位置关系。
	blocks = blocks.map((block) => ({ ...block, text: block.text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n") }));
	const text = blocks.map((block) => block.text).join("\n\n");
	if (Buffer.byteLength(text) > MAX_TEXT_BYTES)
		throw new ApiError(422, "document_too_complex", "提取正文超过 1 MiB，请拆分文档");
	const chunks: ParsedDocument["chunks"] = [];
	let offset = 0;
	let lineOffset = 0;
	let index = 0;
	while (index < blocks.length) {
		const group = [blocks[index++]];
		// 同页同章节的普通段落可合并分块；表格保留独立边界，避免混到相邻正文里。
		while (
			index < blocks.length &&
			blocks[index].location.page === group[0].location.page &&
			blocks[index].heading === group[0].heading &&
			blocks[index].kind !== "table" &&
			group[0].kind !== "table"
		)
			group.push(blocks[index++]);
		const body = group.map((block) => block.text).join("\n\n");
		let position = 0;
		// 保存每个原始正文块在合并文本中的区间，之后按区间交集把来源位置分配给检索块。
		const spans = group.map((block) => {
			const start = position;
			position += block.text.length + 2;
			return { start, end: position - 2, location: block.location };
		});
		if (body.trim()) {
			for (const chunk of parseTextDocument(Buffer.from(body), "text/plain").chunks) {
				chunks.push({
					...chunk,
					position: chunks.length,
					heading: group[0].heading,
					startOffset: chunk.startOffset + offset,
					endOffset: chunk.endOffset + offset,
					startLine: chunk.startLine + lineOffset,
					endLine: chunk.endLine + lineOffset,
					locations: spans
						.filter((span) => span.start < chunk.endOffset && span.end > chunk.startOffset)
						.map((span) => span.location),
				});
				if (chunks.length > MAX_CHUNKS) throw new ApiError(422, "too_many_chunks", "文档分块过多，请拆分文件");
			}
		}
		offset += body.length + 2;
		lineOffset += body.split("\n").length + 1;
	}
	return { text, chunks, pages, blocks, warnings };
}
