# 从 0 到 1 读懂知序知识库

本文对应 packages/company-agent 的当前实现。先沿一条使用流程读通，再深入具体算法；每个业务源码文件都补有中文职责说明，关键函数内标出了状态、权限与异步边界。

先分清两个入口：[src/main.ts](src/main.ts) 在 Node.js 服务端运行；[web/main.tsx](web/main.tsx) 在浏览器中挂载 React。网页通过 HTTP 请求服务端，不会直接访问数据库或取得模型密钥。

## 1. 先知道系统在做什么

系统完成两条相互衔接的流程：

1. 把文档变成可查资料：上传 → 保存原件与任务 → 解析/OCR → 必要时人工复核 → 分块和关键词索引 → 发布版本 → 可选向量补建。
2. 把问题变成可核对的回答：验证身份/知识范围 → 检索与组织历史 → 得到可用证据 → 生成或说明缺少依据 → 校验引用 → 保存消息 → 页面展示与原文核对。

~~~mermaid
flowchart TD
    B["浏览器：React 页面"] -->|"同源 HTTP"| S["server.ts：路由与请求校验"]
    S --> A["auth.ts：认证用户"]
    A --> D["documents.ts：文档业务"]
    A --> C["chat.ts：问答控制"]
    D --> DB[("PGlite：权限、版本、任务、消息")]
    D -. "路由调用 wake" .-> W["ingestion.ts：后台入库"]
    W --> P["文本解析 / Python PDF、Word、OCR"]
    P --> PUB["parsed-store.ts：复核或发布"]
    PUB --> DB
    C --> R["retrieval.ts：关键词与可选向量检索"]
    R --> DB
    R -. "显式开启向量模型" .-> E["embeddings.ts：兼容向量接口"]
    C --> M["answer-model.ts：Pi + 演示/兼容生成接口"]
    C --> DB
    C -->|"SSE：状态、增量、终态"| B
~~~

图中的节点是职责，不代表每个节点都有独立服务器。当前业务服务与调度器在同一 Node 进程中，PGlite 在本机运行，PDF/Word 解析会启动 Python 子进程。

### 最少需要理解的词

| 词 | 在本项目中的意思 |
| --- | --- |
| 组件 | 负责一块界面的 React 函数，例如登录表单或原文弹窗 |
| Hook | 封装 React 状态与生命周期的函数，例如 useChat |
| state / ref | state 驱动界面；ref 保存跨渲染的任务句柄、序号或 DOM 引用 |
| async / await | 函数等待网络或数据库时让出执行机会；等待期间权限、页面或任务可能已变化 |
| 事务 | 一组数据库操作一起成功或回滚，例如发布新版本 |
| 任务队列 | 数据库里等待解析的记录，worker 逐项领取执行 |
| 版本 / 分块 | 版本是一份固定原件及正文；分块是用于检索的正文片段 |
| embedding | 把文本交给配置的服务转换成数字向量，用于比较语义相似性 |
| RAG | 先检索资料，再让模型基于这些资料回答 |
| SSE | 服务端在一个 HTTP 响应中持续发送有边界的文本事件 |
| evidence / citation | evidence 是本轮使用的全部依据；citation 是答案中显式显示的引用编号 |

## 2. 第一次运行：从可控演示开始

要求 Node.js 22.19 或更新版本。依赖尚未安装时，在仓库根目录按照 [README](README.md) 使用 npm ci --ignore-scripts 安装；源码运行不需要先执行整仓构建。

下面是学习用启动方式，在仓库根目录的 PowerShell 执行：

~~~powershell
$env:KNOWLEDGE_DEMO_PASSWORD = 'replace-with-your-local-test-password'
$env:KNOWLEDGE_MODEL_MODE = 'demo'
$env:KNOWLEDGE_EMBEDDING_MODE = 'off'
$env:KNOWLEDGE_DATA_DIR = Join-Path $env:TEMP ('knowledge-learning-' + [guid]::NewGuid().ToString('N'))
npm --prefix packages/company-agent start
~~~

