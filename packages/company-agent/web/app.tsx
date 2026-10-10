/**
 * 网页总入口：恢复登录 → 登录表单或工作空间 → 问答/管理/原文预览。
 * 页面只保存交互状态，权限和持久化事实以服务端返回为准。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { KnowledgeBase, ModelInfo, User } from "../src/types.ts";
import { ChatPanel } from "./chat-panel.tsx";
import { api, RequestError } from "./client.ts";
import { DocumentViewer } from "./document-viewer.tsx";
import { Login } from "./login.tsx";
import { ManagementPanel } from "./management.tsx";
import { Sidebar } from "./sidebar.tsx";
import type {
	BrowserConversation,
	Notice,
	Notify,
	OpenSource,
	ReportError,
	SourceRequest,
	WorkspaceData,
	WorkspacePage,
} from "./types.ts";
import { useChat } from "./use-chat.ts";

async function loadWorkspace(signal: AbortSignal): Promise<WorkspaceData> {
	// 四项读取相互独立，可以并发；共用取消信号，避免退出后继续装载旧用户数据。
	const [identity, knowledge, history, configuration] = await Promise.all([
		api<{ user: User }>("/api/me", "GET", undefined, signal),
		api<{ knowledgeBases: KnowledgeBase[] }>("/api/knowledge-bases", "GET", undefined, signal),
		api<{ conversations: BrowserConversation[] }>("/api/conversations", "GET", undefined, signal),
		api<{ model: ModelInfo }>("/api/model", "GET", undefined, signal),
	]);
	return {
		user: identity.user,
		knowledgeBases: knowledge.knowledgeBases,
		conversations: history.conversations,
		model: configuration.model,
	};
}

export function App() {
	const [workspace, setWorkspace] = useState<WorkspaceData>();
	const [loading, setLoading] = useState(true);
	const [loginError, setLoginError] = useState("");
	const [notice, setNotice] = useState<Notice>({ message: "", success: false });
	const controller = useRef<AbortController | undefined>(undefined);
	const notify = useCallback<Notify>((message, success = false) => setNotice({ message, success }), []);
	const report = useCallback<ReportError>((error) => {
		// 401 会卸载整个 Workspace，其 Hooks 的清理逻辑随后取消问答、轮询和原文请求。
		if (error instanceof RequestError && error.status === 401) {
			controller.current?.abort();
			setWorkspace(undefined);
			setLoginError("登录已失效，请重新登录。");
			setNotice({ message: "", success: false });
		} else setNotice({ message: error instanceof Error ? error.message : "操作失败，请重试", success: false });
	}, []);

	useEffect(() => {
		// 刷新页面时先尝试用浏览器已有的会话 Cookie 恢复工作空间；未登录则显示 Login。
		const request = new AbortController();
		controller.current = request;
		void loadWorkspace(request.signal)
			.then((result) => {
				if (!request.signal.aborted) setWorkspace(result);
			})
			.catch((error: unknown) => {
				if (!request.signal.aborted && !(error instanceof RequestError && error.status === 401))
					setLoginError(error instanceof Error ? error.message : "无法连接服务，请刷新重试");
			})
			.finally(() => {
				if (!request.signal.aborted) setLoading(false);
			});
		return () => {
			request.abort();
			controller.current?.abort();
		};
	}, []);

	const login = async (username: string, password: string) => {
		// 登录响应通过 HttpOnly Cookie 建立会话，随后重新读取服务端允许的知识库和历史。
		controller.current?.abort();
		const request = new AbortController();
		controller.current = request;
		setLoginError("");
		try {
			await api("/api/auth/login", "POST", { username, password }, request.signal);
			const result = await loadWorkspace(request.signal);
			if (!request.signal.aborted) {
				setWorkspace(result);
				notify("");
			}
		} catch (error) {
			if (!request.signal.aborted) setLoginError(error instanceof Error ? error.message : "登录失败，请重试");
		}
	};
	const logout = async () => {
		try {
			await api("/api/auth/logout", "POST", {});
			controller.current?.abort();
			setWorkspace(undefined);
			setLoginError("");
			notify("");
		} catch (error) {
			report(error);
		}
	};

	if (loading)
		return (
			<output id="loading-view" className="loading-view">
				正在连接知识库…
			</output>
		);
	if (!workspace) return <Login error={loginError} onLogin={login} />;
	return (
		<Workspace
			key={workspace.user.id}
			initial={workspace}
			notice={notice}
			notify={notify}
			onError={report}
			onLogout={logout}
		/>
	);
}

interface WorkspaceProps {
	initial: WorkspaceData;
	notice: Notice;
	notify: Notify;
	onError: ReportError;
	onLogout: () => Promise<void>;
}

function Workspace({ initial, notice, notify, onError, onLogout }: WorkspaceProps) {
	// page 只切换可见面板；组件继续挂载，因此到管理页查看文档不会丢掉问答状态。
	const [bases, setBases] = useState(initial.knowledgeBases);
	const [page, setPage] = useState<WorkspacePage>("chat");
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [source, setSource] = useState<SourceRequest>();
	const [documentRevision, setDocumentRevision] = useState(0);
	const [loggingOut, setLoggingOut] = useState(false);
	const navigate = useCallback((next: WorkspacePage) => {
		setPage(next);
		setSidebarOpen(false);
	}, []);
	const navigateChat = useCallback(() => navigate("chat"), [navigate]);
	const chat = useChat({
		bases,
		initialConversations: initial.conversations,
		notify,
		onError,
		onNavigate: navigateChat,
	});
	// 每次打开生成独立 key，旧预览卸载并清理请求，避免同一组件混入不同原文的异步结果。
	const openSource = useCallback<OpenSource>((request) => setSource({ ...request, id: crypto.randomUUID() }), []);
	const closeSource = useCallback(() => setSource(undefined), []);
	const published = useCallback(() => {
		// 原文弹窗完成复核后，通过修订号通知管理区刷新，避免让预览组件直接修改文档列表。
		setDocumentRevision((revision) => revision + 1);
		notify("复核完成，文档已可用于问答。", true);
	}, [notify]);

	return (
		<>
			<div id="app-view" className={`app-shell${sidebarOpen ? " sidebar-open" : ""}`}>
				<Sidebar
					user={initial.user}
					bases={bases}
					chat={chat}
					page={page}
					loggingOut={loggingOut}
					onNavigate={navigate}
					onLogout={() => {
						if (loggingOut) return;
						setLoggingOut(true);
						void chat
							.stop()
							.then(onLogout)
							.finally(() => setLoggingOut(false));
					}}
				/>
				<main className="workspace">
					<header className="workspace-header">
						<div className="header-heading">
							<button
								id="menu-toggle"
								className="button compact menu-toggle"
								type="button"
								aria-label={sidebarOpen ? "关闭导航" : "打开导航"}
								aria-expanded={sidebarOpen}
								aria-controls="sidebar"
								onClick={() => setSidebarOpen((open) => !open)}
							>
								菜单
							</button>
							<div>
								<p className="breadcrumb">
									工作空间 <span aria-hidden="true">/</span>{" "}
									<span id="page-section">{page === "chat" ? "知识问答" : "知识管理"}</span>
								</p>
								<h1 id="page-title">{page === "chat" ? (chat.current?.title ?? "新的问答") : "团队知识"}</h1>
							</div>
						</div>
						<span
							id="model-badge"
							className={`badge${initial.model.mode === "demo" ? " demo" : ""}`}
							title={initial.model.name}
						>
							{initial.model.mode === "demo" ? "演示模式 · 资料摘录" : initial.model.name}
						</span>
					</header>
					{notice.message && (
						<output id="notice" className={`notice${notice.success ? " success" : ""}`}>
							{notice.message}
						</output>
					)}
					<ChatPanel
						active={page === "chat"}
						bases={bases}
						model={initial.model}
						chat={chat}
						onSource={openSource}
					/>
					<ManagementPanel
						active={page === "manage"}
						bases={bases}
						revision={documentRevision}
						onBasesChange={setBases}
						onSource={openSource}
						notify={notify}
						onError={onError}
					/>
				</main>
			</div>
			{source && (
				<DocumentViewer
					key={source.id}
					source={source}
					onClose={closeSource}
					onPublished={published}
					onError={onError}
				/>
			)}
		</>
	);
}
