import type { Transaction } from "@electric-sql/pglite";
import { initializeDocumentVersions } from "./document-index.ts";

interface Migration {
	version: number;
	sql: string;
	after?: (database: Transaction) => Promise<void>;
}

export const migrations: readonly Migration[] = [
	{
		version: 1,
		sql: `
			CREATE TABLE app_users (
				id TEXT PRIMARY KEY,
				username TEXT NOT NULL UNIQUE,
				display_name TEXT NOT NULL,
				password_hash TEXT NOT NULL,
				active BOOLEAN NOT NULL DEFAULT TRUE
			);
			CREATE TABLE user_groups (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL
			);
			CREATE TABLE user_group_memberships (
				user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
				group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
				PRIMARY KEY (user_id, group_id)
			);
			CREATE TABLE auth_sessions (
				token_hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
				expires_at TIMESTAMPTZ NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
			CREATE TABLE knowledge_bases (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				active BOOLEAN NOT NULL DEFAULT TRUE,
				permission_version INTEGER NOT NULL DEFAULT 1 CHECK (permission_version > 0)
			);
			CREATE TABLE knowledge_base_grants (
				knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
				group_id TEXT NOT NULL REFERENCES user_groups(id),
				role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
				PRIMARY KEY (knowledge_base_id, group_id)
			);
			CREATE INDEX knowledge_base_grants_group_idx ON knowledge_base_grants(group_id);
			CREATE TABLE documents (
				id TEXT PRIMARY KEY,
				knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
				title TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
				media_type TEXT NOT NULL DEFAULT 'text/markdown',
				source_text TEXT NOT NULL,
				deleted BOOLEAN NOT NULL DEFAULT FALSE,
				created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE INDEX documents_knowledge_base_idx ON documents(knowledge_base_id, deleted);
			CREATE TABLE conversations (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL REFERENCES app_users(id),
				title TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE INDEX conversations_user_idx ON conversations(user_id, created_at);
			CREATE TABLE conversation_knowledge_bases (
				conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
				knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
				PRIMARY KEY (conversation_id, knowledge_base_id)
			);
		`,
	},
	{
		version: 2,
		sql: `
			CREATE TABLE document_versions (
				id TEXT PRIMARY KEY,
				document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
				version INTEGER NOT NULL CHECK (version > 0),
				title TEXT NOT NULL,
				filename TEXT NOT NULL,
				media_type TEXT NOT NULL CHECK (media_type IN ('text/plain', 'text/markdown')),
				size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
				sha256 TEXT NOT NULL,
				source_bytes BYTEA NOT NULL,
				text TEXT,
				status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
				chunk_count INTEGER NOT NULL DEFAULT 0,
				error TEXT,
				created_by TEXT REFERENCES app_users(id),
				created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE (document_id, version),
				UNIQUE (id, document_id)
			);
			ALTER TABLE documents ADD COLUMN current_version_id TEXT;
			ALTER TABLE documents ADD COLUMN latest_version_id TEXT;
			ALTER TABLE documents ADD FOREIGN KEY (current_version_id, id) REFERENCES document_versions(id, document_id);
			ALTER TABLE documents ADD FOREIGN KEY (latest_version_id, id) REFERENCES document_versions(id, document_id);
			CREATE TABLE document_chunks (
				id TEXT PRIMARY KEY,
				version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
				position INTEGER NOT NULL CHECK (position >= 0),
				text TEXT NOT NULL,
				heading TEXT,
				start_line INTEGER NOT NULL CHECK (start_line > 0),
				end_line INTEGER NOT NULL CHECK (end_line >= start_line),
				start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
				end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
				search_vector TSVECTOR NOT NULL,
				UNIQUE (version_id, position)
			);
			CREATE INDEX document_chunks_search_idx ON document_chunks USING GIN(search_vector);
			CREATE TABLE ingestion_jobs (
				id TEXT PRIMARY KEY,
				version_id TEXT NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE CASCADE,
				document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
				status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'cancelled')),
				attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
				error TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE INDEX ingestion_jobs_queue_idx ON ingestion_jobs(status, created_at);
		`,
		after: initializeDocumentVersions,
	},
	{
		version: 3,
		sql: `
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				position BIGINT GENERATED ALWAYS AS IDENTITY,
				conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
				run_id TEXT NOT NULL,
				role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
				content TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'cancelled', 'error')),
				model TEXT,
				usage JSONB,
				error_code TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE (run_id, role)
			);
			CREATE INDEX messages_conversation_idx ON messages(conversation_id, position);
			CREATE UNIQUE INDEX messages_active_run_idx ON messages(conversation_id) WHERE status = 'running';
			CREATE TABLE message_sources (
				message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
				number INTEGER NOT NULL CHECK (number > 0),
				document_id TEXT NOT NULL REFERENCES documents(id),
				version_id TEXT NOT NULL,
				chunk_id TEXT NOT NULL,
				cited BOOLEAN NOT NULL DEFAULT FALSE,
				PRIMARY KEY (message_id, number),
				UNIQUE (message_id, chunk_id)
			);
			-- Evidence IDs survive content cleanup so a deleted source cannot make an answer appear source-free.
			CREATE INDEX message_sources_document_idx ON message_sources(document_id);
		`,
	},
	{
		version: 4,
		sql: `
			ALTER TABLE document_versions DROP CONSTRAINT document_versions_media_type_check;
			ALTER TABLE document_versions ADD CHECK (media_type IN (
			 'text/plain', 'text/markdown', 'application/pdf', 'application/msword',
			 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
			ALTER TABLE document_versions DROP CONSTRAINT document_versions_status_check;
			ALTER TABLE document_versions ADD CHECK (status IN ('queued','processing','ready','failed','needs_review'));
			ALTER TABLE document_versions ADD COLUMN pages JSONB NOT NULL DEFAULT '[]';
			ALTER TABLE document_versions ADD COLUMN blocks JSONB NOT NULL DEFAULT '[]';
			ALTER TABLE document_versions ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]';
			ALTER TABLE document_versions ADD COLUMN preview_pdf BYTEA;
			ALTER TABLE document_versions ADD COLUMN reviewed_by TEXT REFERENCES app_users(id);
			ALTER TABLE document_versions ADD COLUMN reviewed_at TIMESTAMPTZ;
			ALTER TABLE document_chunks ADD COLUMN locations JSONB NOT NULL DEFAULT '[]';
			ALTER TABLE ingestion_jobs DROP CONSTRAINT ingestion_jobs_status_check;
			ALTER TABLE ingestion_jobs ADD CHECK (status IN ('queued','processing','succeeded','failed','cancelled','needs_review'));
			ALTER TABLE ingestion_jobs ADD COLUMN stage TEXT NOT NULL DEFAULT 'queued';
			ALTER TABLE ingestion_jobs ADD COLUMN processed_pages INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE ingestion_jobs ADD COLUMN total_pages INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE ingestion_jobs ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]';
			UPDATE ingestion_jobs SET stage = CASE WHEN status = 'succeeded' THEN 'complete'
			 WHEN status IN ('failed','cancelled') THEN 'failed' ELSE 'queued' END;
		`,
	},
	{
		version: 5,
		sql: `
			CREATE EXTENSION IF NOT EXISTS vector;
			CREATE TABLE embedding_profiles (
				id TEXT PRIMARY KEY,
				dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
				created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE chunk_embeddings (
				chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
				profile_id TEXT NOT NULL REFERENCES embedding_profiles(id) ON DELETE CASCADE,
				embedding vector NOT NULL,
				PRIMARY KEY (chunk_id, profile_id)
			);
			CREATE INDEX chunk_embeddings_profile_idx ON chunk_embeddings(profile_id);
			ALTER TABLE messages ADD COLUMN retrieval JSONB;
		`,
	},
];
