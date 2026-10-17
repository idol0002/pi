# pi-env 线上协议

版本 1。client 启动 `pi-env serve --token <hex>`（经由 `ssh`，或在测试中直接启动），并通过该进程的
stdin 和 stdout 与之通信。stderr 是仅供日志使用的诊断文本。

## 同步

shell 的启动文件可能在守护进程运行之前向 stdout 打印内容。守护进程的第一行输出是
`PI-ENV <token>\n`，token 来自其命令行。client 丢弃该行之前的所有内容。此后，stdout 只承载帧。

## 帧

每个帧（双向相同）：

```text
u32 length      本字段之后的字节数
u8  type
u32 id          请求 id；不属于任何请求的帧为 0
u32 jsonLength
json            UTF-8 JSON 对象，jsonLength 字节
bytes           原始负载，即剩余的 length - 9 - jsonLength 字节
```

所有整数都是大端序。一帧最多 16 MiB；更大的传输由 client 拆分。JSON 无法解析的请求会收到 `EINVAL`
错误；帧格式错误会终结连接。

| type | 名称 | 方向 | 含义 |
|---|---|---|---|
| 1 | request | client → daemon | `json.op` 指明操作 |
| 2 | result | daemon → client | 请求 `id` 成功；该请求结束 |
| 3 | error | daemon → client | 请求 `id` 失败；该请求结束 |
| 4 | event | daemon → client | 运行中请求的进度（`exec` 和 `pty` 输出、`watch` 变更），不结束请求 |
| 5 | cancel | client → daemon | 取消请求 `id`；见下文 |
| 6 | ping | 双向 | 存活检测；接收方忽略它 |

错误是 `{ code, message, syscall?, path? }`。`code` 是 Node 风格的错误码（`ENOENT`、`EISDIR`、
`ERR_FS_EISDIR` 等）或执行类错误码之一：`shell_unavailable`、`spawn_error`、`timeout`、`aborted`、
`unknown`。message 仅用于诊断；契约中只有 code。

路径是绝对路径的 JSON 字符串；client 在发送前解析相对路径、`~` 和 `file://` URL。字符串以合法形式发送
（孤立代理对变为 U+FFFD）并编码为 UTF-8，与 Node 编码字符串路径和参数的方式一致。文件内容和输出以
原始负载字节传输。

## 取消

一个 cancel 针对一个请求。守护进程在运行每个请求之前先注册它，因此在请求之后立即发出的 cancel 绝不会
丢失。`exec` 和 `pty` 杀掉命令的进程组并以 `aborted` 结束；`{ mode: "kill" }` 杀掉进程但不视为中止，
因此命令以被杀进程的状态结束，与 `cleanup()` 一样。`scanLines` 在块之间停止，`listFiles` 在条目之间
停止，均以 `aborted` 结束。`watch` 停止并以 `{}` 结束。其他操作都很短，正常结束。

## 调度

文件操作在固定大小的 worker 线程池上运行；`exec`、`pty` 和 `watch` 各自运行在自己的线程上。
`ptyWrite`、`ptyResize` 和 `ptyForeground` 由读取帧的线程按到达顺序应答，因此按键永远不会错序。对同一
句柄的块写入按到达顺序执行。结果、错误、ping 和 `watch` 事件先于排队的命令输出发送；负载超过 64 KiB
的结果也排在输出之后，因此慢速链路延迟的是批量数据而不是应答。没有输出窗口的命令，在超过 4 MiB 的输出
未发送时其输出会等待，这会像管道写满一样拖慢该命令。

## 存活检测

双方每 5 秒发送一次 `ping`。守护进程在 30 秒内未收到任何字节或 stdin 结束时，会杀掉它启动的所有进程组
并退出。因此连接断开会停止远程命令。client 对失联连接上的请求以 `{ code: "unknown", lost: true }` 失败，
并在下一个请求时启动新的守护进程；句柄属于打开它们的守护进程，因此在它们上的请求会失败，而不是到达新
的守护进程。

