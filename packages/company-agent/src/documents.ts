import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "./database.ts";
import { documentFormat, validateDocument } from "./document-format.ts";
import { composeParsedDocument } from "./document-parser.ts";
import { ApiError, notFound } from "./errors.ts";
import { publishParsedDocument } from "./parsed-store.ts";
import { planSearch, type SearchPlan } from "./search-query.ts";
import { rankKeywordHits } from "./search-ranking.ts";
import { accessibleKnowledgeBases, documentAccess } from "./store.ts";
import { searchTerms } from "./text-processing.ts";
import type {
	DocumentChunk,
	DocumentPreview,
	DocumentUpload,
	DocumentVersion,
	IngestionJob,
	SearchHit,
	SearchRequest,
	UploadReceipt,
} from "./types.ts";

export const MAX_PENDING_JOBS = 100;
export const MAX_INGESTION_ATTEMPTS = 3;

type PreviewVersion = Pick<DocumentPreview, "versionId" | "filename" | "mediaType" | "status"> & { hasPdf: boolean };

const versionColumns = `v.id, v.document_id AS "documentId", v.version, v.title, v.filename,
	v.media_type AS "mediaType", v.size_bytes AS "sizeBytes", v.sha256, v.status,
	v.chunk_count AS "chunkCount", v.error, v.created_by AS "createdBy", v.created_at AS "createdAt"`;
const jobColumns = `j.id, j.document_id AS "documentId", j.version_id AS "versionId", j.status, j.attempts, j.error,
	j.created_at AS "createdAt", j.updated_at AS "updatedAt", j.stage, j.processed_pages AS "processedPages", j.total_pages AS "totalPages", j.warnings`;
export const chunkColumns = `c.id, d.id AS "documentId", d.knowledge_base_id AS "knowledgeBaseId",
	v.id AS "versionId", v.version, v.title, v.filename, c.position, c.text, c.heading,
	c.start_line AS "startLine", c.end_line AS "endLine", c.start_offset AS "startOffset", c.end_offset AS "endOffset", c.locations`;

export function withSourceUrl<T extends Omit<DocumentChunk, "sourceUrl">>(chunk: T): T & { sourceUrl: string } {
	const query = new URLSearchParams({
		versionId: chunk.versionId,
		startLine: String(chunk.startLine),
		endLine: String(chunk.endLine),
	});
	return { ...chunk, sourceUrl: `/api/documents/${encodeURIComponent(chunk.documentId)}/source?${query}` };
}

async function requireEditor(database: SqlClient, userId: string, knowledgeBaseId: string): Promise<void> {
	const [base] = await accessibleKnowledgeBases(database, userId, [knowledgeBaseId]);
	if (!base) throw notFound();
	if (base.role === "viewer") throw new ApiError(403, "forbidden", "需要知识库维护权限");
}

async function editableDocument(
	database: SqlClient,
	userId: string,
	documentId: string,
): Promise<{
	knowledgeBaseId: string;
	title: string;
	latestVersionId: string;
}> {
	const found = await database.query<{ knowledgeBaseId: string }>(
		'SELECT knowledge_base_id AS "knowledgeBaseId" FROM documents WHERE id = $1 AND NOT deleted',
		[documentId],
	);
	if (!found.rows[0]) throw notFound();
	const { knowledgeBaseId } = found.rows[0];
	// Grant replacement takes an exclusive lock on this same row.
	await database.query("SELECT id FROM knowledge_bases WHERE id = $1 FOR SHARE", [knowledgeBaseId]);
	await requireEditor(database, userId, knowledgeBaseId);
	const { rows } = await database.query<{ title: string; latestVersionId: string }>(
		'SELECT title, latest_version_id AS "latestVersionId" FROM documents WHERE id = $1 AND NOT deleted FOR UPDATE',
		[documentId],
	);
	if (!rows[0]) throw notFound();
	return { ...rows[0], knowledgeBaseId };
}

async function checkQueueCapacity(database: SqlClient): Promise<void> {
	const { rows } = await database.query<{ count: number }>(
		"SELECT count(*)::int AS count FROM ingestion_jobs WHERE status IN ('queued', 'processing')",
	);
	if (rows[0].count >= MAX_PENDING_JOBS) throw new ApiError(429, "ingestion_busy", "文档处理队列已满，请稍后重试");
}

export class DocumentService {
	private readonly database: PGlite;

	constructor(database: PGlite) {
		this.database = database;
	}

	async requireUploadAccess(
		userId: string,
		target: { knowledgeBaseId: string } | { documentId: string },
	): Promise<void> {
		if ("knowledgeBaseId" in target) {
			await requireEditor(this.database, userId, target.knowledgeBaseId);
		} else {
			await this.database.transaction(async (transaction) => {
				await editableDocument(transaction, userId, target.documentId);
			});
		}
	}

