/**
 * SSE 解码器：响应字节 → 连续 UTF-8 文本 → 完整事件帧 → ChatEvent 回调。
 * 本模块不知道 React 状态；页面如何追加消息由 use-chat.ts 决定。
 */
import type { ChatEvent } from "../src/types.ts";

/** 使用 Fetch 提交 POST 问题并携带会话；原生 EventSource 的 GET 连接不适合此请求契约。 */
export async function readChatStream(response: Response, onEvent: (event: ChatEvent) => void): Promise<void> {
	if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
		throw new Error("未收到有效回答流，请重试");
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "";
	let finished = false;
	const consume = () => {
		// 空行分隔事件；一块网络数据可能有半个事件，也可能同时包含多个事件。
		for (let boundary = buffer.indexOf("\n\n"); boundary >= 0; boundary = buffer.indexOf("\n\n")) {
			const frame = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			// 心跳注释等不含 data 的帧不进入业务回调。
			if (!data) continue;
			const event = JSON.parse(data) as ChatEvent;
			if (!event || !["start", "status", "agent", "delta", "sources", "done", "error"].includes(event.type)) {
				throw new Error("回答流格式无效");
			}
			if (
				event.type === "agent" &&
				(!["context", "tool_start", "tool_end"].includes(event.phase) ||
					typeof event.note !== "string" ||
					event.note.length > 300)
			)
				throw new Error("回答流格式无效");
			if (finished) throw new Error("回答结束后收到额外事件");
			onEvent(event);
			if (event.type === "done" || event.type === "error") finished = true;
		}
	};
	try {
		while (true) {
			const { value, done } = await reader.read();
			// 流式 decoder 会保留跨块的 UTF-8 字节，结束时再冲刷未完成的解码状态。
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			// 块末尾 CR 暂不转换；下一块若以 LF 开始，它们仍只代表一个换行。
			const trailingCR = !done && buffer.endsWith("\r");
			const text = trailingCR ? buffer.slice(0, -1) : buffer;
			buffer = text.replace(/\r\n?/g, "\n") + (trailingCR ? "\r" : "");
			if (buffer.length > 256_000) throw new Error("回答流超出大小限制");
			consume();
			if (done) break;
		}
		// 网络结束不是业务成功；必须收到明确的 done 或 error。
		if (!finished) throw new Error("连接中断，回答未完成；请重新提问");
	} finally {
		// 解析失败也释放 reader，避免挂住连接及后端生成任务。
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
