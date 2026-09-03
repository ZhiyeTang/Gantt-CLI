import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { RegistryError, ValidationError } from "./errors.js";
import {
  PHASE_ARCHIVE_SCHEMA_VERSION,
  normalizePhaseId,
  parsePhaseArchive,
  type PhaseArchive,
  type State,
} from "./models.js";

const PHASE_DIRECTORY = /^PHASE-\d{3,}$/;

export interface PhaseArtifacts {
  archive: PhaseArchive;
  summary: string;
  archiveHash: string;
  summaryHash: string;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function phaseFingerprint(
  state: Pick<State, "repository" | "requirements" | "assignments" | "events">,
  phaseId: string,
): string {
  return sha256(JSON.stringify({
    phaseId,
    repository: state.repository,
    requirements: state.requirements,
    assignments: state.assignments,
    events: state.events,
  }));
}

export function phaseArchive(state: State, phaseId: string, archivedAt: string, fingerprint: string): PhaseArchive {
  return {
    schemaVersion: PHASE_ARCHIVE_SCHEMA_VERSION,
    phaseId,
    archivedAt,
    fingerprint,
    repository: structuredClone(state.repository),
    requirements: structuredClone(state.requirements),
    assignments: structuredClone(state.assignments),
    events: structuredClone(state.events),
  };
}

function normalizedSummary(raw: string): string {
  if (!raw.trim()) throw new ValidationError("Phase summary must contain non-whitespace Markdown.");
  if (raw.includes("\0")) throw new ValidationError("Phase summary cannot contain NUL bytes.");
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

export class PhaseStore {
  readonly directory: string;

  constructor(registryDirectory: string) {
    this.directory = join(registryDirectory, "phases");
  }

  phaseDirectory(rawId: string): string {
    return join(this.directory, normalizePhaseId(rawId));
  }

  write(archive: PhaseArchive, rawSummary: string): PhaseArtifacts & { recovered: boolean } {
    const phaseId = normalizePhaseId(archive.phaseId);
    const summary = normalizedSummary(rawSummary);
    const archiveContents = `${JSON.stringify(archive, null, 2)}\n`;
    const expected = {
      archiveHash: sha256(archiveContents),
      summaryHash: sha256(summary),
    };
    const finalDirectory = this.phaseDirectory(phaseId);
    if (existsSync(finalDirectory)) {
      const current = this.read(phaseId);
      if (current.archive.fingerprint !== archive.fingerprint
        || phaseFingerprint(current.archive, phaseId) !== archive.fingerprint
        || current.summaryHash !== expected.summaryHash) {
        throw new RegistryError(`Phase directory already exists with different contents: ${finalDirectory}`);
      }
      return { ...current, recovered: true };
    }

    mkdirSync(this.directory, { recursive: true });
    const temporary = join(this.directory, `.${phaseId}.${process.pid}.${Date.now()}.tmp`);
    try {
      mkdirSync(temporary);
      writeFileSync(join(temporary, "archive.json"), archiveContents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      writeFileSync(join(temporary, "summary.md"), summary, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, finalDirectory);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw new RegistryError(`Could not write ${phaseId}: ${(error as Error).message}`);
    }
    return { archive, summary, ...expected, recovered: false };
  }

  read(rawId: string): PhaseArtifacts {
    const phaseId = normalizePhaseId(rawId);
    const directory = this.phaseDirectory(phaseId);
    const archivePath = join(directory, "archive.json");
    const summaryPath = join(directory, "summary.md");
    try {
      const directoryMetadata = lstatSync(directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        throw new RegistryError(`Phase path is not a regular directory: ${directory}`);
      }
      for (const path of [archivePath, summaryPath]) {
        const metadata = lstatSync(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new RegistryError(`Phase artifact is not a regular file: ${path}`);
        }
      }
      const archiveContents = readFileSync(archivePath, "utf8");
      const summary = readFileSync(summaryPath, "utf8");
      const archive = parsePhaseArchive(JSON.parse(archiveContents));
      if (archive.phaseId !== phaseId) {
        throw new RegistryError(`Phase directory ${phaseId} contains archive for ${archive.phaseId}.`);
      }
      if (!summary.trim()) throw new RegistryError(`Phase summary is empty: ${summaryPath}`);
      return {
        archive,
        summary,
        archiveHash: sha256(archiveContents),
        summaryHash: sha256(summary),
      };
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      throw new RegistryError(`Could not read ${phaseId}: ${(error as Error).message}`);
    }
  }

  directoryIds(): string[] {
    if (!existsSync(this.directory)) return [];
    try {
      return readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && PHASE_DIRECTORY.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      throw new RegistryError(`Could not list phase archives: ${(error as Error).message}`);
    }
  }
}
