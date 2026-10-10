import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { AnswerEvidence } from "./answer-model.ts";
import type { SqlClient } from "./database.ts";
import { ApiError, notFound } from "./errors.ts";
import { accessibleKnowledgeBases, documentAccess } from "./store.ts";
import type { AnswerSource, ChatMessage, Conversation, MessageStatus, ModelUsage, RetrievalInfo } from "./types.ts";

export interface StoredMessage extends ChatMessage {
	evidence: AnswerEvidence[];
}

async function requireConversation(database: SqlClient, userId: string, id: string): Promise<Conversation> {
	const { rows } = await database.query<Conversation>(
		`SELECT c.id, c.title, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
		        array_agg(k.knowledge_base_id ORDER BY k.knowledge_base_id) AS "knowledgeBaseIds"
		 FROM conversations c JOIN conversation_knowledge_bases k ON k.conversation_id = c.id
		 WHERE c.id = $2 AND c.user_id = $1 GROUP BY c.id`,
		[userId, id],
	);
	const conversation = rows[0];
	if (
		!conversation ||
		(await accessibleKnowledgeBases(database, userId, conversation.knowledgeBaseIds)).length !==
			conversation.knowledgeBaseIds.length
	) {
		throw notFound();
	}
	return conversation;
}

async function requireEvidence(database: SqlClient, userId: string, evidence: AnswerEvidence[]): Promise<void> {
	if (evidence.length === 0) return;
	const { rows } = await database.query<{ id: string }>(
		`SELECT c.id FROM document_chunks c
		 JOIN document_versions v ON v.id = c.version_id AND v.status = 'ready'
		 WHERE c.id = ANY($2::text[]) AND EXISTS (SELECT 1 ${documentAccess} AND d.id = v.document_id)`,
		[userId, evidence.map((source) => source.id)],
	);
	if (rows.length !== evidence.length)
		throw new ApiError(403, "sources_changed", "资料已删除或访问权限已变更，请重新提问");
}

export function publicSource(source: AnswerEvidence): AnswerSource {
	return {
		number: source.number,
		chunkId: source.id,
		documentId: source.documentId,
		versionId: source.versionId,
		version: source.version,
		title: source.title,
		heading: source.heading,
		startLine: source.startLine,
		endLine: source.endLine,
		sourceUrl: source.sourceUrl,
		locations: source.locations ?? [],
	};
}

export function publicMessage(message: StoredMessage): ChatMessage {
	const { evidence: _evidence, ...visible } = message;
	return visible;
}

export class ChatStore {
	private readonly database: PGlite;

	constructor(database: PGlite) {
		this.database = database;
	}

	async recoverInterrupted(): Promise<void> {
		await this.database.query(
			"UPDATE messages SET status = 'error', content = '', error_code = 'interrupted' WHERE status = 'running'",
		);
	}

	conversation(userId: string, id: string): Promise<Conversation> {
		return this.database.transaction((transaction) => requireConversation(transaction, userId, id));
	}

	assertAccess(userId: string, conversationId: string, evidence: AnswerEvidence[]): Promise<void> {
		return this.database.transaction(async (transaction) => {
			await requireConversation(transaction, userId, conversationId);
			await requireEvidence(transaction, userId, evidence);
		});
	}

