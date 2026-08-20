import { posix } from "node:path";

import { RegistryError, ValidationError } from "./errors.js";

export const SCHEMA_VERSION = 3;
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export const PRIORITY_ORDER = new Map(PRIORITIES.map((priority, index) => [priority, index]));
export const LIVE_ASSIGNMENT_STATUSES = new Set(["active", "blocked", "merged", "cleaned"]);

const REQUIREMENT_ID = /^REQ-\d{4,}$/;
const ASSIGNMENT_ID = /^ASN-\d{4,}$/;
const DOMAIN = /^[a-z0-9][a-z0-9._/-]*$/;
const REQUIREMENT_STATUSES = new Set(["ready", "active", "blocked", "done", "cancelled"]);
const ASSIGNMENT_STATUSES = new Set([
  "active", "blocked", "merged", "cleaned", "completed", "abandoned", "provisioning_failed", "legacy",
]);

export type JsonObject = { [key: string]: unknown };

export interface Stamp extends JsonObject {
  at: string;
  kind: string;
  note: string;
}

export interface Requirement extends JsonObject {
  id: string;
  request: string;
  verify?: string;
  priority: string;
  points: number;
  dependsOn: string[];
  domains: string[];
  paths: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
  stamps: Stamp[];
}

export interface Assignment extends JsonObject {
  id: string;
  requirementId: string;
  alias: string;
  session: string;
  branch: string;
  worktree: string;
  baseCommit: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Event extends JsonObject {
  id: string;
  at: string;
  type: string;
  requirementId?: string;
  assignmentId?: string;
  actor?: string;
  data?: JsonObject;
}

export interface State extends JsonObject {
  schemaVersion: number;
  repository: { root: string; commonGitDir: string };
  createdAt: string;
  updatedAt: string;
  nextRequirementNumber: number;
  nextAssignmentNumber: number;
  nextEventNumber: number;
  requirements: Requirement[];
  assignments: Assignment[];
  events: Event[];
}

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export interface EventFields {
  requirementId?: string;
  assignmentId?: string;
  actor?: string;
  data?: JsonObject;
}

export function appendEvent(state: State, type: string, fields: EventFields = {}): Event {
  if (!Number.isInteger(state.nextEventNumber) || state.nextEventNumber < 1) {
    throw new RegistryError("Registry nextEventNumber must be a positive integer.");
  }
  const event: Event = {
    id: `EVT-${String(state.nextEventNumber).padStart(6, "0")}`,
    at: utcNow(),
    type,
  };
  if (fields.requirementId !== undefined) event.requirementId = fields.requirementId;
  if (fields.assignmentId !== undefined) event.assignmentId = fields.assignmentId;
  if (fields.actor !== undefined) event.actor = fields.actor;
  if (fields.data && Object.keys(fields.data).length > 0) event.data = fields.data;
  state.events.push(event);
  state.nextEventNumber += 1;
  return event;
}

export function initialState(repositoryRoot: string, commonGitDir: string): State {
  const createdAt = utcNow();
  const state: State = {
    schemaVersion: SCHEMA_VERSION,
    repository: { root: repositoryRoot, commonGitDir },
    createdAt,
    updatedAt: createdAt,
    nextRequirementNumber: 1,
    nextAssignmentNumber: 1,
    nextEventNumber: 1,
    requirements: [],
    assignments: [],
    events: [],
  };
  appendEvent(state, "registry.initialized", { data: { schemaVersion: SCHEMA_VERSION } });
  return state;
}

export function normalizeProjectPath(rawPath: string): string {
  const candidate = rawPath.trim().replaceAll("\\", "/");
  if (!candidate) throw new ValidationError("A path claim cannot be empty.");
  if (candidate.startsWith("/")) {
    throw new ValidationError(`Path claims must be repository-relative: ${JSON.stringify(rawPath)}`);
  }
  if (candidate.split("/").includes("..")) {
    throw new ValidationError(`Path claims cannot leave the repository: ${JSON.stringify(rawPath)}`);
  }
  const normalized = posix.normalize(candidate).replace(/\/$/, "");
  if (!normalized || normalized === ".") {
    throw new ValidationError(`Path claim is not specific enough: ${JSON.stringify(rawPath)}`);
  }
  return normalized;
}

export function normalizeProjectPaths(rawPaths: string[], requireOne = true): string[] {
  const normalized = [...new Set(rawPaths.map(normalizeProjectPath))];
  if (requireOne && normalized.length === 0) {
    throw new ValidationError("At least one --path or --paths claim is required.");
  }
  return normalized;
}

export function normalizeDomains(rawDomains: string[]): string[] {
  return [...new Set(rawDomains.map((rawDomain) => {
    const domain = rawDomain.trim().toLowerCase();
    if (!DOMAIN.test(domain)) {
      throw new ValidationError(
        `Invalid domain ${JSON.stringify(rawDomain)}; use lowercase letters, digits, '.', '_', '/', or '-'.`,
      );
    }
    return domain;
  }))];
}

export function normalizeRequirementIds(rawIds: string[]): string[] {
  return [...new Set(rawIds.map((rawId) => {
    const identifier = rawId.trim().toUpperCase();
    if (!REQUIREMENT_ID.test(identifier)) {
      throw new ValidationError(`Invalid requirement ID: ${JSON.stringify(rawId)}`);
    }
    return identifier;
  }))];
}

export function normalizePriority(rawPriority: string): string {
  const priority = rawPriority.trim().toLowerCase();
  if (!PRIORITY_ORDER.has(priority as (typeof PRIORITIES)[number])) {
    throw new ValidationError("--priority must be one of p0, p1, p2, or p3 (p0 is highest).");
  }
  return priority;
}

export function validatePoints(points: number): number {
  if (!Number.isInteger(points) || points < 1 || points > 100) {
    throw new ValidationError("--points must be between 1 and 100.");
  }
  return points;
}

function nextId(state: State, counter: "nextRequirementNumber" | "nextAssignmentNumber", prefix: string): string {
  const number = state[counter];
  if (!Number.isInteger(number) || number < 1) {
    throw new RegistryError(`Registry ${counter} must be a positive integer.`);
  }
  return `${prefix}-${String(number).padStart(4, "0")}`;
}

export function nextRequirementId(state: State): string {
  return nextId(state, "nextRequirementNumber", "REQ");
}

export function nextAssignmentId(state: State): string {
  return nextId(state, "nextAssignmentNumber", "ASN");
}

export function requirementById(state: State, rawId: string): Requirement {
  const identifier = rawId.trim().toUpperCase();
  const requirement = state.requirements.find((item) => item.id === identifier);
  if (!requirement) throw new ValidationError(`Unknown requirement: ${rawId}`);
  return requirement;
}

export function assignmentById(state: State, rawId: string): Assignment {
  const identifier = rawId.trim().toUpperCase();
  const assignment = state.assignments.find((item) => item.id === identifier);
  if (!assignment) throw new ValidationError(`Unknown assignment: ${rawId}`);
  return assignment;
}

export function assignmentsForRequirement(state: State, requirementId: string): Assignment[] {
  return state.assignments.filter((assignment) => assignment.requirementId === requirementId);
}

export function liveAssignmentForRequirement(state: State, requirementId: string): Assignment | undefined {
  const live = assignmentsForRequirement(state, requirementId)
    .filter((assignment) => LIVE_ASSIGNMENT_STATUSES.has(assignment.status));
  if (live.length > 1) {
    throw new RegistryError(`Requirement ${requirementId} has more than one live assignment.`);
  }
  return live[0];
}

export function activeAssignments(state: State): Assignment[] {
  return state.assignments.filter((assignment) => LIVE_ASSIGNMENT_STATUSES.has(assignment.status));
}

export function dependenciesSatisfied(
  state: State,
  requirement: Requirement,
): { satisfied: boolean; outstanding: string[] } {
  const outstanding = requirement.dependsOn.filter(
    (dependencyId) => requirementById(state, dependencyId).status !== "done",
  );
  return { satisfied: outstanding.length === 0, outstanding };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maximumNumber(records: unknown, prefix: string): number {
  if (!Array.isArray(records)) return 0;
  let maximum = 0;
  for (const record of records) {
    if (!isObject(record) || typeof record.id !== "string" || !record.id.startsWith(`${prefix}-`)) continue;
    const suffix = record.id.slice(prefix.length + 1);
    if (/^\d+$/.test(suffix)) maximum = Math.max(maximum, Number(suffix));
  }
  return maximum;
}

function repairCounters(state: JsonObject): boolean {
  let changed = false;
  const counters = [
    ["nextRequirementNumber", maximumNumber(state.requirements, "REQ")],
    ["nextAssignmentNumber", maximumNumber(state.assignments, "ASN")],
    ["nextEventNumber", maximumNumber(state.events, "EVT")],
  ] as const;
  for (const [name, maximum] of counters) {
    const current = state[name];
    if (!Number.isInteger(current) || (current as number) < maximum + 1) {
      state[name] = maximum + 1;
      changed = true;
    }
  }
  return changed;
}

function baseStateFromLegacy(rawState: JsonObject): State {
  const repository = isObject(rawState.repository) ? rawState.repository : {};
  const createdAt = typeof rawState.createdAt === "string" ? rawState.createdAt : utcNow();
  return {
    schemaVersion: SCHEMA_VERSION,
    repository: {
      root: typeof repository.root === "string" ? repository.root : "",
      commonGitDir: typeof repository.commonGitDir === "string" ? repository.commonGitDir : "",
    },
    createdAt,
    updatedAt: utcNow(),
    nextRequirementNumber: 1,
    nextAssignmentNumber: 1,
    nextEventNumber: 1,
    requirements: [],
    assignments: [],
    events: [],
  };
}

function migrateV1(rawState: JsonObject): State {
  const state = baseStateFromLegacy(rawState);
  if (!Array.isArray(rawState.requirements)) {
    throw new RegistryError("Legacy registry requirements must be a list.");
  }
  const requirementStatus: Record<string, string> = {
    pending: "ready", in_progress: "active", blocked: "blocked", done: "done", cancelled: "cancelled",
  };
  const assignmentStatus: Record<string, string> = {
    pending: "legacy", in_progress: "active", blocked: "blocked", done: "completed", cancelled: "abandoned",
  };
  rawState.requirements.forEach((rawRequirement, index) => {
    if (!isObject(rawRequirement)) throw new RegistryError("Legacy registry contains a non-object requirement.");
    const id = typeof rawRequirement.id === "string" ? rawRequirement.id : `REQ-${String(index + 1).padStart(4, "0")}`;
    if (!REQUIREMENT_ID.test(id)) throw new RegistryError(`Legacy registry has invalid requirement ID: ${JSON.stringify(id)}`);
    const oldStatus = typeof rawRequirement.status === "string" ? rawRequirement.status : "pending";
    const createdAt = typeof rawRequirement.createdAt === "string" ? rawRequirement.createdAt : utcNow();
    const updatedAt = typeof rawRequirement.updatedAt === "string" ? rawRequirement.updatedAt : createdAt;
    const legacyFiles = typeof rawRequirement.files === "string"
      ? [rawRequirement.files]
      : Array.isArray(rawRequirement.files) ? rawRequirement.files.filter((item): item is string => typeof item === "string") : [];
    state.requirements.push({
      id,
      request: String(rawRequirement.request ?? "Migrated legacy requirement"),
      priority: "p2",
      points: 3,
      dependsOn: [],
      domains: [],
      paths: normalizeProjectPaths(legacyFiles, false),
      status: requirementStatus[oldStatus] ?? "ready",
      createdAt,
      updatedAt,
      stamps: [],
    });
    if (["branch", "worktree", "session"].every((key) => typeof rawRequirement[key] === "string" && rawRequirement[key])) {
      state.assignments.push({
        id: `ASN-${String(index + 1).padStart(4, "0")}`,
        requirementId: id,
        alias: `legacy-${id.toLowerCase()}`,
        session: rawRequirement.session as string,
        branch: rawRequirement.branch as string,
        worktree: rawRequirement.worktree as string,
        baseCommit: "legacy-unknown",
        status: assignmentStatus[oldStatus] ?? "legacy",
        createdAt,
        updatedAt,
        migrationNote: "Migrated from schema v1; baseCommit is unavailable.",
      });
    }
  });
  repairCounters(state);
  appendEvent(state, "registry.migrated", {
    data: { fromSchemaVersion: rawState.schemaVersion ?? 1, toSchemaVersion: SCHEMA_VERSION },
  });
  validateV3(state);
  return state;
}

function normalizeV3InPlace(state: JsonObject): boolean {
  let changed = false;
  for (const [key, fallback] of [["assignments", []], ["events", []]] as const) {
    if (!(key in state)) {
      state[key] = fallback;
      changed = true;
    }
  }
  for (const [key, fallback] of [["nextAssignmentNumber", 1], ["nextEventNumber", 1]] as const) {
    if (!(key in state)) {
      state[key] = fallback;
      changed = true;
    }
  }
  if (Array.isArray(state.requirements)) {
    for (const requirement of state.requirements) {
      if (!isObject(requirement)) continue;
      if (!("paths" in requirement) && "files" in requirement) {
        requirement.paths = requirement.files;
        delete requirement.files;
        changed = true;
      }
      for (const [key, fallback] of [
        ["priority", "p2"], ["points", 3], ["dependsOn", []], ["domains", []], ["stamps", []],
      ] as const) {
        if (!(key in requirement)) {
          requirement[key] = fallback;
          changed = true;
        }
      }
      if (requirement.status === "pending") {
        requirement.status = "ready";
        changed = true;
      } else if (requirement.status === "in_progress") {
        requirement.status = "active";
        changed = true;
      }
    }
  }
  if (repairCounters(state)) changed = true;
  if (state.schemaVersion !== SCHEMA_VERSION) {
    state.schemaVersion = SCHEMA_VERSION;
    changed = true;
  }
  return changed;
}

function migrateV2(rawState: JsonObject): State {
  const state = structuredClone(rawState);
  state.schemaVersion = SCHEMA_VERSION;
  normalizeV3InPlace(state);
  const typed = state as unknown as State;
  appendEvent(typed, "registry.migrated", {
    data: { fromSchemaVersion: 2, toSchemaVersion: SCHEMA_VERSION },
  });
  validateV3(typed);
  return typed;
}

function validateV3(state: State): void {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new RegistryError(`Unsupported gantt-cli registry schema: ${JSON.stringify(state.schemaVersion)}.`);
  }
  if (!isObject(state.repository)
    || typeof state.repository.root !== "string"
    || typeof state.repository.commonGitDir !== "string") {
    throw new RegistryError("Registry repository metadata is malformed.");
  }
  for (const key of ["requirements", "assignments", "events"] as const) {
    if (!Array.isArray(state[key])) throw new RegistryError(`Registry ${key} must be a list.`);
  }
  for (const key of ["nextRequirementNumber", "nextAssignmentNumber", "nextEventNumber"] as const) {
    if (!Number.isInteger(state[key]) || state[key] < 1) {
      throw new RegistryError(`Registry ${key} must be a positive integer.`);
    }
  }
  const requirementIds = new Set<string>();
  for (const requirement of state.requirements) {
    if (!isObject(requirement) || typeof requirement.id !== "string" || !REQUIREMENT_ID.test(requirement.id)) {
      throw new RegistryError("Registry has a malformed requirement.");
    }
    if (requirementIds.has(requirement.id)) throw new RegistryError(`Registry duplicates requirement ID ${requirement.id}.`);
    requirementIds.add(requirement.id);
    if (typeof requirement.status !== "string" || !REQUIREMENT_STATUSES.has(requirement.status)) {
      throw new RegistryError(`Requirement ${requirement.id} has invalid status.`);
    }
    if (typeof requirement.priority !== "string" || !PRIORITY_ORDER.has(requirement.priority as "p0")
      || !Number.isInteger(requirement.points) || (requirement.points as number) < 1 || (requirement.points as number) > 100) {
      throw new RegistryError(`Requirement ${requirement.id} has invalid planning fields.`);
    }
    if (typeof requirement.request !== "string"
      || typeof requirement.createdAt !== "string"
      || typeof requirement.updatedAt !== "string") {
      throw new RegistryError(`Requirement ${requirement.id} is missing audit fields.`);
    }
    if (requirement.verify !== undefined
      && (typeof requirement.verify !== "string" || !requirement.verify.trim())) {
      throw new RegistryError(`Requirement ${requirement.id} has an invalid verification command.`);
    }
    if (![requirement.dependsOn, requirement.domains, requirement.paths].every(
      (items) => Array.isArray(items) && items.every((item) => typeof item === "string"),
    )) {
      throw new RegistryError(`Requirement ${requirement.id} has invalid claims.`);
    }
    if (!Array.isArray(requirement.stamps)) {
      throw new RegistryError(`Requirement ${requirement.id} has invalid stamps.`);
    }
  }
  for (const requirement of state.requirements) {
    if (requirement.dependsOn.includes(requirement.id)
      || requirement.dependsOn.some((id) => !requirementIds.has(id))) {
      throw new RegistryError(`Requirement ${requirement.id} has invalid dependencies.`);
    }
  }
  const assignmentIds = new Set<string>();
  for (const assignment of state.assignments) {
    if (!isObject(assignment) || typeof assignment.id !== "string" || !ASSIGNMENT_ID.test(assignment.id)) {
      throw new RegistryError("Registry has a malformed assignment.");
    }
    if (assignmentIds.has(assignment.id)) throw new RegistryError(`Registry duplicates assignment ID ${assignment.id}.`);
    assignmentIds.add(assignment.id);
    if (typeof assignment.requirementId !== "string" || !requirementIds.has(assignment.requirementId)) {
      throw new RegistryError(`Assignment ${assignment.id} references an unknown requirement.`);
    }
    if (typeof assignment.status !== "string" || !ASSIGNMENT_STATUSES.has(assignment.status)) {
      throw new RegistryError(`Assignment ${assignment.id} has invalid status.`);
    }
    for (const key of ["alias", "session", "branch", "worktree", "createdAt", "updatedAt"] as const) {
      if (typeof assignment[key] !== "string" || !assignment[key]) {
        throw new RegistryError(`Assignment ${assignment.id} is missing ${key}.`);
      }
    }
    if (assignment.status !== "legacy" && typeof assignment.baseCommit !== "string") {
      throw new RegistryError(`Assignment ${assignment.id} is missing baseCommit.`);
    }
  }
}

export function normalizeState(rawState: unknown): { state: State; migrated: boolean } {
  if (!isObject(rawState)) throw new RegistryError("gantt-cli state must contain a JSON object.");
  const version = rawState.schemaVersion ?? 1;
  if (!Number.isInteger(version)) throw new RegistryError("Registry schemaVersion must be an integer.");
  if ((version as number) > SCHEMA_VERSION) {
    throw new RegistryError(`Registry schema ${version as number} is newer than gantt-cli schema ${SCHEMA_VERSION}.`);
  }
  if ((version as number) <= 1) return { state: migrateV1(rawState), migrated: true };
  if (version === 2) return { state: migrateV2(rawState), migrated: true };
  const state = structuredClone(rawState);
  const migrated = normalizeV3InPlace(state);
  const typed = state as unknown as State;
  validateV3(typed);
  return { state: typed, migrated };
}
