/**
 * 把服务端环境配置转换成 Pi 可使用的模型描述。
 * 默认 demo；显式选择真实接口却缺少配置时直接报错，不把故障悄悄变成演示回答。
 */
import type { Model } from "@earendil-works/pi-ai";

export interface ModelConfig {
	mode: "demo" | "openai";
	model: Model<"openai-completions">;
	apiKey?: string;
	timeoutMs: number;
}

export function readModelConfig(env: Record<string, string | undefined> = process.env): ModelConfig {
	// 通过参数传入 env，测试就能验证配置行为而不依赖开发者机器上的真实密钥。
	const mode = env.KNOWLEDGE_MODEL_MODE?.trim() || "demo";
	if (mode !== "demo" && mode !== "openai") throw new Error("KNOWLEDGE_MODEL_MODE 必须是 demo 或 openai");
	const timeoutMs = integerSetting(env, "KNOWLEDGE_MODEL_TIMEOUT_MS", 60_000, 1000, 180_000);
	const maxTokens = integerSetting(env, "KNOWLEDGE_MODEL_MAX_TOKENS", 2048, 128, 8192);
	// 兼容接口对输出上限字段和流式 usage 的支持不同，需分别配置。
	const maxTokensField = env.KNOWLEDGE_MODEL_MAX_TOKENS_FIELD?.trim() || "max_tokens";
	if (maxTokensField !== "max_tokens" && maxTokensField !== "max_completion_tokens") {
		throw new Error("KNOWLEDGE_MODEL_MAX_TOKENS_FIELD 必须是 max_tokens 或 max_completion_tokens");
	}
	const streamUsage = env.KNOWLEDGE_MODEL_STREAM_USAGE?.trim() || "true";
	if (streamUsage !== "true" && streamUsage !== "false") {
		throw new Error("KNOWLEDGE_MODEL_STREAM_USAGE 必须是 true 或 false");
	}
	let baseUrl = "";
	let name = "本地演示 · 资料摘录";
	let apiKey: string | undefined;
	if (mode === "openai") {
		name = env.KNOWLEDGE_MODEL_NAME?.trim() ?? "";
		apiKey = env.KNOWLEDGE_MODEL_API_KEY?.trim();
		if (!name || name.length > 200 || !apiKey) {
			throw new Error("openai 模式需要 KNOWLEDGE_MODEL_NAME 和 KNOWLEDGE_MODEL_API_KEY");
		}
		let url: URL;
		try {
			url = new URL(env.KNOWLEDGE_MODEL_BASE_URL?.trim() ?? "");
		} catch {
			throw new Error("请配置有效的 KNOWLEDGE_MODEL_BASE_URL，例如 https://gateway.example/v1");
		}
		const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
		if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
			throw new Error("模型地址须使用 HTTPS（本机允许 HTTP），且不含账号、密码、查询参数或片段");
		}
		if (/\/chat\/completions\/?$/.test(url.pathname)) {
			throw new Error("KNOWLEDGE_MODEL_BASE_URL 应填写 API 根地址，不包含 /chat/completions");
		}
		baseUrl = url.href.replace(/\/$/, "");
	}
	return {
		mode,
		apiKey,
		timeoutMs,
		// 这里描述 API 能力；网页只能看到 AnswerModel.info，不会取得 apiKey 或接口地址。
		model: {
			id: mode === "demo" ? "knowledge-demo" : name,
			name,
			api: "openai-completions",
			provider: "company-approved",
			baseUrl,
			reasoning: false,
			input: ["text"],
			contextWindow: 32_768,
			maxTokens,
			// 未配置真实价格；零值不能被解读为供应商调用免费。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsUsageInStreaming: streamUsage === "true",
				maxTokensField,
			},
		},
	};
}

function integerSetting(
	env: Record<string, string | undefined>,
	key: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const value = env[key]?.trim();
	if (!value) return fallback;
	const number = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
		throw new Error(`${key} 必须是 ${min} 到 ${max} 的整数`);
	}
	return number;
}
