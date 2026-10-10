/** 可对外返回的业务错误：status 用于 HTTP，code 用于程序判断，message 用于用户提示。 */
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
	// 无资源和无权限使用同一提示，避免仅靠错误信息确认其他用户的资源是否存在。
	return new ApiError(404, "not_found", "资源不存在或无权访问");
}
