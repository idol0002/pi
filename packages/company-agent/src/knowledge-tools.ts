/**
 * Pi 的业务工具。身份和知识范围由服务端闭包提供，模型不能传入 userId 扩权。
 * 所有暴露给模型的来源都加入 evidence，后续撤权检查与历史遮蔽因此覆盖未显式引用的资料。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { AnswerEvidence } from "./answer-model.ts";
import type { ChatStore } from "./chat-store.ts";
import { includeEvidence, restoreTurn, usableTurns } from "./conversation-context.ts";
import { ApiError } from "./errors.ts";
import type { RetrievalService } from "./retrieval.ts";
import { meaningfulTerms } from "./search-query.ts";

interface KnowledgeToolsOptions {
	userId: string;
	conversationId: string;
	runId: string;
	knowledgeBaseIds: string[];
	evidence: AnswerEvidence[];
	store: ChatStore;
	retrieval: RetrievalService;
	verifyAccess: () => Promise<void>;
}

export function modelSource(source: AnswerEvidence, full = true) {
	return {
		number: source.number,
		title: source.title,
		version: source.version,
		heading: source.heading,
		text: full ? source.text : source.text.slice(0, 240),
		truncated: !full && source.text.length > 240,
	};
}

export function createKnowledgeTools(options: KnowledgeToolsOptions): AgentTool[] {
	const searchParameters = Type.Object(
		{
			query: Type.String({ minLength: 1, maxLength: 300 }),
		},
		{ additionalProperties: false },
	);
	const readParameters = Type.Object(
		{
			numbers: Type.Array(Type.Integer({ minimum: 1, maximum: 10 }), {
				minItems: 1,
				maxItems: 3,
				uniqueItems: true,
			}),
		},
		{ additionalProperties: false },
	);
	const recallParameters = Type.Object(
		{
			query: Type.String({ minLength: 1, maxLength: 200 }),
		},
		{ additionalProperties: false },
	);
	const search: AgentTool<typeof searchParameters, { count: number }> = {
		name: "knowledge_search",
		label: "检索知识库",
		description:
			"在当前员工获授权且本会话选定的知识库内检索。返回稳定引用编号和摘录；truncated 时可调用 knowledge_read 阅读完整片段。身份与范围不能修改。",
		parameters: searchParameters,
		// 来源编号和容量属于共享运行状态，业务工具按顺序执行以确保编号稳定。
		executionMode: "sequential",
		async execute(_id, { query }, signal) {
			await options.verifyAccess();
			const result = await options.retrieval.search(
				options.userId,
				{
					query,
					knowledgeBaseIds: options.knowledgeBaseIds,
					limit: 3,
				},
				{ signal },
			);
			signal?.throwIfAborted();
			const admitted: AnswerEvidence[] = [];
			for (const hit of result.hits) {
				const sources = includeEvidence(options.evidence, [hit]);
				if (sources) admitted.push(...sources);
			}
			await options.verifyAccess();
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							sources: admitted.map((source) => modelSource(source, false)),
							note:
								admitted.length < result.hits.length ? "资料预算已满，请基于已取得的资料回答。" : result.note,
						}),
					},
				],
				details: { count: admitted.length },
			};
		},
	};
	const read: AgentTool<typeof readParameters, { count: number }> = {
		name: "knowledge_read",
		label: "读取参考资料",
		description:
			"按已发现的引用编号读取完整文本片段；只能读取本轮检索或有效历史中出现的资料。不会访问文件系统或任意 URL。",
		parameters: readParameters,
		executionMode: "sequential",
		async execute(_id, { numbers }, signal) {
			await options.verifyAccess();
			signal?.throwIfAborted();
			const sources = numbers.map((number) => options.evidence.find((source) => source.number === number));
			if (sources.some((source) => !source)) throw new ApiError(404, "unknown_source", "请先检索有效的资料编号");
			return {
				content: [
					{ type: "text", text: JSON.stringify({ sources: sources.map((source) => modelSource(source!)) }) },
				],
				details: { count: sources.length },
			};
		},
	};
	const recall: AgentTool<typeof recallParameters, { count: number }> = {
		name: "conversation_recall",
		label: "查找会话历史",
		description:
			"按关键词查找本会话较早的完成问答。只返回当前仍有权限且来源版本仍有效的历史，并重新映射引用编号。适合恢复此前讨论的条件或结论。",
		parameters: recallParameters,
		executionMode: "sequential",
		async execute(_id, { query }, signal) {
			await options.verifyAccess();
			const terms = meaningfulTerms(query);
			if (terms.length === 0) throw new ApiError(400, "invalid_recall_query", "请提供具体的历史查询词");
			const history = await options.store.history(options.userId, options.conversationId);
			const turns = [];
			for (const turn of usableTurns(history).reverse()) {
				if (turn.answer.runId === options.runId || turn.question.content.length + turn.answer.content.length > 4000)
					continue;
				const text = (turn.question.content + "\n" + turn.answer.content).normalize("NFKC").toLowerCase();
				if (!terms.some((term) => text.includes(term))) continue;
				const restored = restoreTurn(turn, options.evidence);
				if (restored) turns.push(restored);
				if (turns.length === 2) break;
			}
			signal?.throwIfAborted();
			await options.verifyAccess();
			return {
				content: [{ type: "text", text: JSON.stringify({ turns }) }],
				details: { count: turns.length },
			};
		},
	};
	return [search, read, recall];
}
