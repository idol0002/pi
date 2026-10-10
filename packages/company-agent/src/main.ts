/**
 * 服务端学习入口：配置 → 数据库 → 后台任务 → HTTP 服务。
 * 这里运行在 Node.js；浏览器自己的入口是 web/main.tsx。
 * 按完整调用顺序阅读时，先看 ../LEARNING.md，再沿本文件的启动步骤向下跟踪。
 */
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

// 1. 配置只在服务端读取；此密码用于空数据库的测试账号初始化，不会发送给网页。
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
// 创建的是调用适配器；生成请求发生在提问之后。向量模式为 off 时不创建向量索引器。
const model = createAnswerModel(readModelConfig());
const embedding = createEmbeddingModel();
await mkdir(dirname(dataDirectory), { recursive: true });

// 2. 等待数据库打开与迁移完成，再把同一个连接注入各业务服务。
const database = await openDatabase(dataDirectory);
const ingestion = new IngestionWorker(database, { onError: (error) => console.error(error) });
const vectors = embedding ? new VectorIndex(database, embedding) : undefined;
const chat = new ChatService(database, model, new RetrievalService(database, vectors));
try {
	// 3. 已有账号时不重复初始化；入库 worker 启动时会恢复中断的文档任务。
	const seeded = await seedDemo(database, password);
	await ingestion.start();
	vectors?.start();
	// 4. 创建路由并打包网页资源。传入同一个 chat，保证所有请求共享本机生成任务登记。
	const server = await createKnowledgeServer(database, { ingestion, chat, onError: (error) => console.error(error) });
	await new Promise<void>((ready, reject) => {
		server.once("error", reject);
		// 本入口面向本机学习与验证，监听范围和 Host 校验需与 server.ts 一起理解。
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
		// 5. 先请求取消聊天并停止接受新连接，连接关闭后再结束后台任务和数据库。
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
	// 启动过程中任何一步失败，也要释放前面已创建的资源。
	await chat.stop();
	await ingestion.stop();
	await vectors?.stop();
	await database.close();
	throw error;
}
