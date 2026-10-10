/**
 * HTTP 边界：校验请求 → 认证用户 → 选择路由 → 调用业务服务 → 返回 JSON/文件/SSE。
 * 初学时先读 handle 的路由，再按调用进入 store/documents/chat；这里不直接组织模型提示词。
 */
import { File } from "node:buffer";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PGlite } from "@electric-sql/pglite";
import { createAnswerModel } from "./answer-model.ts";
import { type AuthOptions, AuthService, SESSION_COOKIE } from "./auth.ts";
import { ChatService } from "./chat.ts";
import { publicMessage } from "./chat-store.ts";
import { documentFormat } from "./document-format.ts";
import { DocumentService } from "./documents.ts";
import { ApiError, notFound } from "./errors.ts";
import type { IngestionWorker } from "./ingestion.ts";
import { readModelConfig } from "./model-config.ts";
import { KnowledgeStore } from "./store.ts";
import { MAX_DOCUMENT_BYTES } from "./text-processing.ts";
import type { DocumentUpload, KnowledgeGrant } from "./types.ts";
import { loadWebAssets } from "./web.ts";

const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

function objectBody(value: unknown, allowedFields: string[]): Record<string, unknown> {
	// TypeScript 不能验证运行时 JSON；先限制对象和字段，字段类型/长度再分别检查。
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ApiError(400, "invalid_body", "请求内容必须是 JSON 对象");
	}
	if (Object.keys(value).some((key) => !allowedFields.includes(key))) {
		throw new ApiError(400, "invalid_body", "请求包含不支持的字段");
	}
	return value as Record<string, unknown>;
}

function textField(body: Record<string, unknown>, field: string, maxLength: number): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new ApiError(400, "invalid_body", `${field} 必须是长度为 1 到 ${maxLength} 的字符串`);
	}
	return value;
}

async function readBytes(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
	// 同时检查声明长度和实际收到的字节数，客户端省略或伪造 Content-Length 也不能绕过上限。
	if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
		throw new ApiError(415, "unsupported_encoding", "不支持压缩的请求内容");
	}
	if (Number(request.headers["content-length"]) > maxBytes) throw new ApiError(413, "body_too_large", "请求内容过大");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const value of request.iterator({ destroyOnReturn: false })) {
		const chunk: Buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
		size += chunk.length;
		if (size > maxBytes) throw new ApiError(413, "body_too_large", "请求内容过大");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function readJson(
	request: IncomingMessage,
	fields: string[],
	maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
	if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
		throw new ApiError(415, "unsupported_media_type", "请使用 application/json");
	}
	const content = await readBytes(request, maxBytes);
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
	} catch {
		throw new ApiError(400, "invalid_json", "JSON 格式错误");
	}
	return objectBody(parsed, fields);
}

async function readUpload(request: IncomingMessage): Promise<DocumentUpload> {
	// 当前是大小受限的完整表单上传：缓冲后解析 file/title，不提供分片或断点续传。
	const contentType = request.headers["content-type"] ?? "";
	if (contentType.split(";")[0].trim().toLowerCase() !== "multipart/form-data") {
		throw new ApiError(415, "unsupported_media_type", "请使用 multipart/form-data 上传 file 字段");
	}
	const content = await readBytes(request, MAX_DOCUMENT_BYTES + MAX_BODY_BYTES);
	let form: FormData;
	try {
		form = await new Response(content, { headers: { "Content-Type": contentType } }).formData();
	} catch {
		throw new ApiError(400, "invalid_multipart", "文件上传格式错误");
	}
	if (
		[...form.keys()].some((key) => key !== "file" && key !== "title") ||
		form.getAll("file").length !== 1 ||
		form.getAll("title").length > 1
	) {
		throw new ApiError(400, "invalid_upload", "请上传一个 file 文件和可选的 title 标题");
	}
	const file = form.get("file");
	const title = form.get("title");
	if (!(file instanceof File) || (title !== null && typeof title !== "string")) {
		throw new ApiError(400, "invalid_upload", "file 必须是文件，title 必须是文本");
	}
	const mediaType = documentFormat(file.name);
	if (
		!["", mediaType, "application/octet-stream", ...(mediaType === "text/markdown" ? ["text/plain"] : [])].includes(
			file.type,
		)
	) {
		throw new ApiError(415, "unsupported_file_type", "文件类型与扩展名不匹配");
	}
	return {
		filename: file.name,
		title: title ?? undefined,
		mediaType,
		content: new Uint8Array(await file.arrayBuffer()),
	};
}

