#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { GanttCliError, GitError, RegistryError, ValidationError } from "./errors.js";
import { AGENT_INSTRUCTIONS, installAgentInstructions } from "./agent-instructions.js";
import {
  commonGitDir,
  branchExists,
  changedPathsSince,
  commitExists,
  commitIsAncestor,
  commitParent,
  createWorktree,
  defaultWorktreeRoot,
  ensureWorktreeClean,
  headCommit,
  initializeSubmodules,
  mergeBranch,
  primaryWorktree,
  registeredWorktree,
  removeWorktree,
  repositoryRoot,
  rollbackCreatedAssignment,
  verifyAssignmentWorktree,
  worktreeRecords,
} from "./git.js";
import {
  appendEvent,
  assignmentById,
  assignmentsForRequirement,
  liveAssignmentForRequirement,
  nextRequirementId,
  normalizeDomains,
  normalizePriority,
  normalizeProjectPaths,
  normalizeRequirementIds,
  normalizePhaseId,
  nextPhaseId,
  requirementById,
  utcNow,
  validatePoints,
  type Requirement,
  type Assignment,
  type Phase,
  type State,
} from "./models.js";
import { phaseArchive, phaseFingerprint } from "./phases.js";
import {
  activeConflicts,
  buildSchedule,
  outOfScopePaths,
  renderList,
  renderSchedule,
  requirementView,
} from "./scheduler.js";
import { Registry } from "./store.js";

interface ParsedArguments {
  command: string;
  positionals: string[];
  options: Map<string, string[]>;
  flags: Set<string>;
}

const BOOLEAN_OPTIONS = new Set(["json", "force", "help", "install-agent-instructions", "prepare"]);
const VARIADIC_OPTIONS = new Set(["paths", "domains"]);
const COMMAND_OPTIONS: Record<string, { values: string[]; flags: string[]; positionals: number }> = {
  init: { values: ["repo"], flags: ["install-agent-instructions"], positionals: 0 },
  add: {
    values: ["repo", "request", "verify", "priority", "points", "depends-on", "domain", "domains", "path", "paths"],
    flags: ["json"],
    positionals: 0,
  },
  update: { values: ["repo", "add-path", "remove-path"], flags: ["force", "json"], positionals: 1 },
  schedule: { values: ["repo"], flags: ["json"], positionals: 0 },
  start: {
    values: ["repo", "session", "alias", "branch", "worktree-root"], flags: ["force", "json"], positionals: 1,
  },
  repair: { values: ["repo"], flags: ["force", "json"], positionals: 1 },
  merge: { values: ["repo", "into"], flags: ["json"], positionals: 1 },
  cleanup: { values: ["repo"], flags: ["json"], positionals: 1 },
  done: { values: ["repo"], flags: ["json"], positionals: 1 },
  block: { values: ["repo", "reason"], flags: [], positionals: 1 },
  unblock: { values: ["repo"], flags: [], positionals: 1 },
  release: { values: ["repo", "reason"], flags: ["json"], positionals: 1 },
  discard: { values: ["repo"], flags: ["json"], positionals: 1 },
  deprecate: { values: ["repo", "reason"], flags: ["json"], positionals: 1 },
  archive: { values: ["repo", "summary-file", "fingerprint"], flags: ["prepare", "json"], positionals: 0 },
  phase: { values: ["repo"], flags: ["json"], positionals: 2 },
  list: { values: ["repo"], flags: ["json"], positionals: 0 },
  show: { values: ["repo"], flags: ["json"], positionals: 1 },
  doctor: { values: ["repo"], flags: ["json"], positionals: 0 },
  log: { values: ["repo", "requirement", "assignment", "limit"], flags: ["json"], positionals: 0 },
  stamp: { values: ["repo", "note", "kind"], flags: [], positionals: 1 },
  "agent-instructions": { values: [], flags: [], positionals: 0 },
};

function parseArguments(arguments_: string[]): ParsedArguments {
  const command = arguments_[0] ?? "";
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 1; index < arguments_.length; index += 1) {
    const token = arguments_[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (BOOLEAN_OPTIONS.has(name)) {
      flags.add(name);
      continue;
    }
    const values: string[] = [];
    if (VARIADIC_OPTIONS.has(name)) {
      while (arguments_[index + 1] !== undefined && !arguments_[index + 1]?.startsWith("--")) {
        values.push(arguments_[index + 1] as string);
        index += 1;
      }
    } else {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ValidationError(`--${name} requires a value.`);
      }
      values.push(value);
      index += 1;
    }
    options.set(name, [...(options.get(name) ?? []), ...values]);
  }
  return { command, positionals, options, flags };
}

function option(args: ParsedArguments, name: string, fallback?: string): string | undefined {
  return args.options.get(name)?.at(-1) ?? fallback;
}

function requiredOption(args: ParsedArguments, name: string): string {
  const value = option(args, name)?.trim();
  if (!value) throw new ValidationError(`--${name} is required.`);
  return value;
}

function validateCommandArguments(args: ParsedArguments): void {
  const contract = COMMAND_OPTIONS[args.command];
  if (!contract) throw new ValidationError(`Unknown command: ${args.command}`);
  for (const name of args.options.keys()) {
    if (!contract.values.includes(name)) {
      throw new ValidationError(`Unknown option for ${args.command}: --${name}`);
    }
  }
  for (const name of args.flags) {
    if (name !== "help" && !contract.flags.includes(name)) {
      throw new ValidationError(`Unknown option for ${args.command}: --${name}`);
    }
  }
  if (args.positionals.length > contract.positionals) {
    throw new ValidationError(`${args.command} received too many positional arguments.`);
  }
}

function registryFor(path: string): { currentRoot: string; registry: Registry } {
  const currentRoot = repositoryRoot(path);
  return { currentRoot, registry: new Registry(commonGitDir(currentRoot)) };
}

function primaryRepository(state: State, currentRoot: string): string {
  const configured = resolve(state.repository.root);
  if (!existsSync(configured)) {
    throw new GitError(`Primary worktree recorded in state is unavailable: ${configured}. Run doctor before continuing.`);
  }
  const primary = repositoryRoot(configured);
  if (commonGitDir(primary) !== commonGitDir(currentRoot)) {
    throw new GitError("Registry primary worktree belongs to a different Git repository.");
  }
  return primary;
}

function sessionId(explicit?: string): string {
  const value = explicit ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
  if (!value?.trim()) {
    throw new ValidationError("A session is required. Pass --session or set CODEX_THREAD_ID/CODEX_SESSION_ID.");
  }
  return value.trim();
}

function assignmentAlias(rawAlias: string): string {
  const alias = rawAlias.trim();
  if (!alias) throw new ValidationError("--alias cannot be empty.");
  if (alias.length > 80 || alias.includes("/") || alias.includes("\\") || alias.includes("\0")) {
    throw new ValidationError("--alias must be at most 80 characters and cannot contain '/' or '\\'.");
  }
  return alias;
}

function slugify(value: string): string {
  const slug = value.normalize("NFKD").replace(/[^\x00-\x7F]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 36).replace(/-$/, "");
  return slug || "assignment";
}

function ensureOutsideRepository(worktree: string, primary: string): void {
  const candidate = resolve(worktree);
  const roots = [resolve(primary), ...worktreeRecords(primary)
    .map((record) => record.worktree)
    .filter((path): path is string => Boolean(path))
    .map((path) => resolve(path))];
  for (const root of roots) {
    const relation = relative(root, candidate);
    const outside = relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
    if (!outside) {
      throw new ValidationError(
        `Worktree paths must be outside every registered working tree; ${candidate} is inside ${root}.`,
      );
    }
  }
}

function assignmentForTransition(state: State, requirement: Requirement): Assignment {
  const assignment = liveAssignmentForRequirement(state, requirement.id);
  if (!assignment) throw new ValidationError(`${requirement.id} has no live assignment.`);
  return assignment;
}

function updateRequirement(requirement: Requirement, status: string): void {
  requirement.status = status;
  requirement.updatedAt = utcNow();
}

