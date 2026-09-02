import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { createWorktree, initializeSubmodules, rollbackCreatedAssignment } from "../dist/git.js";

const cli = resolve("dist/cli.js");

function git(repository, ...arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" });
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gantt-cli-node-"));
  const repository = join(directory, "sample-project");
  mkdirSync(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "tests@example.invalid");
  git(repository, "config", "user.name", "gantt-cli tests");
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial commit");
  return {
    repository,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function invoke(...arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], { encoding: "utf8" });
}

function invokeAsync(...arguments_) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...arguments_], { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function startAssignment(project, { path = "src/**", alias = "change", verify } = {}) {
  assert.equal(invoke("init", "--repo", project.repository).status, 0);
  const addArguments = [
    "add", "--repo", project.repository,
    "--request", "Implement change", "--path", path,
  ];
  if (verify) addArguments.push("--verify", verify);
  const added = invoke(...addArguments);
  assert.equal(added.status, 0, added.stderr);
  const started = invoke(
    "start", "--repo", project.repository, "REQ-0001",
    "--session", "session-test", "--alias", alias, "--json",
  );
  assert.equal(started.status, 0, started.stderr || started.stdout);
  return JSON.parse(started.stdout).assignment;
}

function commitFile(assignment, path, contents = "export {};\n") {
  const absolute = join(assignment.worktree, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  git(assignment.worktree, "add", path);
  git(assignment.worktree, "commit", "-m", `update ${path}`);
}

function statePath(project) {
  return join(project.repository, ".git", "gantt-cli", "state.json");
}

function readState(project) {
  return JSON.parse(readFileSync(statePath(project), "utf8"));
}

function writeState(project, state) {
  writeFileSync(statePath(project), `${JSON.stringify(state, null, 2)}\n`);
}

test("init creates a schema-v3 state file through the CLI", () => {
  const project = fixture();
  try {
    const result = invoke("init", "--repo", project.repository);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Initialized gantt-cli/);
    const state = JSON.parse(
      readFileSync(join(project.repository, ".git", "gantt-cli", "state.json"), "utf8"),
    );
    assert.equal(state.schemaVersion, 3);
    assert.equal(state.repository.root, realpathSync(project.repository));
    assert.equal(state.events[0].type, "registry.initialized");
  } finally {
    project.cleanup();
  }
});

test("init installs idempotent managed instructions without replacing existing AGENTS.md content", () => {
  const project = fixture();
  try {
    const instructionsPath = join(project.repository, "AGENTS.md");
    writeFileSync(instructionsPath, "# Existing project instructions\n\nKeep this guidance.\n");

    const first = invoke(
      "init", "--repo", project.repository, "--install-agent-instructions",
    );

    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Agent instructions:/);
    const installed = readFileSync(instructionsPath, "utf8");
    assert.match(installed, /^# Existing project instructions/);
    assert.match(installed, /<!-- gantt-cli:instructions:start -->/);
    assert.match(installed, /npx gantt-cli@next agent-instructions/);
    assert.match(installed, /<!-- gantt-cli:instructions:end -->/);

    const second = invoke(
      "init", "--repo", project.repository, "--install-agent-instructions",
    );
    assert.equal(second.status, 0, second.stderr);
    const reinstalled = readFileSync(instructionsPath, "utf8");
    assert.equal(reinstalled, installed);
    assert.equal(reinstalled.match(/gantt-cli:instructions:start/g)?.length, 1);
  } finally {
    project.cleanup();
  }
});

test("add and schedule preserve stable requirement planning behavior", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    const additions = [
      ["Implement authentication", "p1", "2", "src/auth/**", "auth"],
      ["Add login retry", "p2", "1", "src/auth/login.py", "auth"],
      ["Write guide", "p2", "1", "docs/auth.md"],
    ];
    for (const [request, priority, points, path, domain] of additions) {
      const arguments_ = [
        "add",
        "--repo",
        project.repository,
        "--request",
        request,
        "--priority",
        priority,
        "--points",
        points,
        "--path",
        path,
        "--json",
      ];
      if (domain) arguments_.splice(-1, 0, "--domain", domain);
      const added = invoke(...arguments_);
      assert.equal(added.status, 0, added.stderr);
    }

    const scheduled = invoke("schedule", "--repo", project.repository, "--json");

    assert.equal(scheduled.status, 0, scheduled.stderr);
    const plan = JSON.parse(scheduled.stdout);
    assert.deepEqual(plan.batches[0].requirements, ["REQ-0001", "REQ-0003"]);
    assert.deepEqual(plan.batches[1].requirements, ["REQ-0002"]);
    assert.deepEqual(plan.decisions["REQ-0002"], { kind: "batch", batch: 1 });
  } finally {
    project.cleanup();
  }
});

