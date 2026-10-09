import { readdir, readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

export interface WebAsset {
	content: string | Uint8Array;
	contentType: string;
}

/** Explicit asset names only: no request path is ever used as a filesystem path. */
export async function loadWebAssets(): Promise<Map<string, WebAsset>> {
	const assets = new Map<string, WebAsset>();
	const files = [
		["/", "index.html", "text/html; charset=utf-8"],
		["/assets/styles.css", "styles.css", "text/css; charset=utf-8"],
		...["app", "client", "stream", "document-viewer"].map((name) => [
			`/assets/${name}.ts`,
			`${name}.ts`,
			"text/javascript; charset=utf-8",
		]),
	];
	await Promise.all(
		files.map(async ([path, filename, contentType]) => {
			const source = await readFile(new URL(`../web/${filename}`, import.meta.url), "utf8");
			assets.set(path, {
				content: filename.endsWith(".ts")
					? stripTypeScriptTypes(source).replace('from "pdfjs-dist"', 'from "/assets/pdf.mjs"')
					: source,
				contentType,
			});
		}),
	);
	const pdfRoot = new URL("../", import.meta.resolve("pdfjs-dist"));
	for (const name of ["pdf.mjs", "pdf.worker.mjs"]) {
		assets.set(`/assets/${name}`, {
			content: await readFile(new URL(`build/${name}`, pdfRoot), "utf8"),
			contentType: "text/javascript; charset=utf-8",
		});
	}
	for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
		const base = new URL(`${directory}/`, pdfRoot);
		for (const entry of await readdir(base, { withFileTypes: true })) {
			if (!entry.isFile() || !/\.(bcmap|pfb|ttf|wasm|js)$/.test(entry.name)) continue;
			assets.set(`/assets/pdfjs/${directory}/${entry.name}`, {
				content: await readFile(new URL(entry.name, base)),
				contentType: entry.name.endsWith(".wasm")
					? "application/wasm"
					: entry.name.endsWith(".js")
						? "text/javascript"
						: "application/octet-stream",
			});
		}
	}
	return assets;
}
