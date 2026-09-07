import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { ValidationError } from "./errors.js";

const START_MARKER = "<!-- gantt-cli:instructions:start -->";
const END_MARKER = "<!-- gantt-cli:instructions:end -->";

export const AGENT_INSTRUCTIONS = `Agent integration contract

Use \`npx gantt-cli@latest\` for the commands below; the \`npx\` prefix and \`@latest\` tag are optional when this alpha is installed globally.

Before editing, classify the work and briefly state your reasoning. Bounded, low-risk work with a direct verification path is lightweight: complete it inline without registering a Requirement or creating a worktree. File count is not a threshold. Inspect the initial Git diff and local files so you can distinguish existing work from your task changes.

If collaboration, dependency coordination, or isolated experimentation becomes necessary, upgrade automatically and preserve existing work: register the task, create its worktree, transfer only this task's changes, verify the transferred contents, then remove only the matching task changes from the original checkout. Preserve unrelated edits. If ownership is ambiguous, keep the original files and explain the ambiguity. A blanket stash, reset, or clean is not a transfer procedure.

For managed work:
1. Identify repository-relative paths and logical domains. Run \`npx gantt-cli@latest add --request <verbatim-user-request> --path <scope> [--domain <domain>] [--verify <command>]\`.
2. Read \`npx gantt-cli@latest schedule --json\`. For overlapping work, record a plan with \`coordinate --plan-file <json-file>\`: participating requirements, each member's division of work, merge order, and integrated verification. The Agent may authorize this coordination without asking the user each time; uncoordinated claims and real dependencies still block.
3. Run \`npx gantt-cli@latest start REQ-XXXX --session <current-session-id> --alias <name> --json\`, then work in the returned worktree.
4. Commit deliverables. For local configuration and non-delivery files, including ignored files, run \`classify REQ-XXXX --path <file-or-directory> --reason <why-this-is-not-a-deliverable>\`. Classification covers current files only. Commit new source files instead of classifying them to evade delivery.
5. Run \`npx gantt-cli@latest finish REQ-XXXX --json\`. It merges, verifies, preserves classified files outside the worktree, cleans up, and records done. Read returned preservation paths. On failure, follow nextAction, fix the reported problem, and rerun finish. For a Git conflict, resolve it in the reported target worktree and continue Git's merge before retrying. For failed verification, fix and commit in the retained task worktree.
6. After finish, the branch may be retained or deleted; cleanup never deletes it automatically. Low-level merge and cleanup are for diagnosis and repair, not a required command chain.
7. Use \`block\` and \`unblock\` for temporary blockers. Use \`release\` for interrupted work; recover its retained work or classify remaining files and run \`discard <assignment-id>\`.
8. Use \`deprecate REQ-XXXX --reason <reason>\` only when the Requirement will never be delivered. Resolve non-terminal dependents and retained worktrees first.
9. Use \`repair\` for retained provisioning failures and \`doctor\` for consistency checks.

Phase archival is user-triggered, never automatic. When the user asks to archive and every current Requirement is \`done\` or \`deprecated\`, run \`archive --prepare --json\`, inspect the listed commit history, write a non-empty Markdown summary, then finalize with the returned fingerprint and \`--summary-file\`. Historical Phase data is immutable.

For managed work, completion criterion: the Requirement status is \`done\`; a commit or chat claim alone is incomplete.
`;

const MANAGED_BLOCK = `${START_MARKER}
## gantt-cli

Before implementation, run \`npx gantt-cli@latest agent-instructions\` and choose inline or managed work according to its criteria. Inline work needs no registration; managed work follows the returned workflow until \`done\`.
${END_MARKER}`;

function nextContents(existing: string): string {
  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new ValidationError(
      "AGENTS.md has an incomplete gantt-cli managed block; repair its instruction markers before retrying.",
    );
  }
  if (start !== -1) {
    if (existing.indexOf(START_MARKER, start + START_MARKER.length) !== -1
      || existing.indexOf(END_MARKER, end + END_MARKER.length) !== -1) {
      throw new ValidationError(
        "AGENTS.md has multiple gantt-cli managed blocks; keep one block before retrying.",
      );
    }
    return `${existing.slice(0, start)}${MANAGED_BLOCK}${existing.slice(end + END_MARKER.length)}`;
  }
  if (!existing) return `${MANAGED_BLOCK}\n`;
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${MANAGED_BLOCK}\n`;
}

export function installAgentInstructions(repositoryRoot: string): { path: string; changed: boolean } {
  const path = join(repositoryRoot, "AGENTS.md");
  let existing = "";
  let mode = 0o644;
  if (existsSync(path)) {
    try {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new ValidationError("Refusing to update a symlinked AGENTS.md.");
      }
      if (!metadata.isFile()) throw new ValidationError("AGENTS.md exists but is not a regular file.");
      existing = readFileSync(path, "utf8");
      mode = metadata.mode & 0o777;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError(`Could not read AGENTS.md: ${(error as Error).message}`);
    }
  }
  const updated = nextContents(existing);
  if (updated === existing) return { path, changed: false };

  const temporary = join(repositoryRoot, `.AGENTS.md.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, updated, { encoding: "utf8", mode });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new ValidationError(`Could not update AGENTS.md: ${(error as Error).message}`);
  }
  return { path, changed: true };
}
