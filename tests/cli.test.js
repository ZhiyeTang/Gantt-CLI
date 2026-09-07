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

function coordinate(project, members) {
  const file = join(dirname(project.repository), "coordination.json");
  writeFileSync(file, JSON.stringify({ members: members.map((item) => typeof item === "string" ? { requirementId: item, work: `Work for ${item}` } : item), verify: "git diff --check" }));
  const result = invoke("coordinate", "--repo", project.repository, "--plan-file", file, "--json");
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("init creates a schema-v4 state file through the CLI", () => {
  const project = fixture();
  try {
    const result = invoke("init", "--repo", project.repository);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Initialized gantt-cli/);
    const state = JSON.parse(
      readFileSync(join(project.repository, ".git", "gantt-cli", "state.json"), "utf8"),
    );
    assert.equal(state.schemaVersion, 4);
    assert.equal(state.nextPhaseNumber, 1);
    assert.deepEqual(state.phases, []);
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
    assert.match(installed, /npx gantt-cli@latest agent-instructions/);
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

test("list renders a compact table grouped by requirement status", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    const requirements = [
      ["Implement authentication", "src/auth/**"],
      ["Build account UI", "src/ui/**"],
      ["Polish account UI", "src/ui/profile.ts"],
      ["Document account UI", "docs/account.md", "REQ-0002"],
      ["Prepare release", "release/**"],
    ];
    for (const [request, path, dependency] of requirements) {
      const arguments_ = ["add", "--repo", project.repository, "--request", request, "--path", path];
      if (dependency) arguments_.push("--depends-on", dependency);
      assert.equal(invoke(...arguments_).status, 0);
    }
    assert.equal(invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-test", "--alias", "auth-api",
    ).status, 0);
    assert.equal(invoke(
      "block", "--repo", project.repository, "REQ-0005", "--reason", "release window closed",
    ).status, 0);
    assert.equal(invoke(
      "deprecate", "--repo", project.repository, "REQ-0004", "--reason", "docs no longer needed",
    ).status, 0);

    const listed = invoke("list", "--repo", project.repository);

    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^ID\s+PRI\s+TASK\n/);
    assert.match(listed.stdout, /^ACTIVE\s+1$/m);
    assert.match(listed.stdout, /^REQ-0001\s+p2\s+Implement authentication$/m);
    assert.match(listed.stdout, /^READY\s+2$/m);
    assert.match(listed.stdout, /^REQ-0002\s+p2\s+Build account UI$/m);
    assert.match(listed.stdout, /^REQ-0003\s+p2\s+Polish account UI$/m);
    assert.match(listed.stdout, /^BLOCKED\s+1$/m);
    assert.match(listed.stdout, /^REQ-0005\s+p2\s+Prepare release$/m);
    assert.match(listed.stdout, /^CLOSED 1 · use gantt-cli list --all$/m);
    assert.doesNotMatch(listed.stdout, /REQ-0004/);
    assert.doesNotMatch(listed.stdout, /auth-api|batch 1|release window closed|waits for/);
    assert.doesNotMatch(listed.stdout, /\u001b\[/);
  } finally {
    project.cleanup();
  }
});

test("list --all expands closed requirements", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository,
      "--request", "Retire legacy path", "--path", "src/legacy/**", "--priority", "p3",
    ).status, 0);
    assert.equal(invoke(
      "deprecate", "--repo", project.repository, "REQ-0001", "--reason", "obsolete",
    ).status, 0);

    const listed = invoke("list", "--repo", project.repository, "--all");

    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^CLOSED\s+1$/m);
    assert.match(listed.stdout, /^REQ-0001\s+p3\s+Retire legacy path$/m);
    assert.doesNotMatch(listed.stdout, /use gantt-cli list --all/);
  } finally {
    project.cleanup();
  }
});

test("list uses semantic colors when enabled and respects NO_COLOR", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository,
      "--request", "Fix production outage", "--path", "src/**", "--priority", "p0",
    ).status, 0);

    const colored = spawnSync(process.execPath, [cli, "list", "--repo", project.repository], {
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: "" },
    });
    const plain = spawnSync(process.execPath, [cli, "list", "--repo", project.repository], {
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: "1" },
    });

    assert.equal(colored.status, 0, colored.stderr);
    assert.match(colored.stdout, /\u001b\[36m/);
    assert.match(colored.stdout, /\u001b\[31m/);
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /\u001b\[/);
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

test("update adds path claims so an active assignment can recover from a rejected merge", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    writeFileSync(join(assignment.worktree, ".gitmodules"), "# package metadata\n");
    writeFileSync(join(assignment.worktree, "Package.resolved"), "{}\n");
    git(assignment.worktree, "add", ".gitmodules", "Package.resolved");
    git(assignment.worktree, "commit", "-m", "add package metadata");
    const rejected = invoke("merge", "--repo", project.repository, "REQ-0001");
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /\.gitmodules, Package\.resolved/);

    const updated = invoke(
      "update", "--repo", project.repository, "REQ-0001",
      "--add-path", ".gitmodules", "--add-path", "Package.resolved", "--json",
    );

    assert.equal(updated.status, 0, updated.stderr);
    assert.deepEqual(JSON.parse(updated.stdout).requirement.paths, ["src/**", ".gitmodules", "Package.resolved"]);
    const logged = invoke("log", "--repo", project.repository, "--requirement", "REQ-0001", "--json");
    const event = JSON.parse(logged.stdout).events.at(-1);
    assert.equal(event.type, "requirement.paths_updated");
    assert.deepEqual(event.data.addedPaths, [".gitmodules", "Package.resolved"]);
    assert.equal(invoke("doctor", "--repo", project.repository).status, 0);
    assert.equal(invoke("merge", "--repo", project.repository, "REQ-0001").status, 0);
  } finally {
    project.cleanup();
  }
});

