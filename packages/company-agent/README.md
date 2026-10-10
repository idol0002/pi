# 公司知识库 Agent：网页与带来源问答

从 0 到 1 学习代码，请先读[学习指南与流程图](LEARNING.md)。指南按启动、登录、入库、问答、取消与原文追溯串起调用顺序，业务源码中的中文注释对应这些边界。

已实现同源网页、测试账号登录、知识库授权、PDF／Word／Markdown／TXT 上传、本地扫描件 OCR、正文复核、后台分块、关键词排序与可选向量混合检索，以及通过 Pi 接入的流式问答、版本引用、追问检索、历史会话和取消生成。提供无需密钥的演示配置、通用 OpenAI 兼容生成／向量接口，以及可重复运行的检索评测。真实模型试点仍见[实施清单](../../docs/internal-knowledge-agent-mvp.md)。

本阶段使用 PGlite 在本机持久化 PostgreSQL 数据，不需要启动 Docker 或数据库服务。原件字节、解析正文、分块、索引和任务状态都保存在这个私有数据库中。应用仅监听 `127.0.0.1`，一个数据目录只能由一个应用进程使用。正式部署时需要接入公司身份系统、独立 PostgreSQL 服务和私有对象存储。

## 启动

要求 Node.js 22.19 或更新版本。在仓库根目录安装锁定的依赖：

```powershell
npm ci --ignore-scripts
```

在 PowerShell 中设置本地测试密码并启动：

```powershell
$env:KNOWLEDGE_DEMO_PASSWORD = 'replace-with-your-local-test-password'
npm --prefix packages/company-agent start
```

也可以复制本目录的 `.env.example` 为 `.env`，填写密码后运行启动命令。密码需为 12～256 个字符，应用不会提供默认密码，也不会输出密码。

默认网页地址为 `http://127.0.0.1:4310`，健康检查为 `GET /healthz`。启动后直接在浏览器访问该地址。前端采用 React 19 + TypeScript，由同一服务在启动时通过 esbuild 打包并提供，无需额外的前端开发服务器或构建命令。React、PDF.js 和页面资源均来自本地依赖。修改 `web/` 源码后重启服务并刷新页面。

- `KNOWLEDGE_PORT`：本地端口，默认 `4310`。
- `KNOWLEDGE_DATA_DIR`：数据目录；默认是仓库根目录下的 `.artifacts/company-agent/pgdata`，已被 Git 忽略。自定义相对路径相对于启动时的工作目录，推荐设置绝对路径。
- `KNOWLEDGE_DEMO_PASSWORD`：首次初始化两个测试账号的密码。测试账号的密码分别加盐、哈希后存储。

首次启动创建以下合成数据：

- `alice`：研发组，对 `kb-engineering` 有管理权限；可以读取 `doc-engineering`。
- `bob`：财务组，对 `kb-finance` 有管理权限；可以读取 `doc-finance`。

两个账号均使用配置的测试密码。重启保留数据库中的修改，初始化流程不会恢复已经撤销的授权，也不会根据环境变量重置已有密码。需要全新的测试数据时，设置一个新的数据目录。

已有第一阶段数据库会自动升级，示例文档建立版本和关键词索引，账号、授权与会话继续保留。启动时恢复尚未完成的入库任务；正常退出时先等待当前处理完成，再关闭数据库。

该入口用于开发验证，`NODE_ENV=production` 时拒绝启动。

## 网页使用

1. 使用 `alice` 或 `bob` 和配置的测试密码登录。
2. 在侧栏选择知识库，输入问题并点击「发送」。回答逐步显示，点击引用编号或来源卡片可打开该版本的原文；PDF 支持页码定位和来源区域高亮。
3. 可停止正在生成的回答，也可打开自己的历史问答继续提问。会话创建后固定知识范围，切换范围时新建问答。
4. 「知识管理」中可上传资料、查看后台处理状态、更新版本、重试失败任务或删除文档。拥有管理权限时，还可按用户组调整授权；阅读权限不显示维护和授权操作。

默认配置为生成模型 `demo`、向量模型 `off`，会在页面和回答中明确标注，只摘录检索到的真实文档，不调用外部模型。账号权限、上传、检索、引用和历史保存均使用实际后端。单独启用向量模型后，文档索引与问题向量化会调用配置的服务，即使回答仍为演示模式。

## 模型配置

