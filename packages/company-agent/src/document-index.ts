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
	const records = chunks.map((chunk) => ({
		...chunk,
		id: randomUUID(),
		terms: searchTerms(chunk.text).join(" "),
		headingTerms: searchTerms(chunk.heading ?? "").join(" "),
	}));
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

/** Upgrade the phase-one examples and seed fresh databases through the same parser and index. */
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
