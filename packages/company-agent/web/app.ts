import type {
	AnswerSource,
	ChatMessage,
	Conversation,
	DocumentMetadata,
	IngestionJob,
	KnowledgeBase,
	KnowledgeGrant,
	ModelInfo,
	SourceLocation,
	UploadReceipt,
	User,
	UserGroup,
} from "../src/types.ts";
import { api, checkedFetch, RequestError, sourcePath } from "./client.ts";
import { locationLabel, resetDocumentViewer, showDocumentViewer } from "./document-viewer.ts";
import { readChatStream } from "./stream.ts";

type BrowserConversation = Omit<Conversation, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string };
type BrowserDocument = Omit<DocumentMetadata, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string };

function element<T extends HTMLElement = HTMLElement>(id: string): T {
	const result = document.getElementById(id);
	if (!result) throw new Error(`缺少页面元素：${id}`);
	return result as T;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
	const result = document.createElement(tag);
	result.className = className;
	result.textContent = text;
	return result;
}

let user: User | undefined;
let bases: KnowledgeBase[] = [];
let conversations: BrowserConversation[] = [];
let selected = new Set<string>();
let current: BrowserConversation | undefined;
let messages: ChatMessage[] = [];
let page: "chat" | "manage" = "chat";
let sessionEpoch = 0;
let conversationLoad = 0;
let managementLoad = 0;
let sourceLoad = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let updateDocument: BrowserDocument | undefined;
let lastUpload: UploadReceipt | undefined;
let uploading = false;
interface Generation {
	controller: AbortController;
	conversationId?: string;
	runId?: string;
}
let activeGeneration: Generation | undefined;

function notice(message: string, success = false): void {
	const target = element("notice");
	target.textContent = message;
	target.classList.toggle("success", success);
	target.hidden = !message;
}

function report(error: unknown): void {
	if (error instanceof RequestError && error.status === 401) {
		resetSession();
		element("login-error").textContent = "登录已失效，请重新登录。";
		element("login-error").hidden = false;
		return;
	}
	notice(error instanceof Error ? error.message : "操作失败，请重试");
}

function action(task: () => Promise<void>): void {
	void task().catch(report);
}

function resetSession(): void {
	sessionEpoch++;
	conversationLoad++;
	managementLoad++;
	sourceLoad++;
	resetDocumentViewer();
	activeGeneration?.controller.abort();
	activeGeneration = undefined;
	clearTimeout(pollTimer);
	user = undefined;
	bases = [];
	conversations = [];
	selected.clear();
	current = undefined;
	messages = [];
	startUpdate();
	notice("");
	element("grants-status").textContent = "";
	element("generation-status").textContent = "";
	element("messages").replaceChildren();
	element("document-list").replaceChildren();
	element("grant-list").replaceChildren();
	element("conversation-list").replaceChildren();
	element("scope-list").replaceChildren();
	element<HTMLTextAreaElement>("question").value = "";
	element<HTMLInputElement>("password").value = "";
	element<HTMLDialogElement>("source-dialog").close();
	element("source-content").textContent = "";
	element("source-title").textContent = "引用原文";
	element("source-meta").textContent = "";
	element("source-link").removeAttribute("href");
	element("app-view").hidden = true;
	element("login-view").hidden = false;
	element("loading-view").hidden = true;
}