文档解析环境和问答模型分别配置，OCR 不调用问答模型。文档环境的安装方式见下文「PDF、Word 与扫描件」。

配置仅由服务端读取，浏览器只能取得当前模式和模型名称。复制 `.env.example` 为 `.env` 后填写账号密码；保留 `KNOWLEDGE_MODEL_MODE=demo` 即可验证完整页面流程。

接入公司批准的 OpenAI 兼容 Chat Completions 服务时，在 `.env` 中设置以下字段后重启：

```dotenv
KNOWLEDGE_MODEL_MODE=openai
KNOWLEDGE_MODEL_BASE_URL=https://your-approved-gateway.example/v1
KNOWLEDGE_MODEL_NAME=your-approved-model
KNOWLEDGE_MODEL_API_KEY=replace-with-your-key
```

`BASE_URL` 是 API 根地址，不包含 `/chat/completions`。使用 HTTPS，本机模拟服务允许 HTTP。真实模式缺少配置会拒绝启动；请求失败不会切换成演示回答。`.env` 已被 Git 忽略。

- `KNOWLEDGE_MODEL_TIMEOUT_MS`：一次问答的上限，默认 60000，允许 1000～180000 毫秒。
- `KNOWLEDGE_MODEL_MAX_TOKENS`：生成令牌上限，默认 2048，允许 128～8192。
- `KNOWLEDGE_MODEL_MAX_TOKENS_FIELD`：默认 `max_tokens`；需要使用另一参数名的服务可改成 `max_completion_tokens`。
- `KNOWLEDGE_MODEL_STREAM_USAGE`：默认 `true`，请求流式用量。服务不支持 `stream_options.include_usage` 时改成 `false`；该服务未返回的用量不能用于准确计费。

真实模式使用 `pi-agent-core` 的独立 Agent 和 `pi-ai` 的 OpenAI 兼容适配器。启动脚本预加载仓库已有的源码解析器，无需构建 Pi 各个包。模型选择和接入代码已用本地模拟 HTTP 服务验证；实际网关、真实模型质量及中文召回效果还需使用批准的配置与问题集验证。

## 问答与历史规则

- 后端在会话的授权范围内检索，按查询词覆盖度、标题、章节和问题意图重新排序，去除重复摘录并为不同来源预留位置。启用向量后合并两路排名。无资料时说明缺少依据；检索故障作为错误返回。
- “那多久能批”一类省略主题的追问，会使用最近一轮仍有权限且版本有效的问题及来源补全检索。新主题独立检索；没有新结果的独立问题不会仅凭旧会话片段强行回答。这是启发式补全，需要用业务问题集继续验证。
- 单个问题最多 2000 字符；检索查询限制为 300 字符、64 个词，最多返回 6 个当前版本片段。结合最近两轮有效历史后，资料最多 10 段、12000 字符，历史正文最多 6000 字符。旧版本回答可继续阅读，但不会作为新一轮问答的当前依据。
- 每次使用独立 Agent，不注册文件、Shell 或外部执行工具。文档和历史以资料形式传入，不能改变服务端权限范围。正文只按纯文本显示，不执行文档或模型返回的 HTML。
- 每个会话最多 100 轮，每个员工同时最多一个生成任务，本机总计最多四个。同一会话的重复请求返回 `409`，其他并发超限返回 `429`。
- 文本增量属于待验证回答。完成时检查引用编号，只映射服务器提供的真实来源；无效引用、非拒答但没有引用、空回答和超长回答均作为失败。引用校验不等于事实正确性验证，仍需核对原文。
- 保存问题、完成状态、答案和服务返回的令牌用量。所有传入上下文的来源都保留关联，包括没有在最终答案中引用的历史来源；因此删除或撤权后，不会通过后续答案再次带出旧资料。
- 完成的回答保存 `retrieval` 信息：检索方式、是否使用追问上下文、检索耗时和候选数量。索引更新期间的关键词检索提示会随回答保留。引用编号校验仍不代表事实核验。
- 每次读取历史、向模型提供资料及推送文本前重新检查访问权限和登录状态。资料被删除后，相关历史回答及引用被遮蔽；整个会话的知识库权限撤销后，该会话不再可见。
- 点击停止、浏览器断开或超时会取消本次生成。未完成正文不用于后续上下文；重启将中断状态改为失败，不自动重放付费请求。

