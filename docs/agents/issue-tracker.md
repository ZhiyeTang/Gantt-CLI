# 本地任务跟踪

用户于 2026-09-07 选择本地 Markdown 任务跟踪。每项实施任务独立保存在 `.scratch/<feature>/issues/`，文件按依赖顺序编号，使用 `Blocked by` 声明真实阻塞关系。

规格在 `docs/specs/`，术语表在根目录 `CONTEXT.md`，已确认的重要设计决策在 `docs/adr/`。实施前读取任务引用的规格和设计决策。

任务字段 `Status: ready-for-agent` 表示已澄清且可供实施；不需要再做 triage。当前任务来自已确认规格，不创建或修改远程 Issues。
