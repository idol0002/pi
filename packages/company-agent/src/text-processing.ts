import { ApiError } from "./errors.ts";
import type { DocumentMediaType, DocumentPage, ParsedBlock, ParseWarning, TextChunk } from "./types.ts";

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_CHUNKS = 2048;
export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 160;

export interface ParsedDocument {
	text: string;
	chunks: TextChunk[];
	pages?: DocumentPage[];
	blocks?: ParsedBlock[];
	warnings?: ParseWarning[];
	previewPdf?: Uint8Array;
}

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

/** Keep the same tokenizer for indexing and queries, including Chinese bigrams. */
export function searchTerms(text: string): string[] {
	const terms = new Set<string>();
	const normalized = text.normalize("NFKC").toLowerCase();
	for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
		for (const word of segmenter.segment(match[0])) {
			if (word.isWordLike && word.segment.length <= 64) terms.add(word.segment);
		}
		for (const han of match[0].matchAll(/\p{Script=Han}+/gu)) {
			const characters = Array.from(han[0]);
			if (characters.length === 1) terms.add(characters[0]);
			for (let index = 0; index + 1 < characters.length; index++) {
				terms.add(characters[index] + characters[index + 1]);
			}
		}
	}
	return [...terms];
}

export function parseTextDocument(
	content: Uint8Array,
	mediaType: DocumentMediaType,
	options: { chunkSize?: number; overlap?: number } = {},
): ParsedDocument {
	if (content.byteLength > MAX_TEXT_BYTES) throw new ApiError(413, "file_too_large", "文本正文不能超过 1 MiB");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(content).replace(/\r\n?/g, "\n");
	} catch {
		throw new ApiError(422, "invalid_utf8", "文档必须使用 UTF-8 编码");
	}
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
		throw new ApiError(422, "invalid_text", "文档包含二进制或不支持的控制字符");
	}
	if (!text.trim()) throw new ApiError(422, "empty_document", "文档没有可处理的正文");
	const chunkSize = options.chunkSize ?? CHUNK_SIZE;
	const overlap = options.overlap ?? CHUNK_OVERLAP;
	if (!Number.isInteger(chunkSize) || chunkSize < 16 || chunkSize > 4000) throw new Error("Invalid chunk size");
	if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize / 2) throw new Error("Invalid overlap");

	const lineStarts = [0];
	const sections: { start: number; heading: string | null }[] = [{ start: 0, heading: null }];
	const headings: string[] = [];
	let fence: { character: string; length: number } | undefined;
	let offset = 0;
	for (const line of text.split("\n")) {
		if (mediaType === "text/markdown") {
			const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (fence) {
				if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) {
					fence = undefined;
				}
			} else if (marker) {
				fence = { character: marker[1][0], length: marker[1].length };
			} else {
				const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
				if (heading) {
					headings.length = heading[1].length;
					headings[heading[1].length - 1] = heading[2];
					const section = { start: offset, heading: headings.filter(Boolean).join(" / ") };
					if (offset === 0) sections[0] = section;
					else sections.push(section);
				}
			}
		}
		offset += line.length + 1;
		if (offset <= text.length) lineStarts.push(offset);
	}
	function lineAt(position: number): number {
		let low = 0;
		let high = lineStarts.length;
		while (low + 1 < high) {
			const middle = Math.floor((low + high) / 2);
			if (lineStarts[middle] <= position) low = middle;
			else high = middle;
		}
		return low + 1;
	}

	const chunks: TextChunk[] = [];
	for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
		const section = sections[sectionIndex];
		const sectionEnd = sections[sectionIndex + 1]?.start ?? text.length;
		let start = section.start;
		while (start < sectionEnd) {
			let end = Math.min(start + chunkSize, sectionEnd);
			if (end < sectionEnd) {
				const minimum = start + Math.floor(chunkSize / 2);
				const paragraph = text.lastIndexOf("\n\n", end - 2) + 2;
				const newline = text.lastIndexOf("\n", end - 1) + 1;
				if (paragraph >= minimum) end = paragraph;
				else if (newline >= minimum) end = newline;
				else {
					const sentences = [...text.slice(minimum, end).matchAll(/[。！？]|[.!?](?:\s|$)|\s+/g)];
					const boundary = sentences.at(-1);
					if (boundary) end = minimum + boundary.index + boundary[0].length;
				}
			}
			// A Unicode character must never be split between two UTF-16 surrogate halves.
			if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
			const chunkText = text.slice(start, end);
			if (chunkText.trim()) {
				chunks.push({
					position: chunks.length,
					text: chunkText,
					heading: section.heading,
					startLine: lineAt(start),
					endLine: lineAt(end - 1),
					startOffset: start,
					endOffset: end,
				});
				if (chunks.length > MAX_CHUNKS)
					throw new ApiError(422, "too_many_chunks", "文档分块超过 2048 个，请拆分文档");
			}
			if (end === sectionEnd) break;
			start = Math.max(start + 1, end - overlap);
			if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
		}
	}
	return { text, chunks };
}