function updateAssignment(assignment: Assignment, status: string): void {
  assignment.status = status;
  assignment.updatedAt = utcNow();
}

function rollbackAndRethrow(error: unknown, repository: string, branch: string, worktree: string): never {
  const failures = rollbackCreatedAssignment(repository, branch, worktree);
  if (failures.length > 0) {
    const detail = `\nRollback also failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`;
    if (error instanceof Error) error.message += detail;
    else throw new GitError(`${String(error)}${detail}`);
  }
  throw error;
}

function output(value: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else if (typeof value === "object" && value !== null && "message" in value) {
    process.stdout.write(`${String((value as { message: unknown }).message)}\n`);
  } else {
    process.stdout.write(`${String(value)}\n`);
  }
}

function handleInit(args: ParsedArguments): number {
  const { currentRoot, registry } = registryFor(option(args, "repo", ".") ?? ".");
  const primary = primaryWorktree(currentRoot);
  const commonDirectory = commonGitDir(currentRoot);
  const { created } = registry.initialize(primary, commonDirectory);
  process.stdout.write(`${created ? "Initialized" : "Already initialized"} gantt-cli for ${primary}\n`);
  process.stdout.write(`State: ${registry.path}\n`);
  if (args.flags.has("install-agent-instructions")) {
    const installed = installAgentInstructions(primary);
    process.stdout.write(`Agent instructions: ${installed.path} (${installed.changed ? "updated" : "unchanged"})\n`);
  }
  process.stdout.write("Next: gantt-cli add --request <text> --path <scope>\n");
  return 0;
}

function handleAdd(args: ParsedArguments): number {
  const { currentRoot, registry } = registryFor(option(args, "repo", ".") ?? ".");
  const request = requiredOption(args, "request");
  const verify = option(args, "verify")?.trim();
  if (verify !== undefined && !verify) throw new ValidationError("--verify cannot be empty.");
  const priority = normalizePriority(option(args, "priority", "p2") ?? "p2");
  const points = validatePoints(Number(option(args, "points", "3")));
  const paths = normalizeProjectPaths([...(args.options.get("path") ?? []), ...(args.options.get("paths") ?? [])]);
  const domains = normalizeDomains([...(args.options.get("domain") ?? []), ...(args.options.get("domains") ?? [])]);
  const dependencies = normalizeRequirementIds(args.options.get("depends-on") ?? []);
  const result = registry.locked(() => {
    const state = registry.read();
    primaryRepository(state, currentRoot);
    const identifier = nextRequirementId(state);
    if (dependencies.includes(identifier)) throw new ValidationError("A requirement cannot depend on itself.");
    for (const dependency of dependencies) requirementById(state, dependency);
    const createdAt = utcNow();
    const requirement: Requirement = {
      id: identifier,
      request,
      ...(verify ? { verify } : {}),
      priority,
      points,
      dependsOn: dependencies,
      domains,
      paths,
      status: "ready",
      createdAt,
      updatedAt: createdAt,
      stamps: [],
    };
    state.requirements.push(requirement);
    state.nextRequirementNumber += 1;
    appendEvent(state, "requirement.added", {
      requirementId: identifier,
      data: { priority, points },
    });
    registry.write(state);
    return {
      requirement: requirementView(state, requirement),
      message: `Added ${identifier}; run schedule before start.`,
    };
  });
  output(result, args.flags.has("json"));
  return 0;
}

function handleUpdate(args: ParsedArguments): number {
  const { currentRoot, registry } = registryFor(option(args, "repo", ".") ?? ".");
  const identifier = args.positionals[0];
  if (!identifier) throw new ValidationError("update requires a requirement ID.");
  const requestedPaths = normalizeProjectPaths(args.options.get("add-path") ?? [], false);
  const removedPaths = normalizeProjectPaths(args.options.get("remove-path") ?? [], false);
  if (requestedPaths.length === 0 && removedPaths.length === 0) {
    throw new ValidationError("update requires at least one --add-path or --remove-path.");
  }
  const result = registry.locked(() => {
    const state = registry.read();
    primaryRepository(state, currentRoot);
    const requirement = requirementById(state, identifier);
    if (!["ready", "active", "blocked"].includes(requirement.status)) {
      throw new ValidationError(`Cannot update path claims for ${requirement.id} while it is ${requirement.status}.`);
    }
    const assignment = liveAssignmentForRequirement(state, requirement.id);
    if (assignment && !["active", "blocked"].includes(assignment.status)) {
      throw new ValidationError(`Cannot update path claims after ${assignment.id} is ${assignment.status}.`);
    }
    const previousPaths = requirement.paths;
    const paths = normalizeProjectPaths([
      ...previousPaths.filter((path) => !removedPaths.includes(path)),
      ...requestedPaths,
    ]);
    const previousConflictAssignments = new Set(activeConflicts(state, requirement).map((item) => item.assignmentId));
    const conflicts = activeConflicts(state, { ...requirement, paths })
      .filter((item) => !previousConflictAssignments.has(item.assignmentId));
    if (conflicts.length > 0 && !args.flags.has("force")) {
      const blockers = conflicts.map((item) => `${item.requirementId}/${item.assignmentId}`).join(", ");
      throw new ValidationError(
        `${requirement.id} conflicts with active claims held by ${blockers}. Use --force to override advisory claims.`,
      );
    }
    const addedPaths = paths.filter((path) => !previousPaths.includes(path));
    const actualRemovedPaths = previousPaths.filter((path) => !paths.includes(path));
    requirement.paths = paths;
    requirement.updatedAt = utcNow();
    appendEvent(state, "requirement.paths_updated", {
      requirementId: requirement.id,
      data: {
        addedPaths,
        removedPaths: actualRemovedPaths,
        previousPaths,
        paths,
        forced: args.flags.has("force"),
        conflicts: args.flags.has("force") ? conflicts : [],
      },
    });
    registry.write(state);
    return {
      requirement: requirementView(state, requirement),
      message: `Updated path claims for ${requirement.id}.`,
    };
  });
  output(result, args.flags.has("json"));
  return 0;
}

function handleSchedule(args: ParsedArguments): number {
  const { registry } = registryFor(option(args, "repo", ".") ?? ".");
  const state = registry.read();
  const plan = buildSchedule(state);
  if (args.flags.has("json")) output(plan, true);
  else process.stdout.write(`${renderSchedule(state)}\n`);
  return 0;
}

function handleList(args: ParsedArguments): number {
  const { registry } = registryFor(option(args, "repo", ".") ?? ".");
  const state = registry.read();
  const schedule = buildSchedule(state);
  if (args.flags.has("json")) {
    output({ requirements: state.requirements.map((requirement) => requirementView(state, requirement, schedule)) }, true);
  } else {
    process.stdout.write(`${renderList(state)}\n`);
  }
  return 0;
}