`POST /api/conversations/:id/messages` 接收 `{ "content": "谁安排上线窗口？" }`，返回 `text/event-stream`。事件的 JSON 包含同名 `type`：`start`（`runId`、`messageId`）、`status`（检索／回答阶段）、`delta`（文本）、`sources`（验证后的引用）、`done`（完整消息）或 `error`（错误码和说明）。客户端必须等到 `done` 或 `error`，不能把意外断线当成完成。流建立前的鉴权、参数和并发错误仍使用普通 JSON HTTP 错误响应。

## 验证登录和权限

服务启动后，在另一个已设置测试密码的 PowerShell 窗口中执行：

```powershell
$loginBody = @{ username = 'alice'; password = $env:KNOWLEDGE_DEMO_PASSWORD } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4310/api/auth/login -ContentType application/json -Body $loginBody -SessionVariable knowledgeSession
Invoke-RestMethod -Uri http://127.0.0.1:4310/api/knowledge-bases -WebSession $knowledgeSession
Invoke-RestMethod -Uri http://127.0.0.1:4310/api/documents/doc-engineering/source -WebSession $knowledgeSession
```

此时访问 `GET /api/documents/doc-finance` 或 `GET /api/documents/doc-finance/source` 均返回 `404`。不存在的资源和无权访问的资源使用相同错误响应。

登录使用 HttpOnly、SameSite=Strict 的不透明会话 Cookie，有效期为 8 小时；数据库只保存会话令牌的哈希。每次请求重新检查账号状态、用户组和授权。客户端提交的用户 ID、组或角色不能替代服务端的身份判断。

## 上传和检索

沿用上一步的 `$knowledgeSession`。准备 UTF-8 编码的 Markdown 或 TXT 文件，例如正文包含“发布负责人安排上线窗口”，然后上传；将示例路径替换为实际文件路径：

```powershell
$cookieHeader = $knowledgeSession.Cookies.GetCookieHeader([Uri]'http://127.0.0.1:4310')
$upload = curl.exe --silent --show-error --fail --cookie $cookieHeader --form 'file=@C:\documents\release.md;type=text/markdown' --form 'title=发布流程' http://127.0.0.1:4310/api/knowledge-bases/kb-engineering/documents | ConvertFrom-Json
$upload
```

接口返回 HTTP `202`，包含 `documentId`、`versionId`、`jobId` 和接受时的 `status: "queued"`。查询任务，等 `status` 为 `succeeded` 后执行检索：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:4310/api/ingestion-jobs/$($upload.jobId)" -WebSession $knowledgeSession

