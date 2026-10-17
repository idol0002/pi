---
description: 发布前审计 changelog 条目
---
审计自上个发布以来的所有 commit 对应的 changelog 条目。

## 流程

1. **找到最近的发布标签：**
   ```bash
   git tag --sort=-version:refname | head -1
   ```

2. **列出该标签以来的所有 commit：**
   ```bash
   git log <tag>..HEAD --oneline
   ```

3. **读取每个包的 [Unreleased] 章节：**
   - packages/ai/CHANGELOG.md
   - packages/tui/CHANGELOG.md
   - packages/coding-agent/CHANGELOG.md

4. **对每个 commit 检查：**
   - 跳过：changelog 更新、纯文档变更、发布杂务
   - 跳过：生成的模型目录变更（例如 `packages/ai/src/models.generated.ts`），除非在非生成的源码/文档中伴随有面向产品的有意变更。
   - 确定该 commit 影响哪些包（用 `git show <hash> --stat`）
   - 验证受影响的包中存在对应的 changelog 条目
   - 对外部贡献（PR），验证格式：`Description ([#N](url) by [@user](url))`

5. **跨包重复规则：**
   `ai`、`agent` 或 `tui` 中影响最终用户的变更，应重复记录到 `coding-agent` 的 changelog，因为 coding-agent 是依赖它们且面向用户的包。

6. **修复 changelog 后添加新特性章节：**
   - 在 `packages/coding-agent/CHANGELOG.md` 的 `## [Unreleased]` 开头插入 `### New Features` 章节。
   - 写入之前，先把主要新特性提议给用户确认。
   - 尽可能链接到相关文档和章节。

7. **报告：**
   - 列出缺少条目的 commit
   - 列出需要跨包重复的条目
   - 直接补上缺失的条目

## Changelog 格式参考

章节（按顺序）：
- `### Breaking Changes` - 需要迁移的 API 变更
- `### Added` - 新特性
- `### Changed` - 对既有功能的变更
- `### Fixed` - Bug 修复
- `### Removed` - 移除的功能

署名：
- 内部：`Fixed foo ([#123](https://github.com/earendil-works/pi/issues/123))`
- 外部：`Added bar ([#456](https://github.com/earendil-works/pi/pull/456) by [@user](https://github.com/user))`