function handleStart(args: ParsedArguments): number {
  const { currentRoot, registry } = registryFor(option(args, "repo", ".") ?? ".");
  const session = sessionId(option(args, "session"));
  const alias = assignmentAlias(requiredOption(args, "alias"));
  const requirementId = args.positionals[0];
  if (!requirementId) throw new ValidationError("start requires a requirement ID.");
  const state = registry.read();
  const primary = primaryRepository(state, currentRoot);
  const requirement = requirementById(state, requirementId);
  if (requirement.status !== "ready") {
    throw new ValidationError(`${requirement.id} is ${requirement.status}, not ready.`);
  }
  if (state.assignments.some((assignment) => assignment.requirementId === requirement.id
    && ["active", "blocked", "merged", "cleaned"].includes(assignment.status))) {
    throw new ValidationError(`${requirement.id} already has a live assignment.`);
  }
  const dependencies = requirement.dependsOn.filter(
    (identifier) => requirementById(state, identifier).status !== "done",
  );
  if (dependencies.length > 0) {
    throw new ValidationError(`${requirement.id} cannot start before: ${dependencies.join(", ")}.`);
  }
  const conflicts = activeConflicts(state, requirement);
  if (conflicts.length > 0 && !args.flags.has("force")) {
    const blockers = conflicts.map((item) => `${item.requirementId}/${item.assignmentId}`).join(", ");
    throw new ValidationError(
      `${requirement.id} conflicts with active claims held by ${blockers}. Use --force to override advisory claims.`,
    );
  }

  const assignmentId = `ASN-${String(state.nextAssignmentNumber).padStart(4, "0")}`;
  const slug = slugify(alias);
  const branch = option(args, "branch")
    ?? `codex/${nextPhaseId(state).toLowerCase()}-${requirement.id.toLowerCase()}-${slug}-${assignmentId.toLowerCase()}`;
  const worktreeRoot = resolve(option(args, "worktree-root") ?? defaultWorktreeRoot(primary));
  const worktree = resolve(worktreeRoot, `${assignmentId.toLowerCase()}-${slug}`);
  ensureOutsideRepository(worktree, primary);

  let created = false;
  let baseCommit: string;
  try {
    baseCommit = createWorktree(primary, branch, worktree);
    created = true;
    verifyAssignmentWorktree(primary, worktree, branch, commonGitDir(primary));
  } catch (error) {
    if (created) rollbackAndRethrow(error, primary, branch, worktree);
    throw error;
  }

  const createdAt = utcNow();
  const assignment: Assignment = {
    id: assignmentId,
    requirementId: requirement.id,
    alias,
    session,
    branch,
    worktree,
    baseCommit,
    status: "active",
    createdAt,
    startedAt: createdAt,
    updatedAt: createdAt,
  };
  try {
    initializeSubmodules(worktree);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    assignment.status = "provisioning_failed";
    assignment.provisionError = error.message;
    state.assignments.push(assignment);
    state.nextAssignmentNumber += 1;
    appendEvent(state, "assignment.provisioning_failed", {
      requirementId: requirement.id,
      assignmentId,
      actor: session,
      data: { worktree, error: error.message },
    });
    try {
      registry.write(state);
    } catch (writeError) {
      rollbackAndRethrow(writeError, primary, branch, worktree);
    }
    output({
      requirementId: requirement.id,
      assignment,
      nextAction: "repair_worktree",
      message: "Submodule initialization failed; worktree was retained and requirement remains ready.",
    }, args.flags.has("json"));
    return 4;
  }

  state.assignments.push(assignment);
  state.nextAssignmentNumber += 1;
  requirement.status = "active";
  requirement.updatedAt = utcNow();
  appendEvent(state, "assignment.started", {
    requirementId: requirement.id,
    assignmentId,
    actor: session,
    data: {
      branch,
      worktree,
      baseCommit,
      forced: args.flags.has("force"),
      conflicts: args.flags.has("force") ? conflicts : [],
    },
  });
  try {
    registry.write(state);
  } catch (error) {
    rollbackAndRethrow(error, primary, branch, worktree);
  }
  output({
    requirement: requirementView(state, requirement),
    assignment,
    nextAction: "work_in_worktree",
    message: `Started ${requirement.id} as ${assignmentId} in ${worktree}`,
  }, args.flags.has("json"));
  return 0;
}

function handleRepair(args: ParsedArguments): number {
  const assignmentId = args.positionals[0];
  if (!assignmentId) throw new ValidationError("repair requires an assignment ID.");
  const { currentRoot, registry } = registryFor(option(args, "repo", ".") ?? ".");
  return registry.locked(() => {
    const state = registry.read();
    const primary = primaryRepository(state, currentRoot);
    const assignment = assignmentById(state, assignmentId);
    if (assignment.status !== "provisioning_failed") {
      throw new ValidationError(`${assignment.id} is ${assignment.status}, not provisioning_failed.`);
    }
    const requirement = requirementById(state, assignment.requirementId);
    if (requirement.status !== "ready") {
      throw new ValidationError(`${requirement.id} is ${requirement.status}, not ready for repair.`);
    }
    const dependencies = requirement.dependsOn.filter(
      (identifier) => requirementById(state, identifier).status !== "done",
    );
    if (dependencies.length > 0) {
      throw new ValidationError(`${requirement.id} cannot be repaired before: ${dependencies.join(", ")}.`);
    }
    const conflicts = activeConflicts(state, requirement);
    if (conflicts.length > 0 && !args.flags.has("force")) {
      const blockers = conflicts.map((item) => `${item.requirementId}/${item.assignmentId}`).join(", ");
      throw new ValidationError(
        `${requirement.id} conflicts with active claims held by ${blockers}. Use --force to override advisory claims.`,
      );
    }
    verifyAssignmentWorktree(primary, assignment.worktree, assignment.branch, commonGitDir(primary));
    try {
      initializeSubmodules(assignment.worktree);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      assignment.provisionError = error.message;
      assignment.updatedAt = utcNow();
      appendEvent(state, "assignment.repair_failed", {
        requirementId: requirement.id,
        assignmentId: assignment.id,
        actor: assignment.session,
        data: { error: error.message },
      });
      registry.write(state);
      output({
        requirementId: requirement.id,
        assignment,
        nextAction: "repair_worktree",
        message: "Submodule initialization still fails; worktree remains retained.",
      }, args.flags.has("json"));
      return 4;
    }
    updateAssignment(assignment, "active");
    assignment.repairedAt = utcNow();
    delete assignment.provisionError;
    updateRequirement(requirement, "active");
    appendEvent(state, "assignment.repaired", {
      requirementId: requirement.id,
      assignmentId: assignment.id,
      actor: assignment.session,
      data: {
        forced: args.flags.has("force"),
        conflicts: args.flags.has("force") ? conflicts : [],
      },
    });
    registry.write(state);
    output({
      requirement: requirementView(state, requirement),
      assignment,
      nextAction: "work_in_worktree",
      message: `Repaired and activated ${assignment.id}.`,
    }, args.flags.has("json"));
    return 0;
  });
}

function transitionRecords(args: ParsedArguments): {
  registry: Registry;
  state: State;
  primary: string;
  requirement: Requirement;
  assignment: Assignment;
} {
  const requirementId = args.positionals[0];
  if (!requirementId) throw new ValidationError(`${args.command} requires a requirement ID.`);
  const { currentRoot, registry } = registryFor(option(args, "repo", ".") ?? ".");
  const state = registry.read();
  const primary = primaryRepository(state, currentRoot);
  const requirement = requirementById(state, requirementId);
  const assignment = assignmentForTransition(state, requirement);
  return { registry, state, primary, requirement, assignment };
}

interface MergeEvidenceProblem { code: string; message: string }

function mergeEvidenceProblem(repository: string, assignment: Assignment): MergeEvidenceProblem | undefined {
  if (!assignment.sourceCommit) {
    return { code: "missing_source_commit", message: `Assignment ${assignment.id} has no recorded sourceCommit.` };
  }
  if (!commitExists(repository, assignment.sourceCommit)) {
    return {
      code: "missing_source_commit",
      message: `Recorded source commit is missing for ${assignment.id}: ${assignment.sourceCommit}`,
    };
  }
  if (!assignment.mergeCommit) {
    return { code: "missing_merge_commit", message: `Assignment ${assignment.id} has no recorded mergeCommit.` };
  }
  if (!commitExists(repository, assignment.mergeCommit)) {
    return {
      code: "missing_merge_commit",
      message: `Recorded merge commit is missing for ${assignment.id}: ${assignment.mergeCommit}`,
    };
  }
  if (commitParent(repository, assignment.mergeCommit, 2) !== assignment.sourceCommit) {
    return {
      code: "merge_topology",
      message: `Recorded merge commit ${assignment.mergeCommit} does not have sourceCommit ${assignment.sourceCommit} as its second parent.`,
    };
  }
  if (!commitIsAncestor(repository, assignment.mergeCommit)) {
    return {
      code: "merge_not_in_head",
      message: `Recorded merge commit ${assignment.mergeCommit} is not an ancestor of current HEAD.`,
    };
  }
  return undefined;
}

function verifiedMergeEvidence(repository: string, assignment: Assignment): { sourceCommit: string; mergeCommit: string } {
  const problem = mergeEvidenceProblem(repository, assignment);
  if (problem) throw new GitError(problem.message);
  return { sourceCommit: assignment.sourceCommit as string, mergeCommit: assignment.mergeCommit as string };
}

