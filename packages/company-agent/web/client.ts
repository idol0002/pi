/** 网页的网络边界：统一同源会话、HTTP 错误、JSON 请求以及来源 URL 校验。 */
export class RequestError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export async function checkedFetch(path: string, init: RequestInit = {}): Promise<Response> {
	// Cookie 由浏览器携带；JS 不读取 HttpOnly 令牌，也不自己拼接员工身份。
	const response = await fetch(path, { credentials: "same-origin", ...init });
	if (!response.ok) {
		let code = "request_failed";
		let message = `请求失败（${response.status}），请重试`;
		try {
			const body = (await response.json()) as { error?: { code?: string; message?: string } };
			code = body.error?.code ?? code;
			message = body.error?.message ?? message;
		} catch {
			/* A proxy can return a non-JSON error. */
		}
		throw new RequestError(response.status, code, message);
	}
	return response;
}

export async function api<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
	// T 帮助 TypeScript 检查调用方使用方式，不是运行时响应 schema 验证。
	const response = await checkedFetch(path, {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});
	return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export function sourcePath(path: string): string {
	// 即使链接来自服务端，也限定同源与原文路径；实际取内容时后端还会重新鉴权。
	const url = new URL(path, location.origin);
	if (url.origin !== location.origin || !/^\/api\/documents\/[^/]+\/source$/.test(url.pathname)) {
		throw new Error("原文地址无效");
	}
	return `${url.pathname}${url.search}`;
}
