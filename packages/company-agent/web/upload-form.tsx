import { useEffect, useRef, useState } from "react";
import type { BrowserDocument } from "./types.ts";

interface UploadFormProps {
	document?: BrowserDocument;
	status: string;
	busy: boolean;
	onCancel: () => void;
	onUpload: (file: File, title: string) => Promise<void>;
}

export function UploadForm({ document, status, busy, onCancel, onUpload }: UploadFormProps) {
	const [file, setFile] = useState<File>();
	const [title, setTitle] = useState("");
	const form = useRef<HTMLFormElement>(null);
	useEffect(() => {
		if (document) form.current?.scrollIntoView({ block: "nearest" });
	}, [document]);
	return (
		<form
			id="upload-form"
			className="upload-card"
			ref={form}
			onSubmit={(event) => {
				event.preventDefault();
				if (file && !busy) void onUpload(file, title.trim());
			}}
		>
			<div>
				<h3 id="upload-heading">{document ? `更新：${document.title}` : "添加知识文档"}</h3>
				<p className="muted">
					支持 PDF、Word、Markdown、TXT。PDF / Word 最大 20 MiB，文本最大 1
					MiB。扫描件会在后台识别，存在识别问题时需复核后入库。
				</p>
			</div>
			<div className="upload-fields">
				<label className="file-picker" htmlFor="upload-file">
					<span aria-hidden="true">＋</span>
					<span id="file-label">{file?.name ?? "选择一份文档"}</span>
					<input
						id="upload-file"
						name="file"
						type="file"
						accept=".md,.markdown,.txt,.pdf,.docx,.doc"
						required
						disabled={busy}
						onChange={(event) => setFile(event.target.files?.[0])}
					/>
				</label>
				<div className="upload-title">
					<label className="sr-only" htmlFor="upload-title">
						文档标题（可选）
					</label>
					<input
						id="upload-title"
						name="title"
						placeholder="文档标题（可选）"
						maxLength={200}
						value={title}
						disabled={busy}
						onChange={(event) => setTitle(event.target.value)}
					/>
				</div>
				{document && (
					<button id="cancel-update" className="button" type="button" disabled={busy} onClick={onCancel}>
						取消更新
					</button>
				)}
				<button id="upload-submit" className="button primary" type="submit" disabled={busy}>
					{document ? "上传新版本" : "上传并入库"}
				</button>
			</div>
			<output id="upload-status" className="form-hint">
				{status}
			</output>
		</form>
	);
}
