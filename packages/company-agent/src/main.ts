import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnswerModel } from "./answer-model.ts";
import { ChatService } from "./chat.ts";
import { openDatabase, seedDemo } from "./database.ts";
import { createEmbeddingModel } from "./embeddings.ts";
import { IngestionWorker } from "./ingestion.ts";
import { readModelConfig } from "./model-config.ts";
import { RetrievalService } from "./retrieval.ts";
import { createKnowledgeServer } from "./server.ts";
import { VectorIndex } from "./vector-index.ts";

const password = process.env.KNOWLEDGE_DEMO_PASSWORD;
if (!password || password.length < 12 || password.length > 256) {
	throw new Error("请设置 KNOWLEDGE_DEMO_PASSWORD，长度为 12 到 256 个字符，用于初始化测试账号");
}
if (process.env.NODE_ENV === "production") {
	throw new Error("当前入口使用测试账号，仅用于本地开发验证");
}
const port = Number(process.env.KNOWLEDGE_PORT ?? "4310");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("KNOWLEDGE_PORT 必须是 1 到 65535 的整数");
const dataDirectory = process.env.KNOWLEDGE_DATA_DIR
	? resolve(process.env.KNOWLEDGE_DATA_DIR)
	: fileURLToPath(new URL("../../../.artifacts/company-agent/pgdata", import.meta.url));
const model = createAnswerModel(readModelConfig());
const embedding = createEmbeddingModel();
await mkdir(dirname(dataDirectory), { recursive: true });

const database = await openDatabase(dataDirectory);
const ingestion = new IngestionWorker(database, { onError: (error) => console.error(error) });
const vectors = embedding ? new VectorIndex(database, embedding) : undefined;
const chat = new ChatService(database, model, new RetrievalService(database, vectors));
try {
	const seeded = await seedDemo(database, password);
	await ingestion.start();
	vectors?.start();
	const server = await createKnowledgeServer(database, { ingestion, chat, onError: (error) => console.error(error) });
	await new Promise<void>((ready, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			ready();
		});
	});
	console.log(`Knowledge Web: http://127.0.0.1:${port}`);
	console.log(`Model: ${model.info.name} (${model.info.mode})`);
	console.log(`Retrieval: ${vectors ? "keyword + vector" : "keyword"}`);
	console.log(`Database: ${dataDirectory}`);
	if (seeded) console.log("已初始化测试账号 alice、bob，密码来自 KNOWLEDGE_DEMO_PASSWORD。");
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		void chat.stop().catch((error: unknown) => console.error(error));
		server.close(() => {
			void Promise.all([ingestion.stop(), vectors?.stop()])
				.then(() => database.close())
				.catch((error: unknown) => {
					console.error(error);
					process.exitCode = 1;
				});
		});
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
} catch (error) {
	await chat.stop();
	await ingestion.stop();
	await vectors?.stop();
	await database.close();
	throw error;
}
