/** 浏览器专用契约：复用业务字段，同时明确 JSON 日期和页面回调的实际形状。 */
import type { Conversation, DocumentMetadata, KnowledgeBase, ModelInfo, SourceLocation, User } from "../src/types.ts";

// 后端内部的 Date 经过 JSON 后成为字符串，不能在网页中假装它仍有 Date 方法。
export type BrowserConversation = Omit<Conversation, "createdAt" | "updatedAt"> & {
	createdAt: string;
	updatedAt: string;
};
export type BrowserDocument = Omit<DocumentMetadata, "createdAt" | "updatedAt"> & {
	createdAt: string;
	updatedAt: string;
};
export type WorkspacePage = "chat" | "manage";
export type ReportError = (error: unknown) => void;
export type Notify = (message: string, success?: boolean) => void;

export interface WorkspaceData {
	user: User;
	knowledgeBases: KnowledgeBase[];
	conversations: BrowserConversation[];
	model: ModelInfo;
}

export interface SourceRequest {
	/** 每次打开预览的身份；与文档版本 ID 不同，用于 React key 和资源生命周期隔离。 */
	id: string;
	title: string;
	path: string;
	meta: string;
	locations: SourceLocation[];
}

export type OpenSource = (source: Omit<SourceRequest, "id">) => void;

export interface Notice {
	message: string;
	success: boolean;
}
