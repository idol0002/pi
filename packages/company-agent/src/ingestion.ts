/**
 * 文档入库 worker：领取任务 → 解析正文 → 发布或进入复核 → 继续下一项。
 * 队列与重试次数在数据库中；active/currentJob 只是本进程的执行与取消句柄。
 */
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

/** 单个本地 worker；wake 只发出调度信号，文档内容始终从数据库里的任务读取。 */
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
		// 上次进程退出后留下的 processing 不会自己完成；按剩余次数恢复为 queued 或 failed。
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
		// 执行中收到新任务时先记住唤醒请求，既不并发启动第二个 drain，也不丢掉新增任务。
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
		// 删除当前正在解析的文档时，将取消信号一直传递到解析子进程。
		if (this.currentJob?.documentId === documentId) {
			this.currentJob.controller.abort(new ApiError(499, "document_deleted", "文档已删除，解析已停止"));
		}
	}

	private async purgeDeleted(): Promise<void> {
		// 删除版本会通过外键级联清理片段等内容；消息来源 ID 仍保留，供历史失效判断。
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
		// 领取和增加 attempts 在同一事务内完成，后续执行失败也会计入次数上限。
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
			// 解析器返回统一的正文/分块/位置/警告；progress 单独写入数据库供页面轮询。
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
			// 解析可能很慢：发布前再检查是否被删除、任务是否取消以及是否仍为最新版本。
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
			// 服务关闭导致的中断可按剩余次数重新排队；普通解析错误先记录失败，等待维护者处理。
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