## 操作

`hello { protocol }` → `{ protocol, version, os, arch, home, tmpdir, cwd, driveCwds, pid, features }`。第一个
请求。`version` 是守护进程随附的 npm 包版本；`os` 和 `arch` 是 Rust 的 `std::env::consts` 值（`linux`、
`android`、`macos`、`windows`；`x86_64`、`aarch64`），client 的 `nodePlatform` 把它们映射为 Node 的
名称；`tmpdir` 遵循远程 Node 的 `os.tmpdir()` 规则；`cwd` 和 `driveCwds`（Windows 的 `=C:` 变量）是
Node 的 `path.resolve` 在盘符相对路径时的回退值。`features` 列出协议 1 首次发布之后新增的操作
（`listFiles`）；旧守护进程省略该字段并把那些操作当作未知而拒绝，因此 client 应先检查它。

文件操作接收 `{ path }`（以及所列字段），除非另有说明，返回 `{}`：

| op | 字段 | 结果 |
|---|---|---|
| `lstat` | | `info` |
| `realpath` | | `{ path }` |
| `write` | `append`、`parents?`（默认 true）、`keep?`、payload | 像 Node 的递归 `mkdir` 一样创建缺失的父目录，像 `writeFile`（`w`）或 `appendFile`（`a`）一样打开，写入 payload；带 `keep` 时返回 `{ handle }` 供 `writeChunk` 使用 |
| `writeChunk` | `handle`、payload | 追加到一个保留的写入句柄；某块失败后，后续块以 `EBADF` 失败 |
| `truncate` | `size` | |
| `fsync` | | |
| `rename` | `to` | |
| `mkdir` | `recursive` | |
| `rm` | `recursive`、`force` | Node `fs.rm` 语义 |
| `mkdtemp` | （`path` 是前缀） | `{ path }` |
| `open` | `noFollow`、`mode?` | 供 `openBinaryReader` 使用的 `{ handle, info }`：非阻塞，仅限普通文件。`mode: "read"` 时为对任何文件的 Node `open(path, "r")`，阻塞：`{ handle, stat }` 或 `{ handle, statError }` |
| `pread` | `handle`、`offset?`、`length` | payload；不带 `offset` 时在当前位置做一次读取 |
| `fstat` | `handle` | `info` |
| `scanLines` | `handle`、`startLine`、`endLine?` | `LineScan` |
| `opendir` | | `{ handle }` |
| `readdir` | `handle`、`max` | `{ entries, done }` |
| `close` | `handle` | |

`listFiles { path, hidden?, gitignore?, exclude?, maxEntries?, maxBytes?, timeoutMs? }` 列出目录 `path` 之下的
树（feature `listFiles`）：文件、目录和符号链接（不跟随符号链接）；其他类型的文件被排除，无法读取的
条目被跳过。负载中每个条目一条记录：一个类型字节（`f` 文件、`d` 目录、`l` 符号链接）、以 `/` 分隔且相对
于 `path` 的 UTF-8 路径（不是 UTF-8 的名称用替换字符），以及一个 NUL 字节。记录按深度优先排列，同级
条目按名称的字节序排列。结果是 `{ count, truncated }`。名为 `.git` 的条目和 `exclude` 中的名称连同其下
所有内容一起被跳过。`hidden`（默认 true）包含以 `.` 开头的名称（以及 Windows 的隐藏文件）。
`gitignore`（默认 true）在 git 工作树内跳过 `path`、其子目录及其父目录的 `.gitignore` 文件、
`.git/info/exclude` 和全局 excludes 文件所忽略的内容，使用 `fd` 和 ripgrep 的 `ignore` crate。列表在超出
`maxEntries`（默认 50 000）、超出负载 `maxBytes`（默认 4 MiB，至多为帧上限减 64 KiB）或超过
`timeoutMs`（默认 10 000）的第一个条目处以 `truncated: true` 停止。`path` 不存在以 `ENOENT` 失败，
是文件则以 `ENOTDIR` 失败。

