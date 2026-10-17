---
owner: christianklotz
---
# extensions

扩展 API 与运行时。

包含：
- pi.* 和 ctx.* API 表面、事件与钩子。
- registerTool、registerCommand、registerProvider、渲染器。
- ctx.ui 对话框与自定义组件。
- 扩展加载（jiti、模块解析、虚拟模块）、/reload。
- 内置扩展机制、扩展示例与文档。

不包含：
- 安装包：cli。
- 内置 MCP 与 codemode：mcp、codemode。

示例：#5581, #9932, #10599, #6552, #8829, #10002, #10354.

通常不值得提交：第三方扩展的 bug、只为单一小众用例的新钩子、"暴露一切" 类请求。
