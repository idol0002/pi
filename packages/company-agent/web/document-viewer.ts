import {
	GlobalWorkerOptions,
	getDocument,
	type PDFDocumentLoadingTask,
	type PDFDocumentProxy,
	type RenderTask,
} from "pdfjs-dist";
import type { DocumentPreview, SourceLocation } from "../src/types.ts";
import { api, checkedFetch, sourcePath } from "./client.ts";

GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.mjs";
function element<T extends HTMLElement = HTMLElement>(id: string): T {
	const value = document.getElementById(id);
	if (!value) throw new Error(`缺少预览元素：${id}`);
	return value as T;
}
let epoch = 0;
let renderEpoch = 0;
let controller: AbortController | undefined;
let loading: PDFDocumentLoadingTask | undefined;
let pdf: PDFDocumentProxy | undefined;
let rendering: RenderTask | undefined;
let preview: DocumentPreview | undefined;
let documentId = "";
let pageNumber = 1;
let selected: SourceLocation[] = [];
let afterPublished: (() => Promise<void>) | undefined;
const changes = new Map<string, string>();

export function locationLabel(locations: SourceLocation[] | undefined, start: number, end: number): string {
	const pages = [...new Set((locations ?? []).flatMap((location) => (location.page === null ? [] : [location.page])))];
	if (pages.length > 0) return `第 ${pages.join("、")} 页`;
	return locations?.[0]?.label ?? `第 ${start}–${end} 行`;
}

export function resetDocumentViewer(): void {
	epoch++;
	renderEpoch++;
	controller?.abort();
	controller = undefined;
	rendering?.cancel();
	rendering = undefined;
	if (loading) void loading.destroy().catch(() => {});
	loading = undefined;
	pdf = undefined;
	preview = undefined;
	afterPublished = undefined;
	changes.clear();
	selected = [];
	element("source-review-blocks").replaceChildren();
	element("source-warnings").replaceChildren();
	element("source-review-status").textContent = "";
	element("source-content").textContent = "";
	element("source-toolbar").hidden = true;
	element("source-pdf-stage").hidden = true;
	element("source-review").hidden = true;
	element("source-dialog").classList.remove("with-pdf");
	const canvas = element<HTMLCanvasElement>("source-pdf");
	canvas.width = 1;
	canvas.height = 1;
	element<HTMLInputElement>("source-confirm").checked = false;
	element<HTMLButtonElement>("source-publish").disabled = true;
}

export async function showDocumentViewer(
	title: string,
	path: string,
	meta: string,
	locations: SourceLocation[] = [],
	onPublished?: () => Promise<void>,
): Promise<void> {
	const safePath = sourcePath(path);
	const url = new URL(safePath, location.origin);
	const match = /^\/api\/documents\/([^/]+)\/source$/.exec(url.pathname);
	if (!match) throw new Error("原文地址无效");
	resetDocumentViewer();
	const version = epoch;
	documentId = match[1];
	selected = locations;
	afterPublished = onPublished;
	controller = new AbortController();
	const signal = controller.signal;
	const dialog = element<HTMLDialogElement>("source-dialog");
	element("source-title").textContent = title;
	element("source-meta").textContent = meta;
	element("source-content").textContent = "正在读取原文…";
	element("source-link").hidden = true;
	if (!dialog.open) dialog.showModal();
	const response = await checkedFetch(
		"/api/documents/" +
			documentId +
			"/preview?" +
			new URLSearchParams({
				...(url.searchParams.get("versionId") ? { versionId: url.searchParams.get("versionId") ?? "" } : {}),
			}),
		{ signal },
	);
	const result = (await response.json()) as DocumentPreview;
	if (version !== epoch) return;
	preview = result;
	pageNumber = locations.find((item) => item.page !== null)?.page ?? 1;
	const link = element<HTMLAnchorElement>("source-link");
	link.href =
		result.pdfUrl || result.mediaType.includes("word")
			? `/api/documents/${documentId}/download?versionId=${encodeURIComponent(result.versionId)}`
			: safePath;
	link.textContent = result.pdfUrl || result.mediaType.includes("word") ? "下载原件" : "打开原文";
	link.hidden = false;
	const warnings = element("source-warnings");
	for (const warning of result.warnings) {
		const paragraph = document.createElement("p");
		paragraph.textContent = (warning.page ? `第 ${warning.page} 页：` : "") + warning.message;
		warnings.append(paragraph);
	}
	warnings.hidden = result.warnings.length === 0;
	element("source-review").hidden = result.status !== "needs_review";
	if (result.pdfUrl) {
		if (!/^\/api\/documents\/[^/]+\/pdf\?versionId=/.test(result.pdfUrl)) throw new Error("PDF 地址无效");
		element("source-pdf-stage").hidden = false;
		dialog.classList.add("with-pdf");
		const file = await checkedFetch(result.pdfUrl, { signal });
		const bytes = await file.arrayBuffer();
		if (version !== epoch) return;
		const task = getDocument({
			data: new Uint8Array(bytes),
			cMapUrl: "/assets/pdfjs/cmaps/",
			cMapPacked: true,
			standardFontDataUrl: "/assets/pdfjs/standard_fonts/",
			wasmUrl: "/assets/pdfjs/wasm/",
			stopAtErrors: true,
			maxImageSize: 40_000_000,
			enableXfa: false,
		});
		loading = task;
		const document = await task.promise;
		if (version !== epoch) return;
		pdf = document;
		await renderPage();
	} else {
		const start = Number(url.searchParams.get("startLine"));
		const end = Number(url.searchParams.get("endLine"));
		element("source-content").textContent =
			start > 0 && end >= start
				? result.text
						.split("\n")
						.slice(start - 1, end)
						.join("\n")
				: result.text;
		if (result.status === "needs_review") await renderPage();
	}
}

