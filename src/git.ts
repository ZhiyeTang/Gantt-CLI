import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  if (!branchExists(repository, branch)) throw new GitError(`Assignment branch is missing: ${branch}`);
  const actualRoot = repositoryRoot(worktree);
  if (commonGitDir(actualRoot) !== resolve(expectedCommonDirectory)) {
    throw new GitError(`Worktree belongs to a different Git repository: ${worktree}`);
  }
  if (currentBranch(worktree) !== branch) {
    throw new GitError(`Worktree checkout does not have expected branch ${JSON.stringify(branch)}: ${worktree}`);
  }
}

export function rollbackCreatedAssignment(repository: string, branch: string, worktree: string): string[] {
  const failures: string[] = [];
  if (registeredWorktree(repository, worktree) || existsSync(worktree)) {
    try {
      removeWorktree(repository, worktree);
    } catch (error) {
      failures.push(`Could not remove retained worktree ${worktree}: ${(error as Error).message}`);
    }
  }
  if (branchExists(repository, branch)) {
    const deleted = runGitResult(repository, ["branch", "-D", branch]);
    if (deleted.status !== 0) {
      failures.push(`Could not remove retained branch ${branch}: ${deleted.stderr.trim() || deleted.stdout.trim()}`);
    }
  }
  return failures;
}

export interface SubmoduleChanges { path: string; changes: string[] }
export interface WorktreeChanges { topLevel: string[]; submodules: SubmoduleChanges[] }

export function worktreeChanges(worktree: string, trackedOnly = false): WorktreeChanges {
  const topLevel = runGit(worktree, ["status", "--porcelain=v1", trackedOnly ? "--ignore-submodules=untracked" : "--ignore-submodules=none", ...(trackedOnly ? ["--untracked-files=no"] : [])])
    .split("\n").filter(Boolean);
  const submodules = runGitResult(worktree, [
    "submodule", "foreach", "--quiet", "--recursive",
    `status=$(git status --porcelain=v1 ${trackedOnly ? "--untracked-files=no --ignore-submodules=untracked" : ""}) || exit $?; if test -n \"$status\"; then printf '%s\\n' \"$status\" | while IFS= read -r line; do printf '%s\\0%s\\0' \"$displaypath\" \"$line\"; done; fi`,
  ]);
  if (submodules.status !== 0) {
    throw new GitError(
      `Could not verify submodule cleanliness in ${worktree}: ${submodules.stderr.trim() || "submodule status check failed"}`,
    );
  }
  const grouped = new Map<string, string[]>();
  const fields = submodules.stdout.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const path = fields[index];
    const change = fields[index + 1];
    if (!path || !change) continue;
    grouped.set(path, [...(grouped.get(path) ?? []), change]);
  }
  return { topLevel, submodules: [...grouped].map(([path, changes]) => ({ path, changes })) };
}

export function ensureWorktreeClean(worktree: string, trackedOnly = false): void {
  const changes = worktreeChanges(worktree, trackedOnly);
  if (changes.topLevel.length === 0 && changes.submodules.length === 0) return;
  const details: string[] = [];
  if (changes.topLevel.length > 0) {
    details.push(`Worktree has uncommitted changes: ${worktree}`, ...changes.topLevel.map((line) => `  ${line}`));
  }
  for (const submodule of changes.submodules) {
    details.push(`Submodule ${submodule.path} has uncommitted changes:`, ...submodule.changes.map((line) => `  ${line}`));
  }
  throw new GitError(details.join("\n"));
}

export function commitExists(repository: string, commit: string): boolean {
  return Boolean(commit) && runGitResult(repository, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]).status === 0;
}

export function resolveCommit(repository: string, revision: string): string {
  const result = runGitResult(repository, ["rev-parse", "--verify", `${revision}^{commit}`]);
  if (result.status !== 0) throw new GitError(`Git commit is missing or invalid: ${revision}`);
  return result.stdout.trim();
}

export function commitIsAncestor(repository: string, commit: string, target = "HEAD"): boolean {
  return commitExists(repository, commit)
    && runGitResult(repository, ["merge-base", "--is-ancestor", commit, target]).status === 0;
}

