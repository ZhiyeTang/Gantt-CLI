# Gantt-CLI

[English](./README.md) | 简体中文

**一个面向 Coding Agent 的 worktree-first 调度器。**

> **Worktree-first 开发：** 在 Agent 修改任何文件之前，先为每项工作创建独立的 branch 和 worktree。默认隔离、显式协调，并以 Git 事实验证完成状态。

Coding Agent 很快，协调不是。

当多个 Agent 同时改一个仓库时，真正麻烦的通常不是生成代码，而是：谁负责什么、哪些任务会改到同一批文件、分支是否已经合并、失败后该从哪里继续。

Gantt-CLI 把这些问题变成一个基于 Git branch 和 worktree 的本地工作流。它不需要 daemon、数据库或云服务；`doctor` 用于诊断状态漂移，`repair` 用于重试 provisioning 失败后保留的 worktree。

> `0.1.0-alpha.0` 是首个 alpha 版本。命令和状态格式仍可能调整。

## TL;DR

Gantt-CLI 为 Coding Agent 提供隔离的 worktree、明确的文件所有权、依赖感知调度，以及一条从计划任务到合并代码的可验证路径。它完全在本地运行，可脚本化、可恢复，让多个 Agent 无需共享同一个可变工作目录。

## 安装（30 秒）

无需全局安装：

```bash
npx gantt-cli@next --help
```

在 Git 仓库根目录初始化：

```bash
npx gantt-cli@next init --install-agent-instructions
```

这会：

- 创建本地调度状态；
- 在根目录 `AGENTS.md` 中加入一段可重复更新的指引，让 Agent 可以自行发现工作流。

相邻的 worktree 目录会在第一个 assignment 启动时按需创建。

如果你更喜欢全局命令：

```bash
npm install --global gantt-cli@next
gantt-cli --help
```

## 为什么需要 Gantt-CLI

### 并行工作需要明确所有权

“你改后端，我改前端”并不足以避免冲突。Gantt-CLI 用显式 `--path` 模式和可选的 `--domain` 声明识别重叠工作，并解释任务为什么能并行或必须等待。

### 聊天记录不是项目状态

Agent 会退出，终端会关闭，上下文会丢失。Gantt-CLI 把 requirement、assignment、commit、worktree 和状态转换保存在仓库的 Git common dir 中，再由 `doctor` 将这些状态与当前 Git 事实进行比对。

### “实现了”不等于“交付了”

一个 requirement 只有在提交已经合并、worktree 已清理、验证命令通过后，才能进入 `done`。完成状态来自仓库事实，而不是 Agent 的一句声明。

## 工作方式

Gantt-CLI 管理两个核心对象：

- **Requirement**：要交付的结果，包括范围、依赖、验证命令和状态。
- **Assignment**：一次实际执行，包括 branch、worktree、base commit 和结果 commit。

Requirement 通常按以下生命周期流转：

```text
ready -> active -> done
  |        |
  v        v
blocked  blocked
```

解除阻塞后，requirement 会回到 `ready` 或 `active`。验证失败时，它会保持 `active`，assignment 保持 `cleaned`；修复问题后可重新运行 `done`。

调度器只会选择依赖已完成、scope 不冲突且当前可执行的 requirement。使用 `--json` 可以获得适合 Agent 和脚本消费的结构化输出。

## Quick start

### 1. 添加任务

```bash
npx gantt-cli@next add \
  --request "Add task API" \
  --path "src/api/**" \
  --verify "npm test"

npx gantt-cli@next add \
  --request "Build task UI" \
  --path "src/ui/**" \
  --depends-on REQ-0001 \
  --verify "npm test"
```

`add` 会输出生成的 requirement ID。在全新的 registry 中，上面两个命令会创建 `REQ-0001` 和 `REQ-0002`。

### 2. 调度并开始工作

```bash
npx gantt-cli@next schedule
npx gantt-cli@next start REQ-0001 --session agent-1 --alias task-api
```

`start` 会输出新建的 branch 和 worktree。进入该 worktree，正常修改并提交代码。

### 3. 合并并完成

```bash
npx gantt-cli@next merge REQ-0001
npx gantt-cli@next cleanup REQ-0001
npx gantt-cli@next done REQ-0001
```

如果 submodule provisioning 失败且 assignment worktree 被保留：

```bash
npx gantt-cli@next repair ASN-0001
```

`repair` 会验证保留的 branch/worktree 绑定，然后重试递归 submodule 初始化。

## 命令参考

| 命令 | 用途 |
| --- | --- |
| `init` | 初始化仓库；可选安装 Agent 指引 |
| `add` | 创建 requirement |
| `schedule` | 选择可并行工作并解释阻塞原因 |
| `start` | 创建 branch、worktree 和 assignment |
| `merge` | 将 assignment 合并到目标分支 |
| `cleanup` | 删除干净且已合并 assignment 的 worktree |
| `done` | 验证交付事实并完成 requirement |
| `block` / `unblock` | 标记或解除人工阻塞 |
| `abandon` | 放弃 assignment，但保留 requirement |
| `repair` | 对保留的 provisioning-failed assignment 重试 submodule 初始化 |
| `list` / `show` | 查看 requirement 和 assignment |
| `doctor` | 检查仓库、状态文件和 worktree 一致性 |
| `log` | 查看项目事件日志 |
| `stamp` | 为 requirement 追加带时间戳的备注 |
| `agent-instructions` | 输出给 Coding Agent 使用的完整协议 |

主要查询和工作流命令都支持 `--json`。完整参数请运行：

```bash
npx gantt-cli@next <command> --help
```

## Agent 集成

仓库维护者只需运行一次：

```bash
npx gantt-cli@next init --install-agent-instructions
```

支持读取 `AGENTS.md` 的 Agent 会看到一条简短入口，并在开始实现前加载当前协议：

```bash
npx gantt-cli@next agent-instructions
```

安装过程不会覆盖已有的 `AGENTS.md` 内容；它只维护一个带标记的区块，重复执行是幂等的。

## 状态与安全性

- 状态保存在 Git common dir 下的 `.git/gantt-cli/state.json`，不会进入项目提交。
- 写入使用 lock file 和原子替换，避免多个进程破坏状态。
- worktree 默认放在相邻的 `.gantt-worktrees/` 目录。
- `done` 会检查合并关系和 worktree 清理情况，然后在主 worktree 中运行可选的验证命令。
- 验证输出和退出码会记录在 assignment 上；验证失败后仍可修复并重试完成操作。
- `repair` 会先验证当前 Git 事实，再重试保留的 provisioning failure。

## 要求与边界

- Node.js 20 或更高版本
- Git 仓库至少有一个 commit
- scope 冲突来自显式 `--path` 和 `--domain` 声明，不会预测语义或运行时冲突
- `0.1.0-alpha.0` 阶段暂不保证状态格式向后兼容

运行时没有第三方 npm 依赖。

## 本地开发

```bash
npm install
npm test
npm run build
```

Alpha 版本统一发布到 `next` dist-tag：

```bash
npm run release:alpha
```

## License

[MIT](./LICENSE)
