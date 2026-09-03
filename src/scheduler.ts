import pc from "picocolors";

import {
  PRIORITY_ORDER,
  activeAssignments,
  dependenciesSatisfied,
  liveAssignmentForRequirement,
  requirementById,
  type Requirement,
  type State,
} from "./models.js";

export interface ConflictDetails { domains: string[]; paths: string[] }
export interface Conflict {
  requirementId: string;
  assignmentId: string;
  alias: string;
  status: string;
  details: ConflictDetails;
}
export interface Schedule {
  batches: { index: number; requirements: string[] }[];
  deferred: Record<string, unknown>[];
  decisions: Record<string, Record<string, unknown>>;
}

type ListLane = "ACTIVE" | "NEXT" | "QUEUED" | "WAITING" | "BLOCKED" | "CLOSED";

interface ListItem {
  requirement: Requirement;
  marker: string;
  detail: string;
}

const LIST_LANES: ListLane[] = ["ACTIVE", "NEXT", "QUEUED", "WAITING", "BLOCKED", "CLOSED"];
const LANE_STYLES: Record<ListLane, (value: string) => string> = {
  ACTIVE: pc.green,
  NEXT: pc.cyan,
  QUEUED: pc.blue,
  WAITING: pc.yellow,
  BLOCKED: pc.red,
  CLOSED: pc.gray,
};

function scopePrefix(claim: string): string {
  const positions = [..."*?["].map((marker) => claim.indexOf(marker)).filter((index) => index >= 0);
  const prefix = positions.length > 0 ? claim.slice(0, Math.min(...positions)) : claim;
  return prefix.replace(/\/$/, "");
}

function sameOrAncestor(left: string, right: string): boolean {
  return !left || left === right || right.startsWith(`${left}/`);
}

export function pathClaimsConflict(left: string, right: string): boolean {
  const leftScope = scopePrefix(left);
  const rightScope = scopePrefix(right);
  return sameOrAncestor(leftScope, rightScope) || sameOrAncestor(rightScope, leftScope);
}

export function claimConflictDetails(first: Requirement, second: Requirement): ConflictDetails {
  const secondDomains = new Set(second.domains);
  const domains = [...new Set(first.domains.filter((domain) => secondDomains.has(domain)))].sort();
  const paths = [...new Set(first.paths.flatMap((left) => second.paths
    .filter((right) => pathClaimsConflict(left, right))
    .map((right) => `${left} ↔ ${right}`)))].sort();
  return { domains, paths };
}

export function requirementsConflict(first: Requirement, second: Requirement): boolean {
  const details = claimConflictDetails(first, second);
  return details.domains.length > 0 || details.paths.length > 0;
}

export function activeConflicts(state: State, requirement: Requirement): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const assignment of activeAssignments(state)) {
    if (assignment.requirementId === requirement.id) continue;
    const other = requirementById(state, assignment.requirementId);
    const details = claimConflictDetails(requirement, other);
    if (details.domains.length > 0 || details.paths.length > 0) {
      conflicts.push({
        requirementId: other.id,
        assignmentId: assignment.id,
        alias: assignment.alias,
        status: assignment.status,
        details,
      });
    }
  }
  return conflicts;
}

function compareRequirements(first: Requirement, second: Requirement): number {
  const firstPriority = PRIORITY_ORDER.get(first.priority as "p0" | "p1" | "p2" | "p3") ?? 99;
  const secondPriority = PRIORITY_ORDER.get(second.priority as "p0" | "p1" | "p2" | "p3") ?? 99;
  return firstPriority - secondPriority
    || first.points - second.points
    || first.createdAt.localeCompare(second.createdAt)
    || first.id.localeCompare(second.id);
}