	begin(userId: string, conversationId: string, runId: string, question: string, model: string): Promise<string> {
		return this.database.transaction(async (transaction) => {
			await requireConversation(transaction, userId, conversationId);
			const { rows } = await transaction.query<{ count: number; busy: boolean }>(
				`SELECT count(*)::int AS count, COALESCE(bool_or(status = 'running'), FALSE) AS busy
				 FROM messages WHERE conversation_id = $1`,
				[conversationId],
			);
			if (rows[0].busy) throw new ApiError(409, "conversation_busy", "当前会话正在回答，请等待或停止生成");
			if (rows[0].count >= 200) throw new ApiError(409, "conversation_full", "当前会话已达到 100 轮，请新建会话");
			await transaction.query(
				`INSERT INTO messages (id, conversation_id, run_id, role, content, status)
				 VALUES ($1, $2, $3, 'user', $4, 'complete')`,
				[randomUUID(), conversationId, runId, question],
			);
			const messageId = randomUUID();
			await transaction.query(
				`INSERT INTO messages (id, conversation_id, run_id, role, status, model)
				 VALUES ($1, $2, $3, 'assistant', 'running', $4)`,
				[messageId, conversationId, runId, model],
			);
			await transaction.query("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
				conversationId,
			]);
			return messageId;
		});
	}

	history(userId: string, conversationId: string): Promise<StoredMessage[]> {
		return this.database.transaction(async (transaction) => {
			await requireConversation(transaction, userId, conversationId);
			const { rows } = await transaction.query<
				Omit<ChatMessage, "createdAt" | "redacted" | "sources"> & { createdAt: Date; sourceCount: number }
			>(
				`SELECT m.id, m.run_id AS "runId", m.role, m.content, m.status, m.model, m.usage,
				        m.error_code AS "errorCode", m.created_at AS "createdAt", m.retrieval,
				        (SELECT count(*)::int FROM message_sources s WHERE s.message_id = m.id) AS "sourceCount"
				 FROM messages m WHERE m.conversation_id = $1 ORDER BY m.position`,
				[conversationId],
			);
			const sources = await transaction.query<
				Omit<AnswerEvidence, "sourceUrl"> & { messageId: string; cited: boolean }
			>(
				`SELECT s.message_id AS "messageId", s.number, s.cited, c.id, v.document_id AS "documentId",
				        d.knowledge_base_id AS "knowledgeBaseId", v.id AS "versionId", v.version, v.title, v.filename,
				        c.position, c.text, c.heading, c.start_line AS "startLine", c.end_line AS "endLine",
				        c.start_offset AS "startOffset", c.end_offset AS "endOffset", c.locations, d.current_version_id = v.id AS current
				 FROM message_sources s JOIN messages m ON m.id = s.message_id
				 JOIN document_chunks c ON c.id = s.chunk_id AND c.version_id = s.version_id
				 JOIN document_versions v ON v.id = c.version_id AND v.document_id = s.document_id AND v.status = 'ready'
				 JOIN documents d ON d.id = v.document_id
				 WHERE m.conversation_id = $2 AND EXISTS (SELECT 1 ${documentAccess} AND d.id = v.document_id)
				 ORDER BY s.number`,
				[userId, conversationId],
			);
			return rows.map(({ sourceCount, createdAt, ...message }) => {
				const available = sources.rows.filter((source) => source.messageId === message.id);
				const redacted = sourceCount !== available.length;
				const evidence = redacted
					? []
					: available.map(({ messageId: _messageId, cited: _cited, ...source }) => ({
							...source,
							sourceUrl: `/api/documents/${encodeURIComponent(source.documentId)}/source?${new URLSearchParams({
								versionId: source.versionId,
								startLine: String(source.startLine),
								endLine: String(source.endLine),
							})}`,
						}));
				return {
					...message,
					content: redacted ? "" : message.content,
					retrieval: redacted ? null : message.retrieval,
					createdAt: createdAt.toISOString(),
					redacted,
					evidence,
					sources: evidence
						.filter((source) => available.find((item) => item.id === source.id)?.cited)
						.map(publicSource),
				};
			});
		});
	}

	complete(
		userId: string,
		conversationId: string,
		messageId: string,
		content: string,
		usage: ModelUsage | null,
		evidence: AnswerEvidence[],
		cited: Set<number>,
		retrieval?: RetrievalInfo,
	): Promise<void> {
		return this.database.transaction(async (transaction) => {
			await requireConversation(transaction, userId, conversationId);
			await requireEvidence(transaction, userId, evidence);
			for (const source of evidence) {
				await transaction.query(
					`INSERT INTO message_sources (message_id, number, document_id, version_id, chunk_id, cited)
					 VALUES ($1, $2, $3, $4, $5, $6)`,
					[messageId, source.number, source.documentId, source.versionId, source.id, cited.has(source.number)],
				);
			}
			await transaction.query(
				"UPDATE messages SET content = $2, usage = $3, retrieval = $4, status = 'complete' WHERE id = $1 AND status = 'running'",
				[
					messageId,
					content,
					usage === null ? null : JSON.stringify(usage),
					retrieval ? JSON.stringify(retrieval) : null,
				],
			);
			await transaction.query("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
				conversationId,
			]);
		});
	}

	async fail(messageId: string, status: Extract<MessageStatus, "error" | "cancelled">, code: string): Promise<void> {
		await this.database.query(
			"UPDATE messages SET content = '', status = $2, error_code = $3 WHERE id = $1 AND status = 'running'",
			[messageId, status, code],
		);
	}
}
