# Gantt-CLI

English | [简体中文](./README.zh-CN.md)

**Task scheduling and delivery for coding agents.**

> Keep simple tasks simple and complex work coordinated. Clear responsibilities, verifiable delivery.

<p align="center">
  <img src="./assets/gantt-cli-demo.gif" alt="Gantt-CLI schedules requirements into isolated Git worktrees and verifies delivery" width="900" />
</p>

Coding agents are fast. Coordination is not.

When several agents work in the same repository, the hard part is rarely generating code. It is knowing who owns what, which tasks touch the same files, whether a branch was actually merged, and where to resume after an interrupted run.

Gantt-CLI turns those concerns into a local workflow built on Git branches and worktrees. It needs no daemon, database, or hosted service; `doctor` diagnoses state drift, while `repair` retries retained worktrees after provisioning failures.

> Gantt-CLI is in alpha. Commands and the state format may still change.

## TL;DR

Gantt-CLI lets coding agents complete lightweight tasks directly and coordinate complex work in isolated Git worktrees. Declared scopes, dependencies, and coordination plans guide parallel work; one retryable command handles merging, verification, file preservation, and cleanup. Everything runs locally, with state that agents and scripts can inspect and resume.

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

### Parallel work needs clear responsibilities

“You take the backend, I will take the frontend” is not enough to prevent collisions. Gantt-CLI uses declared `--path` patterns and optional `--domain` claims to identify overlapping work and explain why tasks can run together or must wait.

### Chat history is not project state

Agents exit, terminals close, and context disappears. Gantt-CLI records requirements, assignments, commits, worktrees, and state transitions in the repository's Git common dir. `doctor` compares that state with current Git facts.

### “Implemented” is not the same as “delivered”

A requirement cannot become `done` until its commit is merged, its configured verification command passes, and its worktree is cleaned up. Completion comes from repository facts, not an agent's claim.

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

Unblocking returns the requirement to `ready` or `active`. A failed verification leaves it `active` with a `merged` assignment and retained worktree. Fix and commit there, then retry `finish`.

The scheduler selects requirements whose dependencies are complete, whose scopes do not conflict or have a valid coordination plan, and which are otherwise ready to run. Add `--json` to consume its output from an agent or script.

## Quick start

### First decide whether to register

The Agent briefly explains its classification: bounded, low-risk work with direct verification runs inline, without registration or a worktree. File count is not a threshold. If collaboration, dependency coordination, or isolation becomes necessary, upgrade automatically: record the original workspace state, transfer only task changes, verify them in the new worktree, then remove only those task changes from the original checkout. Keep unrelated edits. Preserve the original files and report ambiguity when ownership is unclear.

The following steps apply to managed work.

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
npx gantt-cli@latest finish REQ-0001 --json
```

`finish` checks, merges, verifies, preserves classified files, removes the worktree, and records `done`. On failure, follow the JSON `nextAction`, fix the problem, and retry the same command. Resolve Git conflicts in the primary worktree and run `git merge --continue`; fix failed verification in the retained task worktree and commit. Missing verification commands are reported explicitly. Task branches remain; nothing is pushed or archived automatically.

The old `done` command has been removed. `finish` is the single completion entry point. `merge` and `cleanup` remain for diagnosis and repair; `cleanup` also verifies before deleting.

#### Preserve local files

Starting work records local file lists for the primary and task worktrees. Unrelated untracked primary files may remain; files that would be overwritten still block merging. Baselines describe provenance, not permission to delete. Names and ignored status do not determine ownership.

Commit deliverable source files normally. Explicitly classify configuration, notes, build output, or dependency files that should be retained:

```bash
npx gantt-cli@latest classify REQ-0001 --path .env --path build --reason "Local settings and non-delivery build output"
npx gantt-cli@latest finish REQ-0001 --json
```

`--path` names a concrete file or directory, not a glob. A directory classification covers only its current files; later files need classification separately. Before cleanup, classified files (including ignored files) are saved under `gantt-cli/preserved/<assignment-id>-<unique-key>/` in the Git common dir. The returned `assignment.preservationDirectory` identifies the saved location, which is not reused when phase IDs reset. Relative paths, contents, and file permissions are retained. Symlinks are preserved as links; their external targets are not read.

Unclassified files, failed copies, or conflicting saved contents retain the worktree. Saved copies are never overwritten: retain the old copy elsewhere before retrying. Uncommitted tracked changes and nested repositories holding unique Git data still block removal. After `release`, use the assignment ID with `classify`, then `discard`; the same file protections apply.

#### Work on the same file in parallel

The Agent can record this `plan.json`; the member array is also the merge order:

```json
{
  "members": [
    { "requirementId": "REQ-0001", "work": "Update request parsing" },
    { "requirementId": "REQ-0002", "work": "Update output in the same file" }
  ],
  "verify": "npm test"
}
```

```bash
npx gantt-cli@latest coordinate --plan-file plan.json
npx gantt-cli@latest schedule --json
```

A valid plan permits same-module or same-file development in independent worktrees without repeated user approval. Merges are ordered; each completion runs the task's verification and the plan's integrated verification. Real `--depends-on` relationships still gate starting work. Use a plan for merge order alone. The UI task in Quick start has a real dependency; a plan does not waive it.

Re-record the plan when scopes change. A member may include an optional `paths` array to update its claims atomically with the plan. Unlisted tasks receive no exemption. A new plan replaces all old plans that share any of its members; include remaining members if their coordination must continue. The old `--force` override has been removed.

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
| `cleanup` | Verify merged work, preserve classified files, and remove its worktree |
| `finish` | Merge, verify, preserve files, clean up, and complete; retryable |
| `classify` | Identify current local files to preserve |
| `coordinate` | Record work division, merge order, and integrated verification |
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
- Worktrees live in the adjacent `<repository-name>-worktrees/` directory by default.
- `merge` rejects out-of-scope paths before changing the primary worktree and records immutable source/merge commit evidence.
- `update` records scope changes; overlapping claims need a valid plan, which must be reconsidered when scopes change.
- `cleanup` verifies before preserving classified files; tracked edits, unclassified files, and nested repositories with unique Git data block deletion.
- `release` keeps interrupted work available; `discard` applies the same clean-worktree and nested-repository protections before removing it.
- `finish` records merge intent before Git changes and recovers using exact commit relationships. Verification is bound to the target commit and runs before cleanup; a changed target requires verification again.
- Verification output and exit status are recorded on the assignment; a failure keeps completion retryable.
- `repair` validates current Git facts before retrying a retained provisioning failure.
- Phase data lives under `.git/gantt-cli/phases/PHASE-xxx/`; `doctor` verifies each archive and summary against the hashes recorded in active state.
- Schema-v3 registries migrate automatically: cancelled requirements become deprecated and abandoned assignments become released.

## Requirements and limits

- Node.js 20 or newer
- A Git repository with at least one commit
- Scope conflicts come from explicit `--path` and `--domain` claims; semantic or runtime conflicts are not predicted
- State-format compatibility is not guaranteed during alpha

The only runtime dependency is picocolors for terminal colors; scheduling and Git operations use the Node.js standard library.

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