$searchBody = @{ query = '上线窗口'; knowledgeBaseIds = @('kb-engineering'); limit = 5 } | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4310/api/search -ContentType 'application/json; charset=utf-8' -Body $searchBody -WebSession $knowledgeSession
$result.hits | Select-Object title, heading, text, startLine, endLine, sourceUrl
```

`hits` 中每个片段包含 `id`、`documentId`、`versionId`、版本号、文件名、章节、行号、正文与排序分数。`sourceUrl` 指向该版本对应行范围的原文；`locations` 保存 PDF 页码、文字区域或 Word 正文块位置，问答引用也会返回这些字段。

```powershell
if ($result.hits.Count -gt 0) {
    Invoke-RestMethod -Uri ('http://127.0.0.1:4310' + $result.hits[0].sourceUrl) -WebSession $knowledgeSession
}
```

`POST /api/search` 的 `query` 为 1～300 个字符，最多生成 64 个检索词；`limit` 默认为 5，最大为 20。省略 `knowledgeBaseIds` 时搜索当前员工全部获授权的知识库；提供时必须是 1～20 个不重复且有权访问的知识库。无结果返回空的 `hits` 数组，查询故障返回错误。

关键词索引使用 PostgreSQL `tsvector` 和 GIN 索引。中英文使用同一套分词逻辑，英文忽略大小写和全半角差异；中文加入相邻双字词。查询会过滤常见问句虚词，并按有效词覆盖、标题和章节匹配重排候选。仅使用关键词仍可能漏掉不同措辞的同义问题，可按下一节启用向量检索。

## 向量模型配置

生成模型与向量模型分别配置。在本地 `.env` 填写以下位置，并将模式改为 `openai` 后重启：

```dotenv
KNOWLEDGE_EMBEDDING_MODE=openai
KNOWLEDGE_EMBEDDING_BASE_URL=https://your-approved-gateway.example/v1
KNOWLEDGE_EMBEDDING_NAME=your-embedding-model
KNOWLEDGE_EMBEDDING_API_KEY=your-key
KNOWLEDGE_EMBEDDING_DIMENSIONS=
KNOWLEDGE_EMBEDDING_TIMEOUT_MS=10000
KNOWLEDGE_EMBEDDING_MIN_SIMILARITY=0.35
KNOWLEDGE_EMBEDDING_REVISION=1
```

`BASE_URL` 是根地址，不包含 `/embeddings`。需要支持 OpenAI 格式的批量 `input` 与 `encoding_format: "float"`。维度可留空，此时不发送 `dimensions` 参数；指定时允许 1～4096，且服务必须支持该参数。查询时限允许 1000～60000 ms，相似度阈值须使用实际样本校准。

默认 `off` 不调用向量服务。显式启用后，后台会把所有有效知识库中已发布、当前生效的文档片段发送到批准的接口，批量生成并保存向量。待复核版本不参与；旧数据自动补建，新资料最迟在下一轮扫描发现。更换地址、模型、维度或修订号会使用独立索引；同名模型更换权重时应增加 `REVISION`。

查询采用带权限过滤的精确向量距离检索，再与关键词排名合并。索引尚未齐备时，有关键词结果会明确返回并展示降级提示；没有关键词结果则返回“索引更新中”，不会伪装成无资料。真实服务失败返回错误，不切换到伪造向量。当前适合本地试点；大规模数据需在测量后增加近似向量索引和独立任务调度。

后台遇到临时错误会退避重试，连续失败三次后暂停；地址、权限、维度或结果格式等配置错误立即暂停，避免持续重复发送同一批文档。修正配置后重启应用恢复。

## 检索质量评测

在本目录运行 `npm run eval:retrieval`，默认使用 [28 条合成用例](eval/retrieval-cases.json)，在独立内存数据库中对比原关键词排名与新检索流程；不修改正在运行的知识库，也不调用外部模型。输出保存在仓库 `.artifacts/company-agent/retrieval-eval.json`。

```powershell
npm run eval:retrieval
npm run eval:retrieval -- --dataset C:/private/retrieval-cases.json --output C:/private/retrieval-report.json
```

评测记录前五条结果的来源召回率、首个正确来源的排名，以及应该无结果的问题是否返回了资料。它衡量检索，不衡量生成答案的事实正确率。可按样例结构替换成真实问题及预期来源。

填写向量配置后可加 `--hybrid` 对比语义检索；这个显式选项会把评测文档和问题发送到配置的向量服务。默认不因 `.env` 中已有真实模型配置就自动启用网络评测。

## PDF、Word 与扫描件

解析在独立 Python 进程中执行，已验证 Python 3.12。先在本目录创建环境并安装固定依赖，将 `python` 替换为需要使用的 Python 3.12 解释器：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r parser/requirements.txt
$env:KNOWLEDGE_PYTHON_PATH = (Resolve-Path .venv/Scripts/python.exe).Path
npm start
```

也可以将解释器的绝对路径写入 `.env` 的 `KNOWLEDGE_PYTHON_PATH`。Linux 使用虚拟环境中的 `bin/python`。Markdown／TXT 不依赖 Python。

- PDF 按页选择文字提取或 OCR。带页码文字的扫描页仍会识别图片，不会因为少量文本层而漏掉正文。
- OCR 使用 RapidOCR 随包提供的 PP-OCRv4 中文／英文 ONNX 模型，在本机 CPU 上运行。安装依赖需要下载软件；解析文档期间不调用外部识别服务。
- DOCX 按顺序提取标题、段落和表格，内嵌图片进入 OCR。没有稳定分页的 DOCX 使用正文块位置；不会编造页码。
- 旧版 DOC 需要额外配置 `KNOWLEDGE_LIBREOFFICE_PATH`，指向 `soffice` 可执行文件，转换成固定 PDF 后解析。未配置时任务会明确失败，并提示另存为 DOCX；当前开发环境未安装此转换器。
- PDF.js、字体、字符映射和图片解码资源均由应用同源提供，不使用外部 CDN。

