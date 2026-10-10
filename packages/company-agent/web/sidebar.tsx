/**
 * 侧栏展示用户、知识范围和历史，并把操作交给父组件/useChat。
 * 禁用控件是交互提示；会话所有权和知识库权限仍由服务端检查。
 */
import type { KnowledgeBase, User } from "../src/types.ts";
import type { WorkspacePage } from "./types.ts";
import type { ChatController } from "./use-chat.ts";

interface SidebarProps {
	user: User;
	bases: KnowledgeBase[];
	chat: ChatController;
	page: WorkspacePage;
	loggingOut: boolean;
	onNavigate: (page: WorkspacePage) => void;
	onLogout: () => void;
}

export function Sidebar({ user, bases, chat, page, loggingOut, onNavigate, onLogout }: SidebarProps) {
	return (
		<aside className="sidebar" id="sidebar" aria-label="知识空间导航">
			<a className="brand" href="/">
				<span className="brand-mark" aria-hidden="true">
					知
				</span>
				<strong>知序</strong>
				<span className="brand-caption">工作空间</span>
			</a>
			<button
				id="new-chat"
				className="button primary new-chat"
				type="button"
				disabled={chat.busy}
				onClick={chat.newConversation}
			>
				<span aria-hidden="true">＋</span> 新建问答
			</button>
			<nav className="nav-list" aria-label="主要功能">
				<button
					id="nav-chat"
					className={`nav-item${page === "chat" ? " active" : ""}`}
					type="button"
					aria-current={page === "chat" ? "page" : undefined}
					onClick={() => onNavigate("chat")}
				>
					<span className="nav-symbol" aria-hidden="true">
						↗
					</span>
					知识问答
				</button>
				<button
					id="nav-manage"
					className={`nav-item${page === "manage" ? " active" : ""}`}
					type="button"
					aria-current={page === "manage" ? "page" : undefined}
					onClick={() => onNavigate("manage")}
				>
					<span className="nav-symbol" aria-hidden="true">
						▤
					</span>
					知识管理
				</button>
			</nav>
			<div className="sidebar-section scope-section">
				<p className="section-label">问答知识范围</p>
				<div id="scope-list" className="scope-list">
					{bases.map((base) => (
						<label key={base.id} className="scope-option">
							<input
								type="checkbox"
								value={base.id}
								checked={chat.selected.includes(base.id)}
								disabled={Boolean(chat.current || chat.busy)}
								onChange={(event) => chat.selectBase(base.id, event.target.checked)}
							/>
							<span>{base.name}</span>
						</label>
					))}
					{bases.length === 0 && <p className="history-empty">暂无可用知识库</p>}
				</div>
				<p id="scope-hint" className="sidebar-hint">
					{chat.current ? "如需切换知识范围，请新建问答" : "选择本次问答使用的知识库"}
				</p>
			</div>
			<div className="sidebar-section history-section">
				<p className="section-label">最近问答</p>
				<div id="conversation-list" className="conversation-list">
					{chat.conversations.map((conversation) => (
						<button
							key={conversation.id}
							className={`history-item${conversation.id === chat.current?.id ? " active" : ""}`}
							type="button"
							title={conversation.title}
							disabled={chat.busy}
							onClick={() => void chat.loadConversation(conversation.id)}
						>
							{conversation.title}
						</button>
					))}
					{chat.conversations.length === 0 && <p className="history-empty">你的问答记录会保存在这里</p>}
				</div>
			</div>
			<div className="sidebar-user">
				<span id="user-avatar" className="user-avatar" aria-hidden="true">
					{user.username.slice(0, 1)}
				</span>
				<div>
					<strong id="user-name">{user.displayName}</strong>
					<span id="user-account" className="muted">
						{user.username}
					</span>
				</div>
				<button id="logout" className="text-button" type="button" disabled={loggingOut} onClick={onLogout}>
					退出
				</button>
			</div>
		</aside>
	);
}
