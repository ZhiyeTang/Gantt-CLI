# Gantt-CLI

[English](./README.md) | 简体中文

**一个按任务需要选择流程的 Coding Agent 调度器。**

> 轻量任务直接 inline 完成；需要协作或隔离的任务使用独立 worktree，记录协调计划，并以一个可重试的命令完成交付。

<p align="center">
  <img src="./assets/gantt-cli-demo.gif" alt="Gantt-CLI 将任务调度到独立的 Git worktree，并验证交付结果" width="900" />
</p>

Coding Agent 很快，协调不是。

当多个 Agent 同时改一个仓库时，真正麻烦的通常不是生成代码，而是：谁负责什么、哪些任务会改到同一批文件、分支是否已经合并、失败后该从哪里继续。

Gantt-CLI 把这些问题变成一个基于 Git branch 和 worktree 的本地工作流。它不需要 daemon、数据库或云服务；`doctor` 用于诊断状态漂移，`repair` 用于重试 provisioning 失败后保留的 worktree。

> `0.1.0-alpha.0` 是首个 alpha 版本。命令和状态格式仍可能调整。

## TL;DR

Gantt-CLI 为 Coding Agent 提供隔离的 worktree、明确的文件所有权、依赖感知调度，以及一条从计划任务到合并代码的可验证路径。它完全在本地运行，可脚本化、可恢复，让多个 Agent 无需共享同一个可变工作目录。

## 安装（30 秒）

无需全局安装：

```bash
npx gantt-cli@latest --help
```

在 Git 仓库根目录初始化：

```bash
npx gantt-cli@latest init --install-agent-instructions
```

这会：

- 创建本地调度状态；
- 在根目录 `AGENTS.md` 中加入一段可重复更新的指引，让 Agent 可以自行发现工作流。

相邻的 worktree 目录会在第一个 assignment 启动时按需创建。

如果你更喜欢全局命令：

```bash
npm install --global gantt-cli@latest
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

Gantt-CLI 管理三个核心对象：

- **Requirement**：要交付的结果，包括范围、依赖、验证命令和状态。
- **Assignment**：一次实际执行，包括 branch、worktree、base commit、source commit 和 merge commit。
- **Phase**：一个不可变的长期归档，包含当前规划范围内的全部 requirement，以及 Agent 根据 Git 历史生成的摘要。

Requirement 通常按以下生命周期流转：

```text
ready -> active -> done
  |        |
  v        v
blocked  blocked
  |
  v
deprecated
```

解除阻塞后，requirement 会回到 `ready` 或 `active`。验证失败时，它会保持 `active`，assignment 保持 `merged` 且 worktree 保留；在任务 worktree 修复并提交后，重新运行 `finish`。

调度器只会选择依赖已完成、scope 不冲突或已有有效协调计划且当前可执行的 requirement。使用 `--json` 可以获得适合 Agent 和脚本消费的结构化输出。

## Quick start

### 先判断是否需要登记

Agent 自行判断并简述理由：范围明确、低风险、可直接验证的任务 inline 完成，不登记、不创建 worktree。文件数量不是硬门槛。执行中出现协作、依赖协调或隔离需要时自动升级：先记录原工作区状态，只转移本任务改动，核对新 worktree 后再移除原目录中对应改动，保留其他已有修改。归属不清时保留原状并报告歧义。

下面的步骤用于受管任务。

### 1. 添加任务

```bash
npx gantt-cli@latest add \
  --request "Add task API" \
  --path "src/api/**" \
  --verify "npm test"

npx gantt-cli@latest add \
  --request "Build task UI" \
  --path "src/ui/**" \
  --depends-on REQ-0001 \
  --verify "npm test"
