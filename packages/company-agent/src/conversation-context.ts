/**
 * 会话上下文投影：恢复当前仍有权限、来源仍为生效版本的完成历史。
 * Pi 接收标准角色消息；这里定义业务的来源/容量规则，不按固定“两轮”截断。
 */
import type { AnswerEvidence } from "./answer-model.ts";
import type { StoredMessage } from "./chat-store.ts";
import type { DocumentChunk } from "./types.ts";

export const MAX_EVIDENCE_COUNT = 10;
export const MAX_EVIDENCE_LENGTH = 12_000;
export const MAX_HISTORY_LENGTH = 8000;

export interface ConversationHistory {
	runId: string;
	question: string;
	answer: string;
	timestamp: number;
}

/** 整批接纳，容量不足时不修改数组，避免只记住半份历史的来源。 */
export function includeEvidence(evidence: AnswerEvidence[], sources: DocumentChunk[]): AnswerEvidence[] | undefined {
	const existing = new Map(evidence.map((source) => [source.id, source]));
	const additions = [
		...new Map(sources.filter((source) => !existing.has(source.id)).map((source) => [source.id, source])).values(),
	];
	if (
		evidence.length + additions.length > MAX_EVIDENCE_COUNT ||
		[...evidence, ...additions].reduce((sum, source) => sum + source.text.length, 0) > MAX_EVIDENCE_LENGTH
	)
		return undefined;
	for (const source of additions) {
		const numbered = { ...source, number: evidence.length + 1, current: true };
		evidence.push(numbered);
		existing.set(source.id, numbered);
	}
	return sources.map((source) => existing.get(source.id)!);
}

export function usableTurns(messages: StoredMessage[]): { question: StoredMessage; answer: StoredMessage }[] {
	return messages.flatMap((answer) => {
		if (
			answer.role !== "assistant" ||
			answer.status !== "complete" ||
			answer.redacted ||
			answer.evidence.length === 0 ||
			answer.evidence.some((source) => !source.current)
		)
			return [];
		const question = messages.find((message) => message.role === "user" && message.runId === answer.runId);
		return question ? [{ question, answer }] : [];
	});
}

export function restoreTurn(
	turn: { question: StoredMessage; answer: StoredMessage },
	evidence: AnswerEvidence[],
): ConversationHistory | undefined {
	if (!includeEvidence(evidence, turn.answer.evidence)) return undefined;
	return {
		runId: turn.answer.runId,
		question: turn.question.content,
		answer: turn.answer.content.replace(/\[(\d+)\]/g, (_match, number: string) => {
			const source = turn.answer.evidence.find((item) => item.number === Number(number));
			const current = evidence.find((item) => item.id === source?.id);
			return current ? "[" + current.number + "]" : "";
		}),
		timestamp: new Date(turn.answer.createdAt).getTime(),
	};
}

export function restoreHistory(messages: StoredMessage[], evidence: AnswerEvidence[]): ConversationHistory[] {
	const result: ConversationHistory[] = [];
	let length = 0;
	for (const turn of usableTurns(messages).reverse()) {
		const size = turn.question.content.length + turn.answer.content.length;
		if (length + size > MAX_HISTORY_LENGTH) continue;
		const restored = restoreTurn(turn, evidence);
		if (!restored) continue;
		result.unshift(restored);
		length += size;
	}
	return result;
}