async function renderPage(): Promise<void> {
	if (!preview) return;
	const version = epoch;
	const renderVersion = ++renderEpoch;
	const current = preview;
	const count = pdf?.numPages ?? Math.max(1, Math.ceil(current.blocks.length / 25));
	pageNumber = Math.max(1, Math.min(count, pageNumber));
	element("source-toolbar").hidden = !pdf && current.status !== "needs_review";
	element<HTMLButtonElement>("source-previous").disabled = pageNumber === 1;
	element<HTMLButtonElement>("source-next").disabled = pageNumber === count;
	element("source-page-status").textContent = pdf
		? `第 ${pageNumber} / ${count} 页`
		: `第 ${pageNumber} / ${count} 组正文`;
	const blocks = pdf
		? current.blocks.filter((block) => block.location.page === pageNumber)
		: current.blocks.slice((pageNumber - 1) * 25, pageNumber * 25);
	if (pdf) {
		element("source-page-status").textContent = `正在显示第 ${pageNumber} / ${count} 页…`;
		element<HTMLButtonElement>("source-previous").disabled = true;
		element<HTMLButtonElement>("source-next").disabled = true;
		element("source-pdf").hidden = true;
		element("source-content").textContent =
			blocks.map((block) => changes.get(block.id) ?? block.text).join("\n\n") ||
			"本页没有已识别的正文，请核对原件。";
		if (rendering) {
			rendering.cancel();
			await rendering.promise.catch(() => {});
		}
		if (version !== epoch || renderVersion !== renderEpoch || !pdf) return;
		const page = await pdf.getPage(pageNumber);
		if (version !== epoch || renderVersion !== renderEpoch) return;
		const canvas = element<HTMLCanvasElement>("source-pdf");
		const base = page.getViewport({ scale: 1 });
		const available = Math.max(280, element("source-pdf-stage").clientWidth - 32);
		const scale = Math.min(
			(available * Math.min(devicePixelRatio, 2)) / base.width,
			Math.sqrt(8_000_000 / (base.width * base.height)),
		);
		const viewport = page.getViewport({ scale });
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		canvas.setAttribute("aria-label", `原文第 ${pageNumber} 页`);
		rendering = page.render({ canvas, viewport });
		await rendering.promise;
		if (version !== epoch || renderVersion !== renderEpoch) return;
		const context = canvas.getContext("2d");
		if (context) {
			context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
			context.globalAlpha = 0.18;
			for (const location of selected) {
				if (location.page !== pageNumber || !location.box) continue;
				const [left, top, right, bottom] = location.box;
				context.fillRect(
					left * canvas.width,
					top * canvas.height,
					(right - left) * canvas.width,
					(bottom - top) * canvas.height,
				);
			}
			context.globalAlpha = 1;
		}
		canvas.hidden = false;
		element("source-page-status").textContent = `第 ${pageNumber} / ${count} 页`;
		element<HTMLButtonElement>("source-previous").disabled = pageNumber === 1;
		element<HTMLButtonElement>("source-next").disabled = pageNumber === count;
	}
	if (current.status === "needs_review") {
		const list = element("source-review-blocks");
		list.replaceChildren();
		for (const block of blocks) {
			const label = document.createElement("label");
			label.textContent = block.location.label + (block.location.method === "ocr" ? " · 识别文字" : "");
			const input = document.createElement("textarea");
			input.id = `review-${block.id}`;
			input.value = changes.get(block.id) ?? block.text;
			input.rows = Math.min(8, Math.max(2, input.value.split("\n").length));
			input.maxLength = 65_536;
			label.htmlFor = input.id;
			input.addEventListener("input", () => {
				changes.set(block.id, input.value);
				element<HTMLInputElement>("source-confirm").checked = false;
				element<HTMLButtonElement>("source-publish").disabled = true;
			});
			list.append(label, input);
		}
	}
}

element("source-previous").addEventListener("click", () => {
	pageNumber--;
	void renderPage().catch(showError);
});
element("source-next").addEventListener("click", () => {
	pageNumber++;
	void renderPage().catch(showError);
});
function showError(error: unknown): void {
	if (!preview || (error instanceof Error && error.name === "RenderingCancelledException")) return;
	element("source-review-status").textContent = error instanceof Error ? error.message : "原文预览失败";
}
element("source-confirm").addEventListener("change", () => {
	element<HTMLButtonElement>("source-publish").disabled =
		!element<HTMLInputElement>("source-confirm").checked || !preview?.blocks.length;
});
element("source-publish").addEventListener("click", () => {
	if (!preview || !element<HTMLInputElement>("source-confirm").checked) return;
	const version = epoch;
	const versionId = preview.versionId;
	const callback = afterPublished;
	element<HTMLButtonElement>("source-publish").disabled = true;
	void api(`/api/documents/${documentId}/review`, "POST", {
		versionId,
		changes: [...changes].map(([blockId, text]) => ({ blockId, text })),
		confirmed: true,
	})
		.then(async () => {
			if (version !== epoch) return;
			element<HTMLDialogElement>("source-dialog").close();
			await callback?.();
		})
		.catch((error: unknown) => {
			if (version !== epoch) return;
			showError(error);
			element<HTMLButtonElement>("source-publish").disabled = false;
		});
});
element("source-dialog").addEventListener("close", resetDocumentViewer);
