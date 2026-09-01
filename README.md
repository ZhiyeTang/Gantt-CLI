# Gantt-CLI

English | [简体中文](./README.zh-CN.md)

**A worktree-first scheduler for coding agents.**

> **Worktree-first development:** give every unit of work its own branch and worktree before an agent edits a file. Isolation is the default, coordination is explicit, and completion is verified against Git.

<p align="center">
  <img src="./assets/gantt-cli-demo.gif" alt="Gantt-CLI schedules requirements into isolated Git worktrees and verifies delivery" width="900" />
</p>

Coding agents are fast. Coordination is not.

When several agents work in the same repository, the hard part is rarely generating code. It is knowing who owns what, which tasks touch the same files, whether a branch was actually merged, and where to resume after an interrupted run.

Gantt-CLI turns those concerns into a local workflow built on Git branches and worktrees. It needs no daemon, database, or hosted service; `doctor` diagnoses state drift, while `repair` retries retained worktrees after provisioning failures.

> `0.1.0-alpha.0` is the first alpha release. Commands and the state format may still change.

## TL;DR

Gantt-CLI gives coding agents isolated worktrees, explicit file ownership, dependency-aware scheduling, and a verifiable path from planned work to merged code. It is local, scriptable, recoverable, and designed to let multiple agents work in one repository without sharing a mutable checkout.

## Installation (30 seconds)

Run it without installing anything globally:

```bash
npx gantt-cli@latest --help
```

Initialize it from the root of a Git repository:

```bash
npx gantt-cli@latest init --install-agent-instructions
```

This command:

- creates the local scheduler state; and
- adds a managed pointer to the root `AGENTS.md`, so agents can discover the workflow for themselves.

The adjacent worktree directory is created on demand when the first assignment starts.

If you prefer a global command:

```bash
npm install --global gantt-cli@latest
gantt-cli --help
```

## Why Gantt-CLI exists

### Parallel work needs ownership

“You take the backend, I will take the frontend” is not enough to prevent collisions. Gantt-CLI uses declared `--path` patterns and optional `--domain` claims to identify overlapping work and explain why tasks can run together or must wait.

### Chat history is not project state

Agents exit, terminals close, and context disappears. Gantt-CLI records requirements, assignments, commits, worktrees, and state transitions in the repository's Git common dir. `doctor` compares that state with current Git facts.

### “Implemented” is not the same as “delivered”

A requirement cannot become `done` until its commit is merged, its worktree is cleaned up, and its verification command passes. Completion comes from repository facts, not an agent's claim.

## How it works

Gantt-CLI manages two core objects:

- **Requirement:** the outcome to deliver, including its scope, dependencies, verification command, and status.
- **Assignment:** one execution attempt, including its branch, worktree, base commit, source commit, and merge commit.

A requirement normally moves through this lifecycle:

```text
ready -> active -> done
  |        |
  v        v
blocked  blocked
```

Unblocking returns the requirement to `ready` or `active`. A failed verification leaves it `active` with a cleaned assignment, so `done` can be retried after the failure is fixed.

The scheduler selects requirements whose dependencies are complete, whose scopes do not conflict, and which are otherwise ready to run. Add `--json` to consume its output from an agent or script.

## Quick start

### 1. Add requirements

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

`add` prints the generated requirement ID. In a new registry, the two commands above create `REQ-0001` and `REQ-0002`.

### 2. Schedule and start work

```bash
npx gantt-cli@latest schedule
npx gantt-cli@latest start REQ-0001 --session agent-1 --alias task-api
```

`start` prints the branch and worktree it created. Enter that worktree, make the change, and commit it normally.

### 3. Merge and finish

```bash
npx gantt-cli@latest merge REQ-0001
npx gantt-cli@latest cleanup REQ-0001
npx gantt-cli@latest done REQ-0001
```

`merge` checks the assignment's declared path scope before changing the target branch and records the exact source and merge commits. Do not add commits to the assignment branch after merging unless you run `merge` again. Once no worktree checks out the branch, you may retain or delete it: `cleanup` and `done` use the recorded commits, and `cleanup` never deletes the branch automatically.

If submodule provisioning fails and the assignment worktree is retained:

```bash
npx gantt-cli@latest repair ASN-0001
```

`repair` validates the retained branch and worktree binding, then retries recursive submodule initialization.

## Command reference

| Command | Purpose |
| --- | --- |
| `init` | Initialize a repository and optionally install agent instructions |
| `add` | Create a requirement |
| `schedule` | Select parallel work and explain blocked requirements |
| `start` | Create a branch, worktree, and assignment |
| `merge` | Merge an assignment into the target branch |
| `cleanup` | Remove a clean, merged assignment's worktree |
| `done` | Verify delivery facts and complete a requirement |
| `block` / `unblock` | Apply or remove a manual block |
| `abandon` | Abandon an assignment while preserving its requirement |
| `repair` | Retry submodule provisioning for a retained failed assignment |
| `list` / `show` | Inspect requirements and assignments |
| `doctor` | Check repository, state, and worktree consistency |
| `log` | Read the project event log |
| `stamp` | Append a timestamped note to a requirement |
| `agent-instructions` | Print the complete protocol for coding agents |

The main query and workflow commands support `--json`. For complete options:

```bash
npx gantt-cli@latest <command> --help
```

## Agent integration

The repository maintainer runs this once:

```bash
npx gantt-cli@latest init --install-agent-instructions
```

Agents that read `AGENTS.md` will find a short pointer telling them to load the current protocol before implementation:

```bash
npx gantt-cli@latest agent-instructions
```

Installation preserves existing `AGENTS.md` content. It manages only a marked block and is safe to run repeatedly.

## State and safety

- State lives at `.git/gantt-cli/state.json` in the Git common dir and is not committed.
- A lock file and atomic replacement protect concurrent writes.
- Worktrees live in the adjacent `.gantt-worktrees/` directory by default.
- `merge` rejects out-of-scope paths before changing the primary worktree and records immutable source/merge commit evidence.
- `cleanup` refuses uncommitted changes, including recursive submodule changes, before force-removing a verified-clean worktree.
- `done` verifies recorded merge ancestry and worktree cleanup without requiring the assignment branch, then runs the optional verification command in the primary worktree.
- Verification output and exit status are recorded on the assignment; a failure keeps completion retryable.
- `repair` validates current Git facts before retrying a retained provisioning failure.

## Requirements and limits

- Node.js 20 or newer
- A Git repository with at least one commit
- Scope conflicts come from explicit `--path` and `--domain` claims; semantic or runtime conflicts are not predicted
- State-format compatibility is not guaranteed during the `0.1.0-alpha.0` release

There are no third-party runtime dependencies.

## Development

```bash
npm install
npm test
npm run build
```

Alpha releases are published under the `latest` dist-tag:

```bash
npm run release:alpha
```

## License

[MIT](./LICENSE)
