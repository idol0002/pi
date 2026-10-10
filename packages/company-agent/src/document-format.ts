/** 上传的快速格式检查：扩展名选格式，文件签名排除明显不匹配，完整解析在后台继续执行。 */
import { ApiError } from "./errors.ts";
import { MAX_DOCUMENT_BYTES, MAX_TEXT_BYTES } from "./text-processing.ts";
import type { DocumentMediaType } from "./types.ts";

export const DOCUMENT_FORMATS: Record<string, DocumentMediaType> = {
	md: "text/markdown",
	markdown: "text/markdown",
	txt: "text/plain",
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	doc: "application/msword",
};

export function documentFormat(filename: string): DocumentMediaType {
	const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1].toLowerCase();
	const mediaType = extension && Object.hasOwn(DOCUMENT_FORMATS, extension) ? DOCUMENT_FORMATS[extension] : undefined;
	if (!mediaType) throw new ApiError(415, "unsupported_file_type", "支持 PDF、DOCX、DOC、Markdown 和 TXT 文档");
	return mediaType;
}

export function validateDocument(content: Uint8Array, mediaType: DocumentMediaType): void {
	// 文本与二进制文档分别限额；合法 ZIP/PDF 头不代表内容一定可解析，不能跳过后续解析器。
	const text = mediaType === "text/plain" || mediaType === "text/markdown";
	if (content.byteLength > (text ? MAX_TEXT_BYTES : MAX_DOCUMENT_BYTES)) {
		throw new ApiError(413, "file_too_large", text ? "文本文件不能超过 1 MiB" : "PDF 和 Word 文件不能超过 20 MiB");
	}
	const signature = Buffer.from(content.subarray(0, 8));
	if (
		(mediaType === "application/pdf" && signature.subarray(0, 5).toString() !== "%PDF-") ||
		(mediaType.endsWith("wordprocessingml.document") &&
			!signature.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) ||
		(mediaType === "application/msword" && !signature.equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225])))
	)
		throw new ApiError(415, "invalid_file_signature", "文件内容与扩展名不符，请上传原始文档");
}