这里选择新的数据目录，使每次演练有独立的账号、权限和文档。目录里的数据库会保留，重新使用同一目录即可继续上次状态；换目录会得到一套新的合成数据。已有数据库不会因更换启动密码就自动重置账号密码。

打开 http://127.0.0.1:4310，使用 alice 或 bob 和刚设置的密码登录。alice 管理研发知识库，bob 管理财务知识库。先用 Markdown/TXT 跑通流程，这一步不需要 Python/OCR 环境。

演示模式会明确显示检索到的资料摘录，不调用生成模型。向量开关独立于生成开关，所以初学演练同时设置为 off；不要把“回答演示”理解为“任何配置下都不会调用外部服务”。

### 服务为什么按这个顺序启动

~~~mermaid
flowchart TD
    S1["package.json：start 脚本"] --> S2["加载源码解析器与本地环境配置"]
    S2 --> S3["src/main.ts：校验密码、端口、运行模式"]
    S3 --> S4["openDatabase：打开数据库并执行迁移"]
    S4 --> S5["seedDemo：仅为空库创建账号、权限与示例资料"]
    S5 --> S6["IngestionWorker.start：恢复中断任务并开始处理"]
    S6 --> S7["可选 VectorIndex.start：后台补建向量"]
    S7 --> S8["createKnowledgeServer：认证服务、消息恢复、网页打包"]
    S8 --> S9["listen：监听 127.0.0.1"]
    S9 --> S10["浏览器加载 HTML 和 app.js"]
    S10 --> S11["web/main.tsx：createRoot 挂载 App"]
~~~

先迁移数据库，业务服务才知道可用的表和字段。先恢复旧任务/消息，页面才不会把上次中断的任务一直当成运行中。创建服务时，[src/web.ts](src/web.ts) 将 React 打包到内存资源表，浏览器通过固定的 /assets/app.js 读取。

源码解析器属于仓库运行设施，帮助本地包从源码加载；先理解业务代码如何调用 Pi，之后再深入这个设施即可。

## 3. 按这个顺序读代码

| 阅读轮次 | 文件 | 读完应该能回答 |
| --- | --- | --- |
| 1：启动与词汇 | [main](src/main.ts)、[types](src/types.ts)、[database](src/database.ts) | 谁先启动？哪些数据在浏览器，哪些在数据库？ |
| 2：页面与登录 | [web/main](web/main.tsx)、[App](web/app.tsx)、[Login](web/login.tsx)、[client](web/client.ts)、[auth](src/auth.ts) | 登录后浏览器怎样获得身份与知识库？ |
| 3：上传与发布 | [Management](web/management.tsx)、[documents](src/documents.ts)、[ingestion](src/ingestion.ts)、[parsed-store](src/parsed-store.ts) | 为什么上传回执成功了，文档还不能马上用于问答？ |
| 4：解析与索引 | [text-processing](src/text-processing.ts)、[document-parser](src/document-parser.ts)、[Python parser](parser/parse_document.py)、[document-index](src/document-index.ts) | 原件怎样变成有行号、页码和版本的分块？ |
| 5：问答与流 | [useChat](web/use-chat.ts)、[server](src/server.ts)、[chat](src/chat.ts)、[answer-model](src/answer-model.ts)、[stream](web/stream.ts) | 一次问题怎样变成页面上逐步出现的回答？ |
| 6：检索与历史 | [retrieval](src/retrieval.ts)、[search-query](src/search-query.ts)、[search-ranking](src/search-ranking.ts)、[chat-store](src/chat-store.ts) | 追问怎样理解上文？旧资料何时不能继续使用？ |
| 7：预览与进阶 | [DocumentViewer](web/document-viewer.tsx)、[embeddings](src/embeddings.ts)、[vector-index](src/vector-index.ts)、[evaluate-retrieval](src/evaluate-retrieval.ts) | 引用怎样定位？向量何时可用？怎样验证检索？ |

每读一个函数，先找四件事：谁调用它、输入从哪里来、它改变哪份状态、结果交给谁。遇到 await，再问一句：等待期间对象是否可能被切换、删除、撤权或取消？