test("update removes path claims without allowing an empty scope", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository,
      "--request", "Trim scope", "--path", "src/**", "--path", "docs/**",
    ).status, 0);

    const updated = invoke(
      "update", "--repo", project.repository, "REQ-0001", "--remove-path", "docs/**", "--json",
    );

    assert.equal(updated.status, 0, updated.stderr);
    assert.deepEqual(JSON.parse(updated.stdout).requirement.paths, ["src/**"]);
    const event = JSON.parse(invoke(
      "log", "--repo", project.repository, "--requirement", "REQ-0001", "--json",
    ).stdout).events.at(-1);
    assert.deepEqual(event.data.removedPaths, ["docs/**"]);
    const empty = invoke(
      "update", "--repo", project.repository, "REQ-0001", "--remove-path", "src/**",
    );
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /At least one --path or --paths claim is required/);
  } finally {
    project.cleanup();
  }
});

test("update rejects new active claims until a new plan records the expanded scope", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    for (const [request, path] of [["First", "src/first.ts"], ["Second", "src/second.ts"]]) {
      assert.equal(invoke(
        "add", "--repo", project.repository, "--request", request, "--path", path,
      ).status, 0);
    }
    assert.equal(invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-one", "--alias", "first",
    ).status, 0);
    assert.equal(invoke(
      "start", "--repo", project.repository, "REQ-0002",
      "--session", "session-two", "--alias", "second",
    ).status, 0);

    const rejected = invoke(
      "update", "--repo", project.repository, "REQ-0002", "--add-path", "src/first.ts",
    );
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /conflicts with active claims held by REQ-0001\/ASN-0001/);

    coordinate(project, ["REQ-0001", { requirementId: "REQ-0002", work: "Extend the shared file", paths: ["src/second.ts", "src/first.ts"] }]);
    assert.deepEqual(JSON.parse(invoke("show", "REQ-0002", "--repo", project.repository, "--json").stdout).paths, ["src/second.ts", "src/first.ts"]);
  } finally {
    project.cleanup();
  }
});

test("updating an active coordinated scope requires an updated plan", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    for (const request of ["First", "Second"]) {
      assert.equal(invoke(
        "add", "--repo", project.repository, "--request", request, "--path", "src/shared.ts",
      ).status, 0);
    }
    assert.equal(invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-one", "--alias", "first",
    ).status, 0);
    coordinate(project, ["REQ-0001", "REQ-0002"]);
    assert.equal(invoke(
      "start", "--repo", project.repository, "REQ-0002",
      "--session", "session-two", "--alias", "second",
    ).status, 0);

    const updated = invoke(
      "update", "--repo", project.repository, "REQ-0002", "--add-path", "Package.resolved", "--json",
    );

    assert.equal(updated.status, 2);
    coordinate(project, ["REQ-0001", { requirementId: "REQ-0002", work: "Shared code and package", paths: ["src/shared.ts", "Package.resolved"] }]);
  } finally {
    project.cleanup();
  }
});

test("update rejects path changes after the assignment is merged", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    commitFile(assignment, "src/change.ts");
    assert.equal(invoke("merge", "--repo", project.repository, "REQ-0001").status, 0);

    const updated = invoke(
      "update", "--repo", project.repository, "REQ-0001", "--add-path", "Package.resolved",
    );

    assert.equal(updated.status, 2);
    assert.match(updated.stderr, /Cannot update path claims after ASN-0001 is merged/);
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
    assert.match(result.assignment.branch, /^codex\/phase-001-req-0001-login-interface-asn-0001$/);
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

test("finish completes submitted work without manually chaining transitions", () => {
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

    const completed = invoke("finish", "--repo", project.repository, "REQ-0001", "--json");
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
    assert.match(dirty.stderr, /vendor\/sample\/debug\.log/);
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

test("cleanup preserves ignored bare repositories stored inside the worktree", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project, { path: "**" });
    writeFileSync(join(assignment.worktree, ".gitignore"), "External/package.git/\n");
    git(assignment.worktree, "add", ".gitignore");
    git(assignment.worktree, "commit", "-m", "ignore local bare repository");
    const bareRepository = join(assignment.worktree, "External", "package.git");
    mkdirSync(dirname(bareRepository), { recursive: true });
    git(dirname(bareRepository), "init", "--bare", bareRepository);
    assert.equal(invoke("merge", "--repo", project.repository, "REQ-0001").status, 0);

    const cleaned = invoke("cleanup", "--repo", project.repository, "REQ-0001");

    assert.equal(cleaned.status, 2);
    assert.match(cleaned.stderr, /External\/package\.git/);
    assert.match(readFileSync(join(bareRepository, "HEAD"), "utf8"), /refs\/heads/);
  } finally {
    project.cleanup();
  }
});

