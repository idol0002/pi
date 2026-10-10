/** 密码只保存随机盐与 scrypt 派生结果；登录时重新派生并比较，不保存或解密明文密码。 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

function derivePassword(password: string, salt: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, 64, (error, key) => {
			if (error) reject(error);
			else resolve(key);
		});
	});
}

export async function hashPassword(password: string): Promise<string> {
	// 同一密码在不同账号中也会得到不同结果。
	const salt = randomBytes(16).toString("hex");
	const key = await derivePassword(password, salt);
	return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	// 先验证保存格式与长度，再用 timingSafeEqual 比较等长结果。
	const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
	if (!match) return false;
	const key = await derivePassword(password, match[1]);
	return timingSafeEqual(key, Buffer.from(match[2], "hex"));
}
