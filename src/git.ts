import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { GitError, ValidationError } from "./errors.js";

export interface GitResult { status: number; stdout: string; stderr: string }

export function runGitResult(repository: string, arguments_: string[]): GitResult {
  const result = spawnSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" });
  if (result.error) throw new GitError(`Could not execute Git: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export function runGit(repository: string, arguments_: string[]): string {
  const result = runGitResult(repository, arguments_);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "unknown Git failure";
    throw new GitError(`Git command failed: git -C ${repository} ${arguments_.join(" ")}\n${detail}`);
  }
  return result.stdout;
}

export function repositoryRoot(path: string): string {
  return resolve(runGit(resolve(path), ["rev-parse", "--show-toplevel"]).trim());
}

export function commonGitDir(repository: string): string {
  const result = runGit(repository, ["rev-parse", "--git-common-dir"]).trim();
  return resolve(isAbsolute(result) ? result : resolve(repository, result));
}

export function defaultWorktreeRoot(primaryRepository: string): string {
  return join(dirname(primaryRepository), `${basename(primaryRepository)}-worktrees`);
}

export function headCommit(repository: string): string {
  const result = runGitResult(repository, ["rev-parse", "--verify", "HEAD"]);
  if (result.status !== 0) {
    throw new GitError("The repository has no commit yet. Create an initial commit before starting work.");
  }
  return result.stdout.trim();
}

export function currentBranch(repository: string): string {
  const result = runGitResult(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (result.status !== 0) {
    throw new GitError(`${repository} is in detached HEAD state; a branch is required for this operation.`);
  }
  return result.stdout.trim();
}

export function branchExists(repository: string, branch: string): boolean {
  return runGitResult(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

export function validateNewBranch(repository: string, branch: string): void {
  const checked = runGitResult(repository, ["check-ref-format", "--branch", branch]);
  if (checked.status !== 0 || checked.stdout.trim() !== branch) {
    throw new ValidationError(`Invalid branch name: ${JSON.stringify(branch)}`);
  }
  if (branchExists(repository, branch)) {
    throw new ValidationError(`Branch ${JSON.stringify(branch)} already exists; each assignment needs a new branch.`);
  }
}

export function createWorktree(repository: string, branch: string, worktree: string): string {
  const baseCommit = headCommit(repository);
  validateNewBranch(repository, branch);
  if (existsSync(worktree)) throw new ValidationError(`Worktree path already exists: ${worktree}`);
  mkdirSync(dirname(worktree), { recursive: true });
  runGit(repository, ["worktree", "add", "-b", branch, worktree]);
  return baseCommit;
}

export function initializeSubmodules(worktree: string): void {
  if (existsSync(join(worktree, ".gitmodules"))) {
    runGit(worktree, ["submodule", "update", "--init", "--recursive"]);
  }
}

export interface WorktreeRecord { worktree?: string; HEAD?: string; branch?: string }

export function worktreeRecords(repository: string): WorktreeRecord[] {
  const output = runGit(repository, ["worktree", "list", "--porcelain"]);
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord = {};
  for (const line of output.split("\n")) {
    if (!line) {
      if (Object.keys(current).length > 0) records.push(current);
      current = {};
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    if (key === "worktree" || key === "HEAD" || key === "branch") current[key] = value;
  }
  if (Object.keys(current).length > 0) records.push(current);
  return records;
}

export function primaryWorktree(repository: string): string {
  const first = worktreeRecords(repository)[0]?.worktree;
  if (!first) throw new GitError("Git did not report a primary worktree for this repository.");
  return resolve(first);
}

export function registeredWorktree(repository: string, worktree: string): WorktreeRecord | undefined {
  const expected = resolve(worktree);
  return worktreeRecords(repository).find((record) => record.worktree && resolve(record.worktree) === expected);
}

export function verifyAssignmentWorktree(
  repository: string,
  worktree: string,
  branch: string,
  expectedCommonDirectory: string,
): void {
  if (!existsSync(worktree) || !statSync(worktree).isDirectory()) {
    throw new GitError(`Assignment worktree is missing: ${worktree}`);
  }
  const record = registeredWorktree(repository, worktree);
  if (!record) throw new GitError(`Assignment worktree is not registered with this repository: ${worktree}`);
  const expectedReference = `refs/heads/${branch}`;
  if (record.branch !== expectedReference) {
    throw new GitError(`Worktree branch mismatch: expected ${expectedReference}, found ${record.branch ?? "detached HEAD"}.`);
  }
  const actualRoot = repositoryRoot(worktree);
  if (commonGitDir(actualRoot) !== resolve(expectedCommonDirectory)) {
    throw new GitError(`Worktree belongs to a different Git repository: ${worktree}`);
  }
  if (currentBranch(worktree) !== branch) {
    throw new GitError(`Worktree checkout does not have expected branch ${JSON.stringify(branch)}: ${worktree}`);
  }
}

export function rollbackCreatedAssignment(repository: string, branch: string, worktree: string): void {
  runGitResult(repository, ["worktree", "remove", worktree]);
  runGitResult(repository, ["branch", "-D", branch]);
}

export function worktreeIsClean(worktree: string): boolean {
  const topLevel = runGit(worktree, ["status", "--porcelain=v1", "--ignore-submodules=none"]);
  if (topLevel.trim()) return false;
  const submodules = runGitResult(worktree, [
    "submodule", "foreach", "--quiet", "--recursive", "git status --porcelain=v1",
  ]);
  if (submodules.status !== 0) {
    throw new GitError(
      `Could not verify submodule cleanliness in ${worktree}: ${submodules.stderr.trim() || "submodule status check failed"}`,
    );
  }
  return !submodules.stdout.trim();
}

export function ensureWorktreeClean(worktree: string): void {
  if (!worktreeIsClean(worktree)) {
    throw new GitError(`Worktree or submodule has uncommitted changes: ${worktree}`);
  }
}

export function branchIsMerged(repository: string, branch: string, target = "HEAD"): boolean {
  return branchExists(repository, branch)
    && runGitResult(repository, ["merge-base", "--is-ancestor", branch, target]).status === 0;
}

export function mergeBranch(
  repository: string,
  branch: string,
  expectedTargetBranch?: string,
): { targetBranch: string; mergeCommit: string } {
  const targetBranch = currentBranch(repository);
  if (expectedTargetBranch && targetBranch !== expectedTargetBranch) {
    throw new GitError(
      `Primary worktree is on ${JSON.stringify(targetBranch)}, not requested target ${JSON.stringify(expectedTargetBranch)}. `
      + "Checkout the target branch first; gantt-cli never changes it implicitly.",
    );
  }
  if (targetBranch === branch) throw new GitError("Cannot merge an assignment branch into itself.");
  ensureWorktreeClean(repository);
  runGit(repository, ["merge", "--no-ff", "--no-edit", branch]);
  return { targetBranch, mergeCommit: headCommit(repository) };
}

export function changedPathsSince(repository: string, baseCommit: string, branch: string): string[] {
  if (!baseCommit) {
    throw new GitError("Assignment has no baseCommit; use doctor to inspect this legacy assignment.");
  }
  runGit(repository, ["rev-parse", "--verify", baseCommit]);
  if (!branchExists(repository, branch)) throw new GitError(`Assignment branch no longer exists: ${branch}`);
  return runGit(repository, ["diff", "--name-only", "--no-renames", `${baseCommit}..${branch}`])
    .split("\n").filter(Boolean);
}

export function removeWorktree(repository: string, worktree: string): void {
  runGit(repository, ["worktree", "remove", worktree]);
}