test("finish and doctor use recorded commits after the merged branch is deleted", () => {
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

    const completed = invoke("finish", "--repo", project.repository, "REQ-0001", "--json");
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
    assert.match(merged.stderr, /already in HEAD without recorded merge intent/);
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

test("finish preserves a retryable requirement when verification fails", () => {
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

    const failed = invoke("finish", "--repo", project.repository, "REQ-0001", "--json");

    assert.equal(failed.status, 3, failed.stderr || failed.stdout);
    const failure = JSON.parse(failed.stdout);
    assert.equal(failure.requirement.status, "active");
    assert.equal(failure.assignment.status, "merged");
    assert.equal(exists(assignment.worktree), true);
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
    assert.equal(migrated.schemaVersion, 4);
    assert.equal(migrated.assignments[0].status, "legacy");
    assert.equal(migrated.events.at(-1).type, "registry.migrated");
  } finally {
    project.cleanup();
  }
});

test("schema-v3 migration renames cancelled requirements and abandoned assignments", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    assert.equal(invoke("release", "--repo", project.repository, "REQ-0001", "--reason", "stopped").status, 0);
    const legacy = readState(project);
    legacy.schemaVersion = 3;
    delete legacy.nextPhaseNumber;
    delete legacy.phases;
    legacy.requirements[0].status = "cancelled";
    legacy.assignments[0].status = "abandoned";
    legacy.assignments[0].abandonedAt = legacy.assignments[0].releasedAt;
    legacy.assignments[0].abandonReason = legacy.assignments[0].releaseReason;
    delete legacy.assignments[0].releasedAt;
    delete legacy.assignments[0].releaseReason;
    writeState(project, legacy);

    const listed = invoke("list", "--repo", project.repository, "--json");

    assert.equal(listed.status, 0, listed.stderr);
    const migrated = readState(project);
    assert.equal(migrated.schemaVersion, 4);
    assert.equal(migrated.requirements[0].status, "deprecated");
    assert.match(migrated.requirements[0].deprecationReason, /Migrated from cancelled/);
    assert.equal(migrated.assignments[0].status, "released");
    assert.equal(migrated.assignments[0].releaseReason, "stopped");
    assert.equal(migrated.nextPhaseNumber, 1);
    assert.deepEqual(migrated.phases, []);
    assert.equal(exists(assignment.worktree), true);
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

test("block unblock release and reassign preserve assignment history", () => {
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
      "release", "--repo", project.repository, "REQ-0001", "--reason", "session stopped",
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
      [["ASN-0001", "released"], ["ASN-0002", "active"]],
    );
  } finally {
    project.cleanup();
  }
});

test("release preserves interrupted work while discard and deprecate enforce terminal cleanup", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    mkdirSync(join(assignment.worktree, "src"), { recursive: true });
    writeFileSync(join(assignment.worktree, "src", "draft.ts"), "export const draft = true;\n");

    const released = invoke(
      "release", "--repo", project.repository, "REQ-0001", "--reason", "session ended", "--json",
    );
    assert.equal(released.status, 0, released.stderr);
    assert.equal(JSON.parse(released.stdout).assignment.status, "released");
    assert.equal(readState(project).requirements[0].status, "ready");

    const dirtyDiscard = invoke("discard", "--repo", project.repository, assignment.id);
    assert.equal(dirtyDiscard.status, 2);
    assert.match(dirtyDiscard.stderr, /uncommitted changes/);

    git(assignment.worktree, "add", "src/draft.ts");
    git(assignment.worktree, "commit", "-m", "preserve draft");
    const discarded = invoke("discard", "--repo", project.repository, assignment.id, "--json");
    assert.equal(discarded.status, 0, discarded.stderr);
    assert.equal(JSON.parse(discarded.stdout).assignment.status, "discarded");
    assert.equal(exists(assignment.worktree), false);
    assert.notEqual(git(project.repository, "branch", "--list", assignment.branch).trim(), "");

    const missingReason = invoke("deprecate", "--repo", project.repository, "REQ-0001");
    assert.equal(missingReason.status, 2);
    assert.match(missingReason.stderr, /--reason is required/);
    const deprecated = invoke(
      "deprecate", "--repo", project.repository, "REQ-0001", "--reason", "superseded", "--json",
    );
    assert.equal(deprecated.status, 0, deprecated.stderr);
    assert.equal(JSON.parse(deprecated.stdout).requirement.status, "deprecated");
  } finally {
    project.cleanup();
  }
});

