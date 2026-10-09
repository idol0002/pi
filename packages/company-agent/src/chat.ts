import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { AnswerEvidence, AnswerInput, AnswerModel } from "./answer-model.ts";
import { ChatStore, publicMessage, type StoredMessage } from "./chat-store.ts";
import { DocumentService } from "./documents.ts";
import { ApiError, notFound } from "./errors.ts";
import { searchTerms } from "./text-processing.ts";
import type { ChatEvent, ModelInfo } from "./types.ts";

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

/** A local, bounded run registry. Persisted messages are the durable history, never Agent state. */
export class ChatService {
	readonly store: ChatStore;
	readonly info: ModelInfo;
	private readonly documents: DocumentService;
	private readonly model: AnswerModel;
	private readonly runs = new Map<string, ActiveRun>();
	private stopping = false;

	constructor(database: PGlite, model: AnswerModel) {
		this.store = new ChatStore(database);
		this.documents = new DocumentService(database);
		this.model = model;
		this.info = model.info;
	}

	async prepare(
		userId: string,
		conversationId: string,
		question: string,
		authenticate: () => Promise<unknown>,
	): Promise<ChatRun> {
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
		// Reserve synchronously before awaiting persistence; concurrent requests cannot both enter.
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
				const timeout = setTimeout(
					() => active.controller.abort(new ApiError(504, "model_timeout", "回答超时，请重试")),
					this.model.timeoutMs,
				);
				let evidence: AnswerEvidence[] = [];
				const checkAccess = async () => {
					signal.throwIfAborted();
					await authenticate();
					await this.store.assertAccess(userId, conversationId, evidence);
					signal.throwIfAborted();
				};
				try {
					await checkAccess();
					await emit({ type: "start", runId: active.id, messageId });
					await emit({ type: "status", stage: "retrieving" });
					const previous = (await this.store.history(userId, conversationId)).filter(
						(message) => message.runId !== active.id,
					);
					let query = "";
					for (const term of searchTerms(question)) {
						const candidate = query ? `${query} ${term}` : term;
						if (candidate.length <= 300 && searchTerms(candidate).length <= 64) query = candidate;
						if (query.length >= 280) break;
					}
					const hits = query
						? await this.documents.search(userId, {
								query,
								knowledgeBaseIds: conversation.knowledgeBaseIds,
								limit: 6,
							})
						: [];
					evidence = hits.map((source, index) => ({ ...source, number: index + 1, current: true }));
					const history = addHistory(previous, evidence);
					await checkAccess();
					await emit({ type: "status", stage: "answering", sourceCount: evidence.length });
					let result: Awaited<ReturnType<AnswerModel["generate"]>>;
					if (evidence.length === 0) {
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
					);
					await checkAccess();
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
					clearTimeout(timeout);
					active.controller.abort();
					this.runs.delete(conversationId);
					active.resolve();
				}
			},
		};
	}

	async cancel(userId: string, conversationId: string, runId: string): Promise<void> {
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