function handleMerge(args: ParsedArguments): number {
  const { registry, state, primary, requirement, assignment } = transitionRecords(args);
  if (requirement.status !== "active" || !["active", "merged"].includes(assignment.status)) {
    throw new ValidationError(`${requirement.id} must have an active or merged assignment to merge.`);
  }
  let previousSource: string | undefined;
  if (assignment.status === "merged") {
    previousSource = verifiedMergeEvidence(primary, assignment).sourceCommit;
    if (!registeredWorktree(primary, assignment.worktree)) {
      output({ assignment, message: `${assignment.id} is already merged.` }, args.flags.has("json"));
      return 0;
    }
  }
  verifyAssignmentWorktree(primary, assignment.worktree, assignment.branch, commonGitDir(primary));
  ensureWorktreeClean(assignment.worktree);
  const sourceCommit = headCommit(assignment.worktree);
  if (sourceCommit === previousSource) {
    output({ assignment, message: `${assignment.id} is already merged.` }, args.flags.has("json"));
    return 0;
  }
  const changedPaths = changedPathsSince(primary, assignment.baseCommit, sourceCommit);
  const outsideScope = outOfScopePaths(requirement, changedPaths);
  if (outsideScope.length > 0) {
    throw new ValidationError(
      `Committed changes exceed ${requirement.id} path claims: ${outsideScope.join(", ")}`,
    );
  }
  const merged = mergeBranch(primary, assignment.branch, sourceCommit, option(args, "into"));
  updateAssignment(assignment, "merged");
  assignment.sourceCommit = merged.sourceCommit;
  assignment.mergedInto = merged.targetBranch;
  assignment.mergeCommit = merged.mergeCommit;
  assignment.mergedAt = utcNow();
  appendEvent(state, "assignment.merged", {
    requirementId: requirement.id,
    assignmentId: assignment.id,
    data: {
      sourceCommit: merged.sourceCommit,
      targetBranch: merged.targetBranch,
      mergeCommit: merged.mergeCommit,
      changedPaths,
    },
  });
  registry.write(state);
  output({ assignment, message: `Merged ${assignment.branch} into ${merged.targetBranch}.` }, args.flags.has("json"));
  return 0;
}

function handleCleanup(args: ParsedArguments): number {
  const { registry, state, primary, requirement, assignment } = transitionRecords(args);
  if (requirement.status !== "active") {
    throw new ValidationError(`${requirement.id} must remain active until cleanup completes.`);
  }
  if (assignment.status === "cleaned") {
    output({ assignment, message: `${assignment.id} worktree is already cleaned.` }, args.flags.has("json"));
    return 0;
  }
  if (assignment.status !== "merged") {
    throw new ValidationError(`${assignment.id} must be merged before cleanup.`);
  }
  const evidence = verifiedMergeEvidence(primary, assignment);
  const record = registeredWorktree(primary, assignment.worktree);
  if (!record) {
    if (assignment.cleanupPending) {
      updateAssignment(assignment, "cleaned");
      assignment.cleanupAt = utcNow();
      delete assignment.cleanupPending;
      appendEvent(state, "assignment.cleanup_recovered", {
        requirementId: requirement.id,
        assignmentId: assignment.id,
      });
      registry.write(state);
      output({ assignment, message: `Recovered completed cleanup for ${assignment.id}.` }, args.flags.has("json"));
      return 0;
    }
    throw new GitError(
      `Worktree is already absent but cleanup was not recorded: ${assignment.worktree}. Run doctor.`,
    );
  }
  verifyAssignmentWorktree(primary, assignment.worktree, assignment.branch, commonGitDir(primary));
  if (headCommit(assignment.worktree) !== evidence.sourceCommit) {
    throw new GitError(`Assignment branch advanced after merge: ${assignment.branch}. Run merge again before cleanup.`);
  }
  ensureWorktreeClean(assignment.worktree);
  if (!assignment.cleanupPending) {
    assignment.cleanupPending = true;
    assignment.updatedAt = utcNow();
    appendEvent(state, "assignment.cleanup_requested", {
      requirementId: requirement.id,
      assignmentId: assignment.id,
    });
    registry.write(state);
  }
  removeWorktree(primary, assignment.worktree);
  updateAssignment(assignment, "cleaned");
  assignment.cleanupAt = utcNow();
  delete assignment.cleanupPending;
  appendEvent(state, "assignment.cleaned", {
    requirementId: requirement.id,
    assignmentId: assignment.id,
    data: { worktree: assignment.worktree },
  });
  registry.write(state);
  output({ assignment, message: `Removed worktree ${assignment.worktree}.` }, args.flags.has("json"));
  return 0;
}

function handleDone(args: ParsedArguments): number {
  const { registry, state, primary, requirement, assignment } = transitionRecords(args);
  if (requirement.status !== "active" || assignment.status !== "cleaned") {
    throw new ValidationError(
      `${requirement.id} must be active with a cleaned assignment before it can be done.`,
    );
  }
  if (!assignment.cleanupAt) {
    throw new GitError("Assignment cleanup has no recorded clean-worktree verification. Run cleanup again.");
  }
  if (registeredWorktree(primary, assignment.worktree) || existsSync(assignment.worktree)) {
    throw new GitError("Assignment worktree still exists; run cleanup before done.");
  }
  const evidence = verifiedMergeEvidence(primary, assignment);
  if (requirement.verify) {
    const verification = spawnSync(requirement.verify, {
      cwd: primary,
      encoding: "utf8",
      shell: true,
    });
    const result = {
      command: requirement.verify,
      exitCode: verification.status ?? 1,
      stdout: verification.stdout,
      stderr: verification.stderr || verification.error?.message || "",
      completedAt: utcNow(),
    };
    assignment.verification = result;
    if (result.exitCode !== 0) {
      appendEvent(state, "requirement.verification_failed", {
        requirementId: requirement.id,
        assignmentId: assignment.id,
        data: { command: result.command, exitCode: result.exitCode },
      });
      registry.write(state);
      output({
        requirement,
        assignment,
        nextAction: "fix_verification",
        message: `Verification failed for ${requirement.id} with exit code ${result.exitCode}.`,
      }, args.flags.has("json"));
      return 3;
    }
  }
  updateAssignment(assignment, "completed");
  assignment.completedAt = utcNow();
  updateRequirement(requirement, "done");
  appendEvent(state, "requirement.done", {
    requirementId: requirement.id,
    assignmentId: assignment.id,
    data: evidence,
  });
  registry.write(state);
  output({ requirement, assignment, message: `Completed ${requirement.id}.` }, args.flags.has("json"));
  return 0;
}

function requiredRequirementId(args: ParsedArguments): string {
  const identifier = args.positionals[0];
  if (!identifier) throw new ValidationError(`${args.command} requires a requirement ID.`);
  return identifier;
}

function handleBlock(args: ParsedArguments): number {
  const { registry } = registryFor(option(args, "repo", ".") ?? ".");
  const reason = requiredOption(args, "reason");
  const identifier = requiredRequirementId(args);
  const requirementId = registry.locked(() => {
    const state = registry.read();
    const requirement = requirementById(state, identifier);
    if (!["ready", "active", "blocked"].includes(requirement.status)) {
      throw new ValidationError(`Cannot block ${requirement.id} from ${requirement.status}.`);
    }
    const assignment = liveAssignmentForRequirement(state, requirement.id);
    if (assignment) {
      if (assignment.status !== "active") {
        throw new ValidationError(`Cannot block assignment ${assignment.id} from ${assignment.status}.`);
      }
      updateAssignment(assignment, "blocked");
    }
    updateRequirement(requirement, "blocked");
    requirement.blockedReason = reason;
    appendEvent(state, "requirement.blocked", {
      requirementId: requirement.id,
      ...(assignment ? { assignmentId: assignment.id } : {}),
      data: { reason },
    });
    registry.write(state);
    return requirement.id;
  });
  process.stdout.write(`${requirementId} is blocked.\n`);
  return 0;
}