test("deprecate rejects requirements that still have non-terminal dependents", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository, "--request", "Foundation", "--path", "src/core.ts",
    ).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository, "--request", "Dependent", "--path", "src/use.ts",
      "--depends-on", "REQ-0001",
    ).status, 0);

    const blocked = invoke(
      "deprecate", "--repo", project.repository, "REQ-0001", "--reason", "no longer needed",
    );
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /still required.*REQ-0002/);
    assert.equal(invoke(
      "deprecate", "--repo", project.repository, "REQ-0002", "--reason", "dependent removed",
    ).status, 0);
    assert.equal(invoke(
      "deprecate", "--repo", project.repository, "REQ-0001", "--reason", "no longer needed",
    ).status, 0);
  } finally {
    project.cleanup();
  }
});

test("archive creates an immutable phase and restarts all active IDs", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    commitFile(assignment, "src/delivered.ts", "export const delivered = true;\n");
    assert.equal(invoke("merge", "--repo", project.repository, "REQ-0001").status, 0);
    assert.equal(invoke("cleanup", "--repo", project.repository, "REQ-0001").status, 0);
    assert.equal(invoke("finish", "--repo", project.repository, "REQ-0001").status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository, "--request", "Obsolete", "--path", "src/obsolete.ts",
    ).status, 0);
    assert.equal(invoke(
      "deprecate", "--repo", project.repository, "REQ-0002", "--reason", "superseded",
    ).status, 0);

    const prepared = invoke("archive", "--repo", project.repository, "--prepare", "--json");
    assert.equal(prepared.status, 0, prepared.stderr);
    const manifest = JSON.parse(prepared.stdout);
    assert.equal(manifest.phaseId, "PHASE-001");
    assert.match(manifest.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(manifest.requirements.map((item) => item.status), ["done", "deprecated"]);
    assert.match(manifest.guidance, /merged commits as delivered work/);

    const summaryPath = join(dirname(project.repository), "phase-summary.md");
    writeFileSync(summaryPath, "# Phase summary\n\n## Delivered\n\n- Delivered feature.\n");
    const archived = invoke(
      "archive", "--repo", project.repository,
      "--fingerprint", manifest.fingerprint, "--summary-file", summaryPath, "--json",
    );
    assert.equal(archived.status, 0, archived.stderr);
    assert.equal(JSON.parse(archived.stdout).phase.id, "PHASE-001");

    const state = readState(project);
    assert.deepEqual(state.requirements, []);
    assert.deepEqual(state.assignments, []);
    assert.equal(state.nextRequirementNumber, 1);
    assert.equal(state.nextAssignmentNumber, 1);
    assert.equal(state.events[0].id, "EVT-000001");
    assert.equal(state.events[0].type, "phase.archived");
    assert.equal(state.nextEventNumber, 2);
    assert.equal(state.nextPhaseNumber, 2);
    assert.equal(state.phases[0].id, "PHASE-001");

    const phaseDirectory = join(project.repository, ".git", "gantt-cli", "phases", "PHASE-001");
    assert.equal(exists(join(phaseDirectory, "archive.json")), true);
    assert.equal(exists(join(phaseDirectory, "summary.md")), true);
    const listedPhases = invoke("phase", "--repo", project.repository, "list", "--json");
    assert.equal(JSON.parse(listedPhases.stdout).phases[0].id, "PHASE-001");
    const shownPhase = invoke("phase", "--repo", project.repository, "show", "PHASE-001");
    assert.match(shownPhase.stdout, /Delivered feature/);
    const shownRequirement = invoke(
      "show", "--repo", project.repository, "PHASE-001/REQ-0001", "--json",
    );
    assert.equal(JSON.parse(shownRequirement.stdout).phaseId, "PHASE-001");
    assert.equal(invoke("doctor", "--repo", project.repository).status, 0);

    const restarted = invoke(
      "add", "--repo", project.repository, "--request", "Next phase", "--path", "src/next.ts", "--json",
    );
    assert.equal(JSON.parse(restarted.stdout).requirement.id, "REQ-0001");
    const restartedAssignment = invoke(
      "start", "--repo", project.repository, "REQ-0001",
      "--session", "session-next", "--alias", "change", "--json",
    );
    assert.equal(restartedAssignment.status, 0, restartedAssignment.stderr);
    assert.equal(JSON.parse(restartedAssignment.stdout).assignment.id, "ASN-0001");
    assert.match(JSON.parse(restartedAssignment.stdout).assignment.branch, /^codex\/phase-002-/);
    const blockedArchive = invoke("archive", "--repo", project.repository, "--prepare");
    assert.equal(blockedArchive.status, 2);
    assert.match(blockedArchive.stderr, /REQ-0001 is active/);
  } finally {
    project.cleanup();
  }
});

