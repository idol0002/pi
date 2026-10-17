---
name: release
description: 准备、发布、验证和恢复 pi 发布。用于发布准备、本地发布冒烟测试、发布，以及发布 CI 失败或公告失败的处理。
---

# 发布 pi

除非另有指示，所有仓库命令都从仓库根目录（本技能上两级目录）执行。

**同步版本**：所有包共享一个版本；每次发布同时更新所有包。`patch` = 修复 + 新增，`minor` = 破坏性变更。没有 major 发布。

1. **更新 CHANGELOG**：询问用户是否在 `main` 最新 commit 上运行过 `/cl` prompt。如果没有，必须先运行 `/cl` 审计并更新每个包的 `[Unreleased]` 章节，然后才能发布。

2. **本地冒烟测试**：构建一个未发布的版本，并在仓库之外冒烟测试（这样它无法解析 workspace 文件）：
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node 包安装冒烟测试
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun 二进制冒烟测试
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   验证 Node 和 Bun 的启动、模型/账户列表、交互式启动，以及至少一条使用预期默认提供商的真实 prompt。裸命令 `/tmp/pi-local-release/node/pi` 和 `/tmp/pi-local-release/bun/pi` 会启动交互模式；在 tmux 中分别运行，提交一条 prompt 并等待模型回复，交互式冒烟测试才算通过。失败是发布阻塞项，除非用户明确接受风险。

   tmux 工作流加载并遵循 [interactive-testing.md](interactive-testing.md)。每个发布二进制都从 `/tmp` 启动，不要从仓库根目录启动。

3. **运行发布脚本**：
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # 修复 + 新增
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # 破坏性变更
   ```
   如果测试套件在 `npm run release:local` 中已通过、失败只是机器负载导致，`PI_RELEASE_SKIP_TESTS=1` 可以跳过发布脚本中的 `./test.sh`；检查和打包安装检查仍会运行。仅在用户批准时使用。

   `npm_config_min_release_age=0` 只用于发布命令。否则仓库正常的 npm 版本年龄门槛可能阻止发布时的 lockfile 刷新——当当前 workspace 包版本是最近发布的情况下。推送前审查发布产生的所有 lockfile 和安装锁 diff。

   发布脚本会为 Nix 固定最新已发布的模型目录（`nix/model-catalog.json`），并以 Nix 构建的方式构建当前检出（如果该目录早于 main 上的模型变更则失败；需要先发布一个新目录），提升所有包版本，更新 changelog，重新生成发布产物，运行 `npm run check`，提交 `Release vX.Y.Z`，打标签 `vX.Y.Z`，添加新的 `## [Unreleased]` changelog 章节，提交 `Add [Unreleased] section for next cycle`，然后推送 `main` 和标签。标签推送后不要重跑发布脚本。

4. **CI 验证并公告 npm 发布**：推送 `vX.Y.Z` 标签会触发 `.github/workflows/build-binaries.yml`。`publish-npm` 作业通过 GitHub Actions OIDC 使用 npm 可信发布，环境为 `npm-publish`；不需要本地 `npm publish`、`npm whoami`、OTP 或 WebAuthn 流程。发布后，`announce-pi-dev-release` 验证每个公开 workspace 包都能解析到确切的发布版本、其 npm tarball 可用，然后把验证过的发布标记写入 R2。`pi.dev/api/latest-version` 读取该标记；在该作业成功之前，绝不能从 npm 公告新发布。

5. **CI 构建 Nix 发布**：标签推送还会触发 `.github/workflows/nix.yml`，在 Linux 和 macOS 上构建该标签对应的 flake，然后把 `stable` 分支快进到发布 commit。`nix run github:earendil-works/pi/stable` 运行最新发布。如果 Nix 构建失败，`stable` 会停留在上一个发布；标签无法修复，所以要在 `main` 上修复并在下次发布中带出。

6. **如果 CI 发布或公告失败**：检查失败的作业。发布辅助工具是幂等的，会跳过 npm 上已存在的包版本；公告作业在更新 R2 标记前会重新检查可用性。修复 CI 或临时的 npm 问题后，重跑失败的作业或工作流。不要为同一版本重跑 `npm run release:patch` 或 `npm run release:minor`。