### 目录地图

~~~text
company-agent/
├─ package.json             启动、类型检查与评测命令
├─ LEARNING.md              本学习指南
├─ README.md                配置、接口与运行说明
├─ web/                     浏览器 React 界面
│  ├─ main.tsx / app.tsx    挂载、登录、工作空间
│  ├─ use-chat.ts           会话与生成控制器
│  ├─ stream.ts             SSE 解码器
│  ├─ management.tsx        文档与授权管理
│  └─ document-viewer.tsx   固定版本原文与复核
├─ src/                     Node 业务服务
│  ├─ main.ts / server.ts   启动与 HTTP 路由
│  ├─ auth.ts / store.ts    认证与带授权的数据访问
│  ├─ documents.ts          文档、版本、来源与检索候选
│  ├─ ingestion.ts          入库调度与恢复
│  ├─ chat.ts               问答主流程
│  ├─ chat-store.ts         消息和全部来源关联
│  ├─ answer-model.ts       Pi 模型适配
│  └─ retrieval.ts 等       查询规划、排序与向量索引
├─ parser/                  PDF、Word、OCR 子进程与合成文件生成器
├─ test/                    协议、权限、版本、解析等用例
└─ eval/                    合成检索评测问题集
~~~

## 4. 登录：从账号密码到工作空间

[App.loadWorkspace](web/app.tsx) 同时读取身份、知识库、历史和模型公开信息。已有有效 Cookie 时直接进入；没有登录时显示 Login。

~~~mermaid
sequenceDiagram
    participant L as Login / App
    participant H as server.ts
    participant A as AuthService
    participant D as PGlite
    L->>H: POST /api/auth/login（账号、密码）
    H->>A: login（账号、密码、客户端地址）
    A->>A: 检查限流并在 await 前计数
    A->>D: 读取账号密码派生结果
    A->>A: scrypt 验证
    A->>D: 保存随机会话令牌的哈希
    A-->>H: 原令牌和用户信息
    H-->>L: Set-Cookie + 用户信息
    L->>H: GET me / knowledge-bases / conversations / model
    H->>A: authenticate（Cookie）
    A->>D: 检查会话、账号和当前用户组
    H-->>L: 当前允许访问的工作空间数据
~~~

认证确认“是谁”，授权确认“能做什么”。HttpOnly Cookie 由浏览器自动带回，React 不读取令牌。后端不接受前端提交一个 userId 来冒充其他人；知识库授权由用户组关系计算。

## 5. 上传：从文件到可检索的版本

先创建一个 UTF-8 的 learning-release.md，通过“知识管理”上传：

~~~markdown
# 学习演练发布流程

学习演练发布前需要完成代码审查和自动化测试。
学习演练的上线窗口由发布负责人安排。

## 异常处理

发现异常时先通知值班人员，再按回滚流程处理。
~~~

### 一份文件经过哪些函数

~~~mermaid
flowchart TD
    U1["UploadForm：选择 File 与标题"] --> U2["Management.upload：校验并发送 FormData"]
    U2 --> U3["server：认证 + requireUploadAccess"]
    U3 --> U4["DocumentService.upload：事务保存原件、版本和任务"]
    U4 --> U5["HTTP 202：返回 documentId / versionId / jobId"]
    U5 --> UI["管理区轮询文档状态"]
    U4 -->|"server 调用 wake"| U6["IngestionWorker.claim：领取 queued 任务"]
    U6 --> U7["parse：文本直读，PDF/Word 调 Python"]
    U7 --> U8{"解析是否有质量警告？"}
    U8 -->|"无"| U9["publishParsedDocument：分块和关键词索引"]
    U8 -->|"有"| U10["needs_review：保留候选正文，等待维护者复核"]
    U10 --> U11["DocumentViewer 编辑正文块并确认"]
    U11 --> U12["approveReview：重新验证版本与权限"]
    U12 --> U9
    U9 --> U13["事务内切换 currentVersionId，任务 succeeded"]
    U13 --> UI
    U13 -. "后台另行扫描，且需开启向量" .-> U14["VectorIndex：补建当前 profile 的向量"]
    U7 -->|"解析失败"| UF["failed：保留旧生效版本，允许受限重试"]
    UF --> UI
