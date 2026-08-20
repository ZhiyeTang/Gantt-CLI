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

Use \`npx gantt-cli@next\` for the commands below; the \`npx\` prefix and \`@next\` tag are optional when this alpha is installed globally.

When a user introduces an implementation requirement:
1. Identify its repository-relative path scope and logical domains.
2. Run \`npx gantt-cli@next add --request <verbatim-user-request> --path <scope> [--domain <domain>] [--verify <command>]\`.
3. Read \`npx gantt-cli@next schedule --json\`; start only a requirement in the first batch unless the user authorizes \`--force\`.
4. Run \`npx gantt-cli@next start REQ-XXXX --session <current-session-id> --alias <name> --json\`, then edit only the returned worktree.
5. Commit there, then run \`npx gantt-cli@next merge REQ-XXXX\` → \`npx gantt-cli@next cleanup REQ-XXXX\` → \`npx gantt-cli@next done REQ-XXXX\` from the primary worktree.
6. Use \`block\`, \`unblock\`, and \`abandon\` for interruptions; use \`repair\` for retained provisioning failures and \`doctor\` for consistency checks.

Completion criterion: the Requirement status is \`done\`; a commit or chat claim alone is incomplete.
`;

const MANAGED_BLOCK = `${START_MARKER}
## gantt-cli

Implementation work in this repository: before editing files, run \`npx gantt-cli@next agent-instructions\` and follow the returned workflow until the Requirement is \`done\`.
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
