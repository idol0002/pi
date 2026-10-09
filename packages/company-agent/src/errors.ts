export class ApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

export function notFound(): ApiError {
	return new ApiError(404, "not_found", "资源不存在或无权访问");
}