function handleUnblock(args: ParsedArguments): number {
  const { registry } = registryFor(option(args, "repo", ".") ?? ".");
  const identifier = requiredRequirementId(args);
  const result = registry.locked(() => {
    const state = registry.read();
    const requirement = requirementById(state, identifier);
    if (requirement.status !== "blocked") throw new ValidationError(`${requirement.id} is not blocked.`);
    const assignment = liveAssignmentForRequirement(state, requirement.id);
    let nextStatus = "ready";
    if (assignment) {
      if (assignment.status !== "blocked") {
        throw new ValidationError(`Cannot unblock assignment ${assignment.id} from ${assignment.status}.`);
      }
      updateAssignment(assignment, "active");
      nextStatus = "active";
    }
    updateRequirement(requirement, nextStatus);
    delete requirement.blockedReason;
    appendEvent(state, "requirement.unblocked", {
      requirementId: requirement.id,
      ...(assignment ? { assignmentId: assignment.id } : {}),
    });
    registry.write(state);
    return { id: requirement.id, nextStatus };
  });
  process.stdout.write(`${result.id} is ${result.nextStatus}.\n`);
  return 0;
}

function handleRelease(args: ParsedArguments): number {
  const { registry } = registryFor(option(args, "repo", ".") ?? ".");
  const identifier = requiredRequirementId(args);
  const reason = option(args, "reason", "")?.trim() ?? "";
  const result = registry.locked(() => {
    const state = registry.read();
    const requirement = requirementById(state, identifier);
    const assignment = assignmentForTransition(state, requirement);
    if (!["active", "blocked"].includes(requirement.status)
      || !["active", "blocked"].includes(assignment.status)) {
      throw new ValidationError(
        "Only an active or blocked assignment can be released; merged work must use cleanup/done.",
      );
    }
    updateAssignment(assignment, "released");
    assignment.releasedAt = utcNow();
    if (reason) assignment.releaseReason = reason;
    updateRequirement(requirement, "ready");
    delete requirement.blockedReason;
    appendEvent(state, "assignment.released", {
      requirementId: requirement.id,
      assignmentId: assignment.id,
      data: { reason, worktreeRetained: assignment.worktree },
    });
    registry.write(state);
    return { assignment, requirement };
  });
  output({
    ...result,
    nextAction: "discard_or_recover_worktree",
    message: `Released ${result.assignment.id}; ${result.requirement.id} is ready for reassignment. Worktree retained: ${result.assignment.worktree}`,
  }, args.flags.has("json"));
  return 0;
}

function handleDiscard(args: ParsedArguments): number {
  const assignmentId = args.positionals[0];
  if (!assignmentId) throw new ValidationError("discard requires an assignment ID.");
  const { currentRoot, registry } = registryFor(option(args, "repo", ".") ?? ".");
  const result = registry.locked(() => {
    const state = registry.read();
    const primary = primaryRepository(state, currentRoot);
    const assignment = assignmentById(state, assignmentId);
    if (assignment.status === "discarded") {
      return { assignment, recovered: false, message: `${assignment.id} worktree is already discarded.` };
    }
    if (!["released", "provisioning_failed"].includes(assignment.status)) {
      throw new ValidationError(`${assignment.id} is ${assignment.status}, not released or provisioning_failed.`);
    }
    const requirement = requirementById(state, assignment.requirementId);
    const record = registeredWorktree(primary, assignment.worktree);
    const pathExists = existsSync(assignment.worktree);
    let recovered = false;
    if (!record) {
      if (pathExists) {
        throw new GitError(`Assignment worktree exists but is not registered: ${assignment.worktree}`);
      }
      recovered = true;
    } else {
      verifyAssignmentWorktree(primary, assignment.worktree, assignment.branch, commonGitDir(primary));
      removeWorktree(primary, assignment.worktree);
    }
    if (!assignment.releasedAt) assignment.releasedAt = utcNow();
    updateAssignment(assignment, "discarded");
    assignment.discardedAt = utcNow();
    appendEvent(state, recovered ? "assignment.discard_recovered" : "assignment.discarded", {
      requirementId: requirement.id,
      assignmentId: assignment.id,
      data: { worktree: assignment.worktree, branchRetained: assignment.branch },
    });
    registry.write(state);
    return {
      assignment,
      recovered,
      message: recovered
        ? `Recorded already-absent worktree for ${assignment.id} as discarded.`
        : `Discarded worktree ${assignment.worktree}; branch ${assignment.branch} was retained.`,
    };
  });
  output(result, args.flags.has("json"));
  return 0;
}

function handleDeprecate(args: ParsedArguments): number {
  const identifier = requiredRequirementId(args);
  const reason = requiredOption(args, "reason");
  const { currentRoot, registry } = registryFor(option(args, "repo", ".") ?? ".");
  const result = registry.locked(() => {
    const state = registry.read();
    const primary = primaryRepository(state, currentRoot);
    const requirement = requirementById(state, identifier);
    if (!["ready", "blocked"].includes(requirement.status)) {
      throw new ValidationError(`${requirement.id} is ${requirement.status}; release active work before deprecating it.`);
    }
    const liveAssignment = liveAssignmentForRequirement(state, requirement.id);
    if (liveAssignment) {
      throw new ValidationError(`${requirement.id} still has live assignment ${liveAssignment.id}; release it first.`);
    }
    const retained = assignmentsForRequirement(state, requirement.id).filter(
      (assignment) => registeredWorktree(primary, assignment.worktree) || existsSync(assignment.worktree),
    );
    if (retained.length > 0) {
      throw new ValidationError(
        `${requirement.id} still has retained worktrees for ${retained.map((assignment) => assignment.id).join(", ")}; discard them first.`,
      );
    }
    const dependents = state.requirements.filter((candidate) => candidate.id !== requirement.id
      && !["done", "deprecated"].includes(candidate.status)
      && candidate.dependsOn.includes(requirement.id));
    if (dependents.length > 0) {
      throw new ValidationError(
        `${requirement.id} is still required by non-terminal requirements: ${dependents.map((candidate) => candidate.id).join(", ")}.`,
      );
    }
    updateRequirement(requirement, "deprecated");
    requirement.deprecatedAt = utcNow();
    requirement.deprecationReason = reason;
    delete requirement.blockedReason;
    appendEvent(state, "requirement.deprecated", {
      requirementId: requirement.id,
      data: { reason },
    });
    registry.write(state);
    return { requirement, message: `Deprecated ${requirement.id}.` };
  });
  output(result, args.flags.has("json"));
  return 0;
}

function handleShow(args: ParsedArguments): number {
  const { registry } = registryFor(option(args, "repo", ".") ?? ".");
  const identifier = requiredRequirementId(args);
  const result = registry.locked(() => {
    const state = registry.read();
    if (identifier.includes("/")) {
      const parts = identifier.toUpperCase().split("/");
      if (parts.length !== 2) throw new ValidationError(`Invalid archived requirement reference: ${identifier}`);
      const [rawPhaseId, requirementId] = parts as [string, string];
      const phase = phaseById(state, rawPhaseId);
      const artifacts = verifiedPhaseArtifacts(registry, phase);
      const requirement = artifacts.archive.requirements.find((candidate) => candidate.id === requirementId);
      if (!requirement) throw new ValidationError(`Unknown archived requirement: ${identifier}`);
      return {
        ...requirement,
        phaseId: phase.id,
        assignments: artifacts.archive.assignments.filter((assignment) => assignment.requirementId === requirement.id),
      };
    }
    const requirement = requirementById(state, identifier);
    return {
      ...requirementView(state, requirement),
      assignments: assignmentsForRequirement(state, requirement.id),
    };
  });
  if (args.flags.has("json")) {
    output(result, true);
  } else {
    process.stdout.write(`${result.id} — ${result.status} (${result.priority}, ${result.points}pt)\n`);
    process.stdout.write(`Request: ${result.request}\n`);
    process.stdout.write(`Domains: ${result.domains.join(", ") || "-"}\n`);
    process.stdout.write(`Paths: ${result.paths.join(", ")}\n`);
    process.stdout.write(`Depends on: ${result.dependsOn.join(", ") || "-"}\n`);
    process.stdout.write(`Assignments: ${result.assignments.map((item) => `${item.id}:${item.status}`).join(", ") || "-"}\n`);
  }
  return 0;
}