test("archive rejects stale fingerprints and doctor detects modified phase contents", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository, "--request", "Obsolete", "--path", "src/old.ts",
    ).status, 0);
    assert.equal(invoke(
      "deprecate", "--repo", project.repository, "REQ-0001", "--reason", "superseded",
    ).status, 0);
    const prepared = JSON.parse(invoke(
      "archive", "--repo", project.repository, "--prepare", "--json",
    ).stdout);
    assert.equal(invoke(
      "stamp", "--repo", project.repository, "REQ-0001", "--note", "late context",
    ).status, 0);
    const summaryPath = join(dirname(project.repository), "summary.md");
    writeFileSync(summaryPath, "# Summary\n");
    const stale = invoke(
      "archive", "--repo", project.repository,
      "--fingerprint", prepared.fingerprint, "--summary-file", summaryPath,
    );
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /fingerprint changed/);

    const fresh = JSON.parse(invoke(
      "archive", "--repo", project.repository, "--prepare", "--json",
    ).stdout);
    assert.equal(invoke(
      "archive", "--repo", project.repository,
      "--fingerprint", fresh.fingerprint, "--summary-file", summaryPath,
    ).status, 0);
    const archivedSummary = join(
      project.repository, ".git", "gantt-cli", "phases", "PHASE-001", "summary.md",
    );
    writeFileSync(archivedSummary, "# Modified\n");
    const diagnosed = invoke("doctor", "--repo", project.repository, "--json");
    assert.equal(diagnosed.status, 1);
    assert.equal(JSON.parse(diagnosed.stdout).issues.some((issue) => issue.code === "phase_integrity"), true);
  } finally {
    project.cleanup();
  }
});

test("archive retry recovers a phase directory written before state finalization", () => {
  const project = fixture();
  try {
    assert.equal(invoke("init", "--repo", project.repository).status, 0);
    assert.equal(invoke(
      "add", "--repo", project.repository, "--request", "Obsolete", "--path", "src/old.ts",
    ).status, 0);
    assert.equal(invoke(
      "deprecate", "--repo", project.repository, "REQ-0001", "--reason", "superseded",
    ).status, 0);
    const prepared = JSON.parse(invoke(
      "archive", "--repo", project.repository, "--prepare", "--json",
    ).stdout);
    const preArchiveState = readState(project);
    const summaryPath = join(dirname(project.repository), "summary.md");
    writeFileSync(summaryPath, "# Summary\n");
    assert.equal(invoke(
      "archive", "--repo", project.repository,
      "--fingerprint", prepared.fingerprint, "--summary-file", summaryPath,
    ).status, 0);

    writeState(project, preArchiveState);
    const recovered = invoke(
      "archive", "--repo", project.repository,
      "--fingerprint", prepared.fingerprint, "--summary-file", summaryPath, "--json",
    );
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).recoveredArtifacts, true);
    assert.equal(readState(project).phases.length, 1);
    assert.equal(invoke("doctor", "--repo", project.repository).status, 0);
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

test("doctor reports retained released worktrees as recoverable warnings", () => {
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
      "release", "--repo", project.repository, "REQ-0001", "--reason", "stopped",
    ).status, 0);

    const diagnosed = invoke("doctor", "--repo", project.repository, "--json");

    assert.equal(diagnosed.status, 0, diagnosed.stderr);
    const result = JSON.parse(diagnosed.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.issues[0].severity, "warning");
    assert.equal(result.issues[0].code, "released_worktree");
  } finally {
    project.cleanup();
  }
});

test("help and agent-instructions expose the complete CLI contract", () => {
  const version = invoke("--version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync("package.json", "utf8")).version);

  const help = invoke("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: gantt-cli <command>/);
  assert.match(help.stdout, /start/);
  assert.match(help.stdout, /doctor/);

  const commandHelp = {
    init: "--install-agent-instructions",
    add: "--verify <command>",
    update: "--add-path <glob>",
    schedule: "--json",
    start: "<requirement-id>",
    repair: "<assignment-id>",
    merge: "--into <branch>",
    cleanup: "<requirement-id>",
    finish: "<requirement-id>",
    classify: "--reason <text>",
    coordinate: "--plan-file <json-file>",
    block: "--reason <text>",
    unblock: "<requirement-id>",
    release: "--reason <text>",
    discard: "<assignment-id>",
    deprecate: "--reason <text>",
    archive: "--prepare",
    phase: "<list|show> [phase-id]",
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
  assert.match(instructions.stdout, /inline.*without registering/);
  assert.match(instructions.stdout, /upgrade.*preserve/i);
  assert.match(instructions.stdout, /finish REQ-XXXX/);
  assert.match(instructions.stdout, /branch may be retained or deleted/);
  assert.match(instructions.stdout, /release.*discard/);
  assert.match(instructions.stdout, /archive --prepare --json/);
  assert.doesNotMatch(instructions.stdout, /\babandon\b/);
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
    coordinate(project, ["REQ-0001", "REQ-0002"]);
    const coordinated = invoke("start", "--repo", project.repository, "REQ-0002", "--session", "session-two", "--alias", "login", "--json");
    assert.equal(coordinated.status, 0, coordinated.stderr);

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

test("merge leaves unrelated untracked primary configuration untouched", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    writeFileSync(join(project.repository, "local.env"), "secret=original\n");
    commitFile(assignment, "src/change.ts");
    const result = invoke("merge", "--repo", project.repository, "REQ-0001");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(project.repository, "local.env"), "utf8"), "secret=original\n");
  } finally { project.cleanup(); }
});

test("cleanup preserves classified local and ignored files and blocks new unclassified files", () => {
  const project = fixture();
  try {
    writeFileSync(join(project.repository, ".gitignore"), "private.env\n");
    git(project.repository, "add", ".gitignore"); git(project.repository, "commit", "-m", "ignore private settings");
    const assignment = startAssignment(project);
    commitFile(assignment, "src/change.ts");
    writeFileSync(join(assignment.worktree, "private.env"), "private=keep\n");
    writeFileSync(join(assignment.worktree, "local.txt"), "notes\n");
    const classified = invoke("classify", "--repo", project.repository, "REQ-0001", "--path", "private.env", "--path", "local.txt", "--reason", "local settings", "--json");
    assert.equal(classified.status, 0, classified.stderr);
    assert.equal(invoke("merge", "--repo", project.repository, "REQ-0001").status, 0);
    writeFileSync(join(assignment.worktree, "forgotten.ts"), "deliver me\n");
    const blocked = invoke("cleanup", "--repo", project.repository, "REQ-0001");
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /forgotten.ts/);
    assert.equal(readFileSync(join(assignment.worktree, "private.env"), "utf8"), "private=keep\n");
    rmSync(join(assignment.worktree, "forgotten.ts"));
    const cleaned = invoke("cleanup", "--repo", project.repository, "REQ-0001", "--json");
    assert.equal(cleaned.status, 0, cleaned.stderr);
    const saved = JSON.parse(cleaned.stdout).assignment.preservationDirectory;
    assert.equal(readFileSync(join(saved, "private.env"), "utf8"), "private=keep\n");
    assert.equal(readFileSync(join(saved, "local.txt"), "utf8"), "notes\n");
    assert.equal(git(project.repository, "status", "--porcelain"), "");
  } finally { project.cleanup(); }
});

