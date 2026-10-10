/**
 * 向量索引生命周期：扫描已发布分块、批量向量化、按配置版本写入，再按当前用户权限查询。
 * 文档/关键词发布不等待这里完成；RetrievalService 会检查覆盖情况并解释索引未齐的状态。
 */
import type { PGlite } from "@electric-sql/pglite";
import { chunkColumns, withSourceUrl } from "./documents.ts";
import type { EmbeddingModel } from "./embeddings.ts";
import { ApiError, notFound } from "./errors.ts";
import { accessibleKnowledgeBases, documentAccess } from "./store.ts";
import type { DocumentChunk, SearchHit } from "./types.ts";

/** 每个本地数据库一个索引器；已发布但缺少当前 profile 向量的分块就是持久化待办队列。 */
export class VectorIndex {
	readonly model: EmbeddingModel;
	private readonly database: PGlite;
	private active: Promise<void> | undefined;
	private controller: AbortController | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private failure: string | undefined;
	private failures = 0;
	private paused = false;

	constructor(database: PGlite, model: EmbeddingModel) {
		this.database = database;
		this.model = model;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.wake();
	}

	wake(): void {
		// 同一时刻只跑一轮扫描；配置错误暂停，暂时错误退避，避免持续重复发送同一批资料。
		if (!this.running || this.active || this.paused) return;
		clearTimeout(this.timer);
		const controller = new AbortController();
		this.controller = controller;
		this.active = this.indexPending(controller.signal)
			.then(() => {
				this.failure = undefined;
				this.failures = 0;
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) {
					this.failures++;
					this.paused =
						this.failures >= 3 ||
						(error instanceof ApiError &&
							["embedding_configuration", "invalid_embeddings", "embedding_dimensions_changed"].includes(
								error.code,
							));
					this.failure = this.paused
						? "语义索引已暂停，请检查向量模型配置并重启服务"
						: "语义索引暂不可用，请稍后重试";
				}
			})
			.finally(() => {
				this.active = undefined;
				this.controller = undefined;
				if (this.running && !this.paused) {
					this.timer = setTimeout(() => this.wake(), this.failure ? 30_000 * 2 ** (this.failures - 1) : 5000);
					this.timer.unref();
				}
			});
	}

	async waitForIdle(): Promise<void> {
		await this.active;
	}

	async stop(): Promise<void> {
		this.running = false;
		clearTimeout(this.timer);
		this.controller?.abort(new ApiError(499, "index_stopped", "语义索引已停止"));
		await this.active;
	}

	async indexPending(signal: AbortSignal): Promise<void> {
		// 后台为有效知识库的已发布资料建索引；查询时才按具体员工过滤，索引存在不代表有权读取。
		while (!signal.aborted) {
			const { rows } = await this.database.query<{
				id: string;
				title: string;
				heading: string | null;
				text: string;
			}>(
				`SELECT c.id, v.title, c.heading, c.text FROM document_chunks c
				 JOIN document_versions v ON v.id = c.version_id AND v.status = 'ready'
				 JOIN documents d ON d.current_version_id = v.id AND NOT d.deleted
				 JOIN knowledge_bases k ON k.id = d.knowledge_base_id AND k.active
				 LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.profile_id = $1
				 WHERE e.chunk_id IS NULL ORDER BY c.id LIMIT 16`,
				[this.model.profileId],
			);
			if (rows.length === 0) return;
			// 网络调用放在写事务之外，避免持有数据库事务等待较慢的外部服务。
			const vectors = await this.model.embed(
				rows.map((row) => `${row.title}\n${(row.heading ?? "").slice(0, 400)}\n${row.text}`),
				signal,
			);
			signal.throwIfAborted();
			await this.database.transaction(async (transaction) => {
				await transaction.query(
					"INSERT INTO embedding_profiles (id, dimensions) VALUES ($1, $2) ON CONFLICT DO NOTHING",
					[this.model.profileId, vectors[0].length],
				);
				const profile = await transaction.query<{ dimensions: number }>(
					"SELECT dimensions FROM embedding_profiles WHERE id = $1",
					[this.model.profileId],
				);
				if (profile.rows[0].dimensions !== vectors[0].length)
					throw new ApiError(
						503,
						"embedding_dimensions_changed",
						"向量维度发生变化，请更新模型配置版本后重新建立索引",
					);
				// 服务返回时版本可能已替换或删除，写入前重新连接 current/ready/未删除条件。
				await transaction.query(
					`INSERT INTO chunk_embeddings (chunk_id, profile_id, embedding)
					 SELECT c.id, $1, x.embedding::vector
					 FROM jsonb_to_recordset($2::jsonb) AS x(id text, embedding text)
					 JOIN document_chunks c ON c.id = x.id
					 JOIN document_versions v ON v.id = c.version_id AND v.status = 'ready'
					 JOIN documents d ON d.current_version_id = v.id AND NOT d.deleted
					 JOIN knowledge_bases k ON k.id = d.knowledge_base_id AND k.active
					 ON CONFLICT DO NOTHING`,
					[
						this.model.profileId,
						JSON.stringify(rows.map((row, index) => ({ id: row.id, embedding: JSON.stringify(vectors[index]) }))),
					],
				);
			});
		}
		signal.throwIfAborted();
	}

	async coverage(userId: string, ids: string[] | null): Promise<{ total: number; indexed: number; failure?: string }> {
		// 覆盖率只统计当前员工可见的当前版本，不能让无关知识库影响本次就绪判断。
		if (ids && (await accessibleKnowledgeBases(this.database, userId, ids)).length !== ids.length) throw notFound();
		const result = await this.database.query<{ total: number; indexed: number }>(
			`WITH allowed AS (SELECT d.id, d.current_version_id ${documentAccess} AND ($2::text[] IS NULL OR k.id = ANY($2::text[])))
			 SELECT count(c.id)::int AS total, count(e.chunk_id)::int AS indexed
			 FROM allowed d JOIN document_versions v ON v.id = d.current_version_id AND v.status = 'ready'
			 JOIN document_chunks c ON c.version_id = v.id
			 LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.profile_id = $3`,
			[userId, ids, this.model.profileId],
		);
		const counts = result.rows[0];
		return { ...counts, ...(counts.indexed < counts.total && this.failure ? { failure: this.failure } : {}) };
	}

	async search(userId: string, ids: string[] | null, query: string, signal: AbortSignal): Promise<SearchHit[]> {
		// 先验证范围，再向量化问题；返回后 SQL 仍按实时权限筛选候选。
		if (ids && (await accessibleKnowledgeBases(this.database, userId, ids)).length !== ids.length) throw notFound();
		const [embedding] = await this.model.embed([query], signal);
		const profile = await this.database.query<{ dimensions: number }>(
			"SELECT dimensions FROM embedding_profiles WHERE id = $1",
			[this.model.profileId],
		);
		if (!profile.rows[0] || profile.rows[0].dimensions !== embedding.length) {
			throw new ApiError(503, "embedding_dimensions_changed", "语义索引与当前向量模型不一致，请重新建立索引");
		}
		signal.throwIfAborted();
		// <=> 是余弦距离，1 - 距离作为相似度；当前执行精确排序，未使用近似向量索引。
		const { rows } = await this.database.query<{ hit: Omit<DocumentChunk, "sourceUrl">; score: number }>(
			`WITH allowed AS MATERIALIZED (
			   SELECT d.id, d.knowledge_base_id, d.current_version_id ${documentAccess}
			   AND ($2::text[] IS NULL OR k.id = ANY($2::text[]))
			 ), chunks AS MATERIALIZED (
			   SELECT ${chunkColumns} FROM allowed d
			   JOIN document_versions v ON v.id = d.current_version_id AND v.status = 'ready'
			   JOIN document_chunks c ON c.version_id = v.id
			 ), matching AS MATERIALIZED (
			   SELECT to_jsonb(c) AS hit, e.embedding FROM chunks c
			   JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.profile_id = $3
			 )
			 SELECT hit, (1 - (embedding <=> $4::vector))::double precision AS score FROM matching
			 WHERE 1 - (embedding <=> $4::vector) >= $5 ORDER BY embedding <=> $4::vector LIMIT 40`,
			[userId, ids, this.model.profileId, JSON.stringify(embedding), this.model.minSimilarity],
		);
		return rows.map(({ hit, score }) => withSourceUrl({ ...hit, score }));
	}
}
