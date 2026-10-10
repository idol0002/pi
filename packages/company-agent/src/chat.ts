/**
 * 问答主流程：验证会话 → 登记运行 → 检索 → 组织历史/证据 → 生成 → 校验引用 → 保存终态。
 * conversationId 标识会话，runId 标识一轮生成，messageId 标识该轮助手消息。
 * 浏览器通过 server.ts 的 SSE 接收本文件发出的 ChatEvent。
 */
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { AnswerEvidence, AnswerInput, AnswerModel } from "./answer-model.ts";
import { ChatStore, publicMessage, type StoredMessage } from "./chat-store.ts";
import { ApiError, notFound } from "./errors.ts";
import { RetrievalService } from "./retrieval.ts";
import { planSearch } from "./search-query.ts";
import type { ChatEvent, ModelInfo, SearchResult } from "./types.ts";

const MAX_ANSWER_LENGTH = 24_000;
const MAX_EVIDENCE_LENGTH = 12_000;
const MAX_EVIDENCE_COUNT = 10;
const NO_EVIDENCE = "未在所选知识库中找到可用依据。请补充相关文档或换一种问法。";

interface ActiveRun {
	id: string;
	userId: string;
	controller: AbortController;
	finished: Promise<void>;
	resolve: () => void;
}

export interface ChatRun {
	id: string;
	messageId: string;
	signal: AbortSignal;
	abort: () => void;
	execute: (emit: (event: ChatEvent) => Promise<void>) => Promise<void>;
}

/** runs 只登记本机正在执行的任务；持久化历史在数据库中，不复用某个 Agent 的内存状态。 */
export class ChatService {
	readonly store: ChatStore;
	readonly info: ModelInfo;
	readonly retrieval: RetrievalService;
	private readonly model: AnswerModel;
	private readonly runs = new Map<string, ActiveRun>();
	private stopping = false;

	constructor(database: PGlite, model: AnswerModel, retrieval = new RetrievalService(database)) {
		this.store = new ChatStore(database);
		this.retrieval = retrieval;
		this.model = model;
		this.info = model.info;
	}

