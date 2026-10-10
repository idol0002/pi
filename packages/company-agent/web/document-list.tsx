import type { KnowledgeBase } from "../src/types.ts";
import type { BrowserDocument } from "./types.ts";

export type DocumentAction = "open" | "review" | "update" | "retry" | "delete" | "failure";

interface DocumentListProps {
	documents: BrowserDocument[];
	base: KnowledgeBase;
	busy: boolean;
	onAction: (document: BrowserDocument, action: DocumentAction) => Promise<void>;
}

const statusLabels = {
	queued: "等待处理",
	processing: "处理中",
	needs_review: "需复核",
	ready: "可用于问答",
	failed: "处理失败",
};
const stageLabels = {
	queued: "等待处理",
	extracting: "解析正文",
	ocr: "识别扫描页",
	indexing: "建立索引",
	needs_review: "需复核",
	complete: "处理完成",
	failed: "处理失败",
};

export function DocumentList({ documents, base, busy, onAction }: DocumentListProps) {
	const pending = documents.filter(
		(document) => document.status === "queued" || document.status === "processing",
	).length;
	return (
		<section className="documents-card">
			<div className="card-heading">
				<h3>
					文档列表{" "}
					<span id="document-count" className="count-badge">
						{documents.length}
					</span>
				</h3>
				<p id="document-summary" className="muted">
					{pending > 0 ? `${pending} 份资料处理中，完成后可用于问答` : "只使用已完成处理的版本"}
				</p>
			</div>
			<div className="table-scroll">
				<table>
					<thead>
						<tr>
							<th scope="col">文档名称</th>
							<th scope="col">当前版本</th>
							<th scope="col">处理状态</th>
							<th scope="col">操作</th>
						</tr>
					</thead>
					<tbody id="document-list">
						{documents.map((document) => {
							const status =
								document.status === "processing"
									? stageLabels[document.stage] +
										(document.totalPages ? ` ${document.processedPages}/${document.totalPages} 页` : "")
									: statusLabels[document.status];
							return (
								<tr key={document.id}>
									<td>
										<div className="document-title">{document.title}</div>
										<div className="document-date">
											更新于 {new Date(document.updatedAt).toLocaleString("zh-CN", { hour12: false })}
										</div>
									</td>
									<td>{document.version ? `v${document.version}` : "—"}</td>
									<td>
										<span className={`status-tag ${document.status}`}>{status}</span>
									</td>
									<td>
										<div className="document-actions">
											{document.currentVersionId && (
												<>
													<button
														className="text-button"
														type="button"
														onClick={() => void onAction(document, "open")}
													>
														原文
													</button>
													<a
														className="text-button"
														href={`/api/documents/${encodeURIComponent(document.id)}/download?versionId=${encodeURIComponent(document.currentVersionId)}`}
													>
														下载
													</a>
												</>
											)}
											{document.status === "failed" && document.latestJobId && (
												<button
													className="text-button"
													type="button"
													disabled={busy}
													onClick={() => void onAction(document, "failure")}
												>
													失败原因
												</button>
											)}
											{base.role !== "viewer" && (
												<>
													{document.status === "needs_review" && (
														<button
															className="text-button"
															type="button"
															disabled={busy}
															onClick={() => void onAction(document, "review")}
														>
															复核
														</button>
													)}
													{document.status !== "queued" && document.status !== "processing" && (
														<button
															className="text-button"
															type="button"
															disabled={busy}
															onClick={() => void onAction(document, "update")}
														>
															更新
														</button>
													)}
													{(document.status === "failed" || document.status === "needs_review") &&
														document.latestJobId && (
															<button
																className="text-button"
																type="button"
																disabled={busy}
																onClick={() => void onAction(document, "retry")}
															>
																重试
															</button>
														)}
													<button
														className="text-button danger"
														type="button"
														disabled={busy}
														onClick={() => void onAction(document, "delete")}
													>
														删除
													</button>
												</>
											)}
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{documents.length === 0 && (
				<p id="documents-empty" className="empty-text">
					这里还没有文档。上传第一份资料后，就可以开始提问。
				</p>
			)}
		</section>
	);
}
