# @earendil-works/pi-mcp

一个小巧、独立的 Model Context Protocol 客户端。它不依赖官方 MCP SDK 或其他 pi 包。

该包提供传输无关的客户端核心、stdio 与 Streamable HTTP 传输，以及内存测试传输。

## 用法

```typescript
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";

const transport = new StdioTransport({
	command: "npx",
	args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
});
const client = new McpClient({
	name: "my-client",
	version: "1.0.0",
	roots: [{ uri: "file:///workspace", name: "workspace" }],
});

await client.connect(transport);
const tools = await client.listTools();
const result = await client.callTool("search", { query: "MCP" });
await client.close();
```

远程服务器使用 `new StreamableHttpTransport({ url, headers })`。可以注入 Fetch 用于代理或自定义网络。

### 提供给 LLM 的工具

`toLlmContent(result)` 把 `CallToolResult` 转换为模型可用的文本和图片内容，形状与 `@earendil-works/pi-ai` 的 `TextContent` 和 `ImageContent` 一致。文本和图片直接透传，内嵌的文本和图片资源会被解包，音频、资源链接和二进制资源变成简短的文本占位符。没有 content 块但有 `structuredContent` 的结果会转换为其 JSON。

把 MCP 工具包装为 `pi-agent-core` 的 `AgentTool`：

```typescript
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";

const tools: AgentTool[] = (await client.listTools()).map((tool) => ({
	// 提供商最多允许 64 个字符的 [A-Za-z0-9_-]。
	name: `mcp_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
	label: tool.title ?? tool.name,
	description: tool.description ?? tool.name,
	// 提供商要求 object schema，有些还拒绝没有 `properties` 的 schema。
	parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
	execute: async (_toolCallId, params, signal) => {
		const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal });
		// MCP 在结果中报告工具失败，而不是作为协议错误。
		return { content: toLlmContent(result), details: undefined, isError: result.isError === true };
	},
}));
```

[mcp-codemode 示例](https://github.com/earendil-works/pi/tree/main/packages/agent/examples/mcp-codemode)还转发了进度、透传 `structuredContent`，并让 `@earendil-works/pi-codemode` 脚本可以调用这些工具。

### OAuth

`@earendil-works/pi-mcp/oauth` 提供不依赖官方 SDK 的 MCP OAuth 客户端子集：

```typescript
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
	adaptOAuthProvider,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	OAuthCallbackServer,
} from "@earendil-works/pi-mcp/oauth";

const serverUrl = "https://mcp.example.com/mcp";
const callback = await OAuthCallbackServer.listen();
let authorizationUrl: URL | undefined;
const oauth = new McpOAuthProvider({
	serverUrl,
	redirectUrl: callback.redirectUrl,
	clientMetadata: { client_name: "My MCP client" },
	onRedirect: (url) => {
		authorizationUrl = url;
	},
});

const connect = () => {
	const client = new McpClient({ name: "my-client", version: "1.0.0" });
	return {
		client,
		connected: client.connect(
			new StreamableHttpTransport({ url: serverUrl, authProvider: adaptOAuthProvider(oauth) }),
		),
	};
};

const first = connect();
try {
	await first.connected;
} catch (error) {
	if (!(error instanceof McpOAuthAuthorizationRequiredError)) throw error;
	const state = await oauth.state();
	const result = callback.waitForCallback(state);
	// 在这里用用户浏览器打开 authorizationUrl。
	const { code } = await result;
	await authorizeMcp(oauth, { serverUrl, authorizationCode: code });
}

const { client, connected } = connect();
await connected;
```

把 `McpOAuthStateStore` 注入 `McpOAuthProvider` 可获得持久化凭据。该包不打开浏览器，也不决定凭据的存储位置。

OAuth 实现改编自 MIT 许可的 Model Context Protocol TypeScript SDK v1.29.0。其许可证包含在 `LICENSES/` 下。

MCP 传输层负责分帧和 I/O。它把单个 JSON-RPC 消息递交给 `McpClient`；客户端负责请求关联、初始化、超时、取消、服务器请求和协议级辅助功能。

## 支持的协议面

- MCP 协议版本 `2025-11-25`，接受协商 `2025-06-18`、`2025-03-26` 或 `2024-11-05` 的服务器
- 初始化与 `notifications/initialized`
- ping
- 分页的 `tools/list`
- `tools/call`，包括结构化内容
- 进度通知与超时续期
- 请求取消
- Streamable HTTP 会话、带重连的服务器到客户端 GET 流、用 `Last-Event-ID` 恢复中断的响应流
- 按规范关闭 stdio（先关 stdin，再 SIGTERM，再 SIGKILL），作用于服务器的整个进程组
- 服务器的 `ping` 和 `roots/list` 请求
- 通过通用通知 API 处理日志和工具列表变更通知
- OAuth 受保护资源与授权服务器发现
- PKCE 授权码流程、动态客户端注册、token 刷新（并发 401 共享一次刷新），以及针对 `insufficient_scope` 的升阶授权

批量 JSON-RPC 消息、旧式 HTTP+SSE、servers、sampling 和 tasks 不在初始核心范围内。

## 测试

`@earendil-works/pi-mcp/testing` 导出 `createInMemoryTransportPair()`，用于客户端和适配器测试。