	async prepare(
		userId: string,
		conversationId: string,
		question: string,
		authenticate: () => Promise<unknown>,
	): Promise<ChatRun> {
		// prepare 只做前置验证与持久化占位，server.ts 准备好事件流后才调用返回的 execute。
		question = question.trim();
		if (!question || question.length > 2000)
			throw new ApiError(400, "invalid_question", "问题长度须为 1 到 2000 个字符");
		const conversation = await this.store.conversation(userId, conversationId);
		if (this.stopping) throw new ApiError(503, "shutting_down", "服务正在关闭");
		if (this.runs.has(conversationId))
			throw new ApiError(409, "conversation_busy", "当前会话正在回答，请等待或停止生成");
		if (this.runs.size >= 4 || [...this.runs.values()].some((run) => run.userId === userId)) {
			throw new ApiError(429, "chat_busy", "生成任务已满，请等待现有回答完成");
		}
		let resolve = () => {};
		const active: ActiveRun = {
			id: randomUUID(),
			userId,
			controller: new AbortController(),
			finished: new Promise<void>((ready) => {
				resolve = ready;
			}),
			resolve: () => resolve(),
		};
		// 必须在下一次 await 前同步占位，否则两个并发请求可能都判断“当前没有任务”。
		this.runs.set(conversationId, active);
		let messageId: string;
		try {
			messageId = await this.store.begin(userId, conversationId, active.id, question, this.model.info.name);
		} catch (error) {
			this.runs.delete(conversationId);
			active.resolve();
			throw error;
		}
		const { signal } = active.controller;
		return {
			id: active.id,
			messageId,
			signal,
			abort: () => active.controller.abort(new ApiError(499, "cancelled", "已停止生成")),
			execute: async (emit) => {
				// 本轮运行的超时与取消共享同一个 signal，生成、交付和清理都观察它。
				const timeout = setTimeout(
					() => active.controller.abort(new ApiError(504, "model_timeout", "回答超时，请重试")),
					this.model.timeoutMs,
				);
				let evidence: AnswerEvidence[] = [];
				const checkAccess = async () => {
					// 生成可能持续较久，所以读取资料时验证一次还不够，交付增量前也重新验证。
					signal.throwIfAborted();
					await authenticate();
					await this.store.assertAccess(userId, conversationId, evidence);
					signal.throwIfAborted();
				};
				try {
					await checkAccess();
					await emit({ type: "start", runId: active.id, messageId });
					await emit({ type: "status", stage: "retrieving" });
					// history 已根据当前权限遮蔽失效来源；本轮刚创建的消息不能作为自己的历史。
					const previous = (await this.store.history(userId, conversationId)).filter(
						(message) => message.runId !== active.id,
					);
					// 追问只能借用完成、未遮蔽且所有证据仍为当前版本的上一轮资料。
					const previousAnswer = previous.findLast(
						(message) =>
							message.role === "assistant" &&
							message.status === "complete" &&
							!message.redacted &&
							message.evidence.length > 0 &&
							message.evidence.every((source) => source.current),
					);
					const previousQuestion = previous.find(
						(message) => message.role === "user" && message.runId === previousAnswer?.runId,
					)?.content;
					// “那多久能批”可能补入上轮主题；原始问题仍单独保留给生成模型。
					const plan = planSearch(
						question,
						previousQuestion,
						previousAnswer?.evidence.map((source) => source.documentId),
					);
					const retrieval: SearchResult = plan.keywordQuery
						? await this.retrieval.search(
								userId,
								{ query: plan.keywordQuery, knowledgeBaseIds: conversation.knowledgeBaseIds, limit: 6 },
								{ signal, plan },
							)
						: {
								query: "",
								hits: [],
								method: "keyword",
								contextual: false,
								durationMs: 0,
								keywordCandidates: 0,
								semanticCandidates: 0,
							};
					const hits = retrieval.hits;
					// 编号由服务端分配，模型只引用编号，不自行决定文档 URL。
					evidence = hits.map((source, index) => ({ ...source, number: index + 1, current: true }));
					// addHistory 会同时向 evidence 追加合法历史来源；最终依据不只看本次 hits 是否为空。
					const history = hits.length > 0 || plan.contextual ? addHistory(previous, evidence) : [];
					await checkAccess();
					await emit({ type: "status", stage: "answering", sourceCount: evidence.length, note: retrieval.note });
					let result: Awaited<ReturnType<AnswerModel["generate"]>>;
					if (evidence.length === 0) {
						// 最终仍没有可用依据时直接给出说明，不调用生成模型补猜公司事实。
						result = { content: NO_EVIDENCE, usage: null };
						await emit({ type: "delta", text: NO_EVIDENCE });
					} else {
						let length = 0;
						result = await abortable(
							this.model.generate({
								question,
								history,
								evidence,
								signal,
								onText: async (text) => {
									// 增量是待最终校验的正文；持续检查长度、取消状态和当前权限。
									length += text.length;
									if (length > MAX_ANSWER_LENGTH)
										throw new ApiError(502, "answer_too_long", "回答超过长度限制，请缩小问题范围");
									await checkAccess();
									await emit({ type: "delta", text });
								},
							}),
							signal,
						);
					}
					if (!result.content.trim() || result.content.length > MAX_ANSWER_LENGTH) {
						throw new ApiError(502, "invalid_answer", "模型返回了空白或过长的回答，请重试");
					}
					// 文本生成成功不等于可提交：还需检查引用编号、权限并把完整消息保存到数据库。
					const cited = validateCitations(result.content, evidence.length);
					await checkAccess();
					await this.store.complete(
						userId,
						conversationId,
						messageId,
						result.content,
						result.usage,
						evidence,
						cited,
						{
							method: retrieval.method,
							contextual: retrieval.contextual,
							durationMs: retrieval.durationMs,
							keywordCandidates: retrieval.keywordCandidates,
							semanticCandidates: retrieval.semanticCandidates,
							note: retrieval.note,
						},
					);
					await checkAccess();
					// 保存之后再按当前可见性读取，避免把刚被撤权的答案作为成功终态交给浏览器。
					const message = (await this.store.history(userId, conversationId)).find((item) => item.id === messageId);
					if (!message || message.redacted) throw new ApiError(403, "sources_changed", "资料访问权限已变更");
					await emit({ type: "sources", sources: message.sources });
					await emit({ type: "done", message: publicMessage(message) });
				} catch (error) {
					const cause: unknown = signal.aborted ? signal.reason : error;
					const failure =
						cause instanceof ApiError ? cause : new ApiError(500, "answer_failed", "回答失败，请稍后重试");
					active.controller.abort(failure);
					await this.store.fail(messageId, failure.code === "cancelled" ? "cancelled" : "error", failure.code);
					await emit({ type: "error", code: failure.code, message: failure.message, messageId });
				} finally {
					// 无论完成、失败还是取消，都释放并发名额，并唤醒正在等待取消完成的调用方。
					clearTimeout(timeout);
					active.controller.abort();
					this.runs.delete(conversationId);
					active.resolve();
				}
			},
		};
	}