function handleStamp(args: ParsedArguments): number {
  const { registry } = registryFor(option(args, "repo", ".") ?? ".");
  const identifier = requiredRequirementId(args);
  const note = requiredOption(args, "note");
  const kind = option(args, "kind", "note")?.trim() ?? "";
  if (!kind) throw new ValidationError("--note and --kind cannot be empty.");
  const requirementId = registry.locked(() => {
    const state = registry.read();
    const requirement = requirementById(state, identifier);
    const stamp = { at: utcNow(), kind, note };
    requirement.stamps.push(stamp);
    requirement.updatedAt = stamp.at;
    appendEvent(state, "requirement.stamped", {
      requirementId: requirement.id,
      data: stamp,
    });
    registry.write(state);
    return requirement.id;
  });
  process.stdout.write(`Stamped ${requirementId}: ${kind}\n`);
  return 0;
}

function handleLog(args: ParsedArguments): number {
  const { registry } = registryFor(option(args, "repo", ".") ?? ".");
  const limit = Number(option(args, "limit", "50"));
  if (!Number.isInteger(limit) || limit < 1) throw new ValidationError("--limit must be at least 1.");
  const requirementId = option(args, "requirement")?.toUpperCase();
  const assignmentId = option(args, "assignment")?.toUpperCase();
  const events = registry.locked(() => {
    const state = registry.read();
    return state.events.filter((event) => (!requirementId || event.requirementId === requirementId)
      && (!assignmentId || event.assignmentId === assignmentId)).slice(-limit);
  });
  if (args.flags.has("json")) {
    output({ events }, true);
  } else if (events.length === 0) {
    process.stdout.write("No matching events.\n");
  } else {
    for (const event of events) {
      const target = [event.requirementId, event.assignmentId].filter(Boolean).join("/") || "registry";
      process.stdout.write(`${event.at}  ${event.type.padEnd(32)} ${target}\n`);
    }
  }
  return 0;
}

const PHASE_SUMMARY_GUIDANCE = `Generate a concise Markdown phase summary from the recorded Git evidence.
Describe merged commits as delivered work. For deprecated requirements, record the request and deprecation reason without
presenting released or unmerged commits as delivered. Prefer these sections: Delivered, Deprecated, Verification, Notable commits.`;

function archiveReadiness(state: State, primary: string): void {
  if (state.requirements.length === 0) throw new ValidationError("There are no requirements to archive.");
  const blockers = state.requirements.filter((requirement) => !["done", "deprecated"].includes(requirement.status));
  if (blockers.length > 0) {
    throw new ValidationError([
      "Cannot archive while requirements are non-terminal:",
      ...blockers.map((requirement) => `- ${requirement.id} is ${requirement.status}`),
    ].join("\n"));
  }
  const retained = state.assignments.filter(
    (assignment) => registeredWorktree(primary, assignment.worktree) || existsSync(assignment.worktree),
  );
  if (retained.length > 0) {
    throw new ValidationError([
      "Cannot archive while assignment worktrees are retained:",
      ...retained.map((assignment) => `- ${assignment.id}: ${assignment.worktree}`),
    ].join("\n"));
  }
  for (const requirement of state.requirements.filter((candidate) => candidate.status === "done")) {
    const completed = assignmentsForRequirement(state, requirement.id).filter((assignment) => assignment.status === "completed");
    if (completed.length !== 1) {
      throw new GitError(`${requirement.id} must have exactly one completed assignment before archival.`);
    }
    verifiedMergeEvidence(primary, completed[0] as Assignment);
  }
}

function phaseManifest(state: State, phaseId: string, fingerprint: string): object {
  return {
    phaseId,
    fingerprint,
    requirements: state.requirements.map((requirement) => ({
      ...requirement,
      assignments: assignmentsForRequirement(state, requirement.id),
    })),
    guidance: PHASE_SUMMARY_GUIDANCE,
  };
}

function summaryContents(path: string): string {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ValidationError(`Phase summary must be a regular file: ${path}`);
    }
    const contents = readFileSync(path, "utf8");
    if (!contents.trim()) throw new ValidationError("Phase summary must contain non-whitespace Markdown.");
    return contents;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`Could not read phase summary ${path}: ${(error as Error).message}`);
  }
}

function handleArchive(args: ParsedArguments): number {
  const { currentRoot, registry } = registryFor(option(args, "repo", ".") ?? ".");
  const preparing = args.flags.has("prepare");
  if (preparing && (option(args, "summary-file") || option(args, "fingerprint"))) {
    throw new ValidationError("--prepare cannot be combined with --summary-file or --fingerprint.");
  }
  if (!preparing && (!option(args, "summary-file") || !option(args, "fingerprint"))) {
    throw new ValidationError("archive requires --prepare, or both --summary-file and --fingerprint.");
  }
  return registry.locked(() => {
    const state = registry.read();
    const primary = primaryRepository(state, currentRoot);
    archiveReadiness(state, primary);
    const phaseId = nextPhaseId(state);
    const fingerprint = phaseFingerprint(state, phaseId);
    if (preparing) {
      output({
        ...phaseManifest(state, phaseId, fingerprint),
        nextAction: "write_phase_summary",
        message: `Prepared ${phaseId}; generate a summary, then rerun archive with --fingerprint ${fingerprint} --summary-file <path>.`,
      }, args.flags.has("json"));
      return 0;
    }
    const suppliedFingerprint = requiredOption(args, "fingerprint").toLowerCase();
    if (suppliedFingerprint !== fingerprint) {
      throw new ValidationError(
        `Archive fingerprint changed: expected ${suppliedFingerprint}, current ${fingerprint}. Run archive --prepare again.`,
      );
    }
    const summaryPath = resolve(requiredOption(args, "summary-file"));
    const summary = summaryContents(summaryPath);
    const archivedAt = utcNow();
    const archive = phaseArchive(state, phaseId, archivedAt, fingerprint);
    const artifacts = registry.phases.write(archive, summary);
    const phase: Phase = {
      id: phaseId,
      archivedAt: artifacts.archive.archivedAt,
      requirementCount: state.requirements.length,
      assignmentCount: state.assignments.length,
      eventCount: state.events.length,
      fingerprint,
      archiveHash: artifacts.archiveHash,
      summaryHash: artifacts.summaryHash,
    };
    state.phases.push(phase);
    state.nextPhaseNumber += 1;
    state.requirements = [];
    state.assignments = [];
    state.events = [];
    state.nextRequirementNumber = 1;
    state.nextAssignmentNumber = 1;
    state.nextEventNumber = 1;
    appendEvent(state, "phase.archived", {
      data: {
        phaseId,
        fingerprint,
        requirementCount: phase.requirementCount,
        assignmentCount: phase.assignmentCount,
        eventCount: phase.eventCount,
      },
    });
    registry.write(state);
    output({
      phase,
      recoveredArtifacts: artifacts.recovered,
      message: `Archived all current requirements as ${phaseId}; active IDs restarted.`,
    }, args.flags.has("json"));
    return 0;
  });
}

function phaseById(state: State, rawId: string): Phase {
  const phaseId = normalizePhaseId(rawId);
  const phase = state.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new ValidationError(`Unknown phase: ${rawId}`);
  return phase;
}

function verifiedPhaseArtifacts(registry: Registry, phase: Phase) {
  const artifacts = registry.phases.read(phase.id);
  const archive = artifacts.archive;
  const computedFingerprint = phaseFingerprint(archive, phase.id);
  if (artifacts.archiveHash !== phase.archiveHash || artifacts.summaryHash !== phase.summaryHash
    || archive.fingerprint !== phase.fingerprint || computedFingerprint !== phase.fingerprint
    || archive.archivedAt !== phase.archivedAt) {
    throw new RegistryError(`${phase.id} content does not match its recorded metadata or hashes.`);
  }
  if (archive.requirements.length !== phase.requirementCount
    || archive.assignments.length !== phase.assignmentCount || archive.events.length !== phase.eventCount) {
    throw new RegistryError(`${phase.id} content does not match its recorded counts.`);
  }
  return artifacts;
}

