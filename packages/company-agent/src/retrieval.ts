/**
 * 检索编排入口：关键词候选 → 可选向量候选 → 去重/排名融合 → 返回过程信息。
 * 不调用生成模型；chat.ts 拿到这里的结果后才组织回答上下文。
 */
import type { PGlite } from "@electric-sql/pglite";
import { DocumentService } from "./documents.ts";
import { ApiError } from "./errors.ts";
import { planSearch, type SearchPlan } from "./search-query.ts";
import { fuseRanks, selectSources } from "./search-ranking.ts";
import type { RetrievalInfo, SearchHit, SearchRequest, SearchResult } from "./types.ts";
import type { VectorIndex } from "./vector-index.ts";

export class RetrievalService {
	private readonly documents: DocumentService;
	readonly vectors?: VectorIndex;

	constructor(database: PGlite, vectors?: VectorIndex) {
		this.documents = new DocumentService(database);
		this.vectors = vectors;
	}

	async search(
		userId: string,
		input: SearchRequest,
		options: { signal?: AbortSignal; plan?: SearchPlan } = {},
	): Promise<SearchResult> {
		const started = performance.now();
		const signal = options.signal ?? new AbortController().signal;
		const plan = options.plan ?? planSearch(input.query);
		signal.throwIfAborted();
		// 先验证整个请求知识范围，再考虑向量服务调用，避免无效范围触发外部请求。
		const keyword = await this.documents.search(userId, input, { plan, candidates: true });
		const info: RetrievalInfo = {
			method: "keyword",
			contextual: plan.contextual,
			durationMs: 0,
			keywordCandidates: keyword.length,
			semanticCandidates: 0,
		};
		let hits: SearchHit[] = selectSources(keyword, input.limit ?? 5);
		if (this.vectors && plan.terms.length > 0) {
			// 新文档可能已能做关键词检索，但向量尚未补齐，需要向用户解释本次检索方式。
			const coverage = await this.vectors.coverage(userId, input.knowledgeBaseIds ?? null);
			if (coverage.indexed < coverage.total) {
				this.vectors.wake();
				// 索引未齐且关键词也没找到依据时，不能把“尚未查完整”说成“资料不存在”。
				if (hits.length === 0)
					throw new ApiError(503, "semantic_index_pending", coverage.failure ?? "语义索引正在更新，请稍后重试");
				info.note = coverage.failure ?? "语义索引正在更新，本次使用关键词检索";
			} else if (coverage.total > 0) {
				const semantic = await this.vectors.search(
					userId,
					input.knowledgeBaseIds ?? null,
					plan.embeddingText,
					signal,
				);
				info.method = "hybrid";
				info.semanticCandidates = semantic.length;
				hits = fuseRanks(keyword, semantic, input.limit ?? 5);
			}
		}
		signal.throwIfAborted();
		// 耗时与候选数供诊断使用，不表示回答正确率。
		info.durationMs = Math.round(performance.now() - started);
		return { query: input.query, hits, ...info };
	}
}
