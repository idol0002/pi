import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, seedDemo } from "./database.ts";
import { DocumentService } from "./documents.ts";
import { createEmbeddingModel } from "./embeddings.ts";
import { IngestionWorker } from "./ingestion.ts";
import { RetrievalService } from "./retrieval.ts";
import { planSearch } from "./search-query.ts";
import type { SearchHit } from "./types.ts";
import { VectorIndex } from "./vector-index.ts";

interface Dataset {
	label: string;
	documents: { key: string; base: "engineering" | "finance"; title: string; text: string }[];
	questions: {
		key: string;
		user: "alice" | "bob";
		query: string;
		expected: string[];
		excerpt?: string;
		previousQuestion?: string;
	}[];
}
interface Score {
	correct: boolean;
	recall: number;
	reciprocalRank: number;
	sourceKeys: string[];
}

function validate(value: unknown): Dataset {
	if (
		!value ||
		typeof value !== "object" ||
		!("label" in value) ||
		typeof value.label !== "string" ||
		!("documents" in value) ||
		!Array.isArray(value.documents) ||
		value.documents.length > 200 ||
		!("questions" in value) ||
		!Array.isArray(value.questions) ||
		value.questions.length > 1000
	)
		throw new Error("评测文件结构无效");
	const dataset = value as Dataset;
	const keys = new Set<string>();
	for (const document of dataset.documents) {
		if (
			!document ||
			typeof document.key !== "string" ||
			keys.has(document.key) ||
			!["engineering", "finance"].includes(document.base) ||
			typeof document.title !== "string" ||
			!document.title ||
			typeof document.text !== "string" ||
			!document.text.trim()
		)
			throw new Error("评测文档无效或标识重复");
		keys.add(document.key);
	}
	const questions = new Set<string>();
	for (const question of dataset.questions) {
		if (
			!question ||
			typeof question.key !== "string" ||
			questions.has(question.key) ||
			!["alice", "bob"].includes(question.user) ||
			typeof question.query !== "string" ||
			!question.query.trim() ||
			question.query.length > 300 ||
			!Array.isArray(question.expected) ||
			!question.expected.every((key) => keys.has(key)) ||
			(question.previousQuestion !== undefined && typeof question.previousQuestion !== "string") ||
			(question.excerpt !== undefined && typeof question.excerpt !== "string")
		)
			throw new Error("评测问题或预期来源无效");
		questions.add(question.key);
	}
	if (dataset.questions.length === 0) throw new Error("评测问题不能为空");
	return dataset;
}

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	const argumentValue = (flag: string) => {
		const index = args.indexOf(flag);
		if (index < 0) return undefined;
		if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${flag} 缺少路径`);
		return args[index + 1];
	};
	const datasetPath = resolve(
		argumentValue("--dataset") ?? fileURLToPath(new URL("../eval/retrieval-cases.json", import.meta.url)),
	);
	const outputPath = resolve(
		argumentValue("--output") ??
			fileURLToPath(new URL("../../../.artifacts/company-agent/retrieval-eval.json", import.meta.url)),
	);
	if ((await stat(datasetPath)).size > 32 * 1024 * 1024) throw new Error("评测文件超过 32 MiB");
	const dataset = validate(JSON.parse(await readFile(datasetPath, "utf8")));
	// Network is opt-in even when the app's .env enables a real model.
	const embedding = args.includes("--hybrid") ? createEmbeddingModel() : undefined;
	if (args.includes("--hybrid") && !embedding) throw new Error("--hybrid 需要先配置并启用向量模型");
	const database = await openDatabase();
	const documents = new DocumentService(database);
	const worker = new IngestionWorker(database);
	const vectors = embedding ? new VectorIndex(database, embedding) : undefined;
	const retrieval = new RetrievalService(database, vectors);
	const keyById = new Map<string, string>();
	try {
		await seedDemo(database, "synthetic-evaluation-only");
		await documents.deleteDocument("user-alice", "doc-engineering");
		await documents.deleteDocument("user-bob", "doc-finance");
		await worker.start();
		for (const document of dataset.documents) {
			const receipt = await documents.upload(
				document.base === "finance" ? "user-bob" : "user-alice",
				{ knowledgeBaseId: `kb-${document.base}` },
				{
					filename: `${document.key}.md`,
					mediaType: "text/markdown",
					title: document.title,
					content: Buffer.from(document.text),
				},
			);
			keyById.set(receipt.documentId, document.key);
		}
		worker.wake();
		await worker.waitForIdle();
		await vectors?.indexPending(new AbortController().signal);
		const results: { key: string; expected: string[]; baseline: Score; optimized: Score }[] = [];
		for (const question of dataset.questions) {
			const userId = `user-${question.user}`;
			const baseline = await documents.search(userId, { query: question.query, limit: 5 }, { baseline: true });
			const context = question.previousQuestion
				? await retrieval.search(userId, { query: question.previousQuestion, limit: 5 })
				: undefined;
			const plan = planSearch(
				question.query,
				question.previousQuestion,
				context?.hits.map((hit) => hit.documentId),
			);
			const optimized = plan.keywordQuery
				? (await retrieval.search(userId, { query: plan.keywordQuery, limit: 5 }, { plan })).hits
				: [];
			const score = (hits: SearchHit[]): Score => {
				const sourceKeys = hits.map((hit) => keyById.get(hit.documentId) ?? "unexpected-source");
				if (question.expected.length === 0)
					return { correct: hits.length === 0, recall: 0, reciprocalRank: 0, sourceKeys };
				const relevant = (hit: SearchHit) =>
					question.expected.includes(keyById.get(hit.documentId) ?? "") &&
					(!question.excerpt || hit.text.includes(question.excerpt));
				const found = new Set(hits.filter(relevant).map((hit) => keyById.get(hit.documentId)));
				const rank = hits.findIndex(relevant);
				return {
					correct: question.expected.every((key) => found.has(key)),
					recall: found.size / question.expected.length,
					reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1),
					sourceKeys,
				};
			};
			results.push({
				key: question.key,
				expected: question.expected,
				baseline: score(baseline),
				optimized: score(optimized),
			});
		}
		const summarize = (method: "baseline" | "optimized") => {
			const positives = results.filter((row) => row.expected.length > 0);
			const negatives = results.filter((row) => row.expected.length === 0);
			return {
				cases: results.length,
				correct: results.filter((row) => row[method].correct).length,
				recallAt5: positives.reduce((sum, row) => sum + row[method].recall, 0) / Math.max(1, positives.length),
				mrrAt5: positives.reduce((sum, row) => sum + row[method].reciprocalRank, 0) / Math.max(1, positives.length),
				noEvidenceCorrect: negatives.filter((row) => row[method].correct).length,
				noEvidenceCases: negatives.length,
			};
		};
		const report = {
			dataset: dataset.label,
			generatedAt: new Date().toISOString(),
			mode: embedding ? "hybrid" : "keyword",
			scope: "仅衡量检索来源与无结果判断；不衡量真实生成模型的答案正确率。",
			baseline: summarize("baseline"),
			optimized: summarize("optimized"),
			results,
		};
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
		console.log(
			JSON.stringify(
				{
					dataset: report.dataset,
					mode: report.mode,
					baseline: report.baseline,
					optimized: report.optimized,
					output: outputPath,
				},
				null,
				2,
			),
		);
	} finally {
		await vectors?.stop();
		await worker.stop();
		await database.close();
	}
}

await run();
