import type { ReactNode } from "react";
import type { AnswerSource, ChatMessage } from "../src/types.ts";
import { sourcePath } from "./client.ts";
import { locationLabel } from "./locations.ts";
import type { OpenSource } from "./types.ts";

interface MessageProps {
	message: ChatMessage;
	question?: string;
	streaming: boolean;
	busy: boolean;
	onRetry: (question: string) => void;
	onSource: OpenSource;
}

export function Message({ message, question, streaming, busy, onRetry, onSource }: MessageProps) {
	const openCitation = (source: AnswerSource) =>
		onSource({
			title: source.title,
			path: source.sourceUrl,
			locations: source.locations ?? [],
			meta: `版本 ${source.version} · ${locationLabel(source.locations, source.startLine, source.endLine)}${source.heading ? ` · ${source.heading}` : ""}`,
		});
	let content: ReactNode = message.content;
	if (message.redacted) content = "这条回答所用资料已删除或权限发生变化，内容已隐藏。";
	else if (message.status === "running") content = streaming && message.content ? message.content : "回答进行中…";
	else if (message.status !== "complete")
		content = message.status === "cancelled" ? "已停止生成。" : "这次回答未完成，请重试。";
	else {
		const parts: ReactNode[] = [];
		let offset = 0;
		for (const match of message.content.matchAll(/\[(\d+)\]/g)) {
			const source = message.sources.find((item) => item.number === Number(match[1]));
			if (!source) continue;
			let href: string;
			try {
				href = sourcePath(source.sourceUrl);
			} catch {
				continue;
			}
			parts.push(message.content.slice(offset, match.index));
			parts.push(
				<a
					key={match.index}
					className="citation-link"
					href={href}
					title={`${source.title}，${locationLabel(source.locations, source.startLine, source.endLine)}`}
					onClick={(event) => {
						event.preventDefault();
						openCitation(source);
					}}
				>
					{match[0]}
				</a>,
			);
			offset = match.index + match[0].length;
		}
		parts.push(message.content.slice(offset));
		content = parts;
	}
	const complete = message.status === "complete" && !message.redacted;
	const failed = !message.redacted && (message.status === "error" || message.status === "cancelled");
	return (
		<article className={`message ${message.role}`} data-message-id={message.id}>
			<div className="message-heading">
				{message.role === "assistant" && <span className="mini-mark">知</span>}
				<span>{message.role === "user" ? "你" : "知序"}</span>
			</div>
			<div className="message-content">{content}</div>
			{complete && message.sources.length > 0 && (
				<div className="source-cards">
					{message.sources.map((source) => (
						<button
							key={`${source.number}-${source.chunkId}`}
							className="source-card"
							type="button"
							onClick={() => openCitation(source)}
						>
							<span className="source-number">{source.number}</span>
							<span>
								<strong>{source.title}</strong>
								<span className="muted">
									版本 {source.version} · {locationLabel(source.locations, source.startLine, source.endLine)}
								</span>
							</span>
						</button>
					))}
				</div>
			)}
			{complete && message.role === "assistant" && (
				<>
					<p className="message-status">
						{message.usage ? `已完成 · ${message.usage.totalTokens} tokens` : "已完成"}
					</p>
					{message.retrieval?.note && <p className="message-status">{message.retrieval.note}</p>}
				</>
			)}
			{failed && (
				<p className={`message-status${message.status === "error" ? " failed" : ""}`}>
					{message.errorCode === "interrupted" ? "服务重启中断了回答。" : "未完成的回答不会用于后续问答。"}
					{question && (
						<>
							{" "}
							<button className="text-button" type="button" disabled={busy} onClick={() => onRetry(question)}>
								重新提问
							</button>
						</>
					)}
				</p>
			)}
		</article>
	);
}
