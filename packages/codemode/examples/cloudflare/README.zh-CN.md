# pi-codemode on Cloudflare

这个示例包含两个 Worker：

- **`sandbox/`** 把 `CodemodeSandboxDurableObject` 部署为独立的 Worker `pi-codemode-sandbox`。
  脚本在那里运行，位于单独的 isolate 中。
- **`agent/`** 有一个拥有工具的 `Session` Durable Object。它通过 `RemoteCodemodeSandbox`
  运行脚本：工具和结果保留在 `Session` 中，而沙箱 Worker 运行 VM。

[该包的 README](../../README.md#在-cloudflare-workers-上使用)解释了为什么沙箱必须是独立的
Worker，以及适用哪些限制。

## 本地试用

在每个目录中安装 `@earendil-works/pi-codemode` 和 `wrangler`，然后在同一个进程中启动两个 Worker：

```sh
npx wrangler dev -c agent/wrangler.jsonc -c sandbox/wrangler.jsonc
curl -X POST http://localhost:8787 --data 'const n = await tools.count({ add: 2 }); text("n=" + n); return n'
```

## 部署

先部署沙箱，因为 agent 的绑定按名称引用它：

```sh
(cd sandbox && npx wrangler deploy)
(cd agent && npx wrangler deploy)
```