`KNOWLEDGE_OCR_MODE` 可设为 `auto`（默认）、`always` 或 `off`。`off` 遇到扫描内容会进入复核，不能据此认定扫描页已成功提取。`KNOWLEDGE_PARSE_TIMEOUT_MS` 默认 300000，范围 1000～900000；`KNOWLEDGE_MAX_DOCUMENT_PAGES` 默认 120，范围 1～500。单页渲染最多约 1200 万像素，DOCX 解压后最多 64 MiB，提取正文最多 1 MiB。

当出现低置信度文字、无法读取的图片、可能的扫描表格、额外旋转或复杂 Word 内容时，最新版本标记为 `needs_review`。它不进入检索，已有成功版本继续服务。维护者可以在「复核」中对照原件逐块修改正文，再确认入库；复核前应检查识别覆盖是否完整，缺失正文应重新识别或上传修正版。原文件字节不变，记录复核者、时间和原始质量提示。

置信度与版面检测是启发式规则，不保证识别正确。复杂表格、多栏、手写和模糊扫描仍需用实际样本验证；出现无法识别的页面会明确提示，不将异常解释为空白正文。

## 处理状态与版本

- 支持 `.pdf`、`.docx`、`.doc`、`.md`、`.markdown`、`.txt`；每次一个文件，PDF／Word 上限 20 MiB，文本上限 1 MiB。扩展名、类型、文件签名、大小和维护权限在入队前检查。
- 后台严格按 UTF-8 解码，移除 UTF-8 BOM，将 CRLF／CR 统一为 LF。无正文、二进制控制字符和错误编码会使任务失败。原件下载保留上传时的完整字节。
- Markdown 按 ATX 标题（`#` 到 `######`）划分章节，代码围栏内的 `#` 不作为标题；长内容优先在段落、行或句子边界分块。片段上限为 1200 个 UTF-16 单元，同章节内最多重叠 160 个，不拆开 Unicode 代理对，最多 2048 块。
- 片段行号从 1 开始，对应规范化后的原文；`startOffset`、`endOffset` 是同一原文的 UTF-16 偏移，起点包含、终点不包含，可精确定位长行中的片段。
- 单个后台任务顺序处理，待处理及处理中任务合计最多 100 个。HTTP 请求接收上限 120 秒，上传请求额外预留 16 KiB 表单开销；压缩请求不受支持。

任务状态为 `queued`、`processing`、`needs_review`、`succeeded`、`failed`、`cancelled`。任务额外返回 `stage`、`processedPages`、`totalPages` 和 `warnings`。失败或需复核的最新版本可以通过 `POST /api/ingestion-jobs/:id/retry` 重新解析，请求体为 `{}`。每个任务最多执行 3 次，重启恢复也计入次数。编码或内容错误需上传修正后的新版本。

通过 `POST /api/documents/:id/versions` 上传新版本，表单与首次上传相同。`title` 可选，省略则沿用当前文档标题。同一文档只能有一个待处理或处理中的版本，重复提交返回 `409`。全部分块和索引写入成功后，在同一事务中切换生效版本；失败时旧版本继续供检索和读取。

文档元数据的 `status` 描述最新上传版本，`currentVersionId` 和 `version` 描述当前生效版本，`latestJobId` 可用于刷新页面后恢复任务查询或重试入口。首次上传未完成时，当前版本为 `null`，正文尚不可读取。版本更新失败时，最新状态为 `failed`，当前版本仍指向先前成功版本。

检索只返回当前生效版本。已成功版本的历史片段和原文可由有当前阅读权限的员工访问，因此旧引用不会随着更新指向新内容。指定其他文档的版本 ID、未完成版本、已删除文档或无权内容均返回 `404`。

删除使用 `DELETE /api/documents/:id`，成功返回 `204`。删除标记立即排除检索和全部来源访问，后台再清理各版本的原件、分块、索引和任务；保留不含正文的文档删除记录。解析中发生删除时，任务完成也不会重新发布文档。

## 已实现 API

