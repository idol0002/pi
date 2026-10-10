/**
 * 管理区控制器：知识库切换、文档轮询、上传/更新/重试/删除以及用户组授权。
 * 页面数据与未提交表单分开维护，后台状态刷新不能覆盖管理员正在编辑的授权。
 */
import { useEffect, useRef, useState } from "react";
import type {
	IngestionJob,
	KnowledgeBase,
	KnowledgeGrant,
	KnowledgeRole,
	UploadReceipt,
	UserGroup,
} from "../src/types.ts";
import { api, checkedFetch } from "./client.ts";
import { type DocumentAction, DocumentList } from "./document-list.tsx";
import type { BrowserDocument, Notify, OpenSource, ReportError } from "./types.ts";
import { UploadForm } from "./upload-form.tsx";

interface ManagementProps {
	active: boolean;
	bases: KnowledgeBase[];
	revision: number;
	onBasesChange: (bases: KnowledgeBase[]) => void;
	onSource: OpenSource;
	notify: Notify;
	onError: ReportError;
}

export function ManagementPanel({ bases, ...props }: ManagementProps) {
	// 当前知识库作为子组件 key，切换时重置其草稿并触发旧请求清理。
	const [baseId, setBaseId] = useState(bases[0]?.id ?? "");
	const [refresh, setRefresh] = useState(0);
	const [busy, setBusy] = useState(false);
	const base = bases.find((item) => item.id === baseId) ?? bases[0];
	return (
		<section id="manage-panel" className="manage-panel" aria-label="知识管理" hidden={!props.active}>
			<div className="management-heading">
				<div>
					<h2>让知识保持更新</h2>
					<p className="muted">上传团队资料，管理访问范围。</p>
				</div>
				<div className="management-controls">
					<label className="sr-only" htmlFor="manage-base">
						管理知识库
					</label>
					<select
						id="manage-base"
						value={base?.id ?? ""}
						disabled={busy || bases.length === 0}
						onChange={(event) => setBaseId(event.target.value)}
					>
						{bases.map((item) => (
							<option key={item.id} value={item.id}>
								{item.name}
							</option>
						))}
					</select>
					<button
						id="refresh-documents"
						className="button"
						type="button"
						disabled={busy || !base}
						onClick={() => setRefresh((value) => value + 1)}
					>
						刷新
					</button>
				</div>
			</div>
			{base ? (
				<KnowledgeBaseContent key={base.id} {...props} base={base} refresh={refresh} onBusyChange={setBusy} />
			) : (
				<div id="manage-empty" className="empty-panel">
					你暂时没有可访问的知识库。
				</div>
			)}
		</section>
	);
}

interface ContentProps extends Omit<ManagementProps, "bases"> {
	base: KnowledgeBase;
	refresh: number;
	onBusyChange: (busy: boolean) => void;
}