function sourceVersion(url: URL): string | null {
	const versionId = url.searchParams.get("versionId");
	if (
		versionId !== null &&
		(!versionId || versionId.length > 128 || url.searchParams.getAll("versionId").length !== 1)
	) {
		throw new ApiError(400, "invalid_version", "versionId 无效");
	}
	return versionId;
}

function parseGrants(value: unknown): KnowledgeGrant[] {
	if (!Array.isArray(value) || value.length > 100) {
		throw new ApiError(400, "invalid_grants", "grants 必须是最多 100 项的数组");
	}
	return value.map((item: unknown) => {
		const grant = objectBody(item, ["groupId", "role"]);
		const groupId = textField(grant, "groupId", 128);
		const role = grant.role;
		if (role !== "viewer" && role !== "editor" && role !== "admin") {
			throw new ApiError(400, "invalid_grants", "权限必须是 viewer、editor 或 admin");
		}
		return { groupId, role };
	});
}

export interface ServerOptions extends AuthOptions {
	ingestion: IngestionWorker;
	chat?: ChatService;
	onError?: (error: unknown) => void;
}

export async function createKnowledgeServer(database: PGlite, options: ServerOptions): Promise<Server> {
	const auth = await AuthService.create(database, options);
	const store = new KnowledgeStore(database);
	const documents = new DocumentService(database);
	const chat = options.chat ?? new ChatService(database, createAnswerModel(readModelConfig({})));
	// 重启只修正中断消息状态，不重新执行可能产生费用的模型请求。
	await chat.store.recoverInterrupted();
	const assets = await loadWebAssets();
	const server = createServer(
		{ maxHeaderSize: 8192, requestTimeout: 120_000, headersTimeout: 10_000 },
		(request, response) => {
			// 页面与 API 同源；敏感响应不缓存，资源加载和嵌入行为由这些响应头进一步约束。
			response.setHeader("Cache-Control", "no-store");
			response.setHeader("X-Content-Type-Options", "nosniff");
			response.setHeader("Referrer-Policy", "no-referrer");
			response.setHeader("X-Frame-Options", "DENY");
			response.setHeader(
				"Content-Security-Policy",
				"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
			);
			void handle(request, response).catch((error: unknown) => {
				if (!(error instanceof ApiError)) options.onError?.(error);
				if (response.headersSent) {
					response.destroy();
					return;
				}
				response.shouldKeepAlive = false;
				sendJson(response, error instanceof ApiError ? error.status : 500, {
					error: {
						code: error instanceof ApiError ? error.code : "internal_error",
						message: error instanceof ApiError ? error.message : "服务暂时不可用",
					},
				});
				request.resume();
			});
		},
	);

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		// 本地入口只接受自身 Host 和同源请求；这些约束与 main.ts 的监听方式配套。
		const address = server.address() as AddressInfo;
		const host = request.headers.host;
		if (host !== `127.0.0.1:${address.port}` && host !== `localhost:${address.port}`) {
			throw new ApiError(421, "invalid_host", "请通过本机地址访问服务");
		}
		const origin = `http://${host}`;
		if (
			(request.headers.origin && request.headers.origin !== origin) ||
			(request.headers["sec-fetch-site"] &&
				!["same-origin", "none"].includes(String(request.headers["sec-fetch-site"])))
		) {
			throw new ApiError(403, "invalid_origin", "不允许跨站访问");
		}
		const url = new URL(request.url ?? "/", origin);
		if (url.origin !== origin) throw new ApiError(400, "invalid_url", "请求地址无效");
		let path: string;
		try {
			path = decodeURIComponent(url.pathname);
		} catch {
			throw new ApiError(400, "invalid_url", "请求地址编码无效");
		}
		const method = request.method;
		// 静态页与登录前资源只从固定 Map 读取；不存在把任意 URL 变成磁盘路径的分支。
		const asset = method === "GET" ? assets.get(path) : undefined;
		if (asset) {
			response.writeHead(200, { "Content-Type": asset.contentType });
			response.end(asset.content);
			return;
		}
		if (method === "GET" && path === "/healthz") {
			sendJson(response, 200, { status: "ok", mode: "local-development" });
			return;
		}
		// 重复同名 Cookie 不任选其一，避免浏览器和服务端对身份产生不同解释。
		const cookies = (request.headers.cookie ?? "")
			.split(";")
			.map((cookie) => cookie.trim())
			.filter((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
		const token = cookies.length === 1 ? cookies[0].slice(SESSION_COOKIE.length + 1) : undefined;
		if (method === "POST" && path === "/api/auth/login") {
			const body = await readJson(request, ["username", "password"]);
			const username = textField(body, "username", 64).trim().toLowerCase();
			const password = textField(body, "password", 256);
			const result = await auth.login(username, password, request.socket.remoteAddress ?? "unknown");
			response.setHeader(
				"Set-Cookie",
				`${SESSION_COOKIE}=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(auth.sessionTtlMs / 1000)}`,
			);
			sendJson(response, 200, { user: result.user });
			return;
		}
		if (method === "POST" && path === "/api/auth/logout") {
			await readJson(request, []);
			await auth.logout(token);
			response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
			response.writeHead(204);
			response.end();
			return;
		}

		// 从这里开始的业务接口都需要登录。后续服务只接收验证所得的 user.id。
		const user = await auth.authenticate(token);
		if (method === "GET" && path === "/api/model") {
			sendJson(response, 200, { model: chat.info });
			return;
		}
		if (method === "GET" && path === "/api/me") {
			sendJson(response, 200, { user });
			return;
		}
		if (method === "GET" && path === "/api/knowledge-bases") {
			sendJson(response, 200, { knowledgeBases: await store.listKnowledgeBases(user.id) });
			return;
		}
		if (method === "POST" && path === "/api/search") {
			const body = await readJson(request, ["query", "knowledgeBaseIds", "limit"]);
			const query = textField(body, "query", 300);
			const ids = body.knowledgeBaseIds;
			const limit = body.limit;
			if (
				ids !== undefined &&
				(!Array.isArray(ids) || !ids.every((id: unknown): id is string => typeof id === "string"))
			) {
				throw new ApiError(400, "invalid_scope", "knowledgeBaseIds 必须是字符串数组");
			}
			if (limit !== undefined && typeof limit !== "number")
				throw new ApiError(400, "invalid_limit", "limit 必须是整数");
			const result = await chat.retrieval.search(user.id, { query, knowledgeBaseIds: ids, limit });
			sendJson(response, 200, result);
			return;
		}
		const knowledgePath = /^\/api\/knowledge-bases\/([^/]+)(?:\/(documents|grants|groups))?$/.exec(path);
		if (knowledgePath) {
			const id = knowledgePath[1];
			const resource = knowledgePath[2];
			if (method === "GET" && !resource) {
				sendJson(response, 200, { knowledgeBase: await store.getKnowledgeBase(user.id, id) });
				return;
			}
			if (method === "GET" && resource === "documents") {
				sendJson(response, 200, { documents: await store.listDocuments(user.id, id) });
				return;
			}
			if (method === "POST" && resource === "documents") {
				const target = { knowledgeBaseId: id };
				// 先验证权限再读取较大的文件；upload 的事务内还会再次验证，覆盖上传期间的撤权。
				await documents.requireUploadAccess(user.id, target);
				const receipt = await documents.upload(user.id, target, await readUpload(request));
				options.ingestion.wake();
				sendJson(response, 202, receipt);
				return;
			}
			if (method === "GET" && resource === "grants") {
				sendJson(response, 200, { grants: await store.listGrants(user.id, id) });
				return;
			}
			if (method === "GET" && resource === "groups") {
				sendJson(response, 200, { groups: await store.listGroups(user.id, id) });
				return;
			}
			if (method === "PUT" && resource === "grants") {
				const body = await readJson(request, ["grants"]);
				sendJson(response, 200, await store.replaceGrants(user.id, id, parseGrants(body.grants)));
				return;
			}
		}
		const documentPath = /^\/api\/documents\/([^/]+)(?:\/(source|download|versions|preview|pdf|review))?$/.exec(path);
		if (documentPath) {
			const id = documentPath[1];
			const resource = documentPath[2];
			if (method === "GET" && resource === "preview") {
				sendJson(response, 200, await documents.preview(user.id, id, sourceVersion(url)));
				return;
			}
			if (method === "GET" && resource === "pdf") {
				const bytes = await documents.readPdf(user.id, id, sourceVersion(url));
				response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": bytes.byteLength });
				response.end(bytes);
				return;
			}
			if (method === "POST" && resource === "review") {
				// 前端提交的是正文块修正；是否仍为最新待复核版本由 DocumentService 在事务中确认。
				const body = await readJson(request, ["versionId", "changes", "confirmed"], 2 * 1024 * 1024);
				if (body.confirmed !== true || !Array.isArray(body.changes) || body.changes.length > 12000) {
					throw new ApiError(400, "invalid_review", "请核对原件与识别正文，并确认复核结果");
				}
				const changes = body.changes.map((entry: unknown) => {
					const change = objectBody(entry, ["blockId", "text"]);
					const text = change.text;
					if (typeof text !== "string" || text.length > 65_536)
						throw new ApiError(400, "invalid_review", "单个正文块过长");
					return { blockId: textField(change, "blockId", 80), text };
				});
				await documents.approveReview(user.id, id, textField(body, "versionId", 128), changes);
				response.writeHead(204);
				response.end();
				return;
			}
			if (method === "GET" && resource === "source") {
				// 固定版本和行号属于来源定位；即使地址来自旧回答，也重新检查当前访问权限。
				const source = await store.readDocument(user.id, id, sourceVersion(url));
				let text = source.text;
				if (url.searchParams.has("startLine") || url.searchParams.has("endLine")) {
					const start = Number(url.searchParams.get("startLine"));
					const end = Number(url.searchParams.get("endLine"));
					const lines = text.split("\n");
					if (
						!Number.isSafeInteger(start) ||
						!Number.isSafeInteger(end) ||
						start < 1 ||
						end < start ||
						end > lines.length
					) {
						throw new ApiError(400, "invalid_lines", "原文行号范围无效");
					}
					text = lines.slice(start - 1, end).join("\n");
				}
				response.writeHead(200, {
					"Content-Type": "text/plain; charset=utf-8",
					"X-Document-Version": source.versionId,
				});
				response.end(text);
				return;
			}
			if (method === "GET" && resource === "download") {
				// 原件以附件返回；预览走受控的 preview/pdf 接口。
				const source = await documents.readOriginal(user.id, id, sourceVersion(url));
				const filename = encodeURIComponent(source.filename).replace(
					/['()*]/g,
					(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
				);
				response.writeHead(200, {
					"Content-Type": "application/octet-stream",
					"Content-Disposition": `attachment; filename="document"; filename*=UTF-8''${filename}`,
				});
				response.end(source.content);
				return;
			}
			if (method === "GET" && resource === "versions") {
				sendJson(response, 200, { versions: await documents.listVersions(user.id, id) });
				return;
			}
			if (method === "POST" && resource === "versions") {
				const target = { documentId: id };
				await documents.requireUploadAccess(user.id, target);
				const receipt = await documents.upload(user.id, target, await readUpload(request));
				options.ingestion.wake();
				sendJson(response, 202, receipt);
				return;
			}
			if (method === "DELETE" && !resource) {
				await documents.deleteDocument(user.id, id);
				options.ingestion.cancelDocument(id);
				options.ingestion.wake();
				response.writeHead(204);
				response.end();
				return;
			}
			if (method === "GET" && !resource) {
				sendJson(response, 200, { document: await store.getDocument(user.id, id) });
				return;
			}
		}
		const jobPath = /^\/api\/ingestion-jobs\/([^/]+)(?:\/(retry))?$/.exec(path);
		if (method === "GET" && jobPath && !jobPath[2]) {
			sendJson(response, 200, { job: await documents.getJob(user.id, jobPath[1]) });
			return;
		}
		if (method === "POST" && jobPath?.[2] === "retry") {
			await readJson(request, []);
			const receipt = await documents.retryJob(user.id, jobPath[1]);
			options.ingestion.wake();
			sendJson(response, 202, receipt);
			return;
		}
		const chunkPath = /^\/api\/document-chunks\/([^/]+)$/.exec(path);
		if (method === "GET" && chunkPath) {
			sendJson(response, 200, { chunk: await documents.getChunk(user.id, chunkPath[1]) });
			return;
		}
		if (method === "POST" && path === "/api/conversations") {
			// 选中的知识库只能收窄用户已有的权限；真正的范围检查在 createConversation 中。
			const body = await readJson(request, ["title", "knowledgeBaseIds"]);
			const title = textField(body, "title", 200).trim();
			const ids = body.knowledgeBaseIds;
			if (
				!title ||
				!Array.isArray(ids) ||
				ids.length === 0 ||
				ids.length > 20 ||
				!ids.every((id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 128) ||
				new Set(ids).size !== ids.length
			) {
				throw new ApiError(400, "invalid_body", "请提供标题和 1 到 20 个不重复的知识库 ID");
			}
			sendJson(response, 201, { conversation: await store.createConversation(user.id, title, ids) });
			return;
		}
		if (method === "GET" && path === "/api/conversations") {
			sendJson(response, 200, { conversations: await store.listConversations(user.id) });
			return;
		}
		const cancelPath = /^\/api\/conversations\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(path);
		if (method === "POST" && cancelPath) {
			// 必须匹配会话和具体 run，避免一个较晚到达的取消请求误停下一轮生成。
			await readJson(request, []);
			await chat.cancel(user.id, cancelPath[1], cancelPath[2]);
			response.writeHead(204);
			response.end();
			return;
		}
		const conversationPath = /^\/api\/conversations\/([^/]+)(?:\/(messages))?$/.exec(path);
		if (method === "GET" && conversationPath && !conversationPath[2]) {
			const conversation = await chat.store.conversation(user.id, conversationPath[1]);
			const messages = (await chat.store.history(user.id, conversation.id)).map(publicMessage);
			sendJson(response, 200, { conversation, messages });
			return;
		}
		if (method === "POST" && conversationPath?.[2] === "messages") {
			// prepare 发生在 SSE 响应头之前：参数/权限/并发错误仍可返回普通 JSON HTTP 错误。
			const body = await readJson(request, ["content"]);
			const run = await chat.prepare(user.id, conversationPath[1], textField(body, "content", 2000), () =>
				auth.authenticate(token),
			);
			// 浏览器取消读取或连接断开，也需要取消后端运行，而不只是停止页面显示。
			response.once("close", run.abort);
			if (response.destroyed) run.abort();
			else {
				response.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"X-Accel-Buffering": "no",
					Connection: "keep-alive",
				});
				response.flushHeaders();
			}
			// 冒号开头是 SSE 注释心跳；web/stream.ts 会忽略它，不把它当成业务事件。
			const heartbeat = setInterval(() => {
				if (!response.destroyed && !response.writableNeedDrain) response.write(": keepalive\n\n");
			}, 15_000);
			try {
				await run.execute(async (event) => {
					if (response.destroyed || response.writableEnded) return;
					// 该次写入遇到背压时等 drain，再完成本次发送回调。
					if (!response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
						await once(response, "drain", { signal: run.signal });
					}
				});
			} finally {
				clearInterval(heartbeat);
				response.off("close", run.abort);
				response.end();
			}
			return;
		}
		throw notFound();
	}

	server.once("close", () => {
		void chat.stop().catch((error: unknown) => options.onError?.(error));
	});
	return server;
}
