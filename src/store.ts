import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { RegistryError } from "./errors.js";
import type { State } from "./models.js";
import { initialState, normalizeState, utcNow } from "./models.js";

export class Registry {
  readonly directory: string;
  readonly path: string;
  readonly legacyPath: string;
  readonly lockDirectory: string;

  constructor(commonGitDirectory: string) {
    this.directory = join(commonGitDirectory, "gantt-cli");
    this.path = join(this.directory, "state.json");
    this.legacyPath = join(this.directory, "registry.json");
    this.lockDirectory = join(this.directory, "state.lock.d");
  }

  initialize(repositoryRoot: string, commonGitDirectory: string): { state: State; created: boolean } {
    return this.locked(() => {
      if (existsSync(this.path) || existsSync(this.legacyPath)) return { state: this.read(), created: false };
      const state = initialState(repositoryRoot, commonGitDirectory);
      this.write(state);
      return { state, created: true };
    });
  }

  read(): State {
    const source = existsSync(this.path) ? this.path : this.legacyPath;
    try {
      const normalized = normalizeState(JSON.parse(readFileSync(source, "utf8")));
      if (normalized.migrated || source !== this.path) this.write(normalized.state);
      return normalized.state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RegistryError("gantt-cli is not initialized for this repository. Run `gantt-cli init` first.");
      }
      throw new RegistryError(`Could not read gantt-cli state: ${(error as Error).message}`);
    }
  }

  write(state: State): void {
    mkdirSync(dirname(this.path), { recursive: true });
    state.updatedAt = utcNow();
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
      throw new RegistryError(`Could not write gantt-cli state: ${(error as Error).message}`);
    }
  }

  locked<T>(callback: () => T): T {
    mkdirSync(this.directory, { recursive: true });
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ownerPath = join(this.lockDirectory, "owner.json");
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        mkdirSync(this.lockDirectory);
        writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token }));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new RegistryError(`Could not acquire gantt-cli state lock: ${(error as Error).message}`);
        }
        this.recoverDeadLock();
        if (Date.now() >= deadline) throw new RegistryError("Timed out waiting for the gantt-cli state lock.");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      return callback();
    } finally {
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { token?: string };
        if (owner.token === token) rmSync(this.lockDirectory, { recursive: true, force: true });
      } catch {
        // A missing lock means recovery already released it; never remove a lock now owned by another process.
      }
    }
  }

  private recoverDeadLock(): void {
    const ownerPath = join(this.lockDirectory, "owner.json");
    let pid: number | undefined;
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown };
      if (typeof owner.pid === "number" && Number.isInteger(owner.pid)) pid = owner.pid;
    } catch {
      try {
        if (Date.now() - statSync(this.lockDirectory).mtimeMs < 2_000) return;
      } catch {
        return;
      }
    }
    if (pid === undefined) {
      try {
        if (Date.now() - statSync(this.lockDirectory).mtimeMs < 2_000) return;
      } catch {
        return;
      }
    }
    if (pid !== undefined) {
      try {
        process.kill(pid, 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      }
    }
    const stale = `${this.lockDirectory}.stale-${process.pid}-${Date.now()}`;
    try {
      renameSync(this.lockDirectory, stale);
      rmSync(stale, { recursive: true, force: true });
    } catch (error) {
      if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}