export function commitParent(repository: string, commit: string, parent: number): string | undefined {
  const result = runGitResult(repository, ["rev-parse", "--verify", `${commit}^${parent}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function mergeBranch(
  repository: string,
  branch: string,
  sourceCommit: string,
  expectedTargetBranch?: string,
): { targetBranch: string; sourceCommit: string; mergeCommit: string } {
  const targetBranch = currentBranch(repository);
  if (expectedTargetBranch && targetBranch !== expectedTargetBranch) {
    throw new GitError(
      `Primary worktree is on ${JSON.stringify(targetBranch)}, not requested target ${JSON.stringify(expectedTargetBranch)}. `
      + "Checkout the target branch first; gantt-cli never changes it implicitly.",
    );
  }
  if (targetBranch === branch) throw new GitError("Cannot merge an assignment branch into itself.");
  const currentSource = resolveCommit(repository, `refs/heads/${branch}`);
  if (currentSource !== sourceCommit) {
    throw new GitError(`Assignment branch advanced while merge was being prepared: ${branch}. Retry merge.`);
  }
  if (commitIsAncestor(repository, sourceCommit)) {
    throw new GitError(`Assignment source ${sourceCommit} is already in current HEAD; merge would not create a new merge commit.`);
  }
  ensureWorktreeClean(repository, true);
  const base = runGit(repository, ["merge-base", "HEAD", sourceCommit]).trim();
  const incoming = changedPathsSince(repository, base, sourceCommit);
  const collisions = localFiles(repository).filter((path) => incoming.some((changed) => path === changed || path.startsWith(`${changed}/`) || changed.startsWith(`${path}/`)));
  if (collisions.length) throw new GitError(`Merge would overwrite local files; preserve them before retrying: ${collisions.join(", ")}`);
  runGit(repository, ["merge", "--no-ff", "--no-edit", "--no-overwrite-ignore", branch]);
  const mergeCommit = headCommit(repository);
  if (commitParent(repository, mergeCommit, 2) !== sourceCommit) {
    throw new GitError(`Git did not create the expected merge commit for assignment source ${sourceCommit}.`);
  }
  return { targetBranch, sourceCommit, mergeCommit };
}

export function pendingMergeSource(repository: string): string | undefined {
  const result = runGitResult(repository, ["rev-parse", "--verify", "MERGE_HEAD"]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function recoverMerge(repository: string, intent: { targetBranch: string; targetCommit: string; sourceCommit: string }): string | undefined {
  if (currentBranch(repository) !== intent.targetBranch) throw new GitError(`Pending merge targets ${intent.targetBranch}; restore that checkout before retrying.`);
  if (pendingMergeSource(repository)) throw new GitError(`Resolve the pending conflict in ${repository}, run git merge --continue, then retry finish.`);
  if (headCommit(repository) === intent.targetCommit) return undefined;
  const candidates = runGit(repository, ["rev-list", "--first-parent", "--merges", `${intent.targetCommit}..HEAD`]).trim().split("\n").filter(Boolean);
  const merge = candidates.find((commit) => commitParent(repository, commit, 1) === intent.targetCommit && commitParent(repository, commit, 2) === intent.sourceCommit && !commitParent(repository, commit, 3));
  if (!merge) throw new GitError("Target advanced without the recorded merge topology; preserve the work and inspect the pending merge before retrying.");
  return merge;
}

export function changedPathsSince(repository: string, baseCommit: string, sourceCommit: string): string[] {
  if (!baseCommit) {
    throw new GitError("Assignment has no baseCommit; use doctor to inspect this legacy assignment.");
  }
  const base = resolveCommit(repository, baseCommit);
  const source = resolveCommit(repository, sourceCommit);
  return runGit(repository, ["diff", "--name-only", "--no-renames", "-z", `${base}..${source}`])
    .split("\0").filter(Boolean);
}

function nestedRepositoriesStoredInside(worktree: string): { repository: string; gitDirectory: string }[] {
  const root = resolve(worktree);
  const directories = [root];
  const nested = [];
  while (directories.length > 0) {
    const directory = directories.pop() as string;
    const entries = readdirSync(directory, { withFileTypes: true });
    const names = new Map(entries.map((entry) => [entry.name, entry]));
    if (directory !== root && names.get("HEAD")?.isFile()
      && names.get("objects")?.isDirectory() && names.get("refs")?.isDirectory()) {
      const bare = runGitResult(directory, ["rev-parse", "--is-bare-repository"]);
      if (bare.status === 0 && bare.stdout.trim() === "true") {
        nested.push({ repository: directory, gitDirectory: directory });
        continue;
      }
    }
    for (const entry of entries) {
      if (entry.name === ".git") {
        if (directory === root) continue;
        const discovered = runGitResult(directory, ["rev-parse", "--absolute-git-dir"]);
        const gitDirectory = resolve(discovered.status === 0 ? discovered.stdout.trim() : join(directory, ".git"));
        const relation = relative(root, gitDirectory);
        if (relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))) {
          nested.push({ repository: directory, gitDirectory });
        }
        continue;
      }
      if (entry.isDirectory()) directories.push(join(directory, entry.name));
    }
  }
  return nested;
}

export function removeWorktree(repository: string, worktree: string, preservation?: { paths: string[]; directory: string }): void {
  ensureWorktreeClean(worktree, true);
  const nested = nestedRepositoriesStoredInside(worktree);
  if (nested.length > 0) {
    const details = nested.map((item) => {
      const repositoryPath = relative(worktree, item.repository).replaceAll(sep, "/");
      const gitPath = relative(worktree, item.gitDirectory).replaceAll(sep, "/");
      return `  ${repositoryPath} (Git data: ${gitPath})`;
    });
    throw new GitError([
      `Refusing to remove worktree because nested Git repositories store data inside it: ${worktree}`,
      ...details,
      "Move or push these repositories to durable storage before cleanup.",
    ].join("\n"));
  }
  const files = requireClassifiedFiles(worktree, preservation?.paths ?? []);
  if (preservation) {
    for (const path of files) {
      try { preserveFile(worktree, preservation.directory, path); }
      catch (error) { throw new GitError(`Could not preserve ${path}: ${(error as Error).message}. Worktree retained.`); }
    }
    // Check again after copying: files created or modified during preservation must survive.
    const latest = requireClassifiedFiles(worktree, preservation.paths);
    if (latest.join("\0") !== files.join("\0")) throw new GitError("Local files changed during preservation; retry cleanup.");
    for (const path of files) {
      if (!sameFileContents(safeFilePath(worktree, path), safeFilePath(preservation.directory, path))) {
        throw new GitError(`Local file changed during preservation: ${path}. Worktree retained.`);
      }
    }
  }
  ensureWorktreeClean(worktree, true);
  runGit(repository, ["worktree", "remove", "--force", worktree]);
}

// ponytail: enumerate local files with Git; directory manifests if very large dependency trees become a bottleneck.
export function localFiles(worktree: string): string[] {
  const repositories = ["", ...runGit(worktree, ["submodule", "foreach", "--quiet", "--recursive", "printf '%s\\0' \"$displaypath\" "]).split("\0").filter(Boolean)];
  return [...new Set(repositories.flatMap((prefix) => {
    const root = join(worktree, prefix);
    return [false, true].flatMap((ignored) => runGit(root, ["ls-files", "--others", "--exclude-standard", "-z", ...(ignored ? ["--ignored"] : [])])
      .split("\0").filter(Boolean).map((path) => (prefix ? `${prefix}/${path}` : path).replace(/\/$/, "")));
  }))].sort();
}

export function safeFilePath(root: string, path: string): string {
  const parts = path.split("/");
  if (!path || path.includes("\\") || path.includes("\0") || parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new ValidationError(`Invalid local file path: ${JSON.stringify(path)}`);
  }
  let current = resolve(root);
  const rootMetadata = lstatSync(current, { throwIfNoEntry: false });
  if (rootMetadata && !rootMetadata.isDirectory()) throw new GitError(`Not a real directory: ${root}`);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (metadata && !metadata.isDirectory()) throw new GitError(`Refusing symlink or non-directory parent in ${path}`);
  }
  return join(root, ...parts);
}

export function requireClassifiedFiles(worktree: string, classified: string[]): string[] {
  const files = localFiles(worktree);
  const allowed = new Set(classified);
  const unknown = files.filter((path) => !allowed.has(path));
  if (unknown.length) throw new GitError(`Worktree has uncommitted changes or unclassified local files (including ignored files): ${worktree}\n${unknown.map((path) => `  ${path}`).join("\n")}\nCommit deliverables or run classify with --path and --reason before cleanup.`);
  return files;
}

function sameFileContents(source: string, destination: string): boolean {
  const from = lstatSync(source);
  const to = lstatSync(destination, { throwIfNoEntry: false });
  if (!to) return false;
  if (from.isSymbolicLink()) return to.isSymbolicLink() && readlinkSync(source) === readlinkSync(destination);
  return from.isFile() && to.isFile() && (from.mode & 0o777) === (to.mode & 0o777) && readFileSync(source).equals(readFileSync(destination));
}

function preserveFile(worktree: string, directory: string, path: string): void {
  const source = safeFilePath(worktree, path);
  const destination = safeFilePath(directory, path);
  const metadata = lstatSync(source);
  if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new GitError(`Cannot preserve special file or nested repository: ${path}`);
  if (lstatSync(destination, { throwIfNoEntry: false })) {
    if (sameFileContents(source, destination)) return;
    throw new GitError(`Preservation conflict at ${destination}; retain that copy separately before retrying. Worktree retained.`);
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (metadata.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination);
    return;
  }
  const temporary = join(dirname(destination), `.gantt-preserve-${randomUUID()}`);
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, metadata.mode & 0o777);
    const descriptor = openSync(temporary, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    linkSync(temporary, destination); // Atomic, exclusive publication; a retry never overwrites a saved file.
  } finally { rmSync(temporary, { force: true }); }
}