test("add records an optional verification command", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);

    const added = invoke(
      "add", "--repo", project.repository,
      "--request", "Add task API",
      "--path", "src/api/**",
      "--verify", "npm test",
      "--json",
    );

    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).requirement.verify, "npm test");
  } finally {
    project.cleanup();
  }
});

test("start binds an assignment to an isolated linked worktree", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    const added = invoke(
      "add", "--repo", project.repository,
      "--request", "Add login interface",
      "--path", "src/auth/login.ts",
      "--domain", "auth",
      "--json",
    );
    assert.equal(added.status, 0, added.stderr);

    const started = invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-test-01",
      "--alias", "login-interface",
      "--json",
    );

    assert.equal(started.status, 0, started.stderr);
    const result = JSON.parse(started.stdout);
    assert.equal(result.assignment.id, "ASN-0001");
    assert.equal(result.assignment.requirementId, "REQ-0001");
    assert.equal(result.assignment.session, "session-test-01");
    assert.equal(result.assignment.status, "active");
    assert.match(result.assignment.branch, /^codex\/req-0001-login-interface-asn-0001$/);
    assert.equal(git(result.assignment.worktree, "branch", "--show-current").trim(), result.assignment.branch);

    const linkedAdd = invoke(
      "add", "--repo", result.assignment.worktree,
      "--request", "Write guide",
      "--path", "docs/auth.md",
      "--json",
    );
    assert.equal(linkedAdd.status, 0, linkedAdd.stderr);
    assert.equal(JSON.parse(linkedAdd.stdout).requirement.id, "REQ-0002");
  } finally {
    project.cleanup();
  }
});

test("completion requires merge then cleanup then done", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository,
      "--request", "Implement authentication",
      "--path", "src/auth/**",
      "--verify", "node -e \"require('node:fs').writeFileSync('verification-ran.txt', 'yes')\"",
      "--json",
    ).status, 0);
    const started = invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-test-01", "--alias", "auth-core", "--json",
    );
    assert.equal(started.status, 0, started.stderr);
    const assignment = JSON.parse(started.stdout).assignment;
    mkdirSync(join(assignment.worktree, "src", "auth"), { recursive: true });
    writeFileSync(join(assignment.worktree, "src", "auth", "login.ts"), "export {};\n");
    git(assignment.worktree, "add", "src/auth/login.ts");
    git(assignment.worktree, "commit", "-m", "add login");

    const premature = invoke("done", "--repo", project.repository, "REQ-0001");
    assert.equal(premature.status, 2);

    const merged = invoke("merge", "--repo", project.repository, "REQ-0001", "--json");
    assert.equal(merged.status, 0, merged.stderr);
    assert.equal(JSON.parse(merged.stdout).assignment.status, "merged");

    const cleaned = invoke("cleanup", "--repo", project.repository, "REQ-0001", "--json");
    assert.equal(cleaned.status, 0, cleaned.stderr);
    const cleanedAssignment = JSON.parse(cleaned.stdout).assignment;
    assert.equal(cleanedAssignment.status, "cleaned");
    assert.equal(exists(cleanedAssignment.worktree), false);

    const completed = invoke("done", "--repo", project.repository, "REQ-0001", "--json");
    assert.equal(completed.status, 0, completed.stderr);
    const result = JSON.parse(completed.stdout);
    assert.equal(result.requirement.status, "done");
    assert.equal(result.assignment.status, "completed");
    assert.equal(readFileSync(join(project.repository, "verification-ran.txt"), "utf8"), "yes");
    assert.equal(result.assignment.verification.command, result.requirement.verify);
    assert.equal(result.assignment.verification.exitCode, 0);
  } finally {
    project.cleanup();
  }
});

