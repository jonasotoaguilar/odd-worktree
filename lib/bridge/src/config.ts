/**
 * Resolution of gentle-shell's config home, mirroring how the host resolves its own files
 * (`lib/gentle-shell-bundled.ts:231-239`): `GENTLE_PI_CONFIG_HOME` when set and non-empty,
 * else `<home>/.pi/gentle-ai`.
 *
 * The core resolver is pure: it takes the environment, the home directory and the working
 * directory as parameters, so it is testable without touching `process.env`. `getConfigHome`
 * is the thin wrapper that reads the live process.
 *
 * Path rules, settled here because the host leaves them to `path` semantics:
 * - Only the empty string counts as "unset". Values are not trimmed; a whitespace-only value
 *   is a non-empty path and is used as given.
 * - `~` and a leading `~/` are expanded against the supplied home directory. Any other
 *   leading `~` (another user's home) is left literal, since resolving another user's home
 *   is not something the bridge can do without inventing a lookup.
 * - After expansion a relative value is resolved against the supplied working directory, so
 *   the result is always absolute and normalized (no `.`/`..` segments, no doubled or
 *   trailing separators).
 */

import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/** Name of the directory the bridge owns inside the gentle-shell config home. */
export const BRIDGE_DIR_NAME = "gentle-shell-bridge";

/** Environment shape the resolver needs; `process.env` satisfies it structurally. */
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

export interface ResolveConfigHomeInput {
  /** Environment to read `GENTLE_PI_CONFIG_HOME` from. */
  env: ConfigEnv;
  /** Home directory used for `~` expansion and for the default value. */
  homeDir: string;
  /** Working directory used to make a relative override absolute. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * `GENTLE_PI_CONFIG_HOME` when set and non-empty, else `<homeDir>/.pi/gentle-ai`.
 * Always absolute and normalized.
 */
export function resolveConfigHome(input: ResolveConfigHomeInput): string {
  const configured = input.env.GENTLE_PI_CONFIG_HOME;
  const cwd = input.cwd ?? process.cwd();
  if (configured === undefined || configured === "") {
    return resolvePath(input.homeDir, ".pi", "gentle-ai");
  }
  return resolvePath(cwd, expandTilde(configured, input.homeDir));
}

/** The bridge's own directory inside a resolved config home. */
export function resolveBridgeConfigHome(configHome: string): string {
  return join(configHome, BRIDGE_DIR_NAME);
}

/** Reads the live process environment and home directory. */
export function getConfigHome(): string {
  return resolveConfigHome({ env: process.env, homeDir: homedir() });
}

/** `<config home>/gentle-shell-bridge` for the live process. */
export function getBridgeConfigHome(): string {
  return resolveBridgeConfigHome(getConfigHome());
}

function expandTilde(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}