function handlePhase(args: ParsedArguments): number {
  const action = args.positionals[0]?.toLowerCase();
  const rawId = args.positionals[1];
  const { registry } = registryFor(option(args, "repo", ".") ?? ".");
  const state = registry.read();
  if (action === "list") {
    if (rawId) throw new ValidationError("phase list does not accept a phase ID.");
    if (args.flags.has("json")) output({ phases: state.phases }, true);
    else if (state.phases.length === 0) process.stdout.write("No archived phases.\n");
    else for (const phase of state.phases) {
      process.stdout.write(`${phase.id}  ${phase.archivedAt}  ${phase.requirementCount} requirements\n`);
    }
    return 0;
  }
  if (action === "show") {
    if (!rawId) throw new ValidationError("phase show requires a phase ID.");
    const phase = phaseById(state, rawId);
    const artifacts = verifiedPhaseArtifacts(registry, phase);
    if (args.flags.has("json")) output({ phase, summary: artifacts.summary, archive: artifacts.archive }, true);
    else process.stdout.write(artifacts.summary);
    return 0;
  }
  throw new ValidationError("phase requires `list` or `show <phase-id>`.");
}

interface DoctorIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  requirementId?: string;
  assignmentId?: string;
}

function doctorIssues(currentRoot: string, state: State, registry: Registry): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  let primary: string | undefined;
  try {
    primary = primaryRepository(state, currentRoot);
  } catch (error) {
    if (!(error instanceof GanttCliError)) throw error;
    issues.push({ severity: "error", code: "primary_worktree", message: error.message });
  }
  for (const requirement of state.requirements) {
    let assignment: Assignment | undefined;
    try {
      assignment = liveAssignmentForRequirement(state, requirement.id);
    } catch (error) {
      if (!(error instanceof GanttCliError)) throw error;
      issues.push({
        severity: "error", code: "assignment_cardinality", requirementId: requirement.id, message: error.message,
      });
      continue;
    }
    if (requirement.status === "active" && !assignment) {
      issues.push({
        severity: "error", code: "missing_assignment", requirementId: requirement.id,
        message: "Active requirement has no live assignment.",
      });
    }
    if (requirement.status === "ready" && assignment) {
      issues.push({
        severity: "error", code: "unexpected_assignment", requirementId: requirement.id,
        assignmentId: assignment.id, message: "Ready requirement still has a live assignment.",
      });
    }
  }
  if (!primary) return issues;
  const expectedCommonDirectory = commonGitDir(primary);
  for (const assignment of state.assignments) {
    const status = assignment.status;
    const record = registeredWorktree(primary, assignment.worktree);
    const branchMissing = ["active", "blocked"].includes(status) && !branchExists(primary, assignment.branch);
    if (branchMissing) {
      issues.push({
        severity: "error", code: "missing_branch", assignmentId: assignment.id,
        message: `Branch is missing: ${assignment.branch}`,
      });
    }
    if (status === "merged" && assignment.cleanupPending && !record) {
      issues.push({
        severity: "warning", code: "cleanup_recovery", assignmentId: assignment.id,
        message: "Worktree was removed after cleanupPending; rerun cleanup to finalize state.",
      });
    } else if (["active", "blocked", "merged"].includes(status) && !branchMissing) {
      try {
        verifyAssignmentWorktree(primary, assignment.worktree, assignment.branch, expectedCommonDirectory);
        if (status === "merged" && assignment.sourceCommit
          && headCommit(assignment.worktree) !== assignment.sourceCommit) {
          issues.push({
            severity: "error", code: "branch_advanced_after_merge", assignmentId: assignment.id,
            message: `Assignment branch advanced after merge: ${assignment.branch}. Run merge again before cleanup.`,
          });
        }
      } catch (error) {
        if (!(error instanceof GanttCliError)) throw error;
        issues.push({ severity: "error", code: "assignment_binding", assignmentId: assignment.id, message: error.message });
      }
    } else if (status === "cleaned") {
      if (record || existsSync(assignment.worktree)) {
        issues.push({
          severity: "error", code: "cleanup_incomplete", assignmentId: assignment.id,
          message: "Cleaned assignment still has a worktree.",
        });
      }
    } else if (status === "provisioning_failed") {
      try {
        verifyAssignmentWorktree(primary, assignment.worktree, assignment.branch, expectedCommonDirectory);
      } catch (error) {
        if (!(error instanceof GanttCliError)) throw error;
        issues.push({
          severity: "error", code: "provisioning_binding", assignmentId: assignment.id, message: error.message,
        });
      }
      issues.push({
        severity: "warning", code: "provisioning_failed", assignmentId: assignment.id,
        message: typeof assignment.provisionError === "string"
          ? assignment.provisionError : "Repair or remove the retained worktree before retrying.",
      });
    } else if (status === "released") {
      if (record) {
        try {
          verifyAssignmentWorktree(primary, assignment.worktree, assignment.branch, expectedCommonDirectory);
          issues.push({
            severity: "warning", code: "released_worktree", assignmentId: assignment.id,
            message: "Released worktree was retained for recovery or discard.",
          });
        } catch (error) {
          if (!(error instanceof GanttCliError)) throw error;
          issues.push({ severity: "error", code: "assignment_binding", assignmentId: assignment.id, message: error.message });
        }
      } else if (existsSync(assignment.worktree)) {
        issues.push({
          severity: "error", code: "assignment_binding", assignmentId: assignment.id,
          message: `Released worktree exists but is not registered: ${assignment.worktree}`,
        });
      }
    } else if (status === "discarded" && (record || existsSync(assignment.worktree))) {
      issues.push({
        severity: "error", code: "discard_incomplete", assignmentId: assignment.id,
        message: "Discarded assignment still has a worktree.",
      });
    } else if (status === "legacy") {
      issues.push({
        severity: "warning", code: "legacy_assignment", assignmentId: assignment.id,
        message: "Legacy assignment has no verifiable historical base commit.",
      });
    }
    if (["merged", "cleaned"].includes(status)) {
      const problem = mergeEvidenceProblem(primary, assignment);
      if (problem) {
        issues.push({
          severity: "error", code: problem.code, assignmentId: assignment.id, message: problem.message,
        });
      }
    }
  }
  const indexedPhases = new Set(state.phases.map((phase) => phase.id));
  for (const phase of state.phases) {
    try {
      verifiedPhaseArtifacts(registry, phase);
    } catch (error) {
      if (!(error instanceof GanttCliError)) throw error;
      issues.push({ severity: "error", code: "phase_integrity", message: `${phase.id}: ${error.message}` });
    }
  }
  for (const phaseId of registry.phases.directoryIds()) {
    if (!indexedPhases.has(phaseId)) {
      issues.push({
        severity: "warning", code: "unindexed_phase", message: `${phaseId} exists on disk but is not indexed by state.json.`,
      });
    }
  }
  return issues;
}

function handleDoctor(args: ParsedArguments): number {
  const { currentRoot, registry } = registryFor(option(args, "repo", ".") ?? ".");
  const issues = registry.locked(() => doctorIssues(currentRoot, registry.read(), registry));
  const result = { ok: !issues.some((issue) => issue.severity === "error"), issues };
  if (args.flags.has("json")) {
    output(result, true);
  } else if (issues.length === 0) {
    process.stdout.write("doctor: OK\n");
  } else {
    for (const issue of issues) {
      const identifier = issue.assignmentId ?? issue.requirementId ?? "registry";
      process.stdout.write(`${issue.severity.toUpperCase()} ${identifier} [${issue.code}]: ${issue.message}\n`);
    }
  }
  return result.ok ? 0 : 1;
}