~~~

1. UploadForm 只收集文件和标题，网络请求在 Management 中。
2. 服务端先检查维护权限，再读取有大小上限的表单；事务中会再次检查权限。
3. upload 建立原件、版本和任务，推进 latestVersionId。此时不推进 currentVersionId。
4. HTTP 202 只表示“已接受”。server 唤醒 worker，页面开始观察后端状态。
5. worker 从数据库领取任务并增加 attempts；任务内容不靠一次内存回调长期保存。
6. 文本交给 parseTextDocument；PDF/Word 交给 Python，最终都变成正文、分块、位置和警告。
7. 无警告时发布；有警告时先进入 needs_review，维护者确认后才发布。
8. 发布事务保存正文和关键词索引、切换生效版本并结束任务。向量补建是之后独立的后台工作。

### 两个版本指针为什么不能合并

| 时刻 | latestVersionId | currentVersionId | 用户看到什么 |
| --- | --- | --- | --- |
| 首次上传 v1，仍在处理 | v1 | null | 排队/处理中，尚无可查询正文 |
| v1 成功发布 | v1 | v1 | v1 可检索和查看 |
| 上传 v2，仍在处理或待复核 | v2 | v1 | 新版状态变化，旧版继续服务 |
| v2 失败 | v2 | v1 | 可看失败原因，v1 仍可用 |
| v2 成功发布 | v2 | v2 | 新查询使用 v2，旧引用仍固定到 v1 |

v1/v2 是讲解用标签，真实 versionId 由服务端生成。文档元数据的 status 描述最新版本，而 version/currentVersionId 描述当前生效版本。

### 入库任务的状态图

~~~mermaid
stateDiagram-v2
    [*] --> queued: 接受上传
    queued --> processing: 领取任务并增加次数
    processing --> succeeded: 解析与发布成功
    processing --> needs_review: 发现质量警告
    needs_review --> succeeded: 人工确认并发布
    processing --> failed: 解析失败或次数耗尽
    processing --> queued: 进程中断且仍有剩余次数
    failed --> queued: 手动重试最新版本且未到上限
    needs_review --> queued: 手动重新解析且未到上限
    queued --> cancelled: 文档被删除
    processing --> cancelled: 文档被删除
    needs_review --> cancelled: 文档被删除
    succeeded --> [*]
    cancelled --> [*]
~~~

这是任务状态，不是文档状态。任务成功叫 succeeded，文档版本可用叫 ready。普通解析错误不会无限自动重试；当前每个任务最多执行三次。

### 解析和分块先看哪里

- [text-processing.ts](src/text-processing.ts)：UTF-8 解码、换行统一、Markdown 章节、段落切分、重叠和行号/偏移。1200 和 160 是默认 UTF-16 长度单位，不是模型 token。
- [document-parser.ts](src/document-parser.ts)：Node 子进程管理和统一输出结构。关键点是超时、取消、JSON-lines 进度、结果结构验证以及临时目录清理。
- [parse_document.py](parser/parse_document.py)：按页选择文字提取或 OCR；DOCX 用正文块定位。少量文字层不保证扫描正文已经被读取。
- [document-index.ts](src/document-index.ts)：将分块及标题/章节词项写入关键词索引；索引和查询复用分词规则。

## 6. 提问：从发送按钮到最终回答

在知识问答中选择研发知识库，输入“学习演练的上线窗口由谁安排？”。重点跟踪 useChat.submit → server 路由 → ChatService.prepare/execute。

### 请求与事件的时序

