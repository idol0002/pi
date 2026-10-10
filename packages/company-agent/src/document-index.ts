/**
 * 把统一分块写入数据库并生成关键词索引；解析器只负责提供块和位置，不直接操作数据库。
 * 这里的 tsvector/GIN 走词项检索，可选的向量索引在 vector-index.ts 中单独维护。
 */
import { createHash, randomUUID } from "node:crypto";
import type { SqlClient } from "./database.ts";
import { parseTextDocument, searchTerms } from "./text-processing.ts";
import type { DocumentMediaType, TextChunk } from "./types.ts";

export async function writeChunks(
	database: SqlClient,
	versionId: string,
	title: string,
	chunks: TextChunk[],
): Promise<void> {
	// 一批块生成 JSON 记录后通过 jsonb_to_recordset 写入，位置索引与正文偏移一并保留。
	const records = chunks.map((chunk) => ({
		...chunk,
		id: randomUUID(),
		terms: searchTerms(chunk.text).join(" "),
		headingTerms: searchTerms(chunk.heading ?? "").join(" "),
	}));
	// 标题/章节与正文分别赋权；之后 documents.search 取候选，search-ranking 再做业务重排。
	await database.query(
		`INSERT INTO document_chunks (id, version_id, position, text, heading, start_line, end_line,
		                             start_offset, end_offset, search_vector)
		 SELECT x.id, $1, x.position, x.text, x.heading, x."startLine", x."endLine", x."startOffset", x."endOffset",
		        setweight(to_tsvector('simple', $3 || ' ' || x."headingTerms"), 'A') ||
		        setweight(to_tsvector('simple', x.terms), 'B')
		 FROM jsonb_to_recordset($2::jsonb) AS x(id text, position int, text text, heading text,
		      "startLine" int, "endLine" int, "startOffset" int, "endOffset" int, terms text, "headingTerms" text)`,
		[versionId, JSON.stringify(records), searchTerms(title).join(" ")],
	);
}

/** 旧数据升级与首次合成数据初始化复用同一套版本、解析和索引路径。 */
export async function initializeDocumentVersions(database: SqlClient): Promise<void> {
	const { rows } = await database.query<{
		id: string;
		title: string;
		version: number;
		mediaType: DocumentMediaType;
		text: string;
	}>(
		`SELECT id, title, version, media_type AS "mediaType", source_text AS text
		 FROM documents WHERE current_version_id IS NULL AND latest_version_id IS NULL AND NOT deleted`,
	);
	for (const document of rows) {
		const content = Buffer.from(document.text, "utf8");
		const parsed = parseTextDocument(content, document.mediaType);
		const versionId = randomUUID();
		await database.query(
			`INSERT INTO document_versions (id, document_id, version, title, filename, media_type, size_bytes,
			                               sha256, source_bytes, text, status, chunk_count)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ready', $11)`,
			[
				versionId,
				document.id,
				document.version,
				document.title,
				`${document.id}.${document.mediaType === "text/markdown" ? "md" : "txt"}`,
				document.mediaType,
				content.byteLength,
				createHash("sha256").update(content).digest("hex"),
				content,
				parsed.text,
				parsed.chunks.length,
			],
		);
		await writeChunks(database, versionId, document.title, parsed.chunks);
		await database.query("UPDATE documents SET current_version_id = $2, latest_version_id = $2 WHERE id = $1", [
			document.id,
			versionId,
		]);
	}
}
