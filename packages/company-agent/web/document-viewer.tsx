import {
	GlobalWorkerOptions,
	getDocument,
	type PDFDocumentLoadingTask,
	type PDFDocumentProxy,
	type RenderTask,
} from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import type { DocumentPreview } from "../src/types.ts";
import { api, checkedFetch, RequestError, sourcePath } from "./client.ts";
import type { ReportError, SourceRequest } from "./types.ts";

GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.mjs";

interface ViewerProps {
	source: SourceRequest;
	onClose: () => void;
	onPublished: () => void;
	onError: ReportError;
}

interface LoadedPreview {
	documentId: string;
	path: string;
	startLine: number;
	endLine: number;
	data: DocumentPreview;
}

export function DocumentViewer({ source, onClose, onPublished, onError }: ViewerProps) {
	const dialog = useRef<HTMLDialogElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const rendering = useRef<RenderTask | undefined>(undefined);
	const reviewRequest = useRef<AbortController | undefined>(undefined);
	const [loaded, setLoaded] = useState<LoadedPreview>();
	const [pdf, setPdf] = useState<PDFDocumentProxy>();
	const [page, setPage] = useState(source.locations.find((location) => location.page !== null)?.page ?? 1);
	const [pdfLoading, setPdfLoading] = useState(false);
	const [pageLoading, setPageLoading] = useState(false);
	const [canvasReady, setCanvasReady] = useState(false);
	const [error, setError] = useState("");
	const [changes, setChanges] = useState(() => new Map<string, string>());
	const [confirmed, setConfirmed] = useState(false);
	const [publishing, setPublishing] = useState(false);

	useEffect(() => {
		const element = dialog.current;
		if (element && !element.open) element.showModal();
		return () => element?.close();
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		let loading: PDFDocumentLoadingTask | undefined;
		void (async () => {
			try {
				const path = sourcePath(source.path);
				const url = new URL(path, location.origin);
				const match = /^\/api\/documents\/([^/]+)\/source$/.exec(url.pathname);
				if (!match) throw new Error("原文地址无效");
				const documentId = match[1];
				const versionId = url.searchParams.get("versionId");
				const query = new URLSearchParams(versionId ? { versionId } : {});
				const data = await api<DocumentPreview>(
					`/api/documents/${documentId}/preview?${query}`,
					"GET",
					undefined,
					controller.signal,
				);
				if (controller.signal.aborted) return;
				setLoaded({
					data,
					documentId,
					path,
					startLine: Number(url.searchParams.get("startLine")),
					endLine: Number(url.searchParams.get("endLine")),
				});
				if (!data.pdfUrl) return;
				const pdfUrl = new URL(data.pdfUrl, location.origin);
				if (
					pdfUrl.origin !== location.origin ||
					pdfUrl.pathname !== `/api/documents/${documentId}/pdf` ||
					pdfUrl.searchParams.get("versionId") !== data.versionId
				)
					throw new Error("PDF 地址无效");
				setPdfLoading(true);
				const response = await checkedFetch(`${pdfUrl.pathname}${pdfUrl.search}`, { signal: controller.signal });
				const bytes = await response.arrayBuffer();
				if (controller.signal.aborted) return;
				loading = getDocument({
					data: new Uint8Array(bytes),
					cMapUrl: "/assets/pdfjs/cmaps/",
					cMapPacked: true,
					standardFontDataUrl: "/assets/pdfjs/standard_fonts/",
					wasmUrl: "/assets/pdfjs/wasm/",
					stopAtErrors: true,
					maxImageSize: 40_000_000,
					enableXfa: false,
				});
				const document = await loading.promise;
				if (!controller.signal.aborted) setPdf(document);
			} catch (failure) {
				if (!controller.signal.aborted) {
					setError(failure instanceof Error ? failure.message : "原文读取失败");
					if (failure instanceof RequestError && failure.status === 401) onError(failure);
				}
			} finally {
				if (!controller.signal.aborted) setPdfLoading(false);
			}
		})();
		return () => {
			controller.abort();
			reviewRequest.current?.abort();
			if (loading) void loading.destroy().catch(() => {});
		};
	}, [source.path, onError]);

	const preview = loaded?.data;
	const pageCount =
		pdf?.numPages ??
		(preview?.pdfUrl
			? Math.max(1, preview.pages.length)
			: Math.max(1, Math.ceil((preview?.blocks.length ?? 0) / 25)));
	const currentPage = Math.max(1, Math.min(pageCount, page));

	useEffect(() => {
		if (!pdf) return;
		let cancelled = false;
		let task: RenderTask | undefined;
		setPageLoading(true);
		setCanvasReady(false);
		const previous = rendering.current;
		previous?.cancel();
		void (async () => {
			try {
				await previous?.promise.catch(() => {});
				if (cancelled) return;
				const documentPage = await pdf.getPage(currentPage);
				if (cancelled || !canvas.current || !stage.current) return;
				const target = canvas.current;
				const base = documentPage.getViewport({ scale: 1 });
				const available = Math.max(280, stage.current.clientWidth - 32);
				const scale = Math.min(
					(available * Math.min(devicePixelRatio, 2)) / base.width,
					Math.sqrt(8_000_000 / (base.width * base.height)),
				);
				const viewport = documentPage.getViewport({ scale });
				target.width = Math.ceil(viewport.width);
				target.height = Math.ceil(viewport.height);
				task = documentPage.render({ canvas: target, viewport });
				rendering.current = task;
				await task.promise;
				if (cancelled) return;
				const context = target.getContext("2d");
				if (context) {
					context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
					context.globalAlpha = 0.18;
					for (const location of source.locations) {
						if (location.page !== currentPage || !location.box) continue;
						const [left, top, right, bottom] = location.box;
						context.fillRect(
							left * target.width,
							top * target.height,
							(right - left) * target.width,
							(bottom - top) * target.height,
						);
					}
					context.globalAlpha = 1;
				}
				setCanvasReady(true);
			} catch (failure) {
				if (!cancelled && !(failure instanceof Error && failure.name === "RenderingCancelledException"))
					setError(failure instanceof Error ? failure.message : "原文预览失败");
			} finally {
				if (!cancelled) setPageLoading(false);
			}
		})();
		return () => {
			cancelled = true;
			task?.cancel();
		};
	}, [pdf, currentPage, source.locations]);

	const blocks = preview
		? preview.pdfUrl
			? preview.blocks.filter((block) => block.location.page === currentPage)
			: preview.blocks.slice((currentPage - 1) * 25, currentPage * 25)
		: [];
	let text = loaded ? loaded.data.text : error ? "" : "正在读取原文…";
	if (preview?.pdfUrl || preview?.status === "needs_review")
		text =
			blocks.map((block) => changes.get(block.id) ?? block.text).join("\n\n") ||
			"本页没有已识别的正文，请核对原件。";
	else if (loaded && loaded.startLine > 0 && loaded.endLine >= loaded.startLine)
		text = loaded.data.text
			.split("\n")
			.slice(loaded.startLine - 1, loaded.endLine)
			.join("\n");
	const download = Boolean(preview?.pdfUrl || preview?.mediaType.includes("word"));
	const publish = async () => {
		if (!loaded || !confirmed || loaded.data.blocks.length === 0 || reviewRequest.current) return;
		const controller = new AbortController();
		reviewRequest.current = controller;
		setPublishing(true);
		setError("");
		try {
			await api(
				`/api/documents/${loaded.documentId}/review`,
				"POST",
				{
					versionId: loaded.data.versionId,
					changes: [...changes].map(([blockId, value]) => ({ blockId, text: value })),
					confirmed: true,
				},
				controller.signal,
			);
			if (controller.signal.aborted) return;
			onPublished();
			onClose();
		} catch (failure) {
			if (!controller.signal.aborted) {
				setError(failure instanceof Error ? failure.message : "正文复核失败");
				if (failure instanceof RequestError && failure.status === 401) onError(failure);
			}
		} finally {
			if (!controller.signal.aborted) {
				reviewRequest.current = undefined;
				setPublishing(false);
			}
		}
	};

	return (
		<dialog
			id="source-dialog"
			className={`source-dialog${preview?.pdfUrl ? " with-pdf" : ""}`}
			aria-labelledby="source-title"
			ref={dialog}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
		>
			<div className="dialog-heading">
				<div>
					<p className="eyebrow">SOURCE DOCUMENT</p>
					<h2 id="source-title">{source.title}</h2>
					<p id="source-meta" className="muted">
						{source.meta}
					</p>
				</div>
				<button id="close-source" className="button compact" type="button" aria-label="关闭原文" onClick={onClose}>
					关闭
				</button>
			</div>
			{(preview?.pdfUrl || preview?.status === "needs_review") && (
				<div id="source-toolbar" className="source-toolbar">
					<button
						id="source-previous"
						className="button compact"
						type="button"
						disabled={currentPage === 1 || pageLoading || pdfLoading || publishing}
						onClick={() => setPage(currentPage - 1)}
					>
						上一页
					</button>
					<output id="source-page-status">
						{pageLoading || pdfLoading
							? `正在显示第 ${currentPage} / ${pageCount} 页…`
							: `第 ${currentPage} / ${pageCount} ${preview?.pdfUrl ? "页" : "组正文"}`}
					</output>
					<button
						id="source-next"
						className="button compact"
						type="button"
						disabled={currentPage === pageCount || pageLoading || pdfLoading || publishing}
						onClick={() => setPage(currentPage + 1)}
					>
						下一页
					</button>
				</div>
			)}
			{preview && preview.warnings.length > 0 && (
				<output id="source-warnings" className="source-warnings">
					{preview.warnings.map((warning) => (
						<span key={`${warning.page}-${warning.code}-${warning.message}`}>
							{warning.page ? `第 ${warning.page} 页：` : ""}
							{warning.message}
							<br />
						</span>
					))}
				</output>
			)}
			<div className="source-layout">
				{preview?.pdfUrl && (
					<div id="source-pdf-stage" className="source-pdf-stage" ref={stage}>
						<canvas
							id="source-pdf"
							role="img"
							aria-label={`原文第 ${currentPage} 页`}
							ref={canvas}
							hidden={!canvasReady}
						/>
					</div>
				)}
				<pre id="source-content" className="source-content">
					{text}
				</pre>
			</div>
			{preview?.status === "needs_review" && (
				<section id="source-review" className="source-review">
					<h3>核对识别正文</h3>
					<p className="muted">请对照原件逐页核对，尤其是数字、名称和表格。可修正当前页的文字；翻页会保留修改。</p>
					<div id="source-review-blocks" className="source-review-blocks">
						{blocks.map((block) => {
							const value = changes.get(block.id) ?? block.text;
							return (
								<div key={block.id} className="source-review-block">
									<label htmlFor={`review-${block.id}`}>
										{block.location.label}
										{block.location.method === "ocr" ? " · 识别文字" : ""}
									</label>
									<textarea
										id={`review-${block.id}`}
										value={value}
										rows={Math.min(8, Math.max(2, value.split("\n").length))}
										maxLength={65_536}
										disabled={publishing}
										onChange={(event) => {
											setChanges((previous) => new Map(previous).set(block.id, event.target.value));
											setConfirmed(false);
										}}
									/>
								</div>
							);
						})}
					</div>
					<label className="review-confirm">
						<input
							id="source-confirm"
							type="checkbox"
							checked={confirmed}
							disabled={publishing}
							onChange={(event) => setConfirmed(event.target.checked)}
						/>
						我已核对全部原件与正文，确认可以用于问答
					</label>
					<button
						id="source-publish"
						className="button primary"
						type="button"
						disabled={!confirmed || preview.blocks.length === 0 || publishing}
						onClick={() => void publish()}
					>
						{publishing ? "正在入库…" : "确认并入库"}
					</button>
				</section>
			)}
			{error && (
				<output id="source-review-status" className="form-error">
					{error}
				</output>
			)}
			<div className="dialog-footer">
				<p className="muted">原文读取时再次检查当前权限</p>
				{loaded && (
					<a
						id="source-link"
						className="button"
						href={
							download
								? `/api/documents/${loaded.documentId}/download?versionId=${encodeURIComponent(loaded.data.versionId)}`
								: loaded.path
						}
						target="_blank"
						rel="noopener noreferrer"
					>
						{download ? "下载原件" : "打开原文"}
					</a>
				)}
			</div>
		</dialog>
	);
}