test("coordination allows same-file development while enforcing merge order and scope changes", () => {
  const project = fixture();
  try {
    const baseline = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") + "\n";
    writeFileSync(join(project.repository, "README.md"), baseline);
    git(project.repository, "add", "README.md"); git(project.repository, "commit", "-m", "shared document");
    invoke("init", "--repo", project.repository);
    for (const request of ["first", "second", "outsider"]) {
      assert.equal(invoke("add", "--repo", project.repository, "--request", request, "--path", "README.md").status, 0);
    }
    const plan = join(dirname(project.repository), "plan.json");
    writeFileSync(plan, JSON.stringify({ members: [{ requirementId: "REQ-0001", work: "heading" }, { requirementId: "REQ-0002", work: "footer" }], verify: "git diff --check" }));
    const coordinated = invoke("coordinate", "--repo", project.repository, "--plan-file", plan, "--json");
    assert.equal(coordinated.status, 0, coordinated.stderr);
    const schedule = JSON.parse(invoke("schedule", "--repo", project.repository, "--json").stdout);
    assert.deepEqual(schedule.batches[0].requirements, ["REQ-0001", "REQ-0002"]);
    const first = JSON.parse(invoke("start", "REQ-0001", "--repo", project.repository, "--session", "one", "--alias", "one", "--json").stdout).assignment;
    const second = JSON.parse(invoke("start", "REQ-0002", "--repo", project.repository, "--session", "two", "--alias", "two", "--json").stdout).assignment;
    assert.equal(invoke("start", "REQ-0003", "--repo", project.repository, "--session", "three", "--alias", "three").status, 2);
    commitFile(second, "README.md", baseline + "footer\n");
    const premature = invoke("merge", "REQ-0002", "--repo", project.repository);
    assert.equal(premature.status, 2);
    assert.match(premature.stderr, /merge order.*REQ-0001/i);
    const changed = invoke("update", "REQ-0002", "--repo", project.repository, "--add-path", "src/**");
    assert.equal(changed.status, 2);
    commitFile(first, "README.md", baseline.replace("line 0", "new heading"));
    assert.equal(invoke("finish", "REQ-0001", "--repo", project.repository).status, 0);
    const integrated = invoke("finish", "REQ-0002", "--repo", project.repository, "--json");
    assert.equal(integrated.status, 0, integrated.stdout || integrated.stderr);
    assert.equal(readFileSync(join(project.repository, "README.md"), "utf8"), baseline.replace("line 0", "new heading") + "footer\n");
    assert.equal(JSON.parse(integrated.stdout).assignment.verification.command, "git diff --check");
  } finally { project.cleanup(); }
});

test("finish retains failed verification work, merges a fix, and is repeatable", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project, { verify: "node -e \"process.exit(require('node:fs').readFileSync('src/result.txt','utf8').trim()==='good'?0:7)\"" });
    commitFile(assignment, "src/result.txt", "bad\n");
    const failed = invoke("finish", "REQ-0001", "--repo", project.repository, "--json");
    assert.equal(failed.status, 3, failed.stderr);
    assert.equal(JSON.parse(failed.stdout).nextAction, "fix_verification");
    assert.equal(exists(assignment.worktree), true);
    commitFile(assignment, "src/result.txt", "good\n");
    const finished = invoke("finish", "REQ-0001", "--repo", project.repository, "--json");
    assert.equal(finished.status, 0, finished.stderr);
    assert.equal(JSON.parse(finished.stdout).requirement.status, "done");
    assert.equal(exists(assignment.worktree), false);
    const head = git(project.repository, "rev-parse", "HEAD");
    assert.equal(invoke("finish", "REQ-0001", "--repo", project.repository).status, 0);
    assert.equal(git(project.repository, "rev-parse", "HEAD"), head);
  } finally { project.cleanup(); }
});

