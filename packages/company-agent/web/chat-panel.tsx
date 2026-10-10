/** 问答显示层：草稿、提示、消息列表和滚动；网络与生成状态交由 useChat 管理。 */
import { useLayoutEffect, useRef } from "react";
import type { KnowledgeBase, ModelInfo } from "../src/types.ts";
import { Message } from "./messages.tsx";
import type { OpenSource } from "./types.ts";
import type { ChatController } from "./use-chat.ts";

interface ChatPanelProps {
	active: boolean;
	bases: KnowledgeBase[];
	model: ModelInfo;
	chat: ChatController;
	onSource: OpenSource;
}

export function ChatPanel({ active, bases, model, chat, onSource }: ChatPanelProps) {
	const scroll = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const following = useRef(true);
	const conversationId = chat.current?.id;
	const lastConversation = useRef(conversationId);
	useLayoutEffect(() => {
		// DOM 更新后、绘制前校正滚动位置；只有用户仍在跟随底部时才随增量滚动。
		if (lastConversation.current !== conversationId) {
			lastConversation.current = conversationId;
			following.current = true;
		}
		if (active && chat.messages.length > 0 && following.current && scroll.current)
			scroll.current.scrollTop = scroll.current.scrollHeight;
	}, [active, chat.messages, conversationId]);
	const draft = (text: string) => {
		// 建议问题和重试按钮只预填草稿，不立即触发模型请求。
		chat.setQuestion(text);
		input.current?.focus();
	};
	const finance = chat.selected.includes("kb-finance") && !chat.selected.includes("kb-engineering");
	const suggestions = finance
		? [
				["流程查询", "费用报销需要哪些材料？"],
				["职责确认", "报销由谁审核？"],
			]
		: [
				["流程查询", "发布前需要做哪些准备？"],
				["职责确认", "谁来安排上线窗口？"],
			];
	return (
		<section id="chat-panel" className="chat-panel" aria-label="知识问答" hidden={!active}>
			<div
				id="chat-scroll"
				className="chat-scroll"
				ref={scroll}
				onScroll={(event) => {
					const target = event.currentTarget;
					following.current = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
				}}
			>
				{chat.messages.length === 0 && (
					<section id="welcome" className="welcome">
						<div className="welcome-mark" aria-hidden="true">
							知
						</div>
						<p className="eyebrow">YOUR TEAM’S KNOWLEDGE, ONE QUESTION AWAY</p>
						<h2>想了解些什么？</h2>
						<p className="welcome-description">
							从团队文档中寻找答案，
							<br className="mobile-only" />
							让每一次提问都有依据。
						</p>
						<div id="suggestions" className="suggestions">
							{suggestions.map(([label, text]) => (
								<button
									key={label}
									className="suggestion"
									type="button"
									disabled={chat.busy || chat.loading || chat.selected.length === 0}
									onClick={() => draft(text)}
								>
									<span>
										<span className="suggestion-label">{label}</span>
										<span className="suggestion-text">{text}</span>
									</span>
									<span className="suggestion-arrow">↗</span>
								</button>
							))}
						</div>
						<div className="welcome-footer">
							<span className="small-dot" aria-hidden="true" />
							只检索你有权访问的知识 · 引用可追溯
						</div>
					</section>
				)}
				<div id="messages" className="messages" role="log" aria-label="问答记录" aria-live="off">
					{chat.messages.map((message, index) => (
						<Message
							key={message.id}
							message={message}
							question={
								chat.messages.find((item) => item.role === "user" && item.runId === message.runId)?.content
							}
							streaming={chat.busy && index === chat.messages.length - 1}
							busy={chat.busy || chat.loading}
							onRetry={draft}
							onSource={onSource}
						/>
					))}
				</div>
			</div>
			<div className="composer-area">
				<output id="generation-status" className="generation-status">
					{chat.loading ? "正在读取问答记录…" : chat.stage}
				</output>
				<form
					id="question-form"
					className="composer"
					onSubmit={(event) => {
						event.preventDefault();
						following.current = true;
						void chat.submit();
					}}
				>
					<label className="sr-only" htmlFor="question">
						你的问题
					</label>
					<textarea
						id="question"
						name="question"
						rows={2}
						maxLength={2000}
						placeholder="向知识库提问，例如：发布前需要做哪些准备？"
						required
						ref={input}
						value={chat.question}
						disabled={chat.busy || chat.loading || chat.selected.length === 0}
						onChange={(event) => chat.setQuestion(event.target.value)}
					/>
					<div className="composer-toolbar">
						<span id="composer-scope" className="muted">
							{chat.selected.length > 0
								? bases
										.filter((base) => chat.selected.includes(base.id))
										.map((base) => base.name)
										.join(" · ")
								: "请在左侧选择知识库"}
						</span>
						<div className="composer-actions">
							<span id="question-count" className="character-count">
								{chat.question.length} / 2000
							</span>
							{chat.busy ? (
								<button
									id="stop-answer"
									className="button"
									type="button"
									disabled={chat.stopping}
									onClick={() => void chat.stop()}
								>
									停止生成
								</button>
							) : (
								<button
									id="send-question"
									className="button primary"
									type="submit"
									disabled={chat.loading || chat.selected.length === 0 || !chat.question.trim()}
								>
									发送 <span aria-hidden="true">↑</span>
								</button>
							)}
						</div>
					</div>
				</form>
				<p id="answer-note" className="answer-note">
					{model.mode === "demo"
						? "演示模式仅展示检索到的资料摘录，不调用生成模型。"
						: "回答基于知识库资料，请结合引用原文核对。"}
				</p>
			</div>
		</section>
	);
}
