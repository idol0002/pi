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
		const invalidPasswordHash = await hashPassword(randomBytes(32).toString("hex"));
		return new AuthService(database, invalidPasswordHash, options);
	}

	async login(username: string, password: string, address: string): Promise<{ token: string; user: User }> {
		const now = this.now();
		for (const [key, failure] of this.failures) {
			if (failure.expiresAt <= now) this.failures.delete(key);
		}
		const key = `${address}:${username}`;
		const failure = this.failures.get(key);
		if ((failure?.count ?? 0) >= 5 || (!failure && this.failures.size >= 4096)) {
			throw new ApiError(429, "login_rate_limited", "登录尝试过于频繁，请稍后重试");
		}
		// Count attempts before awaiting password verification, including concurrent attempts.
		this.failures.set(key, { count: (failure?.count ?? 0) + 1, expiresAt: failure?.expiresAt ?? now + 600_000 });
		const { rows } = await this.database.query<{ id: string; passwordHash: string }>(
			'SELECT id, password_hash AS "passwordHash" FROM app_users WHERE username = $1 AND active',
			[username],
		);
		const account = rows[0];
		const valid = await verifyPassword(password, account?.passwordHash ?? this.invalidPasswordHash);
		if (!valid || !account) throw new ApiError(401, "invalid_credentials", "账号或密码错误");
		this.failures.delete(key);
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
		if (token) await this.database.query("DELETE FROM auth_sessions WHERE token_hash = $1", [tokenHash(token)]);
	}
}
