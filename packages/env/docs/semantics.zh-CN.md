# 语义

参照实现是远程机器上的 Durable `NodeExecutionEnv`（`packages/durable/src/env/node.ts`）。Durable 的
env 一致性测试套件和 `test/differential.test.ts` 逐条检查以下规则。

## 职责划分

| 关注点 | 所在位置 |
|---|---|
| 路径解析：`~`（远程 home）、`file://`、相对 `cwd`；Windows 上针对远程工作目录的盘符相对路径 | client，遵循远程系统的 `path` 规则 |
| 每个方法的中止检查点 | client，作为 `NodeExecutionEnv` |
| 错误码映射（`ENOENT` → `not_found` 等） | client，作为 `NodeExecutionEnv` 的 `toFileError` |
| `readFile` 的读取块大小、大小限制和解码（`StringDecoder`，保留字节顺序标记），经由守护进程的 `open(path, "r")` | client |
| `writeFile` 按 512 KiB 分块写入，每次写入前做中止检查；`appendFile` 不做检查 | client，经由一个打开的文件 |
| 行读取器 | client，按位置读取并使用 Durable 的 `StreamDecoder` |
| 监视：快照、原生事件、轮询 | daemon，Durable `NodeFileWatcher` 的移植 |
| 超时校验、结果优先级（回调错误、超时、中止、spill 失败、退出码） | client |
| 系统调用、进程、spill 文件、行扫描 | daemon |
| 命令输出解码：按流分别处理，WHATWG UTF-8，只去掉开头的字节顺序标记 | daemon（`encoding_rs`） |

## 标准库不遵循的规则

- 递归 `mkdir`：已存在的目录没问题；已存在的文件以 `EEXIST` 失败；挡在父目录位置上的文件以 `ENOTDIR`
  失败。写入会以这种方式创建缺失的父目录。
- `rm`：路径不存在时失败，除非 `force`；不带 `recursive` 删除目录以 `ERR_FS_EISDIR` 失败
  （`FileError` 码为 `unknown`）。
- `mkdtemp`：`<tmpdir>/<prefix>XXXXXX` 的 `mkdtemp(3)`；前缀用 POSIX `path.join` 拼接，因此 `../x` 可用。
- `tmpdir`：依次尝试 `TMPDIR`、`TMP`、`TEMP`，然后 `/tmp`（Termux：`$PREFIX/tmp`），去掉末尾斜杠。
- `listDir`：名称按字节序排列，与 libuv 的 `scandir` 一致；任何一个条目无法 lstat 都会失败。`openDirReader`
  保持目录顺序，跳过期间被删除的条目，跳过之后填满每一页。不是 UTF-8 的名称用替换字符解码并以该名称
  lstat，因此与 Node 一样以 `ENOENT` 失败。
- `openBinaryReader`：非阻塞打开；目录以 `is_directory` 失败，其他非普通文件以 `invalid` 失败；
  `noFollow` 拒绝末尾的符号链接（`O_NOFOLLOW`）。
- `readBinaryFile`、`readTextFile` 和 `openTextLineReader` 像对待 `open(path, "r")` 一样打开任何文件：
  `/dev/null` 读出为空，FIFO 阻塞直到有写入者，目录在读取时失败（行读取器在 `readLine` 失败）。普通文件
  在打开时按其大小读取；其他文件读到末尾。
- `listFiles` 在 `NodeExecutionEnv` 中没有对应物：守护进程为远程和本地环境实现同一份代码
  （`LocalExecutionEnv` 在同一台机器上运行守护进程），因此两者用相同的代码列出文件。与 `fd` 不同，
  符号链接不被跟随；与 `git ls-files` 不同，命中 ignore 规则的已跟踪文件会被排除。
- `readBinaryFile` 返回 `Buffer`，读取器读取普通的 `Uint8Array`，与 Node 一致。
- Windows：错误码用 libuv 的转换结果；删除指向目录的符号链接或 junction 时只删除链接本身；在目录位置
  创建文件以 `EISDIR` 失败；1970 年之前的修改时间为负数。

## 命令

- 字符串命令经 shell 运行：配置的 `shellPath` 不存在（跟随链接）时以 `shell_unavailable` 失败；否则依次
  尝试 `/bin/bash`、`which bash`、`sh`，带 `-c`。argv 数组直接运行其程序；在 Windows 上按 libuv 的方式
  搜索（先工作目录，再 `PATH`，附加 `.com` 和 `.exe`），并拒绝批处理文件。
- 工作目录必须存在（`spawn_error`）。
- 环境：带 `inheritEnv`（默认）时，依次合并守护进程的环境、`shellEnv`、`env`；不带时只用 `env`。
- 每个命令获得新会话（进程组）、默认信号处置和空信号掩码。超时、中止和 `cleanup()` 用 `SIGKILL` 杀掉
  整个进程组。
- 进程退出后，输出仍会被收集，直到两个管道都结束，或 100 ms 内没有输出；其间超时仍然生效。命令 settle
  时管道会被关闭，即使某个后代进程仍保持它们打开。
- 中止以 `aborted` settle；`cleanup()` 杀掉进程但不视为中止，因此命令以退出码 137 settle。
- 被信号杀死的进程报告 `128 + 信号编号`。
- Spill：一旦输出超过 `spill.afterBytes` 或 `spill.afterLines`（按到达顺序对原始块计数，与 Node 一致），
  完整的原始输出会写入一个新建 `tmp-` 目录中的 `pi-output-<uuid>.log`。

## 监视

- 守护进程在文件旁边运行 Durable 的 `NodeFileWatcher`：原生事件（inotify、FSEvents）只触发一次去抖的
  重新扫描，变更是快照之间的差异加上事件路径。读取不是事件。
- Windows 以及网络或 FUSE 文件系统采用轮询，与 `NodeExecutionEnv` 一致；原生 watch 耗尽时切换为轮询
  并报告 `overflow`。
- 连接断开时，client 会在新守护进程启动后重新打开监视器并报告 `overflow`。