async function loadWorkspace(): Promise<void> {
	const epoch = ++sessionEpoch;
	const [identity, knowledge, history, config] = await Promise.all([
		api<{ user: User }>("/api/me"),
		api<{ knowledgeBases: KnowledgeBase[] }>("/api/knowledge-bases"),
		api<{ conversations: BrowserConversation[] }>("/api/conversations"),
		api<{ model: ModelInfo }>("/api/model"),
	]);
	if (epoch !== sessionEpoch) return;
	user = identity.user;
	bases = knowledge.knowledgeBases;
	conversations = history.conversations;
	selected = new Set(bases.slice(0, 1).map((base) => base.id));
	element("user-name").textContent = user.displayName;
	element("user-account").textContent = user.username;
	element("user-avatar").textContent = user.username.slice(0, 1);
	const badge = element("model-badge");
	badge.textContent = config.model.mode === "demo" ? "演示模式 · 资料摘录" : config.model.name;
	badge.classList.toggle("demo", config.model.mode === "demo");
	badge.title = config.model.name;
	element("answer-note").textContent =
		config.model.mode === "demo"
			? "演示模式仅展示检索到的资料摘录，不调用生成模型。"
			: "回答基于知识库资料，请结合引用原文核对。";
	element("loading-view").hidden = true;
	element("login-view").hidden = true;
	element("app-view").hidden = false;
	renderManagementOptions();
	newConversation();
}

function renderSidebar(): void {
	const scope = element("scope-list");
	scope.replaceChildren();
	for (const base of bases) {
		const label = node("label", "scope-option");
		const input = node("input");
		input.type = "checkbox";
		input.value = base.id;
		input.checked = selected.has(base.id);
		input.disabled = Boolean(current || activeGeneration);
		input.addEventListener("change", () => {
			if (input.checked) selected.add(base.id);
			else selected.delete(base.id);
			updateComposer();
			renderSuggestions();
		});
		label.append(input, node("span", "", base.name));
		scope.append(label);
	}
	if (bases.length === 0) scope.append(node("p", "history-empty", "暂无可用知识库"));
	element("scope-hint").textContent = current ? "如需切换知识范围，请新建问答" : "选择本次问答使用的知识库";
	element<HTMLButtonElement>("new-chat").disabled = Boolean(activeGeneration);
	const list = element("conversation-list");
	list.replaceChildren();
	for (const conversation of conversations) {
		const button = node(
			"button",
			`history-item${conversation.id === current?.id ? " active" : ""}`,
			conversation.title,
		);
		button.type = "button";
		button.title = conversation.title;
		button.disabled = Boolean(activeGeneration);
		button.addEventListener("click", () => action(() => loadConversation(conversation.id)));
		list.append(button);
	}
	if (conversations.length === 0) list.append(node("p", "history-empty", "你的问答记录会保存在这里"));
	updateComposer();
}

function updateComposer(): void {
	const busy = Boolean(activeGeneration);
	const input = element<HTMLTextAreaElement>("question");
	element("question-count").textContent = `${input.value.length} / 2000`;
	element<HTMLButtonElement>("send-question").disabled = busy || selected.size === 0 || !input.value.trim();
	element("send-question").hidden = busy;
	element<HTMLButtonElement>("stop-answer").hidden = !busy;
	element<HTMLButtonElement>("stop-answer").disabled = false;
	input.disabled = busy || selected.size === 0;
	element("composer-scope").textContent =
		selected.size > 0
			? bases
					.filter((base) => selected.has(base.id))
					.map((base) => base.name)
					.join(" · ")
			: "请在左侧选择知识库";
}

function renderSuggestions(): void {
	const finance = selected.has("kb-finance") && !selected.has("kb-engineering");
	const examples = finance
		? [
				["流程查询", "费用报销需要哪些材料？"],
				["职责确认", "报销由谁审核？"],
			]
		: [
				["流程查询", "发布前需要做哪些准备？"],
				["职责确认", "谁来安排上线窗口？"],
			];
	const target = element("suggestions");
	target.replaceChildren();
	for (const [label, question] of examples) {
		const button = node("button", "suggestion");
		button.type = "button";
		button.disabled = selected.size === 0;
		const copy = node("span");
		copy.append(node("span", "suggestion-label", label), node("span", "suggestion-text", question));
		button.append(copy, node("span", "suggestion-arrow", "↗"));
		button.addEventListener("click", () => {
			const input = element<HTMLTextAreaElement>("question");
			input.value = question;
			updateComposer();
			input.focus();
		});
		target.append(button);
	}
}