test("finish resumes a manually resolved Git conflict using recorded merge intent", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project, { path: "README.md" });
    commitFile(assignment, "README.md", "task heading\n");
    writeFileSync(join(project.repository, "README.md"), "primary heading\n");
    git(project.repository, "add", "README.md"); git(project.repository, "commit", "-m", "primary change");
    assert.equal(invoke("finish", "REQ-0001", "--repo", project.repository, "--json").status, 2);
    assert.equal(invoke("release", "REQ-0001", "--repo", project.repository, "--reason", "interrupted").status, 2);
    writeFileSync(join(project.repository, "README.md"), "combined heading\n");
    git(project.repository, "add", "README.md"); git(project.repository, "-c", "core.editor=true", "merge", "--continue");
    const resolvedHead = git(project.repository, "rev-parse", "HEAD");
    const retried = invoke("finish", "REQ-0001", "--repo", project.repository, "--json");
    assert.equal(retried.status, 0, retried.stdout || retried.stderr);
    assert.equal(git(project.repository, "rev-parse", "HEAD"), resolvedHead);
    assert.equal(JSON.parse(retried.stdout).assignment.mergeCommit, resolvedHead.trim());
  } finally { project.cleanup(); }
});

test("finish recovers when a post-merge hook exposes a state write interruption", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    commitFile(assignment, "src/change.ts");
    const hook = join(project.repository, ".git", "hooks", "post-merge");
    writeFileSync(hook, "#!/bin/sh\nmv .git/gantt-cli/state.json .git/gantt-cli/state.saved\nmkdir .git/gantt-cli/state.json\n", { mode: 0o755 });
    const interrupted = invoke("finish", "REQ-0001", "--repo", project.repository, "--json");
    assert.equal(interrupted.status, 2);
    const head = git(project.repository, "rev-parse", "HEAD");
    rmSync(statePath(project), { recursive: true });
    renameSync(join(project.repository, ".git", "gantt-cli", "state.saved"), statePath(project));
    rmSync(hook);
    const retried = invoke("finish", "REQ-0001", "--repo", project.repository, "--json");
    assert.equal(retried.status, 0, retried.stdout || retried.stderr);
    assert.equal(JSON.parse(retried.stdout).assignment.mergeCommit, head.trim());
    assert.equal(git(project.repository, "rev-parse", "HEAD"), head);
  } finally { project.cleanup(); }
});

test("preservation conflicts keep the source and saved copy intact and are retryable", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    commitFile(assignment, "src/change.ts");
    writeFileSync(join(assignment.worktree, "settings.txt"), "original\n");
    assert.equal(invoke("classify", "REQ-0001", "--repo", project.repository, "--path", "settings.txt", "--reason", "local").status, 0);
    assert.equal(invoke("merge", "REQ-0001", "--repo", project.repository).status, 0);
    // Interrupt deletion through Git's actual worktree lock, after preservation has completed.
    git(project.repository, "worktree", "lock", assignment.worktree);
    assert.equal(invoke("cleanup", "REQ-0001", "--repo", project.repository).status, 2);
    const shown = JSON.parse(invoke("show", "REQ-0001", "--repo", project.repository, "--json").stdout);
    const saved = shown.assignments[0].preservationDirectory;
    assert.equal(readFileSync(join(saved, "settings.txt"), "utf8"), "original\n");
    writeFileSync(join(assignment.worktree, "settings.txt"), "changed\n");
    git(project.repository, "worktree", "unlock", assignment.worktree);
    const blocked = invoke("finish", "REQ-0001", "--repo", project.repository, "--json");
    assert.equal(blocked.status, 2);
    assert.match(blocked.stdout, /Preservation conflict/);
    assert.equal(readFileSync(join(assignment.worktree, "settings.txt"), "utf8"), "changed\n");
    assert.equal(readFileSync(join(saved, "settings.txt"), "utf8"), "original\n");
    renameSync(join(saved, "settings.txt"), join(saved, "settings.original.txt"));
    assert.equal(invoke("finish", "REQ-0001", "--repo", project.repository).status, 0);
    assert.equal(readFileSync(join(saved, "settings.txt"), "utf8"), "changed\n");
    assert.equal(readFileSync(join(saved, "settings.original.txt"), "utf8"), "original\n");
  } finally { project.cleanup(); }
});

