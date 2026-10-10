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
	const response = await checkedFetch(path, {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});
	return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export function sourcePath(path: string): string {
	const url = new URL(path, location.origin);
	if (url.origin !== location.origin || !/^\/api\/documents\/[^/]+\/source$/.test(url.pathname)) {
		throw new Error("原文地址无效");
	}
	return `${url.pathname}${url.search}`;
}