function showPage(next: "chat" | "manage"): void {
	page = next;
	element("chat-panel").hidden = next !== "chat";
	element("manage-panel").hidden = next !== "manage";
	for (const name of ["chat", "manage"]) {
		const button = element(`nav-${name}`);
		button.classList.toggle("active", name === next);
		if (name === next) button.setAttribute("aria-current", "page");
		else button.removeAttribute("aria-current");
	}
	element("page-section").textContent = next === "chat" ? "知识问答" : "知识管理";
	element("page-title").textContent = next === "chat" ? (current?.title ?? "新的问答") : "团队知识";
	element("app-view").classList.remove("sidebar-open");
	element("menu-toggle").setAttribute("aria-expanded", "false");
	clearTimeout(pollTimer);
	if (next === "manage") action(() => loadManagement());
}

function newConversation(): void {
	if (activeGeneration) return;
	conversationLoad++;
	current = undefined;
	messages = [];
	notice("");
	element<HTMLTextAreaElement>("question").value = "";
	element("generation-status").textContent = "";
	renderMessages();
	renderSidebar();
	renderSuggestions();
	showPage("chat");
}

async function loadConversation(id: string, navigate = true): Promise<void> {
	if (activeGeneration) return;
	const load = ++conversationLoad;
	const epoch = sessionEpoch;
	const result = await api<{ conversation: BrowserConversation; messages: ChatMessage[] }>(
		`/api/conversations/${encodeURIComponent(id)}`,
	);
	if (load !== conversationLoad || epoch !== sessionEpoch || activeGeneration) return;
	current = result.conversation;
	messages = result.messages;
	selected = new Set(current.knowledgeBaseIds);
	notice("");
	renderMessages();
	renderSidebar();
	if (navigate) showPage("chat");
	scrollToEnd();
}

function renderMessages(): void {
	element("welcome").hidden = messages.length > 0;
	element("messages").replaceChildren(...messages.map(renderMessage));
}

function renderMessage(message: ChatMessage): HTMLElement {
	const article = node("article", `message ${message.role}`);
	article.dataset.messageId = message.id;
	const heading = node("div", "message-heading");
	if (message.role === "assistant") heading.append(node("span", "mini-mark", "知"));
	heading.append(node("span", "", message.role === "user" ? "你" : "知序"));
	const content = node("div", "message-content");
	article.append(heading, content);
	if (message.redacted) {
		content.textContent = "这条回答所用资料已删除或权限发生变化，内容已隐藏。";
		return article;
	}
	if (message.status !== "complete") {
		content.textContent =
			message.status === "running"
				? "回答进行中…"
				: message.status === "cancelled"
					? "已停止生成。"
					: "这次回答未完成，请重试。";
		if (message.status === "running") return article;
		const status = node(
			"p",
			`message-status${message.status === "error" ? " failed" : ""}`,
			message.errorCode === "interrupted" ? "服务重启中断了回答。" : "未完成的回答不会用于后续问答。",
		);
		article.append(status);
		const question = messages.find((item) => item.role === "user" && item.runId === message.runId);
		if (question) {
			const retry = node("button", "text-button", "重新提问");
			retry.type = "button";
			retry.addEventListener("click", () => {
				element<HTMLTextAreaElement>("question").value = question.content;
				updateComposer();
				element("question").focus();
			});
			status.append(document.createTextNode(" "), retry);
		}
		return article;
	}
	let offset = 0;
	for (const match of message.content.matchAll(/\[(\d+)\]/g)) {
		const source = message.sources.find((item) => item.number === Number(match[1]));
		if (!source) continue;
		content.append(document.createTextNode(message.content.slice(offset, match.index)));
		const link = node("a", "citation-link", match[0]);
		link.href = sourcePath(source.sourceUrl);
		link.title = `${source.title}，${locationLabel(source.locations, source.startLine, source.endLine)}`;
		link.addEventListener("click", (event) => {
			event.preventDefault();
			action(() => openCitation(source));
		});
		content.append(link);
		offset = match.index + match[0].length;
	}
	content.append(document.createTextNode(message.content.slice(offset)));
	if (message.sources.length > 0) {
		const cards = node("div", "source-cards");
		for (const source of message.sources) {
			const button = node("button", "source-card");
			button.type = "button";
			const details = node("span");
			details.append(
				node("strong", "", source.title),
				node(
					"span",
					"muted",
					`版本 ${source.version} · ${locationLabel(source.locations, source.startLine, source.endLine)}`,
				),
			);
			button.append(node("span", "source-number", String(source.number)), details);
			button.addEventListener("click", () => action(() => openCitation(source)));
			cards.append(button);
		}
		article.append(cards);
	}
	if (message.role === "assistant") {
		article.append(
			node("p", "message-status", message.usage ? `已完成 · ${message.usage.totalTokens} tokens` : "已完成"),
		);
	}
	return article;
}