function KnowledgeBaseContent({
	active,
	base,
	refresh,
	revision,
	onBusyChange,
	onBasesChange,
	onSource,
	notify,
	onError,
}: ContentProps) {
	const [documents, setDocuments] = useState<BrowserDocument[]>();
	const [documentsLoading, setDocumentsLoading] = useState(true);
	const [documentRevision, setDocumentRevision] = useState(0);
	const [groups, setGroups] = useState<UserGroup[]>();
	const [grants, setGrants] = useState<KnowledgeGrant[]>([]);
	const [grantRevision, setGrantRevision] = useState(0);
	const [grantsStatus, setGrantsStatus] = useState("");
	const [updateDocument, setUpdateDocument] = useState<BrowserDocument>();
	const [formRevision, setFormRevision] = useState(0);
	const [uploadStatus, setUploadStatus] = useState("");
	const [receipt, setReceipt] = useState<UploadReceipt>();
	const [working, setWorking] = useState<string>();
	const operation = useRef<AbortController | undefined>(undefined);

	useEffect(
		() => () => {
			// 卸载时取消当前操作；仅隐藏管理区时，下面的 active 条件负责暂停轮询。
			operation.current?.abort();
			operation.current = undefined;
			onBusyChange(false);
		},
		[onBusyChange],
	);

	// 文档有 queued/processing 状态才继续轮询；每次请求结束后再安排下一次，避免请求重叠。
	// biome-ignore lint/correctness/useExhaustiveDependencies: Refresh counters and role changes invalidate the document list after mutations and reviews.
	useEffect(() => {
		if (!active) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		setDocumentsLoading(true);
		const load = async () => {
			try {
				const result = await api<{ documents: BrowserDocument[] }>(
					`/api/knowledge-bases/${encodeURIComponent(base.id)}/documents`,
					"GET",
					undefined,
					controller.signal,
				);
				if (controller.signal.aborted) return;
				setDocuments(result.documents);
				setDocumentsLoading(false);
				if (result.documents.some((document) => document.status === "queued" || document.status === "processing"))
					timer = setTimeout(() => void load(), 1200);
			} catch (error) {
				if (!controller.signal.aborted) {
					setDocuments(undefined);
					setDocumentsLoading(false);
					onError(error);
				}
			}
		};
		void load();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [active, base.id, base.role, refresh, revision, documentRevision, onError]);

	// 授权表单单独加载：文档进度轮询不能把用户尚未保存的授权选择重置掉。
	// biome-ignore lint/correctness/useExhaustiveDependencies: Permission saves and manual refreshes must reload grants, while document polling preserves unsaved edits.
	useEffect(() => {
		if (!active || base.role !== "admin") return;
		const controller = new AbortController();
		setGroups(undefined);
		void Promise.all([
			api<{ grants: KnowledgeGrant[] }>(
				`/api/knowledge-bases/${encodeURIComponent(base.id)}/grants`,
				"GET",
				undefined,
				controller.signal,
			),
			api<{ groups: UserGroup[] }>(
				`/api/knowledge-bases/${encodeURIComponent(base.id)}/groups`,
				"GET",
				undefined,
				controller.signal,
			),
		])
			.then(([permissions, identity]) => {
				if (!controller.signal.aborted) {
					setGrants(permissions.grants);
					setGroups(identity.groups);
				}
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) onError(error);
			});
		return () => controller.abort();
	}, [active, base.id, base.role, refresh, grantRevision, onError]);

	const begin = (kind: string) => {
		// ref 即时占位，state 用于按钮/提示；旧请求不能清除后来操作的状态。
		if (operation.current) return undefined;
		const controller = new AbortController();
		operation.current = controller;
		setWorking(kind);
		onBusyChange(true);
		return controller;
	};
	const finish = (controller: AbortController) => {
		if (operation.current !== controller) return;
		operation.current = undefined;
		if (!controller.signal.aborted) {
			setWorking(undefined);
			onBusyChange(false);
		}
	};
	const startUpdate = (document?: BrowserDocument) => {
		// 修订号驱动 UploadForm 的 key，统一重置新建/更新/取消后的文件和标题。
		setUpdateDocument(document);
		setReceipt(undefined);
		setUploadStatus("");
		setFormRevision((value) => value + 1);
	};
	const documentAction = async (document: BrowserDocument, action: DocumentAction) => {
		if (action === "open" || action === "review") {
			// 正常预览用 current，复核用 latest；两者可能指向同一文档的不同版本。
			onSource({
				title: document.title,
				path: `/api/documents/${encodeURIComponent(document.id)}/source?versionId=${encodeURIComponent(action === "review" ? document.latestVersionId : (document.currentVersionId ?? ""))}`,
				meta: action === "review" ? "待复核版本 · 尚未用于问答" : `版本 ${document.version}`,
				locations: [],
			});
			return;
		}
		if (action === "update") {
			if (!operation.current) startUpdate(document);
			return;
		}
		if (action === "delete" && !window.confirm(`删除「${document.title}」？相关引用和历史回答将不再可读。`)) return;
		const controller = begin(document.id);
		if (!controller) return;
		notify("");
		try {
			if (action === "failure") {
				const result = await api<{ job: IngestionJob }>(
					`/api/ingestion-jobs/${encodeURIComponent(document.latestJobId ?? "")}`,
					"GET",
					undefined,
					controller.signal,
				);
				if (!controller.signal.aborted) notify(result.job.error ?? "处理失败，请上传修正后的版本");
			} else {
				if (action === "retry")
					await api(
						`/api/ingestion-jobs/${encodeURIComponent(document.latestJobId ?? "")}/retry`,
						"POST",
						{},
						controller.signal,
					);
				else await api(`/api/documents/${encodeURIComponent(document.id)}`, "DELETE", undefined, controller.signal);
				if (controller.signal.aborted) return;
				setDocumentRevision((value) => value + 1);
				if (action === "delete") {
					if (updateDocument?.id === document.id) startUpdate();
					notify("文档已删除", true);
				}
			}
		} catch (error) {
			if (!controller.signal.aborted) onError(error);
		} finally {
			finish(controller);
		}
	};
	const upload = async (file: File, title: string) => {
		const textFile = /\.(md|markdown|txt)$/i.test(file.name);
		if (
			!/\.(md|markdown|txt|pdf|docx|doc)$/i.test(file.name) ||
			file.size === 0 ||
			file.size > (textFile ? 1 : 20) * 1024 * 1024
		) {
			onError(new Error("请选择有效的 PDF / Word（最大 20 MiB）或 Markdown / TXT（最大 1 MiB）文件"));
			return;
		}
		const controller = begin("upload");
		if (!controller) return;
		setUploadStatus("正在上传…");
		setReceipt(undefined);
		const form = new FormData();
		form.set("file", file);
		if (title) form.set("title", title);
		try {
			const path = updateDocument
				? `/api/documents/${encodeURIComponent(updateDocument.id)}/versions`
				: `/api/knowledge-bases/${encodeURIComponent(base.id)}/documents`;
			const response = await checkedFetch(path, { method: "POST", body: form, signal: controller.signal });
			const uploaded = (await response.json()) as UploadReceipt;
			if (controller.signal.aborted) return;
			startUpdate();
			// 202 回执只说明接受上传；之后靠文档轮询判断 ready、needs_review 或 failed。
			setReceipt(uploaded);
			setUploadStatus("上传成功，正在处理。文档列表将自动更新。");
			setDocumentRevision((value) => value + 1);
		} catch (error) {
			if (!controller.signal.aborted) {
				setUploadStatus(error instanceof Error ? error.message : "上传失败");
				onError(error);
			}
		} finally {
			finish(controller);
		}
	};
	const saveGrants = async () => {
		// 保存后重新取得自己的知识库列表，因为本次修改也可能降低/撤销自己的访问范围。
		if (!groups) return;
		const controller = begin("grants");
		if (!controller) return;
		setGrantsStatus("");
		try {
			await api(`/api/knowledge-bases/${encodeURIComponent(base.id)}/grants`, "PUT", { grants }, controller.signal);
			const result = await api<{ knowledgeBases: KnowledgeBase[] }>(
				"/api/knowledge-bases",
				"GET",
				undefined,
				controller.signal,
			);
			if (controller.signal.aborted) return;
			onBasesChange(result.knowledgeBases);
			setGrantRevision((value) => value + 1);
			setDocumentRevision((value) => value + 1);
			setGrantsStatus("权限已保存，后续访问立即生效。");
		} catch (error) {
			if (!controller.signal.aborted) onError(error);
		} finally {
			finish(controller);
		}
	};

	const uploaded =
		receipt &&
		documents?.find(
			(document) => document.id === receipt.documentId && document.latestVersionId === receipt.versionId,
		);
	const status =
		uploaded?.status === "ready"
			? "处理完成，文档已可用于问答。"
			: uploaded?.status === "needs_review"
				? "识别完成，请在文档列表点击「复核」，确认后用于问答。"
				: uploaded?.status === "failed"
					? "文档处理失败，可在列表查看原因或重试。"
					: uploadStatus;
	return (
		<div id="management-content">
			{documents && base.role !== "viewer" && (
				<UploadForm
					key={formRevision}
					document={updateDocument}
					status={status}
					busy={Boolean(working)}
					onCancel={() => startUpdate()}
					onUpload={upload}
				/>
			)}
			{documents ? (
				<DocumentList
					documents={documents}
					base={base}
					busy={Boolean(working) || documentsLoading}
					onAction={documentAction}
				/>
			) : (
				<output className="empty-text">{documentsLoading ? "正在读取文档…" : "文档读取失败，请刷新重试。"}</output>
			)}
			{base.role === "admin" && groups && documents && (
				<form
					id="grants-form"
					className="grants-card"
					onSubmit={(event) => {
						event.preventDefault();
						void saveGrants();
					}}
				>
					<div className="card-heading">
						<div>
							<h3>访问权限</h3>
							<p className="muted">按用户组设置访问范围，至少保留一个管理组。</p>
						</div>
						<button id="save-grants" className="button" type="submit" disabled={Boolean(working)}>
							保存权限
						</button>
					</div>
					<div id="grant-list" className="grant-list">
						{groups.map((group) => (
							<div className="grant-row" key={group.id}>
								<label htmlFor={`grant-${group.id}`}>{group.name}</label>
								<select
									id={`grant-${group.id}`}
									value={grants.find((grant) => grant.groupId === group.id)?.role ?? ""}
									disabled={Boolean(working)}
									onChange={(event) => {
										const role = event.target.value;
										setGrants((previous) => [
											...previous.filter((grant) => grant.groupId !== group.id),
											...(["viewer", "editor", "admin"].includes(role)
												? [{ groupId: group.id, role: role as KnowledgeRole }]
												: []),
										]);
									}}
								>
									<option value="">无访问权限</option>
									<option value="viewer">阅读</option>
									<option value="editor">维护（含上传）</option>
									<option value="admin">管理（含授权）</option>
								</select>
							</div>
						))}
					</div>
					<output id="grants-status" className="form-hint">
						{grantsStatus}
					</output>
				</form>
			)}
		</div>
	);
}
