/**
 * Optional namespaced store (S5, S8; docs/state.md).
 *
 * `<bridge config home>/<pluginId>.json`, one file per plugin, written atomically. The bridge
 * composes rows; it does not own preferences, so this is a convenience for a plugin that has no
 * file of its own. `registerRows` never reads or writes these files.
 *
 * Document shape:
 *
 * ```json
 * { "schemaVersion": 1, "values": { "bannerSource": "output" } }
 * ```
 *
 * `values` is an envelope so a plugin key can never collide with `schemaVersion`.
 *
 * Malformed files: a file that is not valid JSON, does not parse to an object, or carries an
 * unknown `schemaVersion` is reported through `status`, never repaired and never deleted. Reads
 * fall back to the caller's default.
 *
 * A later `set` writes a valid `schemaVersion: 1` document. Existing `values` are carried forward
 * ONLY when the file was a usable `schemaVersion: 1` document, so a partially written file keeps
 * its other keys. For an unknown `schemaVersion` the write stores only the keys the caller sets —
 * re-labelling a future payload as schema 1 would be a lie about its format — and the discarded
 * payload is recorded as a store problem so `/bridge-status` shows what happened. Foreign
 * top-level keys are always dropped, because the bridge cannot know what they mean.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getBridgeConfigHome } from "./config.ts";
import { isRecord } from "./rows.ts";

/** Current document schema, an integer so a later shape change can migrate. */
export const STORE_SCHEMA_VERSION = 1;

export type StoreProblemKind =
  | "invalid-json"
  | "not-an-object"
  | "unsupported-schema-version"
  | "unreadable";

/** A store file the bridge could not use, surfaced by `status` (S6). */
export interface StoreProblem {
  pluginId: string;
  path: string;
  kind: StoreProblemKind;
  message: string;
}

/** One plugin's file. Every accessor is scoped to that file. */
export interface Store {
  readonly pluginId: string;
  readonly path: string;
  /** The stored value, or `fallback` when the key is absent or the file is unusable. */
  get<T>(key: string, fallback: T): T;
  /** Persist one key atomically. Throws before writing if the value is not JSON-serialisable. */
  set(key: string, value: unknown): void;
}

const STORE_STATE = Symbol.for("gentle-shell-bridge.store.state.v1");

interface StoreState {
  /** Latest problem per plugin id, in first-report order. */
  problems: StoreProblem[];
}

function storeHost(): Record<symbol, unknown> {
  // SAFETY: `globalThis` accepts symbol keys, and the only write to this slot is `storeState()`
  // below; a foreign value is rejected there before use.
  return globalThis as unknown as Record<symbol, unknown>;
}

function storeState(): StoreState {
  const host = storeHost();
  const existing = host[STORE_STATE];
  if (isStoreState(existing)) return existing;
  const created: StoreState = { problems: [] };
  host[STORE_STATE] = created;
  return created;
}

function isStoreState(value: unknown): value is StoreState {
  return isRecord(value) && Array.isArray(value.problems);
}