export function buildSchedule(state: State): Schedule {
  const candidates: Requirement[] = [];
  const deferred: { requirement: Requirement; decision: Record<string, unknown> }[] = [];
  const decisions: Record<string, Record<string, unknown>> = {};

  for (const requirement of state.requirements) {
    if (requirement.status !== "ready") continue;
    const dependencies = dependenciesSatisfied(state, requirement);
    if (!dependencies.satisfied) {
      const decision = { kind: "deferred", reason: "dependencies", dependencies: dependencies.outstanding };
      deferred.push({ requirement, decision });
      decisions[requirement.id] = decision;
      continue;
    }
    const conflicts = activeConflicts(state, requirement);
    if (conflicts.length > 0) {
      const decision = { kind: "deferred", reason: "active_claims", conflicts };
      deferred.push({ requirement, decision });
      decisions[requirement.id] = decision;
      continue;
    }
    candidates.push(requirement);
  }

  const batches: Requirement[][] = [];
  for (const requirement of candidates.sort(compareRequirements)) {
    let index = batches.findIndex((batch) => !batch.some((existing) => requirementsConflict(requirement, existing)));
    if (index === -1) {
      index = batches.length;
      batches.push([]);
    }
    batches[index]?.push(requirement);
    decisions[requirement.id] = { kind: "batch", batch: index };
  }
  return {
    batches: batches.map((batch, index) => ({ index, requirements: batch.map((item) => item.id) })),
    deferred: deferred.sort((first, second) => compareRequirements(first.requirement, second.requirement))
      .map(({ requirement, decision }) => ({ requirementId: requirement.id, ...decision })),
    decisions,
  };
}

export function requirementView(state: State, requirement: Requirement, schedule = buildSchedule(state)) {
  return {
    ...requirement,
    assignment: liveAssignmentForRequirement(state, requirement.id) ?? null,
    schedule: schedule.decisions[requirement.id] ?? null,
  };
}

export function isGlob(path: string): boolean {
  return [..."*?["].some((marker) => path.includes(marker));
}

function escapeRegex(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globRegex(pattern: string): RegExp {
  const pieces = ["^"];
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index] as string;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 2;
        if (pattern[index] === "/") {
          pieces.push("(?:.*/)?");
          index += 1;
        } else {
          pieces.push(".*");
        }
        continue;
      }
      pieces.push("[^/]*");
    } else if (character === "?") {
      pieces.push("[^/]");
    } else if (character === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing === -1) {
        pieces.push("\\[");
      } else {
        let content = pattern.slice(index + 1, closing);
        if (content.startsWith("!")) content = `^${content.slice(1)}`;
        pieces.push(`[${content.replaceAll("\\", "\\\\")}]`);
        index = closing;
      }
    } else {
      pieces.push(escapeRegex(character));
    }
    index += 1;
  }
  pieces.push("$");
  return new RegExp(pieces.join(""));
}

export function pathClaimCoversPath(claim: string, changedPath: string): boolean {
  if (isGlob(claim)) {
    try {
      return globRegex(claim).test(changedPath);
    } catch {
      return false;
    }
  }
  return changedPath === claim || changedPath.startsWith(`${claim}/`);
}

export function outOfScopePaths(requirement: Requirement, changedPaths: string[]): string[] {
  return changedPaths.filter(
    (changedPath) => !requirement.paths.some((claim) => pathClaimCoversPath(claim, changedPath)),
  );
}

