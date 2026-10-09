import type { ChatEvent } from "../src/types.ts";

/** Fetch supports POST + session cookies; EventSource only supports GET. */
export async function readChatStream(response: Response, onEvent: (event: ChatEvent) => void): Promise<void> {
	if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
		throw new Error("未收到有效回答流，请重试");
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "";
	let finished = false;
	const consume = () => {
		for (let boundary = buffer.indexOf("\n\n"); boundary >= 0; boundary = buffer.indexOf("\n\n")) {
			const frame = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data) continue;
			const event = JSON.parse(data) as ChatEvent;
			if (!event || !["start", "status", "delta", "sources", "done", "error"].includes(event.type)) {
				throw new Error("回答流格式无效");
			}
			if (finished) throw new Error("回答结束后收到额外事件");
			onEvent(event);
			if (event.type === "done" || event.type === "error") finished = true;
		}
	};
	try {
		while (true) {
			const { value, done } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			// Retain a trailing CR until the next chunk arrives, so split CRLFs normalize once.
			const trailingCR = !done && buffer.endsWith("\r");
			const text = trailingCR ? buffer.slice(0, -1) : buffer;
			buffer = text.replace(/\r\n?/g, "\n") + (trailingCR ? "\r" : "");
			if (buffer.length > 256_000) throw new Error("回答流超出大小限制");
			consume();
			if (done) break;
		}
		if (!finished) throw new Error("连接中断，回答未完成；请重新提问");
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
