---
owner: davidbrai
---
# models

哪些模型存在、使用哪一个。

包含：
- 内置模型目录（generate-models、models.dev、pi.dev registry）。
- 模型元数据：上下文窗口、最大 token、思考级别映射、定价。
- models.json 自定义提供商与模型。
- 模型解析：--model、--provider、defaultModel、启动回退、作用域模型、虚拟模型。
- /model 的内容与排序、思考级别选择。

不包含：
- 模型选择器如何绘制：tui。
- 传输格式与请求内容：providers。

示例：#9566, #9884, #10160, #9099, #10236, #10552, #8810, #10507.

通常不值得提交：数据来自 models.dev 时的 "添加模型 X"（应在上游修复）、通过更新 pi 即可解决的过期目录。
