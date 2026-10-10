/**
 * 认证回答“当前请求是谁发的”：密码登录换取不透明会话令牌。
 * 授权回答“此人能访问什么”：由 store.ts 等模块根据用户组与知识库授权继续判断。
 */
import { createHash, randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { ApiError } from "./errors.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import type { User } from "./types.ts";

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_COOKIE = "knowledge_session";

export interface AuthOptions {
	now?: () => number;
	sessionTtlMs?: number;
}

function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export class AuthService {
	private readonly database: PGlite;
	private readonly now: () => number;
	private readonly invalidPasswordHash: string;
	readonly sessionTtlMs: number;
	private readonly failures = new Map<string, { count: number; expiresAt: number }>();

	private constructor(database: PGlite, invalidPasswordHash: string, options: AuthOptions) {
		this.database = database;
		this.invalidPasswordHash = invalidPasswordHash;
		this.now = options.now ?? Date.now;
		this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
		if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs <= 0) {
			throw new Error("会话有效期必须是正整数毫秒数");
		}
	}

	static async create(database: PGlite, options: AuthOptions = {}): Promise<AuthService> {
		// 未找到账号时也执行密码派生，避免该分支直接跳过昂贵的密码验证。
		const invalidPasswordHash = await hashPassword(randomBytes(32).toString("hex"));
		return new AuthService(database, invalidPasswordHash, options);
	}

	async login(username: string, password: string, address: string): Promise<{ token: string; user: User }> {
		// 登录限流是本进程内按“客户端地址 + 账号”的计数；先清理已过期计数。
		const now = this.now();
		for (const [key, failure] of this.failures) {
			if (failure.expiresAt <= now) this.failures.delete(key);
		}
		const key = `${address}:${username}`;
		const failure = this.failures.get(key);
		if ((failure?.count ?? 0) >= 5 || (!failure && this.failures.size >= 4096)) {
			throw new ApiError(429, "login_rate_limited", "登录尝试过于频繁，请稍后重试");
		}
		// 在 await 之前计数，防止并发请求都在密码验证完成前绕过次数上限。
		this.failures.set(key, { count: (failure?.count ?? 0) + 1, expiresAt: failure?.expiresAt ?? now + 600_000 });
		const { rows } = await this.database.query<{ id: string; passwordHash: string }>(
			'SELECT id, password_hash AS "passwordHash" FROM app_users WHERE username = $1 AND active',
			[username],
		);
		const account = rows[0];
		const valid = await verifyPassword(password, account?.passwordHash ?? this.invalidPasswordHash);
		if (!valid || !account) throw new ApiError(401, "invalid_credentials", "账号或密码错误");
		this.failures.delete(key);
		// 原令牌只交给浏览器 Cookie；数据库保存哈希，后续请求携带原令牌来匹配。
		const token = randomBytes(32).toString("base64url");
		await this.database.query("DELETE FROM auth_sessions WHERE expires_at <= $1", [new Date(now)]);
		await this.database.query(
			`INSERT INTO auth_sessions (token_hash, user_id, expires_at)
			 SELECT $1, id, $3 FROM app_users WHERE id = $2 AND active`,
			[tokenHash(token), account.id, new Date(now + this.sessionTtlMs)],
		);
		return { token, user: await this.authenticate(token) };
	}

	async authenticate(token: string | undefined): Promise<User> {
		// 每次重新检查会话有效期、账号状态和当前用户组，不信任浏览器传来的身份字段。
		if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
			throw new ApiError(401, "unauthenticated", "请先登录");
		}
		const { rows } = await this.database.query<User>(
			`SELECT u.id, u.username, u.display_name AS "displayName",
			        COALESCE(array_agg(m.group_id ORDER BY m.group_id)
			          FILTER (WHERE m.group_id IS NOT NULL), ARRAY[]::text[]) AS "groupIds"
			 FROM auth_sessions s JOIN app_users u ON u.id = s.user_id
			 LEFT JOIN user_group_memberships m ON m.user_id = u.id
			 WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active
			 GROUP BY u.id`,
			[tokenHash(token), new Date(this.now())],
		);
		if (!rows[0]) throw new ApiError(401, "unauthenticated", "请先登录");
		return rows[0];
	}

	async logout(token: string | undefined): Promise<void> {
		// 撤销服务端会话后，流式回答中的再次认证也会失败并停止继续交付正文。
		if (token) await this.database.query("DELETE FROM auth_sessions WHERE token_hash = $1", [tokenHash(token)]);
	}
}