	async upload(
		userId: string,
		target: { knowledgeBaseId: string } | { documentId: string },
		input: DocumentUpload,
	): Promise<UploadReceipt> {
		if (!input.filename || input.filename.length > 255 || /[\\/\x00-\x1f\x7f]/.test(input.filename)) {
			throw new ApiError(400, "invalid_filename", "请提供不含路径的文件名，长度不超过 255 个字符");
		}
		if (documentFormat(input.filename) !== input.mediaType) {
			throw new ApiError(415, "unsupported_file_type", "文件类型与扩展名不匹配");
		}
		if (input.content.byteLength === 0) throw new ApiError(400, "empty_file", "不能上传空文件");
		validateDocument(input.content, input.mediaType);
		if (
			input.title !== undefined &&
			(!input.title.trim() || input.title.length > 200 || /[\x00-\x1f\x7f]/.test(input.title))
		) {
			throw new ApiError(400, "invalid_title", "标题必须是 1 到 200 个字符的单行文本");
		}
		return this.database.transaction(async (transaction) => {
			let documentId: string;
			let title: string;
			let version = 1;
			if ("documentId" in target) {
				documentId = target.documentId;
				const document = await editableDocument(transaction, userId, documentId);
				const { rows } = await transaction.query<{ version: number; status: string }>(
					"SELECT version, status FROM document_versions WHERE id = $1",
					[document.latestVersionId],
				);
				if (rows[0].status === "queued" || rows[0].status === "processing") {
					throw new ApiError(409, "document_busy", "该文档已有待处理版本，请等待处理完成");
				}
				version = rows[0].version + 1;
				title = input.title?.trim() ?? document.title;
			} else {
				await transaction.query("SELECT id FROM knowledge_bases WHERE id = $1 FOR SHARE", [target.knowledgeBaseId]);
				await requireEditor(transaction, userId, target.knowledgeBaseId);
				documentId = randomUUID();
				title =
					input.title?.trim() ??
					input.filename
						.replace(/\.(md|markdown|txt|pdf|docx|doc)$/i, "")
						.trim()
						.slice(0, 200);
				if (!title) throw new ApiError(400, "invalid_title", "请提供文档标题");
				await transaction.query(
					`INSERT INTO documents (id, knowledge_base_id, title, media_type, source_text)
					 VALUES ($1, $2, $3, $4, '')`,
					[documentId, target.knowledgeBaseId, title, input.mediaType],
				);
			}
			await checkQueueCapacity(transaction);
			const versionId = randomUUID();
			const jobId = randomUUID();
			await transaction.query(
				`INSERT INTO document_versions (id, document_id, version, title, filename, media_type,
				                               size_bytes, sha256, source_bytes, status, created_by)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10)`,
				[
					versionId,
					documentId,
					version,
					title,
					input.filename,
					input.mediaType,
					input.content.byteLength,
					createHash("sha256").update(input.content).digest("hex"),
					input.content,
					userId,
				],
			);
			await transaction.query(
				"INSERT INTO ingestion_jobs (id, version_id, document_id, status) VALUES ($1, $2, $3, 'queued')",
				[jobId, versionId, documentId],
			);
			await transaction.query(
				"UPDATE documents SET latest_version_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
				[documentId, versionId],
			);
			return { documentId, versionId, jobId, status: "queued" };
		});
	}

	async listVersions(userId: string, documentId: string): Promise<DocumentVersion[]> {
		const { rows } = await this.database.query<DocumentVersion>(
			`SELECT ${versionColumns} FROM document_versions v WHERE v.document_id = $2
			 AND EXISTS (SELECT 1 ${documentAccess} AND d.id = v.document_id) ORDER BY v.version DESC`,
			[userId, documentId],
		);
		if (rows.length === 0) throw notFound();
		return rows;
	}

	async getJob(userId: string, id: string): Promise<IngestionJob> {
		const { rows } = await this.database.query<IngestionJob>(
			`SELECT ${jobColumns} FROM ingestion_jobs j WHERE j.id = $2
			 AND EXISTS (SELECT 1 ${documentAccess} AND d.id = j.document_id)`,
			[userId, id],
		);
		if (!rows[0]) throw notFound();
		return rows[0];
	}

