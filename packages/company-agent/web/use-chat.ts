/**
 * React 问答控制器：选择范围/会话 → 提交 → 读取增量 → 接收终态 → 回读持久化历史。
 * useState 驱动显示；ref 保存当前任务与取消句柄，让异步回调确认自己是否仍有权更新页面。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, KnowledgeBase } from "../src/types.ts";
import { api, checkedFetch, RequestError } from "./client.ts";
import { readChatStream } from "./stream.ts";
import type { BrowserConversation, Notify, ReportError } from "./types.ts";

interface Generation {
	controller: AbortController;
	refreshController?: AbortController;
	conversationId?: string;
	runId?: string;
	stopping?: boolean;
}

interface ChatOptions {
	bases: KnowledgeBase[];
	initialConversations: BrowserConversation[];
	notify: Notify;
	onError: ReportError;
	onNavigate: () => void;
}

export function useChat({ bases, initialConversations, notify, onError, onNavigate }: ChatOptions) {
	const [conversations, setConversations] = useState(initialConversations);
	const [current, setCurrent] = useState<BrowserConversation>();
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [selected, setSelected] = useState(() => bases.slice(0, 1).map((base) => base.id));
	const [question, setQuestion] = useState("");
	const [busy, setBusy] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [loading, setLoading] = useState(false);
	const [stage, setStage] = useState("");
	// epoch 区分组件生命周期，view 区分会话视图；A 请求晚于 B 返回时，旧序号不能覆盖 B。
	const epoch = useRef(0);
	const view = useRef(0);
	// current 用于渲染，currentRef 供异步操作立即读取最近确认的会话，相关转换需同时维护。
	const currentRef = useRef<BrowserConversation | undefined>(undefined);
	const generationRef = useRef<Generation | undefined>(undefined);
	const loadController = useRef<AbortController | undefined>(undefined);

	useEffect(
		() => () => {
			// 退出登录等导致组件卸载时，取消流读取和历史回填，防止旧用户数据晚到。
			epoch.current++;
			loadController.current?.abort();
			generationRef.current?.controller.abort();
			generationRef.current?.refreshController?.abort();
			generationRef.current = undefined;
		},
		[],
	);

	useEffect(() => {
		setSelected((previous) => previous.filter((id) => bases.some((base) => base.id === id)));
	}, [bases]);

	const newConversation = useCallback(() => {
		// 这里只清空本地草稿视图；真正的会话记录到首次发送时才由后端创建。
		if (generationRef.current) return;
		view.current++;
		loadController.current?.abort();
		currentRef.current = undefined;
		setCurrent(undefined);
		setMessages([]);
		setQuestion("");
		setStage("");
		setLoading(false);
		notify("");
		onNavigate();
	}, [notify, onNavigate]);

	const loadConversation = useCallback(
		async (id: string) => {
			if (generationRef.current) return;
			// 同时取消旧请求并更新序号；取消减少工作，序号检查保护状态归属。
			const version = ++view.current;
			const session = epoch.current;
			loadController.current?.abort();
			const controller = new AbortController();
			loadController.current = controller;
			setLoading(true);
			try {
				const result = await api<{ conversation: BrowserConversation; messages: ChatMessage[] }>(
					`/api/conversations/${encodeURIComponent(id)}`,
					"GET",
					undefined,
					controller.signal,
				);
				if (version !== view.current || session !== epoch.current || controller.signal.aborted) return;
				currentRef.current = result.conversation;
				setCurrent(result.conversation);
				setMessages(result.messages);
				setSelected(result.conversation.knowledgeBaseIds);
				notify("");
				onNavigate();
			} catch (error) {
				if (!controller.signal.aborted && version === view.current && session === epoch.current) onError(error);
			} finally {
				if (version === view.current && session === epoch.current) setLoading(false);
			}
		},
		[notify, onError, onNavigate],
	);

	const selectBase = useCallback((id: string, checked: boolean) => {
		// 已有会话的知识范围固定；想换范围要新建问答，服务端也按此规则校验。
		if (currentRef.current || generationRef.current) return;
		setSelected((previous) => (checked ? [...new Set([...previous, id])] : previous.filter((item) => item !== id)));
	}, []);

	const submit = async () => {
		const content = question.trim();
		if (!content || selected.length === 0 || generationRef.current || loading) return;
		// 先同步占住任务 ref，再更新 busy 界面，避免等待 React 重渲染期间重复发起请求。
		const generation: Generation = { controller: new AbortController() };
		generationRef.current = generation;
		const session = epoch.current;
		const version = ++view.current;
		loadController.current?.abort();
		const pendingId = crypto.randomUUID();
		let terminalError = "";
		setBusy(true);
		setStopping(false);
		setStage("正在检索知识库…");
		notify("");
		try {
			let conversation = currentRef.current;
			if (!conversation) {
				// 第一次发送先拿到服务端 conversationId，后续消息都属于这个固定知识范围。
				const result = await api<{ conversation: BrowserConversation }>(
					"/api/conversations",
					"POST",
					{
						title: content.slice(0, 80),
						knowledgeBaseIds: selected,
					},
					generation.controller.signal,
				);
				if (session !== epoch.current || generationRef.current !== generation) return;
				conversation = result.conversation;
				currentRef.current = conversation;
				setCurrent(conversation);
				setConversations((previous) => [result.conversation, ...previous]);
			}
			generation.conversationId = conversation.id;
			// 先展示用户问题和助手占位；服务端终态与后续历史回读会给出正式消息内容/ID。
			const placeholder: ChatMessage = {
				id: crypto.randomUUID(),
				runId: pendingId,
				role: "user",
				content,
				status: "complete",
				model: null,
				usage: null,
				errorCode: null,
				redacted: false,
				sources: [],
				createdAt: new Date().toISOString(),
			};
			setMessages((previous) => [
				...previous,
				placeholder,
				{
					...placeholder,
					id: pendingId,
					role: "assistant",
					content: "",
					status: "running",
				},
			]);
			const response = await checkedFetch(`/api/conversations/${encodeURIComponent(conversation.id)}/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content }),
				signal: generation.controller.signal,
			});
			if (session !== epoch.current || generationRef.current !== generation) return;
			// HTTP 已接受流请求后再清空输入；失败会恢复本轮问题，便于用户重试。
			setQuestion("");
			// 这里处理状态与正文；最终来源以 done 的完整消息为准，而不是把增量直接当作已验证答案。
			await readChatStream(response, (event) => {
				if (session !== epoch.current || generationRef.current !== generation) return;
				if (event.type === "start") generation.runId = event.runId;
				if (event.type === "agent" && !generation.stopping) setStage(event.note);
				if (event.type === "status" && !generation.stopping)
					setStage(
						event.stage === "retrieving"
							? "正在检索知识库…"
							: (event.note ?? `正在根据 ${event.sourceCount ?? 0} 段资料整理回答…`),
					);
				if (event.type === "delta")
					// 用函数式更新读取最新状态，避免连续增量都基于同一份旧消息数组。
					setMessages((previous) =>
						previous.map((message) =>
							message.id === pendingId ? { ...message, content: message.content + event.text } : message,
						),
					);
				if (event.type === "done") {
					setMessages((previous) =>
						previous.map((message) => (message.id === pendingId ? event.message : message)),
					);
					setStage("");
				}
				if (event.type === "error") {
					terminalError = event.message;
					setMessages((previous) =>
						previous.map((message) =>
							message.id === pendingId
								? {
										...message,
										content: "",
										sources: [],
										errorCode: event.code,
										status: event.code === "cancelled" ? "cancelled" : "error",
									}
								: message,
						),
					);
				}
			});
		} catch (error) {
			if (session !== epoch.current || generationRef.current !== generation) return;
			terminalError = generation.controller.signal.aborted
				? "已停止生成"
				: error instanceof Error
					? error.message
					: "回答失败，请重试";
			setMessages((previous) =>
				previous.map((message) =>
					message.id === pendingId
						? {
								...message,
								content: "",
								sources: [],
								status: generation.controller.signal.aborted ? "cancelled" : "error",
							}
						: message,
				),
			);
			if (error instanceof RequestError && error.status === 401) onError(error);
		} finally {
			if (session === epoch.current && generationRef.current === generation) {
				// 成功/失败/取消都回读服务端历史，将乐观占位与实际持久化状态对齐。
				if (terminalError) setQuestion(content);
				const controller = new AbortController();
				generation.refreshController = controller;
				try {
					const history = await api<{ conversations: BrowserConversation[] }>(
						"/api/conversations",
						"GET",
						undefined,
						controller.signal,
					);
					if (session === epoch.current && version === view.current) {
						setConversations(history.conversations);
						const id = generation.conversationId;
						if (id && history.conversations.some((item) => item.id === id)) {
							const result = await api<{ conversation: BrowserConversation; messages: ChatMessage[] }>(
								`/api/conversations/${encodeURIComponent(id)}`,
								"GET",
								undefined,
								controller.signal,
							);
							if (session === epoch.current && version === view.current) {
								currentRef.current = result.conversation;
								setCurrent(result.conversation);
								setMessages(result.messages);
							}
						} else if (id) {
							currentRef.current = undefined;
							setCurrent(undefined);
							setMessages([]);
						}
					}
				} catch (error) {
					if (!controller.signal.aborted && session === epoch.current) onError(error);
				} finally {
					if (session === epoch.current && generationRef.current === generation) {
						generationRef.current = undefined;
						setBusy(false);
						setStopping(false);
						setStage("");
						if (terminalError) notify(terminalError);
					}
				}
			}
		}
	};

	const stop = useCallback(async () => {
		const generation = generationRef.current;
		if (!generation || generation.stopping) return;
		generation.stopping = true;
		setStopping(true);
		setStage("正在停止生成…");
		try {
			// 已知 runId 时先取消后端精确任务；无论请求结果怎样，finally 都取消浏览器流读取。
			if (generation.runId && generation.conversationId)
				await api(
					`/api/conversations/${encodeURIComponent(generation.conversationId)}/runs/${encodeURIComponent(generation.runId)}/cancel`,
					"POST",
					{},
				);
		} catch (error) {
			if (!(error instanceof RequestError && error.status === 404)) onError(error);
		} finally {
			generation.controller.abort();
		}
	}, [onError]);

	return {
		conversations,
		current,
		messages,
		selected,
		question,
		busy,
		stopping,
		loading,
		stage,
		setQuestion,
		selectBase,
		newConversation,
		loadConversation,
		submit,
		stop,
	};
}

export type ChatController = ReturnType<typeof useChat>;
