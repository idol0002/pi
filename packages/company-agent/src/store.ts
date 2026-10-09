import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "./database.ts";
import { ApiError, notFound } from "./errors.ts";
import type { Conversation, DocumentMetadata, KnowledgeBase, KnowledgeGrant, UserGroup } from "./types.ts";

export async function accessibleKnowledgeBases(
	database: SqlClient,
	userId: string,
	ids: string[] | null = null,
): Promise<KnowledgeBase[]> {
	const { rows } = await database.query<KnowledgeBase>(
		`SELECT k.id, k.name, k.description, k.permission_version AS "permissionVersion",
		        CASE MAX(CASE g.role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END)
		          WHEN 3 THEN 'admin' WHEN 2 THEN 'editor' ELSE 'viewer' END AS role
		 FROM knowledge_bases k
		 JOIN knowledge_base_grants g ON g.knowledge_base_id = k.id
		 JOIN user_group_memberships m ON m.group_id = g.group_id
		 JOIN app_users u ON u.id = m.user_id
		 WHERE m.user_id = $1 AND u.active AND k.active AND ($2::text[] IS NULL OR k.id = ANY($2::text[]))
		 GROUP BY k.id ORDER BY k.id`,
		[userId, ids],
	);
	return rows;
}

const documentColumns = `d.id, d.knowledge_base_id AS "knowledgeBaseId", d.title,
	CASE WHEN d.current_version_id IS NOT NULL THEN d.version END AS version,
	d.media_type AS "mediaType", d.current_version_id AS "currentVersionId", d.latest_version_id AS "latestVersionId",
	(SELECT j.id FROM ingestion_jobs j WHERE j.version_id = d.latest_version_id) AS "latestJobId",
	(SELECT v.status FROM document_versions v WHERE v.id = d.latest_version_id) AS status,
	COALESCE((SELECT j.stage FROM ingestion_jobs j WHERE j.version_id = d.latest_version_id), 'complete') AS stage,
	COALESCE((SELECT j.processed_pages FROM ingestion_jobs j WHERE j.version_id = d.latest_version_id), 0) AS "processedPages",
	COALESCE((SELECT j.total_pages FROM ingestion_jobs j WHERE j.version_id = d.latest_version_id), 0) AS "totalPages",
	d.created_at AS "createdAt", d.updated_at AS "updatedAt"`;

// Keep permission predicates in the content query, including direct document-ID reads.
export const documentAccess = `FROM documents d JOIN knowledge_bases k ON k.id = d.knowledge_base_id
	WHERE NOT d.deleted AND k.active AND EXISTS (
		SELECT 1 FROM knowledge_base_grants g
		JOIN user_group_memberships m ON m.group_id = g.group_id
		JOIN app_users u ON u.id = m.user_id
		WHERE g.knowledge_base_id = k.id AND m.user_id = $1 AND u.active
	)`;

export class KnowledgeStore {
	private readonly database: PGlite;

	constructor(database: PGlite) {
		this.database = database;
	}

	listKnowledgeBases(userId: string): Promise<KnowledgeBase[]> {
		return accessibleKnowledgeBases(this.database, userId);
	}

	async getKnowledgeBase(userId: string, id: string): Promise<KnowledgeBase> {
		const bases = await accessibleKnowledgeBases(this.database, userId, [id]);
		if (!bases[0]) throw notFound();
		return bases[0];
	}

	async listDocuments(userId: string, knowledgeBaseId: string): Promise<DocumentMetadata[]> {
		await this.getKnowledgeBase(userId, knowledgeBaseId);
		const { rows } = await this.database.query<DocumentMetadata>(
			`SELECT ${documentColumns} ${documentAccess} AND k.id = $2 ORDER BY d.id`,
			[userId, knowledgeBaseId],
		);
		return rows;
	}

	async getDocument(userId: string, id: string): Promise<DocumentMetadata> {
		const { rows } = await this.database.query<DocumentMetadata>(
			`SELECT ${documentColumns} ${documentAccess} AND d.id = $2`,
			[userId, id],
		);
		if (!rows[0]) throw notFound();
		return rows[0];
	}

	async readDocument(
		userId: string,
		id: string,
		versionId: string | null = null,
	): Promise<{ text: string; versionId: string }> {
		const { rows } = await this.database.query<{ text: string; versionId: string }>(
			`SELECT v.text, v.id AS "versionId" FROM document_versions v
			 WHERE v.document_id = $2 AND v.status = 'ready' AND EXISTS (
			   SELECT 1 ${documentAccess} AND d.id = v.document_id AND v.id = COALESCE($3::text, d.current_version_id)
			 )`,
			[userId, id, versionId],
		);
		if (!rows[0]) throw notFound();
		return rows[0];
	}

	async listGrants(userId: string, knowledgeBaseId: string): Promise<KnowledgeGrant[]> {
		return this.database.transaction(async (transaction) => {
			await transaction.query("SELECT id FROM knowledge_bases WHERE id = $1 FOR SHARE", [knowledgeBaseId]);
			const [base] = await accessibleKnowledgeBases(transaction, userId, [knowledgeBaseId]);
			if (!base) throw notFound();
			if (base.role !== "admin") throw new ApiError(403, "forbidden", "需要知识库管理权限");
			const { rows } = await transaction.query<KnowledgeGrant>(
				'SELECT group_id AS "groupId", role FROM knowledge_base_grants WHERE knowledge_base_id = $1 ORDER BY group_id',
				[knowledgeBaseId],
			);
			return rows;
		});
	}