const COMMAND_SUMMARIES: Record<string, string> = {
  init: "Initialize local schema-v4 state.",
  add: "Register a requirement.",
  update: "Update a requirement's path claims.",
  schedule: "Show stable greedy batches and deferrals.",
  start: "Allocate a branch and linked worktree.",
  repair: "Retry a retained provisioning-failed assignment.",
  merge: "Merge an assignment branch into the primary worktree.",
  cleanup: "Remove a clean, merged assignment worktree.",
  done: "Verify and complete a requirement.",
  block: "Block a ready or active requirement.",
  unblock: "Restore a blocked requirement.",
  release: "Release an assignment while retaining its worktree.",
  discard: "Remove a retained released assignment worktree.",
  deprecate: "Permanently deprecate a requirement.",
  archive: "Archive every terminal requirement into an immutable phase.",
  phase: "List or inspect immutable phase archives.",
  list: "List requirements and scheduling facts.",
  show: "Show one requirement and assignment history.",
  doctor: "Diagnose state, branch, and worktree drift.",
  log: "Read the current phase's append-only coordination event log.",
  stamp: "Append a timestamped requirement note.",
  "agent-instructions": "Print the Agent integration contract.",
};

const COMMAND_POSITIONALS: Record<string, string> = {
  update: "<requirement-id>",
  start: "<requirement-id>",
  repair: "<assignment-id>",
  merge: "<requirement-id>",
  cleanup: "<requirement-id>",
  done: "<requirement-id>",
  block: "<requirement-id>",
  unblock: "<requirement-id>",
  release: "<requirement-id>",
  discard: "<assignment-id>",
  deprecate: "<requirement-id>",
  phase: "<list|show> [phase-id]",
  show: "<requirement-id>",
  stamp: "<requirement-id>",
};

const OPTION_HELP: Record<string, { usage: string; description: string }> = {
  repo: { usage: "--repo <path>", description: "Git repository; defaults to the current directory." },
  request: { usage: "--request <text>", description: "Requirement text; required." },
  verify: { usage: "--verify <command>", description: "Shell command that must pass before done." },
  priority: { usage: "--priority <p0|p1|p2|p3>", description: "Planning priority; defaults to p2." },
  points: { usage: "--points <number>", description: "Effort from 1 to 100; defaults to 3." },
  "depends-on": { usage: "--depends-on <id>", description: "Required predecessor; repeatable." },
  domain: { usage: "--domain <name>", description: "Logical ownership claim; repeatable." },
  domains: { usage: "--domains <names...>", description: "One or more logical ownership claims." },
  path: { usage: "--path <glob>", description: "Repository-relative path claim; repeatable." },
  paths: { usage: "--paths <globs...>", description: "One or more repository-relative path claims." },
  "add-path": { usage: "--add-path <glob>", description: "Add a repository-relative path claim; repeatable." },
  "remove-path": { usage: "--remove-path <glob>", description: "Remove a repository-relative path claim; repeatable." },
  session: { usage: "--session <id>", description: "Agent session ID; falls back to Codex environment variables." },
  alias: { usage: "--alias <name>", description: "Assignment alias; required." },
  branch: { usage: "--branch <name>", description: "Explicit assignment branch name." },
  "worktree-root": { usage: "--worktree-root <path>", description: "Directory in which to create assignment worktrees." },
  into: { usage: "--into <branch>", description: "Require the primary worktree to be on this target branch." },
  reason: { usage: "--reason <text>", description: "Reason for the transition." },
  requirement: { usage: "--requirement <id>", description: "Filter events by requirement ID." },
  assignment: { usage: "--assignment <id>", description: "Filter events by assignment ID." },
  limit: { usage: "--limit <number>", description: "Maximum events to return; defaults to 50." },
  note: { usage: "--note <text>", description: "Timestamped note; required." },
  kind: { usage: "--kind <name>", description: "Note category; defaults to note." },
  "summary-file": { usage: "--summary-file <path>", description: "Non-empty Markdown summary to store in the phase." },
  fingerprint: { usage: "--fingerprint <sha256>", description: "State fingerprint returned by archive --prepare." },
  json: { usage: "--json", description: "Print machine-readable JSON." },
  force: { usage: "--force", description: "Override advisory active-claim conflicts." },
  prepare: { usage: "--prepare", description: "Return the immutable commit manifest for Agent summarization." },
  "install-agent-instructions": {
    usage: "--install-agent-instructions",
    description: "Add or update the managed AGENTS.md pointer.",
  },
  help: { usage: "--help", description: "Show help for this command." },
};

function renderCommandHelp(command: string): string {
  const contract = COMMAND_OPTIONS[command];
  if (!contract) throw new ValidationError(`Unknown command: ${command}`);
  const positional = COMMAND_POSITIONALS[command];
  const usage = [`Usage: gantt-cli ${command}`, positional, "[options]"].filter(Boolean).join(" ");
  const optionNames = [...contract.values, ...contract.flags, "help"];
  const options = optionNames.map((name) => {
    const help = OPTION_HELP[name];
    if (!help) throw new ValidationError(`Help is missing for option --${name}.`);
    return `  ${help.usage.padEnd(34)}${help.description}`;
  });
  return `${usage}\n\n${COMMAND_SUMMARIES[command]}\n\nOptions:\n${options.join("\n")}\n`;
}

const HELP = `Usage: gantt-cli <command> [options]

A requirement control plane and Git-worktree execution orchestrator for coding agents.

Commands:
  init                Initialize local schema-v4 state
  add                 Register a requirement
  update              Update a requirement's path claims
  schedule            Show stable greedy batches and deferrals
  start               Allocate a branch and linked worktree
  repair              Retry a retained provisioning-failed assignment
  merge               Merge an assignment branch into the primary worktree
  cleanup             Remove a clean, merged assignment worktree
  done                Verify and complete a requirement
  block               Block a ready or active requirement
  unblock             Restore a blocked requirement
  release             Release an assignment while retaining its worktree
  discard             Remove a retained released assignment worktree
  deprecate           Permanently deprecate a requirement
  archive             Archive all terminal requirements into an immutable phase
  phase               List or inspect immutable phase archives
  list                List requirements and scheduling facts
  show                Show one requirement and assignment history
  doctor              Diagnose state, branch, and worktree drift
  log                 Read the current phase's append-only coordination event log
  stamp               Append a timestamped requirement note
  agent-instructions  Print the Agent integration contract

Common options:
  --repo <path>        Git repository; defaults to the current directory
  --json               Print machine-readable JSON where supported
  --install-agent-instructions  Add a managed AGENTS.md pointer during init
  --help               Show this help
`;

function handleAgentInstructions(): number {
  process.stdout.write(AGENT_INSTRUCTIONS);
  return 0;
}

function withCommandLock(handler: (args: ParsedArguments) => number): (args: ParsedArguments) => number {
  return (args) => {
    const { registry } = registryFor(option(args, "repo", ".") ?? ".");
    return registry.locked(() => handler(args));
  };
}

function main(arguments_ = process.argv.slice(2)): number {
  const args = parseArguments(arguments_);
  if (!args.command || args.command === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command === "--version") {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`${manifest.version}\n`);
    return 0;
  }
  if (args.flags.has("help")) {
    process.stdout.write(renderCommandHelp(args.command));
    return 0;
  }
  validateCommandArguments(args);
  const handlers: Record<string, (parsed: ParsedArguments) => number> = {
    init: handleInit,
    add: handleAdd,
    update: handleUpdate,
    schedule: withCommandLock(handleSchedule),
    list: withCommandLock(handleList),
    start: withCommandLock(handleStart),
    repair: handleRepair,
    merge: withCommandLock(handleMerge),
    cleanup: withCommandLock(handleCleanup),
    done: withCommandLock(handleDone),
    block: handleBlock,
    unblock: handleUnblock,
    release: handleRelease,
    discard: handleDiscard,
    deprecate: handleDeprecate,
    archive: handleArchive,
    phase: withCommandLock(handlePhase),
    show: handleShow,
    stamp: handleStamp,
    log: handleLog,
    doctor: handleDoctor,
    "agent-instructions": handleAgentInstructions,
  };
  const handler = handlers[args.command];
  if (!handler) throw new ValidationError(`Unknown command: ${args.command}`);
  return handler(args);
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof GanttCliError) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
