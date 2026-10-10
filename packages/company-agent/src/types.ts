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
	currentVersionId: string | null;
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
export type DocumentStatus = "queued" | "processing" | "needs_review" | "ready" | "failed";
export type IngestionStatus = "queued" | "processing" | "needs_review" | "succeeded" | "failed" | "cancelled";
export type ParseStage = "queued" | "extracting" | "ocr" | "indexing" | "needs_review" | "complete" | "failed";

export interface ParseWarning {
	page: number | null;
	code: string;
	message: string;
}

export interface SourceLocation {
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
	/** Zero-based UTF-16 offsets in the normalized source; endOffset is exclusive. */
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
}

export interface ModelInfo {
	mode: "demo" | "openai";
	name: string;
}

export interface UserGroup {
	id: string;
	name: string;
}

export type ChatEvent =
	| { type: "start"; runId: string; messageId: string }
	| { type: "status"; stage: "retrieving" | "answering"; sourceCount?: number; note?: string }
	| { type: "delta"; text: string }
	| { type: "sources"; sources: AnswerSource[] }
	| { type: "done"; message: ChatMessage }
	| { type: "error"; code: string; message: string; messageId: string };