	async retryJob(userId: string, id: string): Promise<UploadReceipt> {
		return this.database.transaction(async (transaction) => {
			const { rows } = await transaction.query<IngestionJob>(
				`SELECT ${jobColumns} FROM ingestion_jobs j WHERE j.id = $1`,
				[id],
			);
			const job = rows[0];
			if (!job) throw notFound();
			const document = await editableDocument(transaction, userId, job.documentId);
			if (!["failed", "needs_review"].includes(job.status) || document.latestVersionId !== job.versionId) {
				throw new ApiError(409, "invalid_retry", "只能重试文档最新的失败版本");
			}
			if (job.attempts >= MAX_INGESTION_ATTEMPTS)
				throw new ApiError(409, "retry_limit", "已达到 3 次处理上限，请上传修正后的新版本");
			await checkQueueCapacity(transaction);
			await transaction.query(
				"UPDATE ingestion_jobs SET status = 'queued', stage = 'queued', processed_pages = 0, total_pages = 0, warnings = '[]', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
				[id],
			);
			await transaction.query("UPDATE document_versions SET status = 'queued', error = NULL WHERE id = $1", [
				job.versionId,
			]);
			return { documentId: job.documentId, versionId: job.versionId, jobId: id, status: "queued" };
		});
	}

	async deleteDocument(userId: string, id: string): Promise<void> {
		await this.database.transaction(async (transaction) => {
			await editableDocument(transaction, userId, id);
			await transaction.query("UPDATE documents SET deleted = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
				id,
			]);
			await transaction.query(
				`UPDATE ingestion_jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
				 WHERE document_id = $1 AND status IN ('queued', 'processing', 'needs_review')`,
				[id],
			);
		});
	}

	async readOriginal(
		userId: string,
		documentId: string,
		versionId: string | null,
	): Promise<{
		content: Uint8Array;
		filename: string;
	}> {
		return this.previewVersion(userId, documentId, versionId, async (transaction, version) => {
			const { rows } = await transaction.query<{ content: Uint8Array }>(
				"SELECT source_bytes AS content FROM document_versions WHERE id = $1",
				[version.versionId],
			);
			return { content: rows[0].content, filename: version.filename };
		});
	}

	private async previewVersion<T>(
		userId: string,
		documentId: string,
		versionId: string | null,
		read: (transaction: SqlClient, version: PreviewVersion) => Promise<T>,
	): Promise<T> {
		return this.database.transaction(async (transaction) => {
			const { rows } = await transaction.query<
				PreviewVersion & {
					knowledgeBaseId: string;
					latest: boolean;
				}
			>(
				`SELECT v.id AS "versionId", v.filename, v.media_type AS "mediaType", v.status,
				 (v.media_type = 'application/pdf' OR v.preview_pdf IS NOT NULL) AS "hasPdf",
				 d.knowledge_base_id AS "knowledgeBaseId", d.latest_version_id = v.id AS latest
				 FROM document_versions v JOIN documents d ON d.id = v.document_id
				 WHERE d.id = $2 AND v.id = COALESCE($3::text, d.current_version_id)
				 AND EXISTS (SELECT 1 ${documentAccess} AND d.id = v.document_id)`,
				[userId, documentId, versionId],
			);
			const version = rows[0];
			if (!version) throw notFound();
			if (version.status !== "ready") {
				if (version.status !== "needs_review" || !version.latest) throw notFound();
				await requireEditor(transaction, userId, version.knowledgeBaseId);
			}
			const { knowledgeBaseId: _base, latest: _latest, ...metadata } = version;
			return read(transaction, metadata);
		});
	}

	async preview(userId: string, documentId: string, versionId: string | null): Promise<DocumentPreview> {
		return this.previewVersion(userId, documentId, versionId, async (transaction, { hasPdf, ...version }) => {
			const { rows } = await transaction.query<Pick<DocumentPreview, "text" | "pages" | "blocks" | "warnings">>(
				"SELECT COALESCE(text, '') AS text, pages, blocks, warnings FROM document_versions WHERE id = $1",
				[version.versionId],
			);
			return {
				...version,
				...rows[0],
				pdfUrl: hasPdf
					? `/api/documents/${encodeURIComponent(documentId)}/pdf?versionId=${encodeURIComponent(version.versionId)}`
					: null,
			};
		});
	}

	async readPdf(userId: string, documentId: string, versionId: string | null): Promise<Uint8Array> {
		return this.previewVersion(userId, documentId, versionId, async (transaction, version) => {
			if (!version.hasPdf) throw notFound();
			const { rows } = await transaction.query<{ content: Uint8Array }>(
				"SELECT COALESCE(preview_pdf, source_bytes) AS content FROM document_versions WHERE id = $1",
				[version.versionId],
			);
			return rows[0].content;
		});
	}

	async approveReview(
		userId: string,
		documentId: string,
		versionId: string,
		changes: { blockId: string; text: string }[],
	): Promise<void> {
		await this.database.transaction(async (transaction) => {
			const document = await editableDocument(transaction, userId, documentId);
			if (document.latestVersionId !== versionId)
				throw new ApiError(409, "version_changed", "文档已有新版本，请刷新后复核");
			const { rows } = await transaction.query<Pick<DocumentPreview, "blocks" | "pages" | "warnings" | "status">>(
				"SELECT blocks, pages, warnings, status FROM document_versions WHERE id = $1 FOR UPDATE",
				[versionId],
			);
			const version = rows[0];
			if (!version || version.status !== "needs_review")
				throw new ApiError(409, "invalid_review", "只有待复核的最新版本可以确认");
			if (
				new Set(changes.map((change) => change.blockId)).size !== changes.length ||
				changes.some((change) => !version.blocks.some((block) => block.id === change.blockId))
			) {
				throw new ApiError(400, "invalid_review", "复核内容包含重复或不存在的正文块");
			}
			const blocks = version.blocks.map((block) => {
				const change = changes.find((item) => item.blockId === block.id);
				return change ? { ...block, text: change.text.replace(/\r\n?/g, "\n").trim() } : block;
			});
			await publishParsedDocument(
				transaction,
				versionId,
				composeParsedDocument(blocks, version.pages, version.warnings),
				userId,
			);
		});
	}

	async getChunk(userId: string, id: string): Promise<DocumentChunk> {
		const { rows } = await this.database.query<Omit<DocumentChunk, "sourceUrl">>(
			`WITH allowed_documents AS (SELECT d.id, d.knowledge_base_id ${documentAccess})
			 SELECT ${chunkColumns} FROM allowed_documents d
			 JOIN document_versions v ON v.document_id = d.id AND v.status = 'ready'
			 JOIN document_chunks c ON c.version_id = v.id WHERE c.id = $2`,
			[userId, id],
		);
		if (!rows[0]) throw notFound();
		return withSourceUrl(rows[0]);
	}

	async search(
		userId: string,
		input: SearchRequest,
		options: { plan?: SearchPlan; baseline?: boolean; candidates?: boolean } = {},
	): Promise<SearchHit[]> {
		if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 300) {
			throw new ApiError(400, "invalid_query", "query 必须是 1 到 300 个字符的文本");
		}
		const rawTerms = searchTerms(input.query);
		const plan = options.plan ?? planSearch(input.query);
		const terms = options.baseline ? rawTerms : [...new Set([...plan.terms, ...plan.expandedTerms])];
		if (rawTerms.length === 0 || rawTerms.length > 64)
			throw new ApiError(400, "invalid_query", "请提供 1 到 64 个可检索的关键词");
		const limit = input.limit ?? 5;
		if (!Number.isInteger(limit) || limit < 1 || limit > 20)
			throw new ApiError(400, "invalid_limit", "limit 必须是 1 到 20 的整数");
		const ids = input.knowledgeBaseIds ?? null;
		if (ids !== null) {
			if (
				!Array.isArray(ids) ||
				ids.length < 1 ||
				ids.length > 20 ||
				new Set(ids).size !== ids.length ||
				!ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)
			) {
				throw new ApiError(400, "invalid_scope", "请提供 1 到 20 个不重复的知识库 ID");
			}
			if ((await accessibleKnowledgeBases(this.database, userId, ids)).length !== ids.length) throw notFound();
		}
		if (terms.length === 0) return [];
		// Every term contains letters/numbers only; user text never becomes SQL or raw tsquery syntax.
		const query = terms.map((term) => `'${term}'`).join(" | ");
		const { rows } = await this.database.query<Omit<SearchHit, "sourceUrl">>(
			`WITH allowed_documents AS (
			   SELECT d.id, d.knowledge_base_id, d.current_version_id ${documentAccess}
			   AND ($2::text[] IS NULL OR k.id = ANY($2::text[]))
			 )
			 SELECT ${chunkColumns}, ts_rank_cd(c.search_vector, query, 32)::double precision AS score
			 FROM allowed_documents d JOIN document_versions v ON v.id = d.current_version_id AND v.status = 'ready'
			 JOIN document_chunks c ON c.version_id = v.id, to_tsquery('simple', $3) query
			 WHERE (c.search_vector @@ query OR d.id = ANY($5::text[])) ORDER BY score DESC, d.id, c.position LIMIT $4`,
			[userId, ids, query, options.baseline ? limit : 80, options.baseline ? [] : plan.contextDocumentIds],
		);
		const hits = rows.map(withSourceUrl);
		if (options.baseline) return hits;
		const ranked = rankKeywordHits(hits, plan);
		return options.candidates ? ranked : ranked.slice(0, limit);
	}
}
