/**
 * 把解析结果发布为可检索版本，或保存成待人工复核的候选版本。
 * 本函数不自行开启事务：ingestion.process 和 documents.approveReview 在调用外层提供事务。
 */
import type { SqlClient } from "./database.ts";
import { writeChunks } from "./document-index.ts";
import { ApiError } from "./errors.ts";
import type { ParsedDocument } from "./text-processing.ts";

/** 在调用方事务内执行，保证正文、关键词索引、版本指针和任务状态一起提交。 */
export async function publishParsedDocument(
	database: SqlClient,
	versionId: string,
	parsed: ParsedDocument,
	reviewer: string | null = null,
): Promise<boolean> {
	// 解析有警告且没有复核者时，保留候选正文，但不把它加入可检索分块。
	const review = !reviewer && (parsed.warnings?.length ?? 0) > 0;
	if (!review && parsed.chunks.length === 0)
		throw new ApiError(422, "empty_document", "没有可入库的正文，请重新识别或上传修正版本");
	const { rows } = await database.query<{ title: string }>("SELECT title FROM document_versions WHERE id = $1", [
		versionId,
	]);
	if (!rows[0]) throw new Error("Missing document version");
	await database.query("DELETE FROM document_chunks WHERE version_id = $1", [versionId]);
	if (!review) {
		await writeChunks(database, versionId, rows[0].title, parsed.chunks);
		await database.query(
			"UPDATE document_chunks c SET locations = x.locations FROM jsonb_to_recordset($2::jsonb) AS x(position int, locations jsonb) WHERE c.version_id = $1 AND c.position = x.position",
			[
				versionId,
				JSON.stringify(
					parsed.chunks.map((chunk) => ({ position: chunk.position, locations: chunk.locations ?? [] })),
				),
			],
		);
	}
	await database.query(
		"UPDATE document_versions SET status = $2, text = $3, chunk_count = $4, pages = $5, blocks = $6, warnings = $7, preview_pdf = COALESCE($8, preview_pdf), error = NULL, reviewed_by = $9, reviewed_at = CASE WHEN $9::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END WHERE id = $1",
		[
			versionId,
			review ? "needs_review" : "ready",
			parsed.text,
			review ? 0 : parsed.chunks.length,
			JSON.stringify(parsed.pages ?? []),
			JSON.stringify(parsed.blocks ?? []),
			JSON.stringify(parsed.warnings ?? []),
			parsed.previewPdf ?? null,
			reviewer,
		],
	);
	if (!review) {
		// 只在完整发布后推进 current；向量由 VectorIndex 另行补建，不属于此发布事务。
		await database.query(
			"UPDATE documents d SET current_version_id = v.id, title = v.title, version = v.version, media_type = v.media_type, source_text = v.text, updated_at = CURRENT_TIMESTAMP FROM document_versions v WHERE d.id = v.document_id AND v.id = $1 AND NOT d.deleted AND d.latest_version_id = v.id",
			[versionId],
		);
	}
	await database.query(
		"UPDATE ingestion_jobs SET status = $2, stage = $3, warnings = $4, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE version_id = $1",
		[
			versionId,
			review ? "needs_review" : "succeeded",
			review ? "needs_review" : "complete",
			JSON.stringify(parsed.warnings ?? []),
		],
	);
	// true 表示已经发布；false 表示需复核，上传流程并未因此变成解析失败。
	return !review;
}