~~~mermaid
sequenceDiagram
    participant B as useChat
    participant H as server.ts
    participant C as ChatService
    participant D as ChatStore / PGlite
    participant R as RetrievalService
    participant M as AnswerModel / Pi
    B->>H: 首次发送时创建会话
    H-->>B: conversationId 与固定知识范围
    B->>H: POST conversations/:id/messages
    H->>C: prepare（当前员工、会话、问题）
    C->>D: 验证会话并保存本轮消息占位
    C-->>H: ChatRun
    H-->>B: text/event-stream 响应头
    H->>C: execute（事件发送函数）
    C-->>H: emit start + retrieving 状态
    H-->>B: 写入 SSE 事件
    C->>D: 读取当前可见历史
    C->>R: search（问题计划、固定知识范围）
    R-->>C: hits 与检索过程信息
    C->>C: 编号、补充合法历史、限制上下文
    alt 最终 evidence 为空
        C-->>H: emit 缺少依据说明
        H-->>B: 写入 delta
    else 有可用 evidence
        C->>M: generate（问题、历史、证据、取消信号）
        loop 文本增量
            M-->>C: onText
            C->>D: 复查会话与来源权限
            C-->>H: emit delta
            H-->>B: 写入 delta
        end
        M-->>C: 完整正文与用量
    end
    C->>C: 校验引用编号与回答边界
    C->>D: complete：保存答案及全部来源
    C->>D: 按当前权限重新读取消息
    C-->>H: emit sources + done
    H-->>B: 写入最终事件
    B->>H: 回读会话列表与历史
    H-->>B: 最终持久化状态
~~~

ChatService 调用 emit 回调，server.ts 再把事件写入 HTTP 响应。发生错误或取消时会走 error/finally，不继续沿成功路径保存和发送 done。

### 按函数一步步跟

1. **useChat.submit：** 取得本轮问题快照，同步把 generationRef 占住，再更新 busy。首次提问先创建会话，随后展示用户问题与助手占位。
2. **server 路由：** 从 Cookie 认证员工，只接收 content；准备阶段出错可返回普通 HTTP JSON 错误。
3. **ChatService.prepare：** 检查会话归属和知识范围，检查并发，先在 runs 中同步登记再 await 保存消息。一轮用 runId 关联用户消息与助手消息。
4. **ChatRun.execute：** 启动超时，发送开始与检索状态。此后业务失败通过 SSE error 表达，不能只看 HTTP 200。
5. **历史与查询计划：** ChatStore 先根据当前权限遮蔽历史；planSearch 再决定是否借用上一轮主题，生成有界检索计划。
6. **检索：** 关键词路径先检查完整权限范围；向量模式启用时检查索引覆盖，再决定关键词提示、索引未齐错误或双路融合。
7. **组织证据：** 新来源由服务器编号；addHistory 可能向同一个 evidence 数组补入合法历史来源，并重排引用编号。
8. **选择回答路径：** 判断的是最终 evidence 是否为空，不只是本次 hits 是否为空。为空时说明缺少依据；非空时调用 AnswerModel。
9. **生成增量：** AnswerModel 每轮创建独立 Pi Agent；文本增量交回 ChatService，检查长度、会话和来源访问，再发给网页。
10. **最终校验与保存：** 检查正文和引用编号，保存答案、用量、检索信息及全部来源，再按当前权限读回并发送 done。
11. **页面收尾：** stream.ts 解码，useChat 按事件更新状态，并回读服务端历史校准占位消息。ChatPanel/Messages 根据 state 重新渲染。

### React 中最容易混淆的状态

| 对象 | 保存什么 | 为什么这样做 |
| --- | --- | --- |
| question/messages/busy 等 state | 当前界面需要显示的内容 | 改变时触发 React 渲染 |
| currentRef | 异步操作使用的最近确认会话 | 不依赖旧回调捕获的会话值 |
| generationRef | 正在进行的一轮生成及取消控制器 | 即时防重复，识别旧任务回调 |
| view 序号 | 当前会话视图的代次 | A 后返回时不能覆盖已经打开的 B |
| epoch 序号 | 当前组件生命周期 | 卸载后的旧请求不能更新新工作空间 |
| refreshController | 终态后的历史回读 | 退出时连同数据回填一起取消 |