```

`add` 会输出生成的 requirement ID。在全新的 registry 中，上面两个命令会创建 `REQ-0001` 和 `REQ-0002`。

如果实现过程中发现 merge 前漏报了路径范围，应通过 CLI 更新声明，而不是直接编辑状态文件：

```bash
npx gantt-cli@latest update REQ-0001 --add-path .gitmodules --add-path Package.resolved
```

### 2. 调度并开始工作

```bash
npx gantt-cli@latest schedule
npx gantt-cli@latest start REQ-0001 --session agent-1 --alias task-api
```

`start` 会输出新建的 branch 和 worktree。进入该 worktree，正常修改并提交代码。

### 3. 合并并完成

```bash
npx gantt-cli@latest finish REQ-0001 --json
```

`finish` 依次检查、合并、验证、保存已分类文件、清理 worktree 并标记 `done`。失败时保留现场，按 JSON 的 `nextAction` 修复并重跑同一命令；Git 冲突在主 worktree 解决并执行 `git merge --continue`，验证失败在保留的任务 worktree 修复提交。没有配置验证命令时会明确说明。任务分支保留，不会自动推送或归档。

旧 `done` 命令已移除；`finish` 是统一收口入口。`merge` 和 `cleanup` 保留用于诊断与修复，`cleanup` 也会先验证再删除。

#### 本地文件保护

任务开始时记录主目录和任务 worktree 的本地文件列表。无关未跟踪文件可以留在主目录；会被覆盖的文件仍会阻止合并。记录是来源证据，文件名和 ignored 状态都不代表可以删除。

应交付的源码正常提交。需要保留的配置、笔记、构建结果或依赖内容，先显式分类：

```bash
npx gantt-cli@latest classify REQ-0001 --path .env --path build --reason "本地配置与非交付构建结果"
npx gantt-cli@latest finish REQ-0001 --json
```

`--path` 是具体文件或目录，不是 glob；目录分类只覆盖当时已有的文件。后续新文件需要单独分类。已分类文件（含 ignored 文件）在清理前保存到 Git common dir 下 `gantt-cli/preserved/<assignment-id>-<unique-key>/`，返回 `assignment.preservationDirectory`；保存位置不会因阶段编号重置而复用。保留相对路径、文件内容和权限；符号链接只保存链接本身，不跟随读取外部内容。

未分类新文件、保存失败或保存目标内容冲突会保留现场。已有副本不会被覆盖：先把旧副本另存，再重跑即可。未提交的跟踪文件修改以及含独有 Git 数据的嵌套仓库继续阻止删除。`release` 后可用 assignment ID 分类，再运行 `discard`；丢弃也遵守相同文件保护。

#### 同文件并行

Agent 可提交以下 `plan.json`，成员数组的顺序就是合并顺序：

```json
{
  "members": [
    { "requirementId": "REQ-0001", "work": "修改请求解析部分" },
    { "requirementId": "REQ-0002", "work": "修改同文件的输出部分" }
  ],
  "verify": "npm test"
}
```

```bash
npx gantt-cli@latest coordinate --plan-file plan.json
npx gantt-cli@latest schedule --json
```

有效计划允许同模块或同文件在不同 worktree 同时开发，无需用户逐次授权。合并依次进行，每项收口都运行任务验证和计划的整体验证。真实 `--depends-on` 仍约束启动；仅需控制合并次序时使用计划，不添加启动依赖。示例 Quick start 中的 UI 任务有真实依赖，记录计划不会解除它。

范围变化时重新提交计划；成员可用可选 `paths` 数组同时明确新声明，避免先放宽范围再补记录。计划不能覆盖未列入的任务。新的计划会替换所有与其成员相交的旧计划；若仍要保留其他成员的协调，需把他们一并列入新计划。旧 `--force` 放行方式已移除。

如果 submodule provisioning 失败且 assignment worktree 被保留：

```bash
npx gantt-cli@latest repair ASN-0001
```

`repair` 会验证保留的 branch/worktree 绑定，然后重试递归 submodule 初始化。

### 4. 归档 Phase

归档由用户显式触发，并且是全有或全无的操作。当前所有 requirement 必须为 `done` 或 `deprecated`，且不能遗留 assignment worktree。首先让 gantt-cli 生成不可变的 commit manifest：

```bash
npx gantt-cli@latest archive --prepare --json
```

Agent 根据返回的 Git 证据编写 Markdown 摘要，再使用同一个指纹完成归档：

```bash
npx gantt-cli@latest archive \
  --fingerprint <prepare-返回的-sha256> \
  --summary-file phase-summary.md