	async cancel(userId: string, conversationId: string, runId: string): Promise<void> {
		// 校验创建者与精确 runId，防止取消别人的任务或误停本会话下一轮。
		await this.store.conversation(userId, conversationId);
		const run = this.runs.get(conversationId);
		if (!run || run.id !== runId || run.userId !== userId) throw notFound();
		run.controller.abort(new ApiError(499, "cancelled", "已停止生成"));
		await run.finished;
	}

	async stop(): Promise<void> {
		this.stopping = true;
		for (const run of this.runs.values())
			run.controller.abort(new ApiError(499, "cancelled", "服务关闭，已停止生成"));
		await Promise.all([...this.runs.values()].map((run) => run.finished));
	}
}

function addHistory(messages: StoredMessage[], evidence: AnswerEvidence[]): AnswerInput["history"] {
	// 优先尝试最近两轮，预算同时约束证据条数、证据正文和历史对话长度。
	// evidence 是本轮共享数组：补入历史来源后，原答案中的引用编号要映射到新编号。
	const history: AnswerInput["history"] = [];
	let size = evidence.reduce((total, source) => total + source.text.length, 0);
	let historySize = 0;
	for (const answer of messages
		.filter((message) => message.role === "assistant")
		.slice(-2)
		.reverse()) {
		const question = messages.find((message) => message.role === "user" && message.runId === answer.runId);
		if (
			!question ||
			answer.status !== "complete" ||
			answer.redacted ||
			answer.evidence.length === 0 ||
			answer.evidence.some((source) => !source.current)
		)
			continue;
		const additions = answer.evidence.filter((source) => !evidence.some((item) => item.id === source.id));
		const addedSize = additions.reduce((total, source) => total + source.text.length, 0);
		const pairSize = question.content.length + answer.content.length;
		if (
			evidence.length + additions.length > MAX_EVIDENCE_COUNT ||
			size + addedSize > MAX_EVIDENCE_LENGTH ||
			historySize + pairSize > 6000
		)
			continue;
		for (const source of additions) evidence.push({ ...source, number: evidence.length + 1 });
		size += addedSize;
		historySize += pairSize;
		// 相同文档片段用 ID 对齐，不能假设旧回答的 [1] 仍是新上下文的第一个来源。
		const content = answer.content.replace(/\[(\d+)\]/g, (_match, oldNumber: string) => {
			const old = answer.evidence.find((source) => source.number === Number(oldNumber));
			const current = evidence.find((source) => source.id === old?.id);
			return current ? `[${current.number}]` : "";
		});
		history.unshift({ question: question.content, answer: content });
	}
	return history;
}

function validateCitations(content: string, count: number): Set<number> {
	// 检查编号是否属于本轮证据，以及是否缺少必要引用；不判断每个自然语言结论是否成立。
	const cited = new Set([...content.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
	if ([...cited].some((number) => !Number.isSafeInteger(number) || number < 1 || number > count)) {
		throw new ApiError(502, "invalid_citation", "模型返回了无效来源编号，回答未保存，请重试");
	}
	if (count > 0 && cited.size === 0 && !/现有资料不足以回答|未找到足够依据/.test(content)) {
		throw new ApiError(502, "missing_citation", "模型回答缺少来源，回答未保存，请重试");
	}
	return cited;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	// 即使适配器未及时响应取消，也让本应用结束等待；不等于保证上游服务已经停止计算/计费。
	let abort = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([promise, cancelled]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