test("cleanup force-removes clean submodule worktrees and reports every dirty path", () => {
  const project = fixture();
  const submodule = fixture();
  const previousAllowedProtocols = process.env.GIT_ALLOW_PROTOCOL;
  try {
    git(project.repository, "-c", "protocol.file.allow=always", "submodule", "add", submodule.repository, "vendor/sample");
    git(project.repository, "commit", "-am", "add submodule");
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const assignment = startAssignment(project);
    commitFile(assignment, "src/change.ts");
    assert.equal(invoke("merge", "--repo", project.repository, "REQ-0001").status, 0);

    writeFileSync(join(assignment.worktree, "dirty.txt"), "dirty\n");
    writeFileSync(join(assignment.worktree, "vendor", "sample", "debug.log"), "dirty\n");
    const dirty = invoke("cleanup", "--repo", project.repository, "REQ-0001");

    assert.equal(dirty.status, 2);
    assert.match(dirty.stderr, /dirty\.txt/);
    assert.match(dirty.stderr, /Submodule vendor\/sample/);
    assert.match(dirty.stderr, /debug\.log/);

    rmSync(join(assignment.worktree, "dirty.txt"));
    rmSync(join(assignment.worktree, "vendor", "sample", "debug.log"));
    const cleaned = invoke("cleanup", "--repo", project.repository, "REQ-0001");
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(exists(assignment.worktree), false);
  } finally {
    if (previousAllowedProtocols === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocols;
    project.cleanup();
    submodule.cleanup();
  }
});

test("cleanup preserves nested Git repositories whose objects exist only inside the worktree", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project, { path: "**" });
    const nestedRepository = join(assignment.worktree, "External", "package");
    mkdirSync(nestedRepository, { recursive: true });
    git(nestedRepository, "init", "-b", "main");
    git(nestedRepository, "config", "user.email", "tests@example.invalid");
    git(nestedRepository, "config", "user.name", "gantt-cli tests");
    writeFileSync(join(nestedRepository, "package.txt"), "durable only here\n");
    git(nestedRepository, "add", "package.txt");
    git(nestedRepository, "commit", "-m", "package commit");
    writeFileSync(
      join(assignment.worktree, ".gitmodules"),
      "[submodule \"External/package\"]\n\tpath = External/package\n\turl = ./External/package\n",
    );
    git(assignment.worktree, "add", ".gitmodules", "External/package");
    git(assignment.worktree, "commit", "-m", "add embedded package repository");
    const merged = invoke("merge", "--repo", project.repository, "REQ-0001");
    assert.equal(merged.status, 0, merged.stderr);

    const cleaned = invoke("cleanup", "--repo", project.repository, "REQ-0001");

    assert.equal(cleaned.status, 2);
    assert.match(cleaned.stderr, /nested Git repositories store data inside it/);
    assert.match(cleaned.stderr, /External\/package/);
    assert.equal(readFileSync(join(nestedRepository, "package.txt"), "utf8"), "durable only here\n");
  } finally {
    project.cleanup();
  }
});

test("done and doctor use recorded commits after the merged branch is deleted", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    commitFile(assignment, "src/change.ts");
    const merged = invoke("merge", "--repo", project.repository, "REQ-0001", "--json");
    assert.equal(merged.status, 0, merged.stderr);
    const mergedAssignment = JSON.parse(merged.stdout).assignment;
    assert.equal(
      git(project.repository, "rev-parse", `${mergedAssignment.mergeCommit}^2`).trim(),
      mergedAssignment.sourceCommit,
    );
    assert.equal(invoke("cleanup", "--repo", project.repository, "REQ-0001").status, 0);

    git(project.repository, "branch", "-D", assignment.branch);
    const diagnosed = invoke("doctor", "--repo", project.repository, "--json");
    assert.equal(diagnosed.status, 0, diagnosed.stderr || diagnosed.stdout);
    assert.equal(JSON.parse(diagnosed.stdout).issues.some((issue) => issue.code === "missing_branch"), false);

    const completed = invoke("done", "--repo", project.repository, "REQ-0001", "--json");
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    assert.equal(JSON.parse(completed.stdout).requirement.status, "done");
  } finally {
    project.cleanup();
  }
});

