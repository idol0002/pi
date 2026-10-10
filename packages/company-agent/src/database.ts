import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { initializeDocumentVersions } from "./document-index.ts";
import { migrations } from "./migrations.ts";
import { hashPassword } from "./password.ts";

export type SqlClient = Pick<PGlite, "query">;

export async function migrate(database: PGlite): Promise<void> {
	await database.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`);
	await database.transaction(async (transaction) => {
		const { rows } = await transaction.query<{ version: number }>("SELECT version FROM schema_migrations");
		const applied = new Set(rows.map((row) => row.version));
		if (rows.some((row) => row.version > migrations[migrations.length - 1].version)) {
			throw new Error("数据库版本比应用新，请使用对应版本的应用");
		}
		for (const migration of migrations) {
			if (applied.has(migration.version)) continue;
			await transaction.exec(migration.sql);
			await migration.after?.(transaction);
			await transaction.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
		}
	});
}

export async function openDatabase(dataDirectory?: string): Promise<PGlite> {
	const database = new PGlite({ dataDir: dataDirectory, extensions: { vector } });
	try {
		await database.waitReady;
		await migrate(database);
		return database;
	} catch (error) {
		await database.close();
		throw error;
	}
}

/** Bootstrap an empty development database. Restarting never restores revoked grants or resets passwords. */
export async function seedDemo(database: PGlite, password: string): Promise<boolean> {
	if (password.length < 12 || password.length > 256) {
		throw new Error("测试账号密码长度必须为 12 到 256 个字符");
	}
	const hashes = await Promise.all([hashPassword(password), hashPassword(password)]);
	return database.transaction(async (transaction) => {
		const existing = await transaction.query("SELECT id FROM app_users LIMIT 1");
		if (existing.rows.length > 0) return false;
		await transaction.query(
			`INSERT INTO app_users (id, username, display_name, password_hash)
			 VALUES ('user-alice', 'alice', '研发测试员工', $1), ('user-bob', 'bob', '财务测试员工', $2)`,
			hashes,
		);
		await transaction.exec(`
			INSERT INTO user_groups (id, name) VALUES ('group-engineering', '研发组'), ('group-finance', '财务组');
			INSERT INTO user_group_memberships (user_id, group_id)
			VALUES ('user-alice', 'group-engineering'), ('user-bob', 'group-finance');
			INSERT INTO knowledge_bases (id, name, description)
			VALUES ('kb-engineering', '研发知识库', '本地权限验证用的合成资料'),
			       ('kb-finance', '财务知识库', '本地权限验证用的合成资料');
			INSERT INTO knowledge_base_grants (knowledge_base_id, group_id, role)
			VALUES ('kb-engineering', 'group-engineering', 'admin'), ('kb-finance', 'group-finance', 'admin');
		`);
		await transaction.query(
			`INSERT INTO documents (id, knowledge_base_id, title, source_text)
			 VALUES ('doc-engineering', 'kb-engineering', '研发发布流程（示例）', $1),
			        ('doc-finance', 'kb-finance', '费用报销流程（示例）', $2)`,
			[
				"# 研发发布流程（合成示例）\n\n发布前完成代码审查和测试，由发布负责人安排上线窗口。\n",
				"# 费用报销流程（合成示例）\n\n员工提交费用说明和凭证，经部门负责人审核后交财务复核。\n",
			],
		);
		await initializeDocumentVersions(transaction);
		return true;
	});
}
