/**
 * 浏览器入口：把 React 挂到 index.html 的 root 节点。
 * 服务器先通过 src/web.ts 将此文件及依赖打包，浏览器实际加载的是 /assets/app.js。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("缺少网页挂载节点");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