test("active assignments report a missing branch directly", () => {
  const project = fixture();
  const blockedProject = fixture();
  try {
    const assignment = startAssignment(project);
    git(project.repository, "update-ref", "-d", `refs/heads/${assignment.branch}`);

    const diagnosed = invoke("doctor", "--repo", project.repository, "--json");
    assert.equal(diagnosed.status, 1, diagnosed.stderr || diagnosed.stdout);
    const issue = JSON.parse(diagnosed.stdout).issues.find((item) => item.code === "missing_branch");
    assert.equal(issue.message, `Branch is missing: ${assignment.branch}`);

    const merged = invoke("merge", "--repo", project.repository, "REQ-0001");
    assert.equal(merged.status, 2);
    assert.match(merged.stderr, /Assignment branch is missing/);
    assert.doesNotMatch(merged.stderr, /not merged/);

    const blockedAssignment = startAssignment(blockedProject);
    assert.equal(invoke(
      "block", "--repo", blockedProject.repository, "REQ-0001", "--reason", "waiting",
    ).status, 0);
    git(blockedProject.repository, "update-ref", "-d", `refs/heads/${blockedAssignment.branch}`);
    const blockedDiagnosis = invoke("doctor", "--repo", blockedProject.repository, "--json");
    assert.equal(JSON.parse(blockedDiagnosis.stdout).issues.some((item) => item.code === "missing_branch"), true);
  } finally {
    project.cleanup();
    blockedProject.cleanup();
  }
});

test("cleanup and doctor reject incomplete, inconsistent, or unreachable merge evidence", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    commitFile(assignment, "src/change.ts");
    const merged = invoke("merge", "--repo", project.repository, "REQ-0001", "--json");
    assert.equal(merged.status, 0, merged.stderr);
    const evidence = JSON.parse(merged.stdout).assignment;

    const missingSource = readState(project);
    delete missingSource.assignments[0].sourceCommit;
    writeState(project, missingSource);
    let diagnosed = invoke("doctor", "--repo", project.repository, "--json");
    assert.equal(JSON.parse(diagnosed.stdout).issues.some((issue) => issue.code === "missing_source_commit"), true);
    const missingCleanup = invoke("cleanup", "--repo", project.repository, "REQ-0001");
    assert.match(missingCleanup.stderr, /has no recorded sourceCommit/);

    const wrongParent = readState(project);
    wrongParent.assignments[0].sourceCommit = assignment.baseCommit;
    writeState(project, wrongParent);
    diagnosed = invoke("doctor", "--repo", project.repository, "--json");
    assert.equal(JSON.parse(diagnosed.stdout).issues.some((issue) => issue.code === "merge_topology"), true);

    const restored = readState(project);
    restored.assignments[0].sourceCommit = evidence.sourceCommit;
    writeState(project, restored);
    git(project.repository, "reset", "--hard", `${evidence.mergeCommit}^1`);
    diagnosed = invoke("doctor", "--repo", project.repository, "--json");
    assert.equal(JSON.parse(diagnosed.stdout).issues.some((issue) => issue.code === "merge_not_in_head"), true);
    const unreachableCleanup = invoke("cleanup", "--repo", project.repository, "REQ-0001");
    assert.match(unreachableCleanup.stderr, /is not an ancestor of current HEAD/);
  } finally {
    project.cleanup();
  }
});