```

归档结果是不可变的 `PHASE-001`。当前 requirement、assignment 和 event 的编号会从初始值重新开始；历史 ID 使用 `PHASE-001/REQ-0001` 这样的完整引用保持唯一。

## 命令参考

| 命令 | 用途 |
| --- | --- |
| `init` | 初始化仓库；可选安装 Agent 指引 |
| `add` | 创建 requirement |
| `update` | 在 merge 前添加或移除路径声明 |
| `schedule` | 选择可并行工作并解释阻塞原因 |
| `start` | 创建 branch、worktree 和 assignment |
| `merge` | 将 assignment 合并到目标分支 |
| `cleanup` | 删除干净且已合并 assignment 的 worktree |
| `finish` | 合并、验证、保全文件、清理并标记完成；可重试 |
| `classify` | 声明要保留的当前本地文件 |
| `coordinate` | 记录分工、合并顺序及整体验证 |
| `block` / `unblock` | 标记或解除人工阻塞 |
| `release` | 释放 assignment，但保留 requirement 和 worktree |
| `discard` | 删除 released assignment 保留的干净 worktree |
| `deprecate` | 永久终止不会交付的 requirement |
| `archive` | 将全部终态 requirement 归档为不可变 Phase |
| `phase` | 列出或查看 Phase 归档 |
| `repair` | 对保留的 provisioning-failed assignment 重试 submodule 初始化 |
| `list` / `show` | 查看 requirement 和 assignment |
| `doctor` | 检查仓库、状态文件和 worktree 一致性 |
| `log` | 查看项目事件日志 |
| `stamp` | 为 requirement 追加带时间戳的备注 |
| `agent-instructions` | 输出给 Coding Agent 使用的完整协议 |

主要查询和工作流命令都支持 `--json`。完整参数请运行：

```bash
npx gantt-cli@latest <command> --help
```

## Agent 集成

仓库维护者只需运行一次：

```bash
npx gantt-cli@latest init --install-agent-instructions
```

支持读取 `AGENTS.md` 的 Agent 会看到一条简短入口，并在开始实现前加载当前协议：

```bash
npx gantt-cli@latest agent-instructions
```

安装过程不会覆盖已有的 `AGENTS.md` 内容；它只维护一个带标记的区块，重复执行是幂等的。

## 状态与安全性

- 状态保存在 Git common dir 下的 `.git/gantt-cli/state.json`，不会进入项目提交。
- 写入使用 lock file 和原子替换，避免多个进程破坏状态。
- worktree 默认放在相邻的 `<仓库名>-worktrees/` 目录。
- `merge` 会在修改主 worktree 前拒绝越界路径，并记录不可变的 source/merge commit 证据。
- `update` 记录范围变更；重叠范围需要有效协调计划，范围变化后需重新核对计划。
- `cleanup` 先验证再保全已分类文件；未提交的跟踪文件修改、未分类文件和嵌套仓库独有 Git 数据都会阻止删除。
- `release` 会保留中断的工作；`discard` 删除 worktree 前采用与 `cleanup` 相同的干净状态和嵌套仓库保护。
- `finish` 在合并前记录意图，依据准确的提交关系恢复中断；验证绑定目标提交，目标变化后重新验证，验证成功才清理。
- 验证输出和退出码会记录在 assignment 上；验证失败后仍可修复并重试完成操作。
- `repair` 会先验证当前 Git 事实，再重试保留的 provisioning failure。
- Phase 数据位于 `.git/gantt-cli/phases/PHASE-xxx/`；`doctor` 会使用活动状态中记录的哈希验证归档 JSON 和摘要。
- schema-v3 registry 会自动迁移：`cancelled` requirement 变为 `deprecated`，`abandoned` assignment 变为 `released`。

## 要求与边界

- Node.js 20 或更高版本
- Git 仓库至少有一个 commit
- scope 冲突来自显式 `--path` 和 `--domain` 声明，不会预测语义或运行时冲突
- `0.1.0-alpha.0` 阶段暂不保证状态格式向后兼容

运行时仅使用现有的 picocolors 提供终端颜色；调度和 Git 操作使用 Node.js 标准库。

## 本地开发

```bash
npm install
npm test
npm run build
```

Alpha 版本统一发布到 `latest` dist-tag：

```bash
npm run release:alpha
```

## License

[MIT](./LICENSE)