`info` 是 `{ name, kind, size, mtimeSec, mtimeNsec, dev, ino }`，`kind` 为 `file`、`directory`、`symlink`、
`other` 之一。`readdir` 条目是 `{ name, raw?, info }`，当该条目的 `lstat` 失败时为 `{ name, raw?, error }`。
名称用替换字符按 UTF-8 解码并以该名称 lstat，与 Node 一致；`raw` 保存不是有效 UTF-8 的名称的原始字节，
用于排序。句柄是数字，在 `close` 或连接结束前有效；打开超过 4096 个以 `EMFILE` 失败。

`exec { command | argv, cwd, env, inheritEnv, shellPath?, timeoutMs?, spill?, window? }` 运行 shell 字符串或
argv 数组。运行期间，`event` 帧 `{ kind: "output", stream, skipped? }` 以 UTF-8 负载携带解码后的输出文本。
带 `window { maxBytes, maxLines, minIntervalMs, bytesPerSecond }` 时，输出像调用者的提交一样合并并限速，
每个命令至多一个输出帧未发送，超过窗口的输出在下一个事件中被替换为 `skipped { bytes, newlines,
endsWithNewline }`，该事件携带其后的全部输出（`ShellOutputInfo.skipped`）。结果是 `{ exitCode,
spillPath? }`；失败是错误码为 `timeout` 或 `aborted`（携带 `spillPath`）、`shell_unavailable`、
`spawn_error` 或 `unknown`（spill 失败）的错误。

`watch { targets, mode?, pollIntervalMs?, maxDirectories? }` 在守护进程中运行 Durable 的
`NodeFileWatcher`。`targets` 是 `{ path, recursive, exclude: { hidden, names } }`。建立覆盖后，先有一个事件
`{ kind: "ready", mode }`；然后是 `{ kind: "change", paths }` 或 `{ kind: "change", overflow: true, mode:
"polling" }`（原生监视失败），或 `{ kind: "error", code, message }`，之后不再有任何事件。该请求持续到被
取消。无法建立覆盖是该请求的错误。

`pty { argv?, cwd, env, inheritEnv, cols, rows }` 在一个新的 `cols` × `rows`（1 到 4096）单元格伪终端中运行
程序，作为新会话的 leader，终端是其控制终端。不带 `argv` 时，它把 `SHELL`（来自 `env`，否则来自守护进程
的环境，否则 `/bin/sh`）作为登录 shell 运行（名称前加 `-`）。环境的构建与 `exec` 相同；在 `env` 中设置
`TERM`。程序运行后，先有一个事件 `{ kind: "started", pid }`；然后 `{ kind: "output" }` 事件以负载携带终端
的原始输出字节（与 `exec` 不同，不解码）。超过 4 MiB 的输出未发送时输出会等待，如同管道写满。程序退出
后，输出被收集到终端关闭或 100 ms 内没有输出为止。结果是 `{ exitCode }`。Windows 上尚不支持
（`ENOTSUP`）。

`pty` 请求运行期间，`ptyWrite { target }` 把其负载写入终端输入，`ptyResize { target, cols, rows }` 更改其
大小（程序会收到 `SIGWINCH`）；`target` 是该 `pty` 请求的 id。两者都立即返回 `{}`；输入被排队并按顺序
写入，程序不读取时会等待。终端结束后，两者以 `EBADF` 失败。

`ptyForeground { target }` 在终端的前台进程组不是程序自己的进程组时报告它：`{ foreground: { pid, name } }`，
其中 `pid` 是组的 id，`name` 是其 leader 的进程名（未知时为 `null`）；程序自己在前台时为
`{ foreground: null }`。对 shell 而言，这能区分正在运行的任务（编辑器、构建）和提示符；后台任务不会被
报告。终端结束后以 `EBADF` 失败。