test("merge refuses to overwrite an ignored primary file", () => {
  const project = fixture();
  try {
    writeFileSync(join(project.repository, ".gitignore"), "local.env\n");
    git(project.repository, "add", ".gitignore"); git(project.repository, "commit", "-m", "ignore config");
    const assignment = startAssignment(project, { path: "local.env" });
    writeFileSync(join(assignment.worktree, "local.env"), "task\n");
    git(assignment.worktree, "add", "-f", "local.env"); git(assignment.worktree, "commit", "-m", "deliver config example");
    writeFileSync(join(project.repository, "local.env"), "keep secret\n");
    const head = git(project.repository, "rev-parse", "HEAD");
    assert.equal(invoke("finish", "REQ-0001", "--repo", project.repository, "--json").status, 2);
    assert.equal(readFileSync(join(project.repository, "local.env"), "utf8"), "keep secret\n");
    assert.equal(git(project.repository, "rev-parse", "HEAD"), head);
  } finally { project.cleanup(); }
});

test("parallel finish calls complete once with consistent merge and verification evidence", async () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project, { verify: "node -e \"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)\"" });
    commitFile(assignment, "src/change.ts");
    const results = await Promise.all([1, 2].map(() => invokeAsync("finish", "REQ-0001", "--repo", project.repository, "--json")));
    for (const result of results) assert.equal(result.status, 0, result.stderr || result.stdout);
    const first = JSON.parse(results[0].stdout).assignment;
    const second = JSON.parse(results[1].stdout).assignment;
    assert.equal(first.mergeCommit, second.mergeCommit);
    assert.equal(first.verificationTarget, second.verificationTarget);
    assert.equal(exists(assignment.worktree), false);
  } finally { project.cleanup(); }
});


test("inline upgrade rehearsal preserves original unrelated edits while starting managed work", () => {
  const project = fixture();
  try {
    const original = "user's existing edits\n";
    writeFileSync(join(project.repository, "README.md"), original);
    writeFileSync(join(project.repository, "local.env"), "user settings\n");
    const before = git(project.repository, "diff", "--", "README.md");
    // Rehearse the documented Agent procedure through Git and the CLI; no inline state machine exists.
    writeFileSync(join(project.repository, "feature.txt"), "work completed inline\n");
    const taskContents = readFileSync(join(project.repository, "feature.txt"));
    const assignment = startAssignment(project, { path: "feature.txt" });
    writeFileSync(join(assignment.worktree, "feature.txt"), taskContents);
    assert.deepEqual(readFileSync(join(assignment.worktree, "feature.txt")), taskContents);
    rmSync(join(project.repository, "feature.txt"));
    assert.equal(git(project.repository, "diff", "--", "README.md"), before);
    assert.equal(readFileSync(join(project.repository, "local.env"), "utf8"), "user settings\n");
    assert.equal(readFileSync(join(assignment.worktree, "feature.txt"), "utf8"), "work completed inline\n");
    assert.ok(assignment.localBaseline.primary.includes("local.env"));
  } finally { project.cleanup(); }
});

test("preservation refuses an invalid destination and completes after it is repaired", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    commitFile(assignment, "src/change.ts");
    writeFileSync(join(assignment.worktree, "private.env"), "retained\n");
    assert.equal(invoke("classify", "REQ-0001", "--repo", project.repository, "--path", "private.env", "--reason", "local settings").status, 0);
    const destination = join(project.repository, ".git", "gantt-cli", "preserved");
    writeFileSync(destination, "existing unrelated file\n");
    const failed = invoke("finish", "REQ-0001", "--repo", project.repository, "--json");
    assert.equal(failed.status, 2);
    assert.match(failed.stdout, /non-directory parent/);
    assert.equal(readFileSync(join(assignment.worktree, "private.env"), "utf8"), "retained\n");
    assert.equal(readFileSync(destination, "utf8"), "existing unrelated file\n");
    renameSync(destination, `${destination}.original`);
    const completed = invoke("finish", "REQ-0001", "--repo", project.repository, "--json");
    assert.equal(completed.status, 0, completed.stdout || completed.stderr);
    assert.equal(readFileSync(join(JSON.parse(completed.stdout).assignment.preservationDirectory, "private.env"), "utf8"), "retained\n");
  } finally { project.cleanup(); }
});

test("classification captures current files and refuses traversal and tracked deliverables", () => {
  const project = fixture();
  try {
    const assignment = startAssignment(project);
    commitFile(assignment, "src/change.ts");
    mkdirSync(join(assignment.worktree, "notes"));
    writeFileSync(join(assignment.worktree, "notes", "one.txt"), "keep\n");
    for (const path of ["../outside", ".git/config", "src/change.ts"]) {
      assert.equal(invoke("classify", "REQ-0001", "--repo", project.repository, "--path", path, "--reason", "local").status, 2);
    }
    assert.equal(invoke("classify", "REQ-0001", "--repo", project.repository, "--path", "notes", "--reason", "local notes").status, 0);
    writeFileSync(join(assignment.worktree, "notes", "new.ts"), "new deliverable\n");
    const blocked = invoke("finish", "REQ-0001", "--repo", project.repository, "--json");
    assert.equal(blocked.status, 2);
    assert.match(blocked.stdout, /notes\/new.ts/);
    assert.equal(exists(assignment.worktree), true);
  } finally { project.cleanup(); }
});
