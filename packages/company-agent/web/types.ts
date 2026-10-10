import type { Conversation, DocumentMetadata, KnowledgeBase, ModelInfo, SourceLocation, User } from "../src/types.ts";

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
