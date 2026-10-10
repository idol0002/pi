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
		// This also validates the complete requested knowledge scope before any provider request.
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
			const coverage = await this.vectors.coverage(userId, input.knowledgeBaseIds ?? null);
			if (coverage.indexed < coverage.total) {
				this.vectors.wake();
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
		info.durationMs = Math.round(performance.now() - started);
		return { query: input.query, hits, ...info };
	}
}