- `GET /healthz`：无需登录的存活检查。
- `POST /api/auth/login`：请求 `{ "username": "alice", "password": "..." }`，返回用户信息并设置 Cookie。
- `POST /api/auth/logout`：请求 `{}`，撤销当前会话并清除 Cookie。
- `GET /api/me`：读取当前用户及用户组。
- `GET /api/model`：登录后读取当前模型模式和名称，不返回地址或密钥。
- `GET /api/knowledge-bases`：仅列出获授权的知识库及有效权限。
- `GET /api/knowledge-bases/:id`：读取获授权的知识库信息。
- `GET /api/knowledge-bases/:id/documents`：列出可访问的文档元数据。
- `POST /api/knowledge-bases/:id/documents`：具有维护权限时上传文档，使用 `multipart/form-data` 的 `file` 和可选 `title`，返回 `202`。
- `GET /api/knowledge-bases/:id/grants`：知识库管理员读取当前授权。
- `GET /api/knowledge-bases/:id/groups`：知识库管理员读取授权表单所需的用户组 ID 和名称。
- `PUT /api/knowledge-bases/:id/grants`：知识库管理员替换授权，更新权限版本。
- `GET /api/documents/:id`：鉴权后读取文档元数据，不包含正文。
- `POST /api/documents/:id/versions`：具有维护权限时上传文档新版本，返回 `202`。
- `GET /api/documents/:id/versions`：读取版本元数据、内容摘要和处理状态，不包含正文或原件。
- `GET /api/documents/:id/source`：再次鉴权后，以纯文本返回当前生效版本的规范化原文；可指定 `versionId`，以及成对的 `startLine`／`endLine`。
- `GET /api/documents/:id/preview`：返回固定版本的页面、文字块、质量提示和 PDF 预览地址；可指定 `versionId`。待复核的最新版本只向维护者开放。
- `GET /api/documents/:id/pdf`：鉴权后返回原 PDF 或 DOC 转换后的 PDF，供同源 PDF.js 渲染；可指定 `versionId`。
- `POST /api/documents/:id/review`：维护者提交 `{ versionId, confirmed: true, changes: [{ blockId, text }] }`，核对并修正正文后原子发布。来源位置仍对应原件，保留复核者和时间。
- `GET /api/documents/:id/download`：以附件下载原件字节；可指定已成功版本的 `versionId`。
- `DELETE /api/documents/:id`：具有维护权限时删除文档，立即停止查询和来源访问。
- `GET /api/ingestion-jobs/:id`：鉴权后读取任务状态、已执行次数和失败原因。
- `POST /api/ingestion-jobs/:id/retry`：具有维护权限时重试最新失败任务，请求 `{}`，返回 `202`。
- `POST /api/search`：请求 `{ "query": "上线窗口", "knowledgeBaseIds": ["kb-engineering"], "limit": 5 }`，返回 `query`、`hits`、`method`（`keyword`／`hybrid`）、耗时、候选数量及可选 `note`。
- `GET /api/document-chunks/:id`：再次鉴权后读取指定片段及其原文定位信息。
- `POST /api/conversations`：请求 `{ "title": "发布流程", "knowledgeBaseIds": ["kb-engineering"] }`，创建当前员工的会话元数据。
- `GET /api/conversations`：列出当前员工仍有权限访问的会话。
- `GET /api/conversations/:id`：检查所有权及当前权限，返回会话和经过来源校验的历史消息。
- `POST /api/conversations/:id/messages`：提交问题并通过 SSE 接收回答。
- `POST /api/conversations/:id/runs/:runId/cancel`：检查归属并取消指定的运行，成功返回 `204`。

上传使用 `multipart/form-data`，删除不需要请求体，其余写入请求使用 `application/json`；普通 JSON 请求体上限 16 KiB，正文复核上限 2 MiB。接口拒绝跨站请求及非本机 Host；网页与 API 同源。静态文件采用固定白名单，不能访问 `.env`、数据目录或后端代码。登录失败限流按账号和客户端地址执行。

## 授权变更

权限从低到高为 `viewer`、`editor`、`admin`；属于多个用户组时采用最高权限。只有 `admin` 可以读取或修改授权。授权替换在事务内完成，必须保留至少一个有可用账号的管理组。

例如由 `alice` 为财务组增加研发知识库的阅读权限：

```json
{
  "grants": [
    { "groupId": "group-engineering", "role": "admin" },
    { "groupId": "group-finance", "role": "viewer" }
  ]
}
```

把此内容提交到 `PUT /api/knowledge-bases/kb-engineering/grants` 后，`bob` 的现有会话即可阅读研发资料，但无法修改研发知识库授权。再次提交仅包含研发组的授权列表后，`bob` 立即失去相关文档和引用该知识库的会话访问权限。

## 测试

在本目录运行指定测试：

