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
	const epoch = useRef(0);
	const view = useRef(0);
	const currentRef = useRef<BrowserConversation | undefined>(undefined);
	const generationRef = useRef<Generation | undefined>(undefined);
	const loadController = useRef<AbortController | undefined>(undefined);

	useEffect(
		() => () => {
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
		if (currentRef.current || generationRef.current) return;
		setSelected((previous) => (checked ? [...new Set([...previous, id])] : previous.filter((item) => item !== id)));
	}, []);

	const submit = async () => {
		const content = question.trim();
		if (!content || selected.length === 0 || generationRef.current || loading) return;
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
			setQuestion("");
			await readChatStream(response, (event) => {
				if (session !== epoch.current || generationRef.current !== generation) return;
				if (event.type === "start") generation.runId = event.runId;
				if (event.type === "status" && !generation.stopping)
					setStage(
						event.stage === "retrieving"
							? "正在检索知识库…"
							: (event.note ?? `正在根据 ${event.sourceCount ?? 0} 段资料整理回答…`),
					);
				if (event.type === "delta")
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
