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

Gantt-CLI manages three core objects:

- **Requirement:** the outcome to deliver, including its scope, dependencies, verification command, and status.
- **Assignment:** one execution attempt, including its branch, worktree, base commit, source commit, and merge commit.
- **Phase:** an immutable archive of every requirement in a completed planning horizon, plus an Agent-written summary grounded in Git history.

A requirement normally moves through this lifecycle:

```text
ready -> active -> done
  |        |
  v        v
blocked  blocked
  |
  v
deprecated
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

If implementation reveals missing scope before merge, update the claims through the CLI instead of editing state directly:

```bash
npx gantt-cli@latest update REQ-0001 --add-path .gitmodules --add-path Package.resolved
```

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

### 4. Archive a phase

Archival is explicit and all-or-nothing. Every current requirement must be `done` or `deprecated`, and no assignment worktree may remain. First ask gantt-cli for the immutable commit manifest:

```bash
npx gantt-cli@latest archive --prepare --json
```

An Agent uses the returned Git evidence to write a Markdown summary, then finalizes the archive with the returned fingerprint:

```bash
npx gantt-cli@latest archive \
  --fingerprint <sha256-from-prepare> \
  --summary-file phase-summary.md
```

The result is an immutable `PHASE-001`. Current requirement, assignment, and event IDs restart from their initial ranges. Historical IDs remain unambiguous through qualified references such as `PHASE-001/REQ-0001`.

## Command reference

| Command | Purpose |
| --- | --- |
| `init` | Initialize a repository and optionally install agent instructions |
| `add` | Create a requirement |
| `update` | Add or remove path claims before merge |
| `schedule` | Select parallel work and explain blocked requirements |
| `start` | Create a branch, worktree, and assignment |
| `merge` | Merge an assignment into the target branch |
| `cleanup` | Remove a clean, merged assignment's worktree |
| `done` | Verify delivery facts and complete a requirement |
| `block` / `unblock` | Apply or remove a manual block |
| `release` | Release an assignment while preserving its requirement and worktree |
| `discard` | Remove a clean worktree retained by a released assignment |
| `deprecate` | Permanently stop a requirement that will not be delivered |
| `archive` | Archive all terminal requirements into an immutable Phase |
| `phase` | List or inspect Phase archives |
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
- `update` records path-claim changes in the event log and rejects new active conflicts unless explicitly forced.
- `cleanup` refuses uncommitted changes, including recursive submodule changes, and preserves nested repositories whose Git data exists only inside the worktree.
- `release` keeps interrupted work available; `discard` applies the same clean-worktree and nested-repository protections before removing it.
- `done` verifies recorded merge ancestry and worktree cleanup without requiring the assignment branch, then runs the optional verification command in the primary worktree.
- Verification output and exit status are recorded on the assignment; a failure keeps completion retryable.
- `repair` validates current Git facts before retrying a retained provisioning failure.
- Phase data lives under `.git/gantt-cli/phases/PHASE-xxx/`; `doctor` verifies each archive and summary against the hashes recorded in active state.
- Schema-v3 registries migrate automatically: cancelled requirements become deprecated and abandoned assignments become released.

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
