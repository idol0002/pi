import { createHash } from "node:crypto";
import { ApiError } from "./errors.ts";

export interface EmbeddingModel {
	profileId: string;
	name: string;
	minSimilarity: number;
	embed: (input: string[], signal: AbortSignal) => Promise<number[][]>;
}

/** Explicit opt-in: filling credentials while mode=off never starts document transmission. */
export function createEmbeddingModel(
	env: Record<string, string | undefined> = process.env,
): EmbeddingModel | undefined {
	const mode = env.KNOWLEDGE_EMBEDDING_MODE?.trim() || "off";
	if (mode === "off") return undefined;
	if (mode !== "openai") throw new Error("KNOWLEDGE_EMBEDDING_MODE 必须是 off 或 openai");
	const name = env.KNOWLEDGE_EMBEDDING_NAME?.trim();
	const key = env.KNOWLEDGE_EMBEDDING_API_KEY?.trim();
	if (!name || name.length > 200 || !key || /[\r\n]/.test(key)) {
		throw new Error("请填写 KNOWLEDGE_EMBEDDING_NAME 和 KNOWLEDGE_EMBEDDING_API_KEY");
	}
	let base: URL;
	try {
		base = new URL(env.KNOWLEDGE_EMBEDDING_BASE_URL?.trim() ?? "");
	} catch {
		throw new Error("请填写有效的 KNOWLEDGE_EMBEDDING_BASE_URL");
	}
	const local = base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
	if (
		(!local && base.protocol !== "https:") ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		/\/embeddings\/?$/.test(base.pathname)
	) {
		throw new Error("向量接口须使用 HTTPS API 根地址（本机允许 HTTP），不包含 /embeddings、账号或查询参数");
	}
	const dimensions = env.KNOWLEDGE_EMBEDDING_DIMENSIONS?.trim()
		? Number(env.KNOWLEDGE_EMBEDDING_DIMENSIONS)
		: undefined;
	const timeoutMs = Number(env.KNOWLEDGE_EMBEDDING_TIMEOUT_MS?.trim() || 10_000);
	const minSimilarity = Number(env.KNOWLEDGE_EMBEDDING_MIN_SIMILARITY?.trim() || 0.35);
	if (
		(dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096)) ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs < 1000 ||
		timeoutMs > 60_000 ||
		!Number.isFinite(minSimilarity) ||
		minSimilarity < -1 ||
		minSimilarity > 1
	) {
		throw new Error("向量配置无效：维度为 1–4096，时限为 1000–60000 ms，相似度为 -1 到 1");
	}
	const baseUrl = base.href.replace(/\/$/, "");
	const profileId = createHash("sha256")
		.update(JSON.stringify([baseUrl, name, dimensions ?? null, env.KNOWLEDGE_EMBEDDING_REVISION?.trim() || "1"]))
		.digest("hex");
	return {
		name,
		profileId,
		minSimilarity,
		async embed(input, signal) {
			if (
				input.length === 0 ||
				input.length > 16 ||
				input.some((text) => !text.trim() || text.length > 4096) ||
				input.reduce((sum, text) => sum + text.length, 0) > 48_000
			) {
				throw new ApiError(400, "embedding_input_limit", "向量输入超过批次或长度限制");
			}
			signal.throwIfAborted();
			const timeout = AbortSignal.timeout(timeoutMs);
			try {
				const response = await fetch(`${baseUrl}/embeddings`, {
					method: "POST",
					redirect: "error",
					signal: AbortSignal.any([signal, timeout]),
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
					body: JSON.stringify({
						model: name,
						input,
						encoding_format: "float",
						...(dimensions ? { dimensions } : {}),
					}),
				});
				if (!response.ok || !response.body) {
					await response.body?.cancel();
					if ([400, 401, 403, 404, 422].includes(response.status)) {
						throw new ApiError(
							502,
							"embedding_configuration",
							"向量服务拒绝请求，请检查地址、模型名、密钥和维度配置",
						);
					}
					throw new ApiError(502, "embedding_unavailable", "向量服务调用失败，请检查服务端配置");
				}
				const reader = response.body.getReader();
				const decoder = new TextDecoder("utf-8", { fatal: true });
				let body = "";
				let bytes = 0;
				try {
					while (true) {
						const part = await reader.read();
						if (part.done) break;
						bytes += part.value.byteLength;
						if (bytes > 4 * 1024 * 1024)
							throw new ApiError(502, "invalid_embeddings", "向量服务响应超过大小限制");
						body += decoder.decode(part.value, { stream: true });
					}
					body += decoder.decode();
				} finally {
					await reader.cancel().catch(() => {});
					reader.releaseLock();
				}
				return validateEmbeddings(JSON.parse(body), input.length, dimensions);
			} catch (error) {
				if (signal.aborted) throw signal.reason;
				if (timeout.aborted) throw new ApiError(504, "embedding_timeout", "向量服务超时，请稍后重试");
				if (error instanceof ApiError) throw error;
				// Provider errors can contain credentials or input documents.
				throw new ApiError(502, "embedding_unavailable", "向量服务返回无效结果或暂时不可用");
			}
		},
	};
}

export function validateEmbeddings(value: unknown, count: number, dimensions?: number): number[][] {
	const invalid = () => new ApiError(502, "invalid_embeddings", "向量服务返回的数量、维度或数值无效");
	if (
		!value ||
		typeof value !== "object" ||
		!("data" in value) ||
		!Array.isArray(value.data) ||
		value.data.length !== count
	)
		throw invalid();
	const vectors = new Map<number, number[]>();
	let size = dimensions;
	for (const item of value.data as unknown[]) {
		if (
			!item ||
			typeof item !== "object" ||
			!("index" in item) ||
			!("embedding" in item) ||
			typeof item.index !== "number" ||
			!Number.isInteger(item.index) ||
			item.index < 0 ||
			item.index >= count ||
			vectors.has(item.index) ||
			!Array.isArray(item.embedding) ||
			item.embedding.length < 1 ||
			item.embedding.length > 4096 ||
			!item.embedding.every((number: unknown) => typeof number === "number" && Number.isFinite(number))
		)
			throw invalid();
		const vector = item.embedding as number[];
		size ??= vector.length;
		if (vector.length !== size) throw invalid();
		const norm = Math.hypot(...vector);
		if (!Number.isFinite(norm) || norm <= 1e-12) throw invalid();
		vectors.set(
			item.index,
			vector.map((number) => number / norm),
		);
	}
	return Array.from({ length: count }, (_, index) => vectors.get(index)!);
}
