import { useState } from "react";

interface LoginProps {
	error: string;
	onLogin: (username: string, password: string) => Promise<void>;
}

export function Login({ error, onLogin }: LoginProps) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);

	return (
		<main id="login-view" className="login-view">
			<section className="login-story" aria-label="关于知序">
				<div className="brand">
					<span className="brand-mark" aria-hidden="true">
						知
					</span>
					<strong>知序</strong>
					<span className="brand-caption">团队知识库</span>
				</div>
				<div className="login-intro">
					<p className="eyebrow">KNOWLEDGE, CONNECTED.</p>
					<h1>
						把团队的知识，
						<br />
						变成有据可循的答案。
					</h1>
					<p>
						从分散的文档到清晰的回答。
						<br />
						找到所需信息，也找到它的出处。
					</p>
					<div className="story-note">
						<span className="note-index">01 /</span>
						<div>
							<strong>每个答案，都能回到原文</strong>
							<p>在你的知识范围内检索，让经验更容易被找到。</p>
						</div>
					</div>
				</div>
				<p className="login-footnote">为团队协作而整理，为可靠回答而连接。</p>
			</section>
			<section className="login-form-panel">
				<form
					id="login-form"
					className="login-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (busy) return;
						setBusy(true);
						void onLogin(username.trim(), password).finally(() => {
							setPassword("");
							setBusy(false);
						});
					}}
				>
					<p className="eyebrow">YOUR WORKSPACE</p>
					<h2>登录知识空间</h2>
					<p className="muted">使用你的团队账号，开始查找与提问。</p>
					<label htmlFor="username">账号</label>
					<input
						id="username"
						name="username"
						autoComplete="username"
						placeholder="请输入账号"
						maxLength={64}
						required
						disabled={busy}
						value={username}
						onChange={(event) => setUsername(event.target.value)}
					/>
					<label htmlFor="password">密码</label>
					<input
						id="password"
						name="password"
						type="password"
						autoComplete="current-password"
						placeholder="请输入密码"
						maxLength={256}
						required
						disabled={busy}
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
					{error && (
						<p id="login-error" className="form-error" role="alert">
							{error}
						</p>
					)}
					<button id="login-submit" className="button primary" type="submit" disabled={busy}>
						{busy ? "正在登录…" : "登录并进入"}
					</button>
					<p className="login-help">
						本地测试账号：alice（研发）、bob（财务）。
						<br />
						密码由本地配置提供。
					</p>
				</form>
			</section>
		</main>
	);
}