export function renderSchedule(state: State): string {
  const plan = buildSchedule(state);
  if (state.requirements.length === 0) return "No requirements registered.";
  const lines = ["Gantt batches (requirements in the same batch may run in parallel)"];
  if (plan.batches.length > 0) {
    for (const batch of plan.batches) {
      const summaries = batch.requirements.map((identifier) => {
        const requirement = requirementById(state, identifier);
        return `${identifier} [${requirement.priority}, ${requirement.points}pt]`;
      });
      lines.push(`batch ${String(batch.index).padEnd(2)} | ${summaries.join("  ")}`);
    }
  } else {
    lines.push("(no startable requirements)");
  }
  if (plan.deferred.length > 0) {
    lines.push("", "Deferred");
    for (const item of plan.deferred) {
      const identifier = String(item.requirementId);
      if (item.reason === "dependencies") {
        lines.push(`${identifier}: waiting for ${(item.dependencies as string[]).join(", ")}`);
      } else {
        const blockers = (item.conflicts as Conflict[])
          .map((conflict) => `${conflict.requirementId}/${conflict.assignmentId}`).join(", ");
        lines.push(`${identifier}: conflicts with active ${blockers}`);
      }
    }
  }
  const inactive = state.requirements.filter((requirement) => requirement.status !== "ready");
  if (inactive.length > 0) {
    lines.push("", "Not scheduled");
    for (const requirement of inactive) lines.push(`${requirement.id}: ${requirement.status}`);
  }
  return lines.join("\n");
}

function styledPriority(priority: string): string {
  if (priority === "p0") return pc.bold(pc.red(priority));
  if (priority === "p1") return pc.yellow(priority);
  if (priority === "p2") return pc.cyan(priority);
  return pc.gray(priority);
}

function waitingDetail(decision: Record<string, unknown>): string {
  if (decision.reason === "dependencies" && Array.isArray(decision.dependencies)) {
    return `waits for ${decision.dependencies.join(", ")}`;
  }
  if (decision.reason === "active_claims" && Array.isArray(decision.conflicts)) {
    const blockers = (decision.conflicts as Conflict[])
      .map((conflict) => `${conflict.requirementId}/${conflict.assignmentId}`).join(", ");
    return `conflicts with active ${blockers}`;
  }
  return "waiting";
}

export function renderList(state: State): string {
  if (state.requirements.length === 0) return "No requirements registered.";
  const schedule = buildSchedule(state);
  const lanes: Record<ListLane, ListItem[]> = {
    ACTIVE: [], NEXT: [], QUEUED: [], WAITING: [], BLOCKED: [], CLOSED: [],
  };

  for (const requirement of state.requirements) {
    const assignment = liveAssignmentForRequirement(state, requirement.id);
    const decision = schedule.decisions[requirement.id];
    if (requirement.status === "active") {
      lanes.ACTIVE.push({
        requirement,
        marker: "▶",
        detail: assignment ? `${assignment.alias} · ${assignment.status}` : "active",
      });
    } else if (requirement.status === "blocked") {
      const reason = typeof requirement.blockedReason === "string" ? requirement.blockedReason : "blocked";
      lanes.BLOCKED.push({ requirement, marker: "!", detail: reason });
    } else if (requirement.status === "ready" && decision?.kind === "batch") {
      const batch = Number(decision.batch);
      const lane = batch === 0 ? "NEXT" : "QUEUED";
      lanes[lane].push({ requirement, marker: batch === 0 ? "●" : "○", detail: `batch ${batch}` });
    } else if (requirement.status === "ready" && decision?.kind === "deferred") {
      lanes.WAITING.push({ requirement, marker: "◌", detail: waitingDetail(decision) });
    } else {
      const reason = typeof requirement.deprecationReason === "string" ? ` · ${requirement.deprecationReason}` : "";
      lanes.CLOSED.push({
        requirement,
        marker: requirement.status === "done" ? "✓" : "×",
        detail: `${requirement.status}${reason}`,
      });
    }
  }

  const lines = [`Gantt · ${state.requirements.length} requirements`];
  for (const lane of LIST_LANES) {
    const items = lanes[lane];
    if (items.length === 0) continue;
    const style = LANE_STYLES[lane];
    lines.push("", pc.bold(style(`${lane.padEnd(8)} ${items.length}`)));
    for (const item of items) {
      lines.push(`  ${style(item.marker)} ${pc.bold(item.requirement.id)}  ${item.requirement.request}`);
      lines.push(`    ${styledPriority(item.requirement.priority)} · ${item.requirement.points}pt · ${pc.dim(item.detail)}`);
    }
  }
  return lines.join("\n");
}