test("a merged assignment can merge new commits again but cannot clean them silently", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    commitFile(assignment, "src/change.ts", "export const version = 1;\n");
    const first = invoke("merge", "--repo", project.repository, "REQ-0001", "--json");
    assert.equal(first.status, 0, first.stderr);
    const firstEvidence = JSON.parse(first.stdout).assignment;

    commitFile(assignment, "src/change.ts", "export const version = 2;\n");
    const drift = invoke("doctor", "--repo", project.repository, "--json");
    assert.equal(JSON.parse(drift.stdout).issues.some((issue) => issue.code === "branch_advanced_after_merge"), true);
    const prematureCleanup = invoke("cleanup", "--repo", project.repository, "REQ-0001");
    assert.equal(prematureCleanup.status, 2);
    assert.match(prematureCleanup.stderr, /advanced after merge/);

    const second = invoke("merge", "--repo", project.repository, "REQ-0001", "--json");
    assert.equal(second.status, 0, second.stderr);
    const secondEvidence = JSON.parse(second.stdout).assignment;
    assert.notEqual(secondEvidence.sourceCommit, firstEvidence.sourceCommit);
    assert.notEqual(secondEvidence.mergeCommit, firstEvidence.mergeCommit);

    const repeated = invoke("merge", "--repo", project.repository, "REQ-0001");
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /already merged/);
    const logged = invoke("log", "--repo", project.repository, "--assignment", assignment.id, "--json");
    assert.equal(JSON.parse(logged.stdout).events.filter((event) => event.type === "assignment.merged").length, 2);
    assert.equal(invoke("cleanup", "--repo", project.repository, "REQ-0001").status, 0);
  } finally {
    project.cleanup();
  }
});

test("merge rejects an assignment that would not create a merge commit", () => {
  const project = fixture();
  try {
    startAssignment(project);
    const before = git(project.repository, "rev-parse", "HEAD").trim();

    const merged = invoke("merge", "--repo", project.repository, "REQ-0001");

    assert.equal(merged.status, 2);
    assert.match(merged.stderr, /would not create a new merge commit/);
    assert.equal(git(project.repository, "rev-parse", "HEAD").trim(), before);
  } finally {
    project.cleanup();
  }
});

test("cleanup recovers only a previously verified removal", () => {
  const recoverable = fixture();
  const unverified = fixture();
  try {
    const recoverableAssignment = startAssignment(recoverable);
    commitFile(recoverableAssignment, "src/change.ts");
    assert.equal(invoke("merge", "--repo", recoverable.repository, "REQ-0001").status, 0);
    const recoverableState = readState(recoverable);
    recoverableState.assignments[0].cleanupPending = true;
    writeState(recoverable, recoverableState);
    git(recoverable.repository, "worktree", "remove", "--force", recoverableAssignment.worktree);
    git(recoverable.repository, "branch", "-D", recoverableAssignment.branch);
    const recovered = invoke("cleanup", "--repo", recoverable.repository, "REQ-0001");
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /Recovered completed cleanup/);

    const unverifiedAssignment = startAssignment(unverified);
    commitFile(unverifiedAssignment, "src/change.ts");
    assert.equal(invoke("merge", "--repo", unverified.repository, "REQ-0001").status, 0);
    git(unverified.repository, "worktree", "remove", "--force", unverifiedAssignment.worktree);
    const rejected = invoke("cleanup", "--repo", unverified.repository, "REQ-0001");
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /cleanup was not recorded/);
  } finally {
    recoverable.cleanup();
    unverified.cleanup();
  }
});