取消请求用来减少无用工作，序号/身份检查用来决定旧结果能否更新界面。它们作用不同；只做其中一个，难以完整解释异步生命周期。

### SSE 如何从字节变成消息

[stream.ts](web/stream.ts) 不操作 React。它只完成：

~~~text
reader.read() 的任意字节块
→ TextDecoder 连续解码 UTF-8
→ 保留跨块 CR，统一换行
→ 缓冲直到遇到空行边界
→ 合并 data 行并解析 JSON
→ 检查事件类型和终态
→ onEvent 交给 useChat
~~~

| 事件 | 服务端表达什么 | 当前页面怎么使用 |
| --- | --- | --- |
| start | 服务端 runId、messageId | 记录精确取消任务所需 ID |
| status | 检索/回答阶段及可选提示 | 更新生成状态文字 |
| delta | 尚待最终校验的正文片段 | 函数式追加到助手占位消息 |
| sources | 服务端确认的引用列表 | 协议接受此事件，当前页面以 done 的完整消息确认来源 |
| done | 完整成功消息 | 替换占位内容并进入收尾回读 |
| error | 失败或取消 | 显示对应状态，不把未完成内容当作成功答案 |

一块网络数据不等于一个完整字符，也不等于一个完整事件。连接结束而没有 done/error，解析器会认为回答被截断。这个原则由 [web.test.ts](test/web.test.ts) 中的分片与截断用例验证。

## 7. 可选向量检索在哪里接入

先跑通纯关键词，再读这条路径：

~~~mermaid
flowchart TD
    R1["RetrievalService.search"] --> R2["DocumentService.search：权限 + 当前版本 + 关键词候选"]
    R2 --> R3{"向量已开启且有有效词？"}
    R3 -->|"否"| K["关键词去重与选择"]
    R3 -->|"是"| R4["VectorIndex.coverage：当前授权范围的覆盖情况"]
    R4 --> R5{"索引是否齐备？"}
    R5 -->|"未齐且有关键词结果"| KN["返回关键词结果并说明索引更新中"]
    R5 -->|"未齐且无关键词结果"| ER["返回索引未齐错误"]
    R5 -->|"齐备且有可索引内容"| R6["问题向量化 + 实时权限条件下的精确距离查询"]
    R6 --> R7["fuseRanks：按排名融合"]
    R7 --> R8["selectSources：重复摘录与文档占位控制"]
    R8 --> OUT["SearchResult"]
    K --> OUT
    KN --> OUT
    R5 -->|"没有可索引内容"| K
~~~

[VectorIndex.indexPending](src/vector-index.ts) 在后台找出已发布却缺少当前 profile 向量的片段。网络请求在数据库写事务之外，写回时再次检查版本是否仍生效、文档是否删除。

[embeddings.ts](src/embeddings.ts) 检查服务返回的条数、index、维度和数值，并归一化。模型配置通过 profileId 隔离，不能把不同模型产生的向量直接混用。

[search-ranking.ts](src/search-ranking.ts) 的 RRF 按名次融合，当前每路贡献为 1 / (40 + 排名)。它没有把两种尺度不同的原始分数直接相加，也不是独立训练的重排序模型。

这些都是当前实现细节，不代表经过真实业务数据验证的最优参数。实际检索质量与生成事实正确性要分别评测。

## 8. 停止、断线和错误怎样结束

~~~mermaid
flowchart TD
    C1["用户点击停止"] --> C2["useChat.stop"]
    C2 -->|"已有 runId"| C3["POST 精确会话 / run 的取消接口"]
    C3 --> C4["ChatService.cancel：验证归属并 abort"]
    C2 --> C5["finally 取消浏览器读取"]
    C5 --> C6["HTTP close 触发 run.abort"]
    C7["本轮超时"] --> C4
    C4 --> SIG["共享 AbortSignal"]
    C6 --> SIG
    SIG --> M["AnswerModel 通知 Agent.abort"]
    SIG --> END["execute：记录 error/cancelled，释放名额"]
    END --> VIEW["连接仍可用时发送 error；页面按终态/回读收尾"]
