import type { PGlite } from "@electric-sql/pglite";
import { createDocumentParser, type DocumentParser } from "./document-parser.ts";
import { MAX_INGESTION_ATTEMPTS } from "./documents.ts";
import { ApiError } from "./errors.ts";
import { publishParsedDocument } from "./parsed-store.ts";
import type { DocumentMediaType } from "./types.ts";

interface ClaimedJob {
	id: string;
	versionId: string;
	documentId: string;
	content: Uint8Array;
	mediaType: DocumentMediaType;
	title: string;
	version: number;
}

export interface IngestionOptions {
	parse?: DocumentParser;
	onError?: (error: unknown) => void;
}

/** A single local worker. The database owns queue state; wake-ups carry no document content. */
export class IngestionWorker {
	private readonly database: PGlite;
	private readonly options: IngestionOptions;
	private running = false;
	private wakeRequested = false;
	private active: Promise<void> | undefined;
	private readonly parse: DocumentParser;
	private currentJob: { documentId: string; controller: AbortController } | undefined;

	constructor(database: PGlite, options: IngestionOptions = {}) {
		this.database = database;
		this.options = options;
		this.parse = options.parse ?? createDocumentParser();
	}

	async start(): Promise<void> {
		if (this.running) return;
		await this.database.transaction(async (transaction) => {
			await transaction.query(
				`UPDATE ingestion_jobs SET status = CASE WHEN attempts < $1 THEN 'queued' ELSE 'failed' END,
				 error = CASE WHEN attempts < $1 THEN NULL ELSE '处理进程中断，已达到处理上限' END,
				 stage = CASE WHEN attempts < $1 THEN 'queued' ELSE 'failed' END,
				 updated_at = CURRENT_TIMESTAMP WHERE status = 'processing'`,
				[MAX_INGESTION_ATTEMPTS],
			);
			await transaction.query(
				`UPDATE document_versions v SET status = j.status, error = j.error
				 FROM ingestion_jobs j WHERE j.version_id = v.id AND v.status = 'processing'
				 AND j.status IN ('queued', 'failed')`,
			);
		});
		this.running = true;
		this.wake();
	}

	wake(): void {
		this.wakeRequested = true;
		if (!this.running || this.active) return;
		this.active = this.drain()
			.catch((error: unknown) => this.options.onError?.(error))
			.finally(() => {
				this.active = undefined;
				if (this.running && this.wakeRequested) this.wake();
			});
	}

	async waitForIdle(): Promise<void> {
		while (this.active) await this.active;
	}

	async stop(): Promise<void> {
		this.running = false;
		this.currentJob?.controller.abort(new ApiError(499, "parse_interrupted", "服务关闭，解析将在重启后恢复"));
		await this.waitForIdle();
	}

	cancelDocument(documentId: string): void {
		if (this.currentJob?.documentId === documentId) {
			this.currentJob.controller.abort(new ApiError(499, "document_deleted", "文档已删除，解析已停止"));
		}
	}

	private async purgeDeleted(): Promise<void> {
		await this.database.transaction(async (transaction) => {
			await transaction.query(
				`UPDATE documents SET current_version_id = NULL, latest_version_id = NULL, source_text = ''
				 WHERE deleted AND (latest_version_id IS NOT NULL OR source_text <> '')`,
			);
			await transaction.query(
				"DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE deleted)",
			);
		});
	}

	private async drain(): Promise<void> {
		do {
			this.wakeRequested = false;
			await this.purgeDeleted();
			while (this.running) {
				const job = await this.claim();
				if (!job) break;
				await this.process(job);
			}
			await this.purgeDeleted();
		} while (this.running && this.wakeRequested);
	}

	private async claim(): Promise<ClaimedJob | undefined> {
		return this.database.transaction(async (transaction) => {
			const { rows } = await transaction.query<ClaimedJob>(
				`SELECT j.id, j.version_id AS "versionId", j.document_id AS "documentId", v.source_bytes AS content,
				        v.media_type AS "mediaType", v.title, v.version
				 FROM ingestion_jobs j JOIN document_versions v ON v.id = j.version_id
				 JOIN documents d ON d.id = j.document_id
				 WHERE j.status = 'queued' AND j.attempts < $1 AND NOT d.deleted AND d.latest_version_id = v.id
				 ORDER BY j.created_at, j.id LIMIT 1 FOR UPDATE OF j`,
				[MAX_INGESTION_ATTEMPTS],
			);
			const job = rows[0];
			if (!job) return undefined;
			await transaction.query(
				`UPDATE ingestion_jobs SET status = 'processing', stage = 'extracting', processed_pages = 0, total_pages = 0, warnings = '[]', attempts = attempts + 1,
				 updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
				[job.id],
			);
			await transaction.query("UPDATE document_versions SET status = 'processing' WHERE id = $1", [job.versionId]);
			return job;
		});
	}

	private async process(job: ClaimedJob): Promise<void> {
		const controller = new AbortController();
		this.currentJob = { documentId: job.documentId, controller };
		try {
			const parsed = await this.parse(job.content, job.mediaType, {
				signal: controller.signal,
				progress: async (progress) => {
					controller.signal.throwIfAborted();
					const result = await this.database.query(
						"UPDATE ingestion_jobs SET stage = $2, processed_pages = $3, total_pages = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'processing' RETURNING id",
						[job.id, progress.stage, progress.processedPages, progress.totalPages],
					);
					if (result.rows.length === 0) throw new ApiError(499, "document_deleted", "文档已删除，解析已停止");
				},
			});
			controller.signal.throwIfAborted();
			await this.database.query(
				"UPDATE ingestion_jobs SET stage = 'indexing' WHERE id = $1 AND status = 'processing'",
				[job.id],
			);
			await this.database.transaction(async (transaction) => {
				const { rows } = await transaction.query(
					`SELECT j.id FROM ingestion_jobs j JOIN documents d ON d.id = j.document_id
					 WHERE j.id = $1 AND j.status = 'processing' AND NOT d.deleted AND d.latest_version_id = $2
					 FOR UPDATE OF j, d`,
					[job.id, job.versionId],
				);
				if (rows.length === 0) return;
				await publishParsedDocument(transaction, job.versionId, parsed);
			});
		} catch (error) {
			if (!(error instanceof ApiError)) this.options.onError?.(error);
			const message = error instanceof ApiError ? error.message : "文档处理失败，请重试";
			const retry = error instanceof ApiError && error.code === "parse_interrupted";
			await this.database.transaction(async (transaction) => {
				const result = await transaction.query(
					`UPDATE ingestion_jobs SET status = CASE WHEN $3 AND attempts < 3 THEN 'queued' ELSE 'failed' END,
					 stage = CASE WHEN $3 AND attempts < 3 THEN 'queued' ELSE 'failed' END, error = $2, updated_at = CURRENT_TIMESTAMP
					 WHERE id = $1 AND status = 'processing' RETURNING id`,
					[job.id, message, retry],
				);
				if (result.rows.length === 0) return;
				await transaction.query(
					"UPDATE document_versions SET status = (SELECT CASE WHEN status = 'queued' THEN 'queued' ELSE 'failed' END FROM ingestion_jobs WHERE version_id = $1), error = $2 WHERE id = $1",
					[job.versionId, message],
				);
			});
		} finally {
			this.currentJob = undefined;
		}
	}
}