test("rollback removes a newly created worktree containing submodules", () => {
  const project = fixture();
  const submodule = fixture();
  const previousAllowedProtocols = process.env.GIT_ALLOW_PROTOCOL;
  try {
    git(project.repository, "-c", "protocol.file.allow=always", "submodule", "add", submodule.repository, "vendor/sample");
    git(project.repository, "commit", "-am", "add submodule");
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const branch = "codex/rollback";
    const worktree = `${project.repository}-rollback`;
    createWorktree(project.repository, branch, worktree);
    initializeSubmodules(worktree);

    assert.deepEqual(rollbackCreatedAssignment(project.repository, branch, worktree), []);
    assert.equal(exists(worktree), false);
    assert.equal(git(project.repository, "branch", "--list", branch).trim(), "");
  } finally {
    if (previousAllowedProtocols === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocols;
    project.cleanup();
    submodule.cleanup();
  }
});

test("done preserves a retryable requirement when verification fails", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository,
      "--request", "Implement authentication",
      "--path", "src/auth/**",
      "--verify", "node -e \"process.stderr.write('broken'); process.exit(7)\"",
    ).status, 0);
    const started = invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-test-01", "--alias", "auth-core", "--json",
    );
    assert.equal(started.status, 0, started.stderr);
    const assignment = JSON.parse(started.stdout).assignment;
    mkdirSync(join(assignment.worktree, "src", "auth"), { recursive: true });
    writeFileSync(join(assignment.worktree, "src", "auth", "login.ts"), "export {};\n");
    git(assignment.worktree, "add", "src/auth/login.ts");
    git(assignment.worktree, "commit", "-m", "add login");
    assert.equal(invoke("merge", "--repo", project.repository, "REQ-0001").status, 0);
    assert.equal(invoke("cleanup", "--repo", project.repository, "REQ-0001").status, 0);

    const failed = invoke("done", "--repo", project.repository, "REQ-0001", "--json");

    assert.equal(failed.status, 3, failed.stderr || failed.stdout);
    const failure = JSON.parse(failed.stdout);
    assert.equal(failure.requirement.status, "active");
    assert.equal(failure.assignment.status, "cleaned");
    assert.equal(failure.assignment.verification.exitCode, 7);
    assert.equal(failure.assignment.verification.stderr, "broken");
    assert.equal(failure.nextAction, "fix_verification");
    const shown = invoke("show", "--repo", project.repository, "REQ-0001", "--json");
    assert.equal(JSON.parse(shown.stdout).assignments[0].verification.exitCode, 7);
  } finally {
    project.cleanup();
  }
});

test("list migrates a legacy schema-v1 registry without losing evidence", () => {
  const project = fixture();
  try {
    const registryDirectory = join(project.repository, ".git", "gantt-cli");
    mkdirSync(registryDirectory);
    writeFileSync(join(registryDirectory, "registry.json"), JSON.stringify({
      schemaVersion: 1,
      repository: {
        root: realpathSync(project.repository),
        commonGitDir: realpathSync(join(project.repository, ".git")),
      },
      nextRequirementNumber: 2,
      requirements: [{
        id: "REQ-0001",
        request: "Legacy requirement",
        session: "legacy-session",
        files: ["src/legacy.py"],
        branch: "codex/legacy",
        worktree: "/tmp/legacy-worktree",
        status: "pending",
        createdAt: "2026-08-20T00:00:00+00:00",
      }],
    }));

    const listed = invoke("list", "--repo", project.repository, "--json");

    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).requirements[0].status, "ready");
    const migrated = JSON.parse(readFileSync(join(registryDirectory, "state.json"), "utf8"));
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.assignments[0].status, "legacy");
    assert.equal(migrated.events.at(-1).type, "registry.migrated");
  } finally {
    project.cleanup();
  }
});

test("parallel add commands receive distinct IDs through the process lock", async () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => invokeAsync(
      "add", "--repo", project.repository,
      "--request", `Parallel task ${index + 1}`,
      "--path", `src/task-${index + 1}.ts`,
      "--json",
    )));
    assert.deepEqual(results.map((result) => result.status), [0, 0, 0, 0, 0, 0], results);

    const listed = invoke("list", "--repo", project.repository, "--json");
    assert.equal(listed.status, 0, listed.stderr);
    const identifiers = JSON.parse(listed.stdout).requirements.map((item) => item.id).sort();
    assert.deepEqual(identifiers, [
      "REQ-0001", "REQ-0002", "REQ-0003", "REQ-0004", "REQ-0005", "REQ-0006",
    ]);
  } finally {
    project.cleanup();
  }
});