~~~

“停止显示文字”“结束应用等待”“让上游服务停止计算”不是同一个动作。当前会传递取消信号，并让应用有界地结束等待；上游是否立即停止计费取决于供应商。

失败路径同样值得读：

- 参数、身份、范围或并发检查失败：prepare/路由阶段返回普通 HTTP 错误。
- 检索故障：作为故障返回，不能说资料不存在。
- 无可用依据：给出明确说明，不调用生成模型猜测事实。
- 引用编号无效、空答案、答案过长：不按正常成功路径完成。
- 普通断线：不自动重发生成请求，避免重复模型调用。
- 服务重启：恢复文档任务状态；中断的回答标记失败，不重放付费生成。

## 9. 点击引用以后，如何回到原文

~~~mermaid
flowchart TD
    V1["Messages：点击合法引用编号"] --> V2["App：创建独立 SourceRequest"]
    V2 --> V3["DocumentViewer：检查同源来源 URL"]
    V3 --> V4["GET preview：固定 versionId 并再次鉴权"]
    V4 --> V5{"是否有 PDF？"}
    V5 -->|"有"| V6["GET pdf：鉴权后读取字节"]
    V6 --> V7["PDF.js Worker 渲染指定页"]
    V7 --> V8["归一化来源矩形乘画布尺寸，高亮区域"]
    V5 -->|"无"| V9["显示规范化正文/指定行号或正文块"]
    V4 --> R["若是待复核版本：维护者编辑正文块并确认"]
    R --> P["POST review：验证最新版本后发布"]
~~~

PDF 有真实页码与区域；DOCX 用正文块标签，不能把每组复核正文当作原文件页码。PDF 切页前先取消并等待旧 RenderTask，关闭时销毁加载任务，避免同一画布被多个异步操作同时使用。

### 为什么历史答案也要重新查权限

假设第一轮用了文档 A，第二轮检索到 B，同时借用了第一轮历史。即使第二轮最终只显示 B 的引用，它也可能受 A 影响。因此 [ChatStore.complete](src/chat-store.ts) 保存全部 evidence，并用 cited 标记显式引用。

读取历史时，原本的来源关联若不能全部通过当前检查，就遮蔽答案正文和引用。文档正文被清理后，关联 ID 仍保留，避免误以为这是一条本来就不依赖资料的答案。

需要区分版本和权限：

- 新问题检索 current 版本；新一轮历史上下文也要求来源仍为 current。
- 旧引用固定到旧 ready 版本，只要当前仍有权限就可以回看。
- 一轮已开始的回答使用固定来源版本，交付期间继续检查可访问性；发布新版本不等于删除旧版本。
- 删除或撤权限制后续访问，不能追溯撤回已经发送到用户浏览器或上游服务的内容。

## 10. 核心 API 与输入输出

这些是代码中的导出/公开调用边界，不是另一个 HTTP API 清单。完整 HTTP 地址见 [README](README.md)。

| API | 输入 → 输出 | 谁调用 |
| --- | --- | --- |
| openDatabase(dataDirectory?) | 可选目录 → 已迁移的 PGlite | main、独立测试/评测 |
| createKnowledgeServer(database, options) | 数据库与业务服务 → Node Server | main |
| DocumentService.upload(userId, target, input) | 身份、知识库/文档、原件 → UploadReceipt | HTTP 上传路由 |
| IngestionWorker.start / wake | 恢复或唤醒任务 → 后台处理 | main、上传/重试/删除路由 |
| createDocumentParser(options?) | 配置 → DocumentParser 函数 | IngestionWorker |
| publishParsedDocument(transaction, versionId, parsed, reviewer?) | 事务连接与解析结果 → 是否发布 | worker、approveReview |
| RetrievalService.search(userId, request, options?) | 身份与检索计划 → SearchResult | HTTP 搜索、ChatService |
| ChatService.prepare(...) | 身份、会话、问题、认证回调 → ChatRun | 消息路由 |
| ChatRun.execute(emit) | 事件发送函数 → 一轮执行结束 | server 的 SSE 分支 |
| AnswerModel.generate(input) | 问题、历史、证据、signal、onText → 完整答案与用量 | ChatService |
| useChat(options) | 知识库与页面回调 → 状态和操作控制器 | Workspace |
| readChatStream(response, onEvent) | HTTP 流响应 → 解码后的事件回调 | useChat |

