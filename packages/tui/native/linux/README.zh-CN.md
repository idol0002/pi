# Linux 剪贴板助手

使用 `libxcb.so.1` 提供异步的 X11 文本和图片读取。预编译支持 glibc 和 musl 上的 x64 与 arm64。读取有有限的等待时间；如果原生操作卡住，助手在它结束之前保持不可用。

原生读取不可用时，coding-agent 会退回到命令行工具。Wayland 读取使用 `wl-paste`；所有 Linux 写入使用已有的命令行或终端剪贴板路径。

## 构建

安装 C 编译器和 XCB 开发头文件，然后在每个受支持的 Linux 架构上从仓库根目录运行：

```sh
npm --prefix packages/tui run build:native:linux
```

## 测试

安装构建依赖外加 `pkg-config`、`Xvfb` 和 `xclip`，然后从 `packages/tui` 运行：

```sh
node --test test/native-clipboard-linux.test.ts
```

测试使用隔离的 X11 服务器，不使用桌面剪贴板。缺少依赖时测试会跳过。