test("block unblock abandon and reassign preserve assignment history", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository,
      "--request", "Implement auth", "--path", "src/auth/**",
    ).status, 0);
    const first = invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-one", "--alias", "auth-one", "--json",
    );
    assert.equal(first.status, 0, first.stderr);

    const blocked = invoke(
      "block", "--repo", project.repository, "REQ-0001", "--reason", "waiting for key",
    );
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.equal(invoke("unblock", "--repo", project.repository, "REQ-0001").status, 0);
    assert.equal(invoke(
      "abandon", "--repo", project.repository, "REQ-0001", "--reason", "session stopped",
    ).status, 0);

    const second = invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-two", "--alias", "auth-two", "--json",
    );
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).assignment.id, "ASN-0002");

    const shown = invoke("show", "--repo", project.repository, "REQ-0001", "--json");
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(
      JSON.parse(shown.stdout).assignments.map((item) => [item.id, item.status]),
      [["ASN-0001", "abandoned"], ["ASN-0002", "active"]],
    );
  } finally {
    project.cleanup();
  }
});

test("stamp and log preserve append-only audit events", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository,
      "--request", "Document release", "--path", "docs/release.md",
    ).status, 0);
    const stamped = invoke(
      "stamp", "--repo", project.repository, "REQ-0001",
      "--kind", "decision", "--note", "Use stable interface",
    );
    assert.equal(stamped.status, 0, stamped.stderr);

    const logged = invoke(
      "log", "--repo", project.repository, "--requirement", "req-0001", "--json",
    );

    assert.equal(logged.status, 0, logged.stderr);
    assert.deepEqual(
      JSON.parse(logged.stdout).events.map((event) => event.type),
      ["requirement.added", "requirement.stamped"],
    );
  } finally {
    project.cleanup();
  }
});

test("repair reuses a worktree retained after submodule provisioning fails", () => {
  const project = fixture();
  const submodule = fixture();
  const offlineSubmodule = `${submodule.repository}-offline`;
  const previousAllowedProtocols = process.env.GIT_ALLOW_PROTOCOL;
  try {
    git(project.repository, "-c", "protocol.file.allow=always", "submodule", "add", submodule.repository, "vendor/sample");
    git(project.repository, "commit", "-am", "add submodule");
    process.env.GIT_ALLOW_PROTOCOL = "file";
    renameSync(submodule.repository, offlineSubmodule);
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository,
      "--request", "Update vendor", "--path", "vendor/sample/**",
    ).status, 0);

    const failed = invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-test", "--alias", "vendor", "--json",
    );

    assert.equal(failed.status, 4, failed.stderr);
    const failedAssignment = JSON.parse(failed.stdout).assignment;
    assert.equal(failedAssignment.status, "provisioning_failed");
    assert.equal(exists(failedAssignment.worktree), true);

    renameSync(offlineSubmodule, submodule.repository);
    const repaired = invoke(
      "repair", "--repo", project.repository, failedAssignment.id, "--json",
    );
    assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
    assert.equal(JSON.parse(repaired.stdout).assignment.id, failedAssignment.id);
    assert.equal(JSON.parse(repaired.stdout).assignment.status, "active");
  } finally {
    if (exists(offlineSubmodule)) renameSync(offlineSubmodule, submodule.repository);
    if (previousAllowedProtocols === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocols;
    project.cleanup();
    submodule.cleanup();
  }
});

test("doctor reports retained abandoned worktrees as recoverable warnings", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository,
      "--request", "Try auth", "--path", "src/auth/**",
    ).status, 0);
    assert.equal(invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-test", "--alias", "auth",
    ).status, 0);
    assert.equal(invoke(
      "abandon", "--repo", project.repository, "REQ-0001", "--reason", "stopped",
    ).status, 0);

    const diagnosed = invoke("doctor", "--repo", project.repository, "--json");

    assert.equal(diagnosed.status, 0, diagnosed.stderr);
    const result = JSON.parse(diagnosed.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.issues[0].severity, "warning");
    assert.equal(result.issues[0].code, "abandoned_worktree");
  } finally {
    project.cleanup();
  }
});