```powershell
node --import ../coding-agent/src/experimental/source-resolver.ts --env-file-if-exists=.env --test --test-concurrency=1 test/server.test.ts test/database.test.ts test/documents.test.ts test/documents-rich.test.ts test/document-parser.test.ts test/text-processing.test.ts test/chat.test.ts test/model.test.ts test/web.test.ts test/embeddings.test.ts test/retrieval.test.ts
```

测试使用本地 HTTP 服务、内存 PostgreSQL、独立的临时持久化目录、模拟模型及模拟 OpenAI 兼容接口，不需要外部模型 API、真实文档或 Docker。

真实 PDF／Word／OCR 测试使用仓库内的合成文件，需安装下述解析环境，并设置 `KNOWLEDGE_PYTHON_PATH`。缺少解释器路径时会显式跳过这些测试。测试另外覆盖混合扫描页、旋转扫描页、Word 表格及内嵌图片、加密和损坏文件、页数限制、进程取消、复核权限、版本发布及 PDF 原件撤权。

覆盖登录与权限、上传和索引、版本与任务恢复、问答来源隔离、无资料拒答、历史撤权及删除、旧版本上下文、SSE、忙碌与取消、超时及断线、引用校验、错误脱敏、兼容 API 请求格式，以及 React 资源打包、静态文件白名单和浏览器事件流的 UTF-8／CRLF 分片处理。

仓库根目录的 `npm run check` 检查格式、依赖和 TypeScript 类型；本目录的 `npm run typecheck` 还单独检查浏览器代码，`npm run lint` 检查本模块的后端、测试及网页脚本。

## 代码入口

- [main.ts](src/main.ts)：配置和本地服务启动。
- [migrations.ts](src/migrations.ts)：数据库迁移。
- [database.ts](src/database.ts)：数据库打开、迁移和首次测试数据初始化。
- [auth.ts](src/auth.ts)：密码验证、会话及登录限流。
- [store.ts](src/store.ts)：带权限约束的数据访问。
- [documents.ts](src/documents.ts)：文档版本、入库任务、权限检查、检索与来源访问。
- [ingestion.ts](src/ingestion.ts)：后台队列、失败状态、重启恢复和删除清理。
- [text-processing.ts](src/text-processing.ts)：文本解析、结构分块和中英文检索词。
- [document-index.ts](src/document-index.ts)：分块索引写入及第一阶段文档迁移。
- [server.ts](src/server.ts)：HTTP 接口和请求校验。
- [model-config.ts](src/model-config.ts)：演示／兼容模式配置和启动校验。
- [answer-model.ts](src/answer-model.ts)：Pi Agent、模型适配和演示流。
- [chat.ts](src/chat.ts)：检索、生成、并发、取消、权限复查和引用校验。
- [chat-store.ts](src/chat-store.ts)：消息、来源关联和历史遮蔽。
- [web.ts](src/web.ts)：React 启动时打包和固定静态资源入口。
- [document-parser.ts](src/document-parser.ts)：Python 进程、时限、协议校验及带来源分块。
- [parse_document.py](parser/parse_document.py)：PDF、DOCX、DOC 转换及本地 OCR。
- [parsed-store.ts](src/parsed-store.ts)：候选版本与复核后的原子发布。
- [document-viewer.tsx](web/document-viewer.tsx)：React 原文弹窗、PDF.js 预览、页码高亮和逐块正文校对。
- [retrieval.ts](src/retrieval.ts)、[search-query.ts](src/search-query.ts)、[search-ranking.ts](src/search-ranking.ts)：查询补全、候选排序、去重与排名融合。
- [embeddings.ts](src/embeddings.ts)、[vector-index.ts](src/vector-index.ts)：兼容向量 API、后台索引和权限过滤。
- [evaluate-retrieval.ts](src/evaluate-retrieval.ts)：独立检索评测入口。
- [main.tsx](web/main.tsx)、[app.tsx](web/app.tsx)：React 挂载、登录状态和工作空间。
- [use-chat.ts](web/use-chat.ts)、[chat-panel.tsx](web/chat-panel.tsx)、[messages.tsx](web/messages.tsx)：会话、流式回答、取消和来源引用。
- [management.tsx](web/management.tsx)、[document-list.tsx](web/document-list.tsx)、[upload-form.tsx](web/upload-form.tsx)：文档处理状态、版本上传和用户组授权。
- [网页入口](web/index.html)、[设计约定](DESIGN.md)。

后续填写批准的真实模型配置，使用试点文档和问题集验证检索、答案与引用质量，再完善文档管理和正式部署设施。
