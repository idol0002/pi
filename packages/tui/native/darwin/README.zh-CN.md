# Darwin 原生预编译

通过 AppKit 提供修饰键状态，以及异步的文本、图片和文件路径剪贴板访问。

## 构建

在 macOS 上，从仓库根目录运行：

```sh
npm --prefix packages/tui run build:native:darwin
```

构建使用 Apple clang 和通过 `xcrun` 找到的 macOS SDK。Intel 或 Apple Silicon 都可以构建两个目标：arm64（macOS 11+）和 x64（macOS 10.15+）。

交叉构建需要带 macOS SDK 和 Mach-O 链接器的 Darwin 工具链，例如 osxcross：

```sh
CC=/path/to/osxcross/clang SDKROOT=/path/to/MacOSX.sdk \
  npm --prefix packages/tui run build:native:darwin
```

SDK 必须在 Apple 的许可条款下获取和使用。仅用 clang 或 Zig 是不够的。