test("help and agent-instructions expose the complete CLI contract", () => {
  const version = invoke("--version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "0.1.0-alpha.2");

  const help = invoke("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: gantt-cli <command>/);
  assert.match(help.stdout, /start/);
  assert.match(help.stdout, /doctor/);

  const commandHelp = {
    init: "--install-agent-instructions",
    add: "--verify <command>",
    schedule: "--json",
    start: "<requirement-id>",
    repair: "<assignment-id>",
    merge: "--into <branch>",
    cleanup: "<requirement-id>",
    done: "<requirement-id>",
    block: "--reason <text>",
    unblock: "<requirement-id>",
    abandon: "--reason <text>",
    list: "--json",
    show: "<requirement-id>",
    doctor: "--json",
    log: "--requirement <id>",
    stamp: "--note <text>",
    "agent-instructions": "--help",
  };
  for (const [command, expected] of Object.entries(commandHelp)) {
    const contextual = invoke(command, "--help");
    assert.equal(contextual.status, 0, contextual.stderr);
    assert.match(contextual.stdout, new RegExp(`Usage: gantt-cli ${command.replace("-", "\\-")}`));
    assert.match(contextual.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const instructions = invoke("agent-instructions");
  assert.equal(instructions.status, 0, instructions.stderr);
  assert.match(instructions.stdout, /Agent integration contract/);
  assert.match(instructions.stdout, /npx gantt-cli@next merge.*npx gantt-cli@next cleanup.*npx gantt-cli@next done/);
  assert.match(instructions.stdout, /branch may be retained or deleted/);
});

test("start rechecks unfinished dependencies and active claim conflicts", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    const requirements = [
      ["Auth core", "src/auth/**", []],
      ["Login retry", "src/auth/login.ts", []],
      ["Auth docs", "docs/auth.md", ["--depends-on", "REQ-0001"]],
    ];
    for (const [request, path, extra] of requirements) {
      const added = invoke(
        "add", "--repo", project.repository,
        "--request", request, "--path", path, ...extra,
      );
      assert.equal(added.status, 0, added.stderr);
    }
    assert.equal(invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-one", "--alias", "auth-core",
    ).status, 0);

    const conflicted = invoke(
      "start", "--repo", project.repository, "REQ-0002",
      "--session", "session-two", "--alias", "login",
    );
    assert.equal(conflicted.status, 2);
    assert.match(conflicted.stderr, /conflicts with active claims/);
    const forced = invoke(
      "start", "--repo", project.repository, "REQ-0002",
      "--session", "session-two", "--alias", "login", "--force", "--json",
    );
    assert.equal(forced.status, 0, forced.stderr);

    const dependent = invoke(
      "start", "--repo", project.repository, "REQ-0003",
      "--session", "session-three", "--alias", "docs",
    );
    assert.equal(dependent.status, 2);
    assert.match(dependent.stderr, /cannot start before: REQ-0001/);
  } finally {
    project.cleanup();
  }
});

test("merge rejects committed files outside the declared glob scope before changing HEAD", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository,
      "--request", "Only top-level sources", "--path", "src/*.ts",
    ).status, 0);
    const started = invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-test", "--alias", "scope", "--json",
    );
    assert.equal(started.status, 0, started.stderr);
    const assignment = JSON.parse(started.stdout).assignment;
    mkdirSync(join(assignment.worktree, "src", "nested"), { recursive: true });
    writeFileSync(join(assignment.worktree, "src", "nested", "outside.ts"), "export {};\n");
    git(assignment.worktree, "add", "src/nested/outside.ts");
    git(assignment.worktree, "commit", "-m", "outside scope");
    const before = git(project.repository, "rev-parse", "HEAD").trim();

    const merged = invoke("merge", "--repo", project.repository, "REQ-0001");

    assert.equal(merged.status, 2);
    assert.match(merged.stderr, /Committed changes exceed REQ-0001 path claims/);
    assert.equal(git(project.repository, "rev-parse", "HEAD").trim(), before);
  } finally {
    project.cleanup();
  }
});

function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch (error) {
    if (error.code === "EISDIR") return true;
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
