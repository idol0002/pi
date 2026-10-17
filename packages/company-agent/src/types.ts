/**
 * 前后端共享的业务词汇表。类型说明数据形状，运行时请求校验仍由 server.ts 等模块执行。
 * 阅读顺序：身份/权限 → 文档及版本 → 分块/来源 → 会话/消息 → 流事件。
 */
// 角色从阅读到维护再到管理；真正的授权由服务端根据用户组计算。
export type KnowledgeRole = "viewer" | "editor" | "admin";

export interface User {
	id: string;
	username: string;
	displayName: string;
	groupIds: string[];
}

export interface KnowledgeBase {
	id: string;
	name: string;
	description: string;
	permissionVersion: number;
	role: KnowledgeRole;
}

export interface KnowledgeGrant {
	groupId: string;
	role: KnowledgeRole;
}

export interface DocumentMetadata {
	id: string;
	knowledgeBaseId: string;
	title: string;
	version: number | null;
	mediaType: string;
	/** 已成功发布的版本；首次上传尚未完成时为 null。 */
	currentVersionId: string | null;
	/** 最新上传版本，可能仍在排队、处理、复核或已经失败。 */
	latestVersionId: string;
	latestJobId: string | null;
	status: DocumentStatus;
	stage: ParseStage;
	processedPages: number;
	totalPages: number;
	createdAt: Date;
	updatedAt: Date;
}

export type DocumentMediaType =
	| "text/plain"
	| "text/markdown"
	| "application/pdf"
	| "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	| "application/msword";
// 文档版本用 ready 表示可检索，任务用 succeeded 表示执行成功，页面不要混用两者。
export type DocumentStatus = "queued" | "processing" | "needs_review" | "ready" | "failed";
export type IngestionStatus = "queued" | "processing" | "needs_review" | "succeeded" | "failed" | "cancelled";
export type ParseStage = "queued" | "extracting" | "ocr" | "indexing" | "needs_review" | "complete" | "failed";

export interface ParseWarning {
	page: number | null;
	code: string;
	message: string;
}

export interface SourceLocation {
	/** PDF 使用真实页码；没有稳定分页的 DOCX 使用 null 和正文块标签。 */
	page: number | null;
	blockId: string;
	label: string;
	/** Normalized [left, top, right, bottom], relative to the upright PDF page. */
	box: [number, number, number, number] | null;
	method: "text" | "ocr" | "docx";
}

export interface ParsedBlock {
	id: string;
	text: string;
	heading: string | null;
	kind: "paragraph" | "heading" | "table";
	location: SourceLocation;
	confidence: number | null;
}

export interface DocumentPage {
	number: number;
	width: number;
	height: number;
	method: "text" | "ocr" | "blank";
}

export interface ParseProgress {
	stage: ParseStage;
	processedPages: number;
	totalPages: number;
}

export interface DocumentPreview {
	versionId: string;
	filename: string;
	mediaType: DocumentMediaType;
	text: string;
	pages: DocumentPage[];
	blocks: ParsedBlock[];
	warnings: ParseWarning[];
	pdfUrl: string | null;
	status: DocumentStatus;
}

export interface DocumentUpload {
	filename: string;
	title?: string;
	mediaType: DocumentMediaType;
	content: Uint8Array;
}

export interface DocumentVersion {
	id: string;
	documentId: string;
	version: number;
	title: string;
	filename: string;
	mediaType: DocumentMediaType;
	sizeBytes: number;
	sha256: string;
	status: DocumentStatus;
	chunkCount: number;
	error: string | null;
	createdBy: string | null;
	createdAt: Date;
}

export interface IngestionJob {
	id: string;
	documentId: string;
	versionId: string;
	status: IngestionStatus;
	attempts: number;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
	stage: ParseStage;
	processedPages: number;
	totalPages: number;
	warnings: ParseWarning[];
}

export interface UploadReceipt {
	// 这是 HTTP 202 的接受回执；要继续查询任务/文档状态，才能知道何时可用于问答。
	documentId: string;
	versionId: string;
	jobId: string;
	status: "queued";
}

export interface TextChunk {
	position: number;
	text: string;
	heading: string | null;
	startLine: number;
	endLine: number;
	/** 规范化正文中的 UTF-16 偏移，从 0 开始，终点不包含；不是字节或模型 token 偏移。 */
	startOffset: number;
	endOffset: number;
	locations?: SourceLocation[];
}

export interface DocumentChunk extends TextChunk {
	id: string;
	documentId: string;
	knowledgeBaseId: string;
	versionId: string;
	version: number;
	title: string;
	filename: string;
	sourceUrl: string;
}

export interface SearchHit extends DocumentChunk {
	score: number;
}

export interface SearchRequest {
	query: string;
	knowledgeBaseIds?: string[];
	limit?: number;
}

export interface RetrievalInfo {
	// 这些是检索过程信息，不是答案正确性评分。
	method: "keyword" | "hybrid";
	contextual: boolean;
	durationMs: number;
	keywordCandidates: number;
	semanticCandidates: number;
	note?: string;
}

export interface SearchResult extends RetrievalInfo {
	query: string;
	hits: SearchHit[];
}

export interface Conversation {
	id: string;
	title: string;
	/** 创建后固定本次会话的知识范围；切换范围需要另建会话。 */
	knowledgeBaseIds: string[];
	createdAt: Date;
	updatedAt: Date;
}

export type MessageStatus = "running" | "complete" | "cancelled" | "error";

export interface AnswerSource {
	number: number;
	chunkId: string;
	documentId: string;
	versionId: string;
	version: number;
	title: string;
	heading: string | null;
	startLine: number;
	endLine: number;
	sourceUrl: string;
	locations?: SourceLocation[];
}

export interface ModelUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export type KnowledgeToolName = "knowledge_search" | "knowledge_read" | "conversation_recall";

/** 只公开执行摘要，不将模型原始工具参数或工具正文直接发送到页面。 */
export interface AgentExecution {
	providerTurns: number;
	toolCalls: number;
	restoredTurns: number;
	steps: { tool: string; status: "complete" | "error" }[];
}

export interface AgentProgress {
	phase: "context" | "tool_start" | "tool_end";
	note: string;
}

export interface ChatMessage {
	id: string;
	runId: string;
	role: "user" | "assistant";
	content: string;
	status: MessageStatus;
	model: string | null;
	usage: ModelUsage | null;
	errorCode: string | null;
	redacted: boolean;
	sources: AnswerSource[];
	createdAt: string;
	retrieval?: RetrievalInfo | null;
	agent?: AgentExecution | null;
}

export interface ModelInfo {
	mode: "demo" | "openai";
	name: string;
}

export interface UserGroup {
	id: string;
	name: string;
}

// HTTP 连接的数据块不等于事件。web/stream.ts 先组装 SSE 帧，再交给 useChat 按此联合类型处理。
// 只有 done/error 是业务终态，不能把网络断开直接视为回答完成。
export type ChatEvent =
	| { type: "start"; runId: string; messageId: string }
	| { type: "status"; stage: "retrieving" | "answering"; sourceCount?: number; note?: string }
	| ({ type: "agent" } & AgentProgress)
	| { type: "delta"; text: string }
	| { type: "sources"; sources: AnswerSource[] }
	| { type: "done"; message: ChatMessage }
	| { type: "error"; code: string; message: string; messageId: string };
