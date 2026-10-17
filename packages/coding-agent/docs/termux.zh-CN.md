# 在 Android 上用 Termux 运行 Pi

Pi 通过 [Termux](https://termux.dev/)（一个终端模拟器和 Linux 环境）在 Android 上运行。支持文本输入、文件工具和 shell 命令。Pi 可以通过 Termux:API 使用 Android 剪贴板复制粘贴文本。不支持粘贴剪贴板图片。

## 开始之前

从 [GitHub 或 F-Droid](https://github.com/termux/termux-app#installation) 安装 Termux。不要使用已停用的 Google Play 版本。

[Termux:API](https://github.com/termux/termux-api#installation) 可选。只有当你想让 Pi 复制或粘贴 Android 剪贴板文本，或 shell 命令需要 Android 设备 API 时才安装。

## 安装 Pi

1. 更新 Termux 包：

   ```bash
   pkg update && pkg upgrade
   ```

2. 安装 Node.js 和 Git：

   ```bash
   pkg install nodejs git
   ```

3. 安装 Pi：

   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   ```

4. 验证安装：

   ```bash
   pi --version
   ```

5. 打开你想工作的文件夹并启动 Pi：

   ```bash
   cd /path/to/working-folder
   pi
   ```

继续跟随主[快速开始](quickstart.zh-CN.md#3-choose-a-model)连接模型并运行第一个任务。

## 访问 Android 共享存储

在授予权限之前，Termux 无法访问 Android 共享存储。运行一次：

```bash
termux-setup-storage
```

批准后，Android 共享存储位于 `/storage/emulated/0`，以及 Termux 在 `~/storage/` 下创建的链接。

只在 Pi 需要访问这些文件时才授予该权限。Termux 中运行的命令和工具使用与 Termux 进程相同的存储权限。

## 使用剪贴板命令

Pi 用 `termux-clipboard-set` 复制文本，用 `termux-clipboard-get` 实现剪贴板粘贴快捷键。shell 命令可以直接使用这两个命令。安装 Termux:API 应用及其命令行包：

```bash
pkg install termux-api
```

验证集成：

```bash
printf 'Pi clipboard test' | termux-clipboard-set
termux-clipboard-get
```

第二条命令应输出 `Pi clipboard test`。

Termux 剪贴板 API 只支持文本。Pi 的剪贴板粘贴快捷键会把文本插入编辑器，但无法附带剪贴板图片。

## 添加 Termux 专属指令

Pi 能检测到自己运行在 Termux 中，但无法推断你希望它如何与 Android 交互。只把与你的工作相关的环境细节加到 `~/.pi/agent/AGENTS.md`：

````markdown
# Termux environment

- Pi runs in Termux on Android.
- Shared Android storage is under `/storage/emulated/0`.
- Open URLs with `termux-open-url "https://example.com"`.
- Open files with `termux-open <path>`.
- Do not access shared storage unless the task requires it.
````

活动会话中修改该文件后，运行 `/reload`。

## 故障排查

### 剪贴板集成失败

确认两个组件都已安装：

1. 与 Termux 同一来源的 Termux:API Android 应用
2. `termux-api` 命令行包

然后在 Pi 之外运行上面的剪贴板验证命令。如果在那里就失败，先修复 Termux:API 安装，再重试 Pi 的复制命令。

### 共享存储报权限拒绝

运行 `termux-setup-storage`，批准 Android 权限请求，然后重试 `~/storage/` 或 `/storage/emulated/0` 下的路径。

### 安装后找不到 pi

打开新的 Termux shell 并运行：

```bash
npm prefix -g
command -v pi
```

确认全局 npm 二进制目录在 `PATH` 上，包缺失时重新安装 Pi。