	async listGroups(userId: string, knowledgeBaseId: string): Promise<UserGroup[]> {
		return this.database.transaction(async (transaction) => {
			const [base] = await accessibleKnowledgeBases(transaction, userId, [knowledgeBaseId]);
			if (!base) throw notFound();
			if (base.role !== "admin") throw new ApiError(403, "forbidden", "需要知识库管理权限");
			return (await transaction.query<UserGroup>("SELECT id, name FROM user_groups ORDER BY id")).rows;
		});
	}

	async replaceGrants(
		userId: string,
		knowledgeBaseId: string,
		grants: KnowledgeGrant[],
	): Promise<{ permissionVersion: number }> {
		return this.database.transaction(async (transaction) => {
			await transaction.query("SELECT id FROM knowledge_bases WHERE id = $1 FOR UPDATE", [knowledgeBaseId]);
			const [base] = await accessibleKnowledgeBases(transaction, userId, [knowledgeBaseId]);
			if (!base) throw notFound();
			if (base.role !== "admin") throw new ApiError(403, "forbidden", "需要知识库管理权限");
			const groupIds = grants.map((grant) => grant.groupId);
			const groups = await transaction.query<{ id: string }>(
				"SELECT id FROM user_groups WHERE id = ANY($1::text[])",
				[groupIds],
			);
			if (groups.rows.length !== groupIds.length) {
				throw new ApiError(400, "invalid_grants", "用户组不存在或重复");
			}
			const admins = await transaction.query(
				`SELECT 1 FROM user_group_memberships m JOIN app_users u ON u.id = m.user_id
				 WHERE u.active AND m.group_id = ANY($1::text[]) LIMIT 1`,
				[grants.filter((grant) => grant.role === "admin").map((grant) => grant.groupId)],
			);
			if (admins.rows.length === 0) {
				throw new ApiError(409, "last_admin", "至少保留一个有可用账号的知识库管理组");
			}
			await transaction.query("DELETE FROM knowledge_base_grants WHERE knowledge_base_id = $1", [knowledgeBaseId]);
			for (const grant of grants) {
				await transaction.query(
					"INSERT INTO knowledge_base_grants (knowledge_base_id, group_id, role) VALUES ($1, $2, $3)",
					[knowledgeBaseId, grant.groupId, grant.role],
				);
			}
			const { rows } = await transaction.query<{ permissionVersion: number }>(
				`UPDATE knowledge_bases SET permission_version = permission_version + 1
				 WHERE id = $1 RETURNING permission_version AS "permissionVersion"`,
				[knowledgeBaseId],
			);
			return rows[0];
		});
	}

	async createConversation(userId: string, title: string, knowledgeBaseIds: string[]): Promise<Conversation> {
		return this.database.transaction(async (transaction) => {
			const bases = await accessibleKnowledgeBases(transaction, userId, knowledgeBaseIds);
			if (bases.length !== knowledgeBaseIds.length) throw notFound();
			const id = randomUUID();
			const { rows } = await transaction.query<Omit<Conversation, "knowledgeBaseIds">>(
				`INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, $3)
				 RETURNING id, title, created_at AS "createdAt", updated_at AS "updatedAt"`,
				[id, userId, title],
			);
			for (const knowledgeBaseId of knowledgeBaseIds) {
				await transaction.query(
					"INSERT INTO conversation_knowledge_bases (conversation_id, knowledge_base_id) VALUES ($1, $2)",
					[id, knowledgeBaseId],
				);
			}
			return { ...rows[0], knowledgeBaseIds };
		});
	}

	async listConversations(userId: string, id: string | null = null): Promise<Conversation[]> {
		const { rows } = await this.database.query<Conversation>(
			`SELECT c.id, c.title, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
			        array_agg(ck.knowledge_base_id ORDER BY ck.knowledge_base_id) AS "knowledgeBaseIds"
			 FROM conversations c JOIN conversation_knowledge_bases ck ON ck.conversation_id = c.id
			 WHERE c.user_id = $1 AND ($2::text IS NULL OR c.id = $2)
			 AND NOT EXISTS (
			   SELECT 1 FROM conversation_knowledge_bases selected WHERE selected.conversation_id = c.id
			   AND NOT EXISTS (
			     SELECT 1 FROM knowledge_bases k
			     JOIN knowledge_base_grants g ON g.knowledge_base_id = k.id
			     JOIN user_group_memberships m ON m.group_id = g.group_id
			     JOIN app_users u ON u.id = m.user_id
			     WHERE k.id = selected.knowledge_base_id AND k.active AND m.user_id = $1 AND u.active
			   )
			 )
			 GROUP BY c.id ORDER BY c.updated_at DESC, c.id`,
			[userId, id],
		);
		return rows;
	}
}