function scrollToEnd(): void {
	const scroll = element("chat-scroll");
	scroll.scrollTop = scroll.scrollHeight;
}

async function submitQuestion(): Promise<void> {
	const input = element<HTMLTextAreaElement>("question");
	const question = input.value.trim();
	if (!question || selected.size === 0 || activeGeneration) return;
	const epoch = sessionEpoch;
	const generation: Generation = { controller: new AbortController() };
	activeGeneration = generation;
	let terminalError = "";
	let pending: HTMLElement | undefined;
	notice("");
	renderSidebar();
	try {
		if (!current) {
			const result = await api<{ conversation: BrowserConversation }>("/api/conversations", "POST", {
				title: question.slice(0, 80),
				knowledgeBaseIds: [...selected],
			});
			if (epoch !== sessionEpoch) return;
			current = result.conversation;
			conversations.unshift(current);
		}
		generation.conversationId = current.id;
		element("page-title").textContent = current.title;
		const placeholder: ChatMessage = {
			id: crypto.randomUUID(),
			runId: "pending",
			role: "user",
			content: question,
			status: "complete",
			model: null,
			usage: null,
			errorCode: null,
			redacted: false,
			sources: [],
			createdAt: new Date().toISOString(),
		};
		messages.push(placeholder);
		renderMessages();
		pending = renderMessage({ ...placeholder, id: "pending", role: "assistant", content: "", status: "running" });
		element("messages").append(pending);
		element("generation-status").textContent = "正在检索知识库…";
		renderSidebar();
		scrollToEnd();
		const response = await checkedFetch(`/api/conversations/${encodeURIComponent(current.id)}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: question }),
			signal: generation.controller.signal,
		});
		if (epoch !== sessionEpoch) return;
		input.value = "";
		updateComposer();
		let text = "";
		await readChatStream(response, (event) => {
			if (epoch !== sessionEpoch || activeGeneration !== generation) return;
			if (event.type === "start") generation.runId = event.runId;
			if (event.type === "status")
				element("generation-status").textContent =
					event.stage === "retrieving" ? "正在检索知识库…" : `正在根据 ${event.sourceCount ?? 0} 段资料整理回答…`;
			if (event.type === "delta") {
				const scroll = element("chat-scroll");
				const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
				text += event.text;
				const body = pending?.querySelector(".message-content");
				if (body) body.textContent = text;
				if (atBottom) scrollToEnd();
			}
			if (event.type === "done") {
				pending?.replaceWith(renderMessage(event.message));
				element("generation-status").textContent = "";
			}
			if (event.type === "error") {
				terminalError = event.message;
				const body = pending?.querySelector(".message-content");
				if (body) body.textContent = event.message;
				text = "";
			}
		});
	} catch (error) {
		if (epoch === sessionEpoch) {
			terminalError = generation.controller.signal.aborted
				? "已停止生成"
				: error instanceof Error
					? error.message
					: "回答失败，请重试";
			if (error instanceof RequestError && error.status === 401) report(error);
			const body = pending?.querySelector(".message-content");
			if (body) body.textContent = terminalError;
		}
	} finally {
		if (epoch === sessionEpoch) {
			activeGeneration = undefined;
			element("generation-status").textContent = "";
			if (terminalError) input.value = question;
			renderSidebar();
			const viewVersion = conversationLoad;
			try {
				const history = await api<{ conversations: BrowserConversation[] }>("/api/conversations");
				if (epoch === sessionEpoch) {
					conversations = history.conversations;
					if (!activeGeneration && viewVersion === conversationLoad && current?.id === generation.conversationId) {
						if (
							generation.conversationId &&
							conversations.some((item) => item.id === generation.conversationId)
						) {
							await loadConversation(generation.conversationId, false);
						} else newConversation();
					}
					renderSidebar();
				}
			} catch (error) {
				report(error);
			}
			if (epoch === sessionEpoch && terminalError) notice(terminalError);
		}
	}
}

async function stopAnswer(): Promise<void> {
	const generation = activeGeneration;
	if (!generation) return;
	element<HTMLButtonElement>("stop-answer").disabled = true;
	element("generation-status").textContent = "正在停止生成…";
	try {
		if (generation.runId && generation.conversationId) {
			await api(
				`/api/conversations/${encodeURIComponent(generation.conversationId)}/runs/${encodeURIComponent(generation.runId)}/cancel`,
				"POST",
				{},
			);
		}
	} catch (error) {
		if (!(error instanceof RequestError && error.status === 404)) throw error;
	} finally {
		generation.controller.abort();
	}
}

async function openCitation(source: AnswerSource): Promise<void> {
	await openSource(
		source.title,
		source.sourceUrl,
		`版本 ${source.version} · ${locationLabel(source.locations, source.startLine, source.endLine)}${source.heading ? ` · ${source.heading}` : ""}`,
		source.locations,
	);
}

async function openSource(title: string, path: string, meta: string, locations: SourceLocation[] = []): Promise<void> {
	const load = ++sourceLoad;
	try {
		await showDocumentViewer(title, path, meta, locations, async () => {
			await loadManagement(false);
			notice("复核完成，文档已可用于问答。", true);
		});
	} catch (error) {
		if (load !== sourceLoad) return;
		element("source-content").textContent = error instanceof Error ? error.message : "原文读取失败";
		if (error instanceof RequestError && error.status === 401) report(error);
	}
}

function renderManagementOptions(): void {
	const select = element<HTMLSelectElement>("manage-base");
	const previous = select.value;
	select.replaceChildren(
		...bases.map((base) => {
			const option = node("option", "", base.name);
			option.value = base.id;
			return option;
		}),
	);
	if (bases.some((base) => base.id === previous)) select.value = previous;
}

async function loadManagement(includeGrants = true): Promise<void> {
	clearTimeout(pollTimer);
	const load = ++managementLoad;
	const epoch = sessionEpoch;
	const id = element<HTMLSelectElement>("manage-base").value;
	const base = bases.find((item) => item.id === id);
	element("manage-empty").hidden = Boolean(base);
	element("management-content").hidden = !base;
	if (!base) return;
	element("upload-form").hidden = base.role === "viewer";
	element("grants-form").hidden = base.role !== "admin";
	try {
		const result = await api<{ documents: BrowserDocument[] }>(
			`/api/knowledge-bases/${encodeURIComponent(id)}/documents`,
		);
		if (load !== managementLoad || epoch !== sessionEpoch) return;
		renderDocuments(result.documents, base);
		if (lastUpload) {
			const uploaded = result.documents.find(
				(doc) => doc.id === lastUpload?.documentId && doc.latestVersionId === lastUpload.versionId,
			);
			if (uploaded?.status === "ready") element("upload-status").textContent = "处理完成，文档已可用于问答。";
			else if (uploaded?.status === "needs_review")
				element("upload-status").textContent = "识别完成，请在文档列表点击「复核」，确认后用于问答。";
			else if (uploaded?.status === "failed")
				element("upload-status").textContent = "文档处理失败，可在列表查看原因或重试。";
		}
		if (includeGrants && base.role === "admin") {
			const [grants, groups] = await Promise.all([
				api<{ grants: KnowledgeGrant[] }>(`/api/knowledge-bases/${encodeURIComponent(id)}/grants`),
				api<{ groups: UserGroup[] }>(`/api/knowledge-bases/${encodeURIComponent(id)}/groups`),
			]);
			if (load !== managementLoad || epoch !== sessionEpoch) return;
			renderGrants(groups.groups, grants.grants);
		}
		if (page === "manage" && result.documents.some((doc) => doc.status === "queued" || doc.status === "processing")) {
			pollTimer = setTimeout(() => action(() => loadManagement(false)), 1200);
		}
	} catch (error) {
		if (load !== managementLoad || epoch !== sessionEpoch) return;
		element("document-list").replaceChildren();
		element("grants-form").hidden = true;
		element("upload-form").hidden = true;
		throw error;
	}
}

function renderDocuments(documents: BrowserDocument[], base: KnowledgeBase): void {
	element("document-count").textContent = String(documents.length);
	element("documents-empty").hidden = documents.length > 0;
	const pending = documents.filter((doc) => doc.status === "queued" || doc.status === "processing").length;
	element("document-summary").textContent =
		pending > 0 ? `${pending} 份资料处理中，完成后可用于问答` : "只使用已完成处理的版本";
	const list = element("document-list");
	list.replaceChildren();
	for (const doc of documents) {
		const row = node("tr");
		const title = node("td");
		title.append(
			node("div", "document-title", doc.title),
			node("div", "document-date", `更新于 ${new Date(doc.updatedAt).toLocaleString("zh-CN", { hour12: false })}`),
		);
		const status = node("td");
		const labels = {
			queued: "等待处理",
			processing: "处理中",
			needs_review: "需复核",
			ready: "可用于问答",
			failed: "处理失败",
		};
		const stages = {
			queued: "等待处理",
			extracting: "解析正文",
			ocr: "识别扫描页",
			indexing: "建立索引",
			needs_review: "需复核",
			complete: "处理完成",
			failed: "处理失败",
		};
		const progress =
			doc.status === "processing"
				? (stages[doc.stage] ?? "处理中") + (doc.totalPages ? ` ${doc.processedPages}/${doc.totalPages} 页` : "")
				: labels[doc.status];
		status.append(node("span", `status-tag ${doc.status}`, progress));
		const actions = node("td");
		const buttons = node("div", "document-actions");
		const add = (label: string, callback: () => Promise<void> | void, danger = false) => {
			const button = node("button", `text-button${danger ? " danger" : ""}`, label);
			button.type = "button";
			button.addEventListener("click", () =>
				action(async () => {
					await callback();
				}),
			);
			buttons.append(button);
		};
		if (doc.currentVersionId) {
			add("原文", () =>
				openSource(
					doc.title,
					`/api/documents/${encodeURIComponent(doc.id)}/source?versionId=${encodeURIComponent(doc.currentVersionId ?? "")}`,
					`版本 ${doc.version}`,
				),
			);
			const download = node("a", "text-button", "下载");
			download.href = `/api/documents/${encodeURIComponent(doc.id)}/download?versionId=${encodeURIComponent(doc.currentVersionId)}`;
			buttons.append(download);
		}
		if (doc.status === "failed" && doc.latestJobId) {
			add("失败原因", async () => {
				const result = await api<{ job: IngestionJob }>(
					`/api/ingestion-jobs/${encodeURIComponent(doc.latestJobId ?? "")}`,
				);
				notice(result.job.error ?? "处理失败，请上传修正后的版本");
			});
		}
		if (base.role !== "viewer") {
			if (doc.status === "needs_review")
				add("复核", () =>
					openSource(
						doc.title,
						`/api/documents/${encodeURIComponent(doc.id)}/source?versionId=${encodeURIComponent(doc.latestVersionId)}`,
						"待复核版本 · 尚未用于问答",
					),
				);
			if (doc.status !== "queued" && doc.status !== "processing") add("更新", () => startUpdate(doc));
			if ((doc.status === "failed" || doc.status === "needs_review") && doc.latestJobId)
				add("重试", async () => {
					notice("");
					await api(`/api/ingestion-jobs/${encodeURIComponent(doc.latestJobId ?? "")}/retry`, "POST", {});
					await loadManagement(false);
				});
			add(
				"删除",
				async () => {
					if (!window.confirm(`删除「${doc.title}」？相关引用和历史回答将不再可读。`)) return;
					await api(`/api/documents/${encodeURIComponent(doc.id)}`, "DELETE");
					await loadManagement(false);
					notice("文档已删除", true);
				},
				true,
			);
		}
		actions.append(buttons);
		row.append(title, node("td", "", doc.version ? `v${doc.version}` : "—"), status, actions);
		list.append(row);
	}
}

function startUpdate(doc?: BrowserDocument): void {
	updateDocument = doc;
	lastUpload = undefined;
	element<HTMLFormElement>("upload-form").reset();
	element("file-label").textContent = "选择一份文档";
	element("upload-heading").textContent = doc ? `更新：${doc.title}` : "添加知识文档";
	element("upload-submit").textContent = doc ? "上传新版本" : "上传并入库";
	element("cancel-update").hidden = !doc;
	element("upload-status").textContent = "";
	if (doc) element("upload-form").scrollIntoView({ block: "nearest" });
}

async function upload(): Promise<void> {
	if (uploading) return;
	const file = element<HTMLInputElement>("upload-file").files?.[0];
	if (!file) return;
	const textFile = /\.(md|markdown|txt)$/i.test(file.name);
	if (
		!/\.(md|markdown|txt|pdf|docx|doc)$/i.test(file.name) ||
		file.size === 0 ||
		file.size > (textFile ? 1 : 20) * 1024 * 1024
	) {
		throw new Error("请选择有效的 PDF / Word（最大 20 MiB）或 Markdown / TXT（最大 1 MiB）文件");
	}
	const id = element<HTMLSelectElement>("manage-base").value;
	const form = new FormData();
	form.set("file", file);
	const title = element<HTMLInputElement>("upload-title").value.trim();
	if (title) form.set("title", title);
	const path = updateDocument
		? `/api/documents/${encodeURIComponent(updateDocument.id)}/versions`
		: `/api/knowledge-bases/${encodeURIComponent(id)}/documents`;
	const epoch = sessionEpoch;
	uploading = true;
	element<HTMLButtonElement>("upload-submit").disabled = true;
	element<HTMLSelectElement>("manage-base").disabled = true;
	element("upload-status").textContent = "正在上传…";
	try {
		const response = await checkedFetch(path, { method: "POST", body: form });
		const receipt = (await response.json()) as UploadReceipt;
		if (epoch !== sessionEpoch) return;
		startUpdate();
		lastUpload = receipt;
		element("upload-status").textContent = "上传成功，正在处理。文档列表将自动更新。";
		await loadManagement(false);
	} catch (error) {
		if (epoch === sessionEpoch)
			element("upload-status").textContent = error instanceof Error ? error.message : "上传失败";
		throw error;
	} finally {
		uploading = false;
		element<HTMLButtonElement>("upload-submit").disabled = false;
		element<HTMLSelectElement>("manage-base").disabled = false;
	}
}

function renderGrants(groups: UserGroup[], grants: KnowledgeGrant[]): void {
	const list = element("grant-list");
	list.replaceChildren();
	for (const group of groups) {
		const row = node("div", "grant-row");
		const label = node("label", "", group.name);
		const select = node("select");
		select.id = `grant-${group.id}`;
		label.htmlFor = select.id;
		select.dataset.groupId = group.id;
		for (const [value, text] of [
			["", "无访问权限"],
			["viewer", "阅读"],
			["editor", "维护（含上传）"],
			["admin", "管理（含授权）"],
		]) {
			const option = node("option", "", text);
			option.value = value;
			select.append(option);
		}
		select.value = grants.find((grant) => grant.groupId === group.id)?.role ?? "";
		row.append(label, select);
		list.append(row);
	}
}

async function saveGrants(): Promise<void> {
	const id = element<HTMLSelectElement>("manage-base").value;
	const grants = [...element("grant-list").querySelectorAll("select")]
		.filter((select) => select.value)
		.map((select) => ({ groupId: select.dataset.groupId, role: select.value }));
	element<HTMLButtonElement>("save-grants").disabled = true;
	const epoch = sessionEpoch;
	try {
		await api(`/api/knowledge-bases/${encodeURIComponent(id)}/grants`, "PUT", { grants });
		const result = await api<{ knowledgeBases: KnowledgeBase[] }>("/api/knowledge-bases");
		if (epoch !== sessionEpoch) return;
		bases = result.knowledgeBases;
		selected = new Set([...selected].filter((value) => bases.some((base) => base.id === value)));
		renderManagementOptions();
		renderSidebar();
		await loadManagement();
		element("grants-status").textContent = "权限已保存，后续访问立即生效。";
	} finally {
		element<HTMLButtonElement>("save-grants").disabled = false;
	}
}

element("login-form").addEventListener("submit", (event) => {
	event.preventDefault();
	void (async () => {
		element<HTMLButtonElement>("login-submit").disabled = true;
		element("login-submit").textContent = "正在登录…";
		element("login-error").hidden = true;
		try {
			await api("/api/auth/login", "POST", {
				username: element<HTMLInputElement>("username").value.trim(),
				password: element<HTMLInputElement>("password").value,
			});
			element<HTMLInputElement>("password").value = "";
			await loadWorkspace();
		} catch (error) {
			element("login-error").textContent = error instanceof Error ? error.message : "登录失败，请重试";
			element("login-error").hidden = false;
		} finally {
			element<HTMLButtonElement>("login-submit").disabled = false;
			element("login-submit").textContent = "登录并进入";
		}
	})();
});
element("logout").addEventListener("click", () =>
	action(async () => {
		await stopAnswer();
		await api("/api/auth/logout", "POST", {});
		resetSession();
	}),
);
element("new-chat").addEventListener("click", newConversation);
element("nav-chat").addEventListener("click", () => showPage("chat"));
element("nav-manage").addEventListener("click", () => showPage("manage"));
element("question").addEventListener("input", updateComposer);
element("question-form").addEventListener("submit", (event) => {
	event.preventDefault();
	action(submitQuestion);
});
element("stop-answer").addEventListener("click", () => action(stopAnswer));
element("close-source").addEventListener("click", () => {
	sourceLoad++;
	element<HTMLDialogElement>("source-dialog").close();
});
element("menu-toggle").addEventListener("click", () => {
	const open = element("app-view").classList.toggle("sidebar-open");
	element("menu-toggle").setAttribute("aria-expanded", String(open));
});
element("manage-base").addEventListener("change", () => {
	startUpdate();
	element("document-list").replaceChildren();
	element("grant-list").replaceChildren();
	element("grants-status").textContent = "";
	action(() => loadManagement());
});
element("refresh-documents").addEventListener("click", () => action(() => loadManagement()));
element("upload-file").addEventListener("change", () => {
	element("file-label").textContent = element<HTMLInputElement>("upload-file").files?.[0]?.name ?? "选择一份文档";
});
element("cancel-update").addEventListener("click", () => startUpdate());
element("upload-form").addEventListener("submit", (event) => {
	event.preventDefault();
	action(upload);
});
element("grants-form").addEventListener("submit", (event) => {
	event.preventDefault();
	action(saveGrants);
});

void loadWorkspace().catch((error: unknown) => {
	resetSession();
	if (!(error instanceof RequestError && error.status === 401)) {
		element("login-error").textContent = error instanceof Error ? error.message : "无法连接服务，请刷新重试";
		element("login-error").hidden = false;
	}
});