/** Problems from the most recent read or write of each store file. */
export function getStoreDiagnostics(): StoreProblem[] {
  return storeState().problems.map((problem) => ({ ...problem }));
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetStoreStateForTests(): void {
  storeState().problems = [];
}

function recordProblem(problem: StoreProblem): void {
  const state = storeState();
  const index = state.problems.findIndex((existing) => existing.pluginId === problem.pluginId);
  if (index === -1) state.problems.push(problem);
  else state.problems[index] = problem;
}

function clearProblem(pluginId: string): void {
  const state = storeState();
  state.problems = state.problems.filter((problem) => problem.pluginId !== pluginId);
}

/**
 * Create the store for one plugin. The id is validated before any filesystem access: it must be a
 * non-empty single path segment, so it can never name a file outside the bridge directory.
 * Invalid ids throw; they are never silently sanitised.
 */
export function createStore(pluginId: string): Store {
  const path = resolveStorePath(pluginId);

  return {
    pluginId,
    path,
    get<T>(key: string, fallback: T): T {
      const read = readValues(pluginId, path);
      if (read.problem !== undefined) {
        // An unusable file reads as empty. Its `values` are kept only so a later `set` can carry
        // them over — an unknown or future schema must never serve foreign data to the caller.
        // A reported problem stays on record until a write resolves it, so a read of a usable
        // file cannot silently erase what `/bridge-status` is supposed to show.
        recordProblem(read.problem);
        return fallback;
      }
      return Object.hasOwn(read.values, key) ? (read.values[key] as T) : fallback;
    },
    set(key: string, value: unknown): void {
      const read = readValues(pluginId, path);
      // Serialise before touching the disk so an unserialisable value cannot truncate the file.
      const document = {
        schemaVersion: STORE_SCHEMA_VERSION,
        // Only a usable schema-1 document contributes existing values to the write.
        values: { ...(read.carriesValues ? read.values : {}), [key]: value },
      };
      const serialised = `${JSON.stringify(document, null, 2)}\n`;

      mkdirSync(dirname(path), { recursive: true });
      const tempPath = `${path}.${process.pid}.${Date.now().toString(36)}.${writeCounter++}.tmp`;
      try {
        writeFileSync(tempPath, serialised, "utf8");
        // Same directory, so the rename is atomic on one filesystem.
        renameSync(tempPath, path);
      } catch (error) {
        // Never leave a partial temp file behind if the rename failed.
        try {
          unlinkSync(tempPath);
        } catch {
          // Already renamed, or never created: nothing to clean.
        }
        throw error;
      }
      if (
        !read.carriesValues &&
        read.problem !== undefined &&
        read.problem.kind === "unsupported-schema-version"
      ) {
        // The write dropped a payload the bridge could not interpret; keep that fact visible.
        recordProblem({
          ...read.problem,
          message: `${read.problem.message}; its payload was discarded by this write, which stored only the keys set afterwards`,
        });
      } else {
        clearProblem(pluginId);
      }
    },
  };
}

let writeCounter = 0;

function resolveStorePath(pluginId: string): string {
  const reject = (reason: string): never => {
    throw new Error(
      `gentle-shell-bridge: invalid plugin id ${JSON.stringify(pluginId)}: ${reason}. ` +
        "A plugin id must be one non-empty path segment (no separators, no '.' or '..').",
    );
  };

  if (typeof pluginId !== "string" || pluginId.length === 0) reject("it is empty");
  if (pluginId.includes("\0")) reject("it contains a NUL byte");
  if (pluginId === "." || pluginId === "..") reject("it is a directory reference");
  if (pluginId.includes("/") || pluginId.includes("\\")) reject("it contains a path separator");
  if (pluginId.includes("..")) reject("it contains '..'");

  const directory = getBridgeConfigHome();
  const path = join(directory, `${pluginId}.json`);
  // Defence in depth: even a future id rule cannot place the file outside the bridge directory.
  if (dirname(path) !== directory) reject("it resolves outside the bridge directory");
  return path;
}

interface ReadResult {
  values: Record<string, unknown>;
  /** Existing values may be carried into a write: only for a usable `schemaVersion: 1` document. */
  carriesValues: boolean;
  problem?: StoreProblem;
}

function readValues(pluginId: string, path: string): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { values: {}, carriesValues: false };
    return {
      values: {},
      carriesValues: false,
      problem: {
        pluginId,
        path,
        kind: "unreadable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      values: {},
      carriesValues: false,
      problem: {
        pluginId,
        path,
        kind: "invalid-json",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (!isRecord(parsed)) {
    return {
      values: {},
      carriesValues: false,
      problem: { pluginId, path, kind: "not-an-object", message: "document is not a JSON object" },
    };
  }

  if (parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
    return {
      // An unknown schema's payload is NOT carried forward: the bridge cannot know its meaning,
      // so a write must not re-label it as schema 1. It is reported instead (see `set`).
      values: {},
      carriesValues: false,
      problem: {
        pluginId,
        path,
        kind: "unsupported-schema-version",
        message: `schemaVersion is ${String(parsed.schemaVersion)}, expected ${STORE_SCHEMA_VERSION}`,
      },
    };
  }

  if (!isRecord(parsed.values)) {
    return {
      values: {},
      carriesValues: false,
      problem: {
        pluginId,
        path,
        kind: "not-an-object",
        message: "schemaVersion is 1 but values is not an object",
      },
    };
  }

  return { values: parsed.values, carriesValues: true };
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
