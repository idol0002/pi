# Pi evals

Pi 编码 agent 的行为评估（eval），基于 `vitest-evals` 构建。

## 文件约定

评估定义平铺在 `evals/` 下：

- `*.docs.eval.ts` 是文档提升（documentation-lift）评估。`eval:docs` 在隔离的 `without_docs` 和 `with_docs` 容器中运行每个用例并报告提升幅度。
- 其他 `*.eval.ts` 文件是宿主（host）评估。`eval:host` 在本机用 Vitest 运行它们。它们是普通的 vitest-evals 套件，不是成对比较。

运行器代码在 `src/` 下：

- `cli.ts` 编排一次比较
- `docker.ts` 构建两个镜像、发现用例并运行一个隔离分支
- `plan.ts` 把用例展开为 `(case, variant, repetition)` 任务
- `report.ts` 读取 Vitest JSON、配对分支并计算提升幅度
- `harness.ts` 是 vitest-evals 适配器

评估套件及其 fixtures 在 `evals/` 下。镜像构建文件在 `docker/` 下。

## 运行评估

宿主评估（冒烟、文档审计）和文档提升评估需要 `PI_PROVIDER` 和 `PI_MODEL`。

```bash
PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol npm run eval -w packages/evals
```

这会先运行宿主评估，再运行文档比较。`--` 之后的额外 CLI 参数只传给 `eval:docs`。

仅宿主评估：

```bash
PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol npm run eval:host -w packages/evals
```

单个宿主套件：

```bash
PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol \
  npm run eval:host -w packages/evals -- evals/documentation-audit.eval.ts
```

## 运行文档比较

从仓库根目录：

```bash
npm run eval:docs -w packages/evals -- \
  --provider openai-codex \
  --model gpt-5.6-sol
```

`PI_PROVIDER` 和 `PI_MODEL` 提供相同的默认值。两个值都是必需的。

默认每个变体运行一次。测量稳定性时显式增加重复次数：

```bash
npm run eval:docs -w packages/evals -- \
  evals/extensions.docs.eval.ts \
  --runs-per-variant 5
```

`PI_EVAL_RUNS_PER_VARIANT=5` 等效。Vitest 过滤器在发现阶段生效：

```bash
npm run eval:docs -w packages/evals -- -t "adds the model"
```

运行器的步骤：

1. 为 Docker 构建临时挂载仓库，用仓库的 consumer-install 机制打包当前 workspace 包，然后从暂存的运行时创建独立的 `without_docs` 和 `with_docs` 镜像。
2. 在两个镜像中发现所选用例，并要求两者用例完全一致。
3. 执行前规划每个 `(case, variant, model, runNumber)` 分支。
4. 在全新容器中运行每个分支。失败或缺失的分支会被记录，规划好的用例组继续执行。
5. 报告存在时，通过 `@vitest-evals/core/node` 读取原生 Vitest JSON。
6. 精确配对分支并写入比较报告。被阻塞的配对会扣留总体提升幅度；进程以非零码退出。

重复顺序按运行编号交替，以减少顺序偏差。

## 文档变体

`without_docs` 移除 coding-agent 的 `README.md`、`CHANGELOG.md`、`docs/` 和 `examples/`，然后从默认系统提示词中删除 Pi 文档路由章节。

`with_docs` 包含这些文件，并使用不变的默认提示词。

两个变体安装相同的本地 workspace tarball。已有的 npm overrides 确保 coding-agent 内部的 Pi 依赖同样来自当前仓库而不是注册表。内部依赖包的文档和源码文件被对称移除，以免它们充当替代指令。启动时校验镜像允许列表，并验证安装的 coding-agent 包从 `dist/` 解析。评估定义、评分辅助函数、fixtures 和 Vitest 配置归 root 所有，在 harness 永久降权到无特权 UID 之后不可读。每次运行都获得全新的 home、agent 目录、工作区、会话目录和容器文件系统。

文档评估默认只允许 `read`、`write`、`edit`、`grep`、`find` 和 `ls`。它们不暴露 shell 或 web-search 工具。提供商流量仍需要容器网络访问，因此仅靠 Docker 无法证明 agent 编写的任意代码从不使用网络。

## 结果

每次调用都会创建一个被忽略的 `.eval/<timestamp>_<id>/` 目录，包含：

- `protocol.json`：模型、镜像 ID、用例、任务和协议摘要。
- `expected-runs.json`：完整的规划用例组。
- `observations.jsonl`：归一化的结果与遥测。
- `tasks/*/vitest.json`:每个隔离分支的原生 JSON。
- `<variant>/sessions/*/session.jsonl`：原生 Pi 会话。
- `report.json` 和 `report.txt`：配对比较。

只有当两个分支都恰好产生一个分数时，该配对才计入通过率提升。缺失、重复、跳过、待定、未评分或出错的分支会阻塞该配对。如果评估集中任何配对被阻塞，总体通过率会被扣留。缺失的遥测保持不可用状态，而不是当作零处理。

报告会标记无提升、负向变化、饱和的对照组或实验组，以及观察到的抖动。一次重复无法证明稳定性。

产物可能包含提示词、响应、生成的代码和工具输出。

## 编写评估

每个用例使用一个普通的 `describeEval(...)` 套件和一次显式的 `run(...)` 调用：

```ts
import { describeEval, StructuredOutputJudge } from "vitest-evals";
import { createPiDocumentationEvalHarness } from "../src/harness.ts";

const harness = createPiDocumentationEvalHarness();
const judge = StructuredOutputJudge({ expected: { ok: true }, match: "strict", allowExtras: false });

describeEval("Target workflow", { harness, judges: [judge], judgeThreshold: null }, (it) => {
  it("completes the task", async ({ run }) => {
    await run("Complete the target task.");
  });
});
```

外层运行器负责变体、重复、隔离、身份、持久化和报告。评估文件应只包含场景设置、模型任务和确定性评分。

比较性评分使用 `judgeThreshold: null`。低分是数据，不是基础设施故障。Vitest 断言只用于套件不变量被破坏的情况。