### 依赖关系

- 浏览器上游是用户操作，下游是同源业务 API。
- 业务 API 上游是经过认证的请求，下游是存储、文档、检索和聊天服务。
- Pi Agent / pi-ai 提供模型调用与事件能力，本应用负责其前后的权限、证据和生命周期。
- Python 解析依赖提供格式/OCR 能力，本应用负责输入限制、进度、结果验证和复核发布。
- PGlite 与 vector 扩展提供存储/查询能力，本应用定义授权条件、版本语义和任务状态。

## 11. 做三个小实验，确认自己真的读懂

### 实验一：一份 Markdown 走完闭环

使用上面的独立学习目录，以 alice 上传样例，观察状态变为可用于问答。发送关于学习演练的问题，查看增量、最终引用，再点击原文。

同时在浏览器 Network 中找出上传 POST、文档轮询 GET、创建会话 POST、消息 POST、历史 GET 和原文 preview 请求。把每个请求对应到 server.ts 的分支。

完成标准：能分别指出文件保存、关键词可用、答案完成发生在哪个函数，而不是都称为“接口成功”。

### 实验二：新版失败，旧版为什么还在

在样例文档的“更新”中上传一个仅包含几个空格的文本文件。文件并非零字节，可能被接受进入后台；解析时会发现没有有效正文并失败。

观察最新状态与当前版本，再查看之前的引用。沿 DocumentService.upload 和 publishParsedDocument 查找：失败路径为什么没有推进 currentVersionId？

完成标准：能解释 queued/failed、latest/current、版本 ID/文档 ID 各自含义。

### 实验三：权限与历史来源

使用独立浏览器会话分别登录 alice、bob。先验证 bob 不能读研发资料；由 alice 暂时授予财务组阅读研发知识库的权限，bob 刷新后创建相关问答；再由 alice 撤销该授权。

bob 下一次刷新历史或请求原文时应重新受到权限约束。只在独立学习数据库演练，保留至少一个有效管理组。观察当前浏览器中已经显示的文字与后续服务端读取结果有什么区别。

完成标准：能从 AuthService、documentAccess、requireConversation 和 ChatStore.history 说明各自的责任。

## 12. 怎样验证学习中的改动

代码变更后按仓库规则运行：

~~~powershell
npm run check
npm --prefix packages/company-agent run typecheck
~~~

它们主要验证格式、依赖约束、类型与打包边界，不能代替业务测试。需要验证某条业务规则时，从 [test](test) 找到对应的具体用例，按 [仓库 AGENTS.md](../../AGENTS.md) 运行指定测试；不要直接运行全量测试或为了学习执行真实模型调用。

当前有一条已知旧用例在 [chat.test.ts](test/chat.test.ts) 中仍断言初始 HTML 包含 question-form，并检查迁移前的脚本资源。React 现在由 root 挂载，相关测试契约需要同步；这次学习注释没有顺手修改该用例。不要因此把“类型/专项检查通过”写成“全部业务测试已通过”。

需要自测检索时，可以阅读并运行 eval:retrieval：默认用独立内存库和合成数据，衡量来源检索与无结果判断。它不衡量真实生成事实正确性；--hybrid 会显式启用已配置的向量服务。

## 13. 暂时不用深入的部分

先用文本、关键词与演示模式读通。之后再依次深入 PDF/OCR 的格式差异、向量索引的模型版本、Pi 事件适配以及正式部署需要的身份和存储设施。

当前没有自动多 Agent 规划、模型训练、生产 SSO、分布式任务集群、近似向量索引或浏览器断线事件重放。读图时只跟随实际实现，不把依赖能做的事或实施草案当成已经接通的路径。
