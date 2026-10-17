# @earendil-works/pi-env

为 [Pi Durable](../durable) 提供的远程执行环境：agent 的工具在另一台机器上运行（通常通过 SSH），而 Durable worker、其存储和凭据留在本地。

- `pi-env`（`daemon/`）：一个运行在远程机器上的小型 Rust 程序。它在 stdin 和 stdout 上使用分帧协议（[docs/protocol.md](docs/protocol.md)），并在该机器上执行文件操作和命令。
- `RemoteExecutionEnv`：一个 Durable `ExecutionEnv`，通过 `Connection` 与守护进程通信。其结果与在远程机器上运行的 `NodeExecutionEnv` 一致；只有错误信息可能不同（[docs/semantics.md](docs/semantics.md)）。

```ts
import { acceptHostKey, connectSsh, RemoteExecutionEnv, scanHostKey, sshConnection } from "@earendil-works/pi-env";

const target = { host: "gpu-box", knownHostsFile: "/data/ssh/known_hosts", hostKeyAlias: "pi-env-gpu" };
// 一次性的操作：把主机密钥指纹展示给所有者，由其带外比对后接受。
const { lines, fingerprints } = await scanHostKey(target);
await acceptHostKey(target, lines);

// 自动检测远程系统，缺失时部署守护进程（以其 SHA-256 命名，每次启动前校验），
// 并返回一个通过 ssh 启动它的连接。
const { connection } = await connectSsh(target);
const env = new RemoteExecutionEnv({ connection, id: "pi-env:gpu", cwd: "/home/me/project" });

// 或者惰性模式：在第一次操作之前什么都不发生，该操作会检测、部署并连接。
// 失败（无网络、主机密钥不受信任）会作为该操作的错误抛出，下一次操作会重试。
const lazy = sshConnection(target);
const lazyEnv = new RemoteExecutionEnv({ connection: lazy.connection, id: "pi-env:gpu", cwd: "/home/me/project" });
```

该包在 `bin/` 中为每个受支持的远程系统提供守护进程。`ssh` 以 `BatchMode` 运行，使用固定别名对应用自己的 known-hosts 文件做严格主机密钥校验，不转发任何内容，不使用共享连接或配置的命令，也不转发本地 locale。在 Windows 上，检测和部署通过 PowerShell 进行，守护进程通过服务器的默认 shell（cmd.exe 或 PowerShell）启动。

`env.listFiles(path, options, context)` 列出守护进程内某个目录之下的目录树，行为等同 `fd --hidden --exclude .git` 且不跟随符号链接：以相对 `/` 路径列出文件、目录和链接，跳过 git 在工作树内忽略的内容，受 `maxEntries`、`maxBytes` 和 `timeoutMs` 限制并带 `truncated` 标志，可通过中止 context 停止。它是 Durable 可选的 `ExecutionEnv.listFiles`。早于此功能发布的守护进程会报告 `not_supported`（`hello.features` 缺少 `listFiles`），调用者回退到自己的遍历实现。对于本地会话，`LocalExecutionEnv` 是 `NodeExecutionEnv` 加上通过同机守护进程实现的 `listFiles`：

```ts
const local = new Connection({ command: [localDaemon()] }); // 由调用者持有；关机时调用 close()
const env = new LocalExecutionEnv({ cwd: "/home/me/project", connection: local });
const listing = await env.listFiles(".", { exclude: ["node_modules"] }, context);
// { ok: true, value: { entries: [{ path: "src", kind: "directory" }, { path: "src/a.ts", kind: "file" }], truncated } }
```

`nodePlatform(await connection.info())` 以 Node 的命名（`win32`、`darwin`、`x64`、`arm64`）返回远程系统，与 `process.platform` 和 `process.arch` 的写法一致。

`openTerminal(connection, options)` 在守护进程的伪终端中运行一个程序（默认是用户的登录 shell）：提供原始输出、输入、调整大小和退出码，用于交互式终端。`localDaemon()` 是本机的守护进程，用于不经过 SSH 的终端（`new Connection({ command: [localDaemon()] })`）。Windows 尚不支持终端。

受支持的远程系统：Linux、macOS、Android（Termux）和 Windows，x86-64 与 arm64 架构。在 Windows 上，字符串命令通过 Git Bash 运行，与 `NodeExecutionEnv` 在该平台的行为一致；argv 命令直接运行。

## 开发

`npm run build:daemon` 用 Cargo 构建守护进程；测试通过管道与 `daemon/target/debug/pi-env` 通信，或与 `PI_ENV_DAEMON` 指定的二进制通信（CI 就是这样测试 release 构建的）。测试对 `RemoteExecutionEnv` 运行 Durable 的 env 一致性套件，并在同一台机器上把随机操作序列和 Durable 工具与 `NodeExecutionEnv` 对比。设置 `PI_ENV_SSH_HOST` 时，`test/ssh-external.test.ts` 会通过真实 SSH 服务器运行该套件。
