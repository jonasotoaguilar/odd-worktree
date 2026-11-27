/**
 * Hook backend (S4): prefer a real host registry over patching anything.
 *
 * ⚠️  UNVERIFIED BRANCH. No host has been observed exposing
 * `globalThis[Symbol.for("gentle-pi.customize-row-providers")]`; the key arrives from the
 * verified probe notes, but its value shape does not. The bridge therefore accepts exactly two
 * shapes and reports anything else:
 *
 * - a plain `Array` — the fan-out provider is appended with `push`;
 * - an object with a callable `register` method — the provider is handed to `register(provider)`.
 *
 * Anything else (primitive, function, `null`, object without a callable `register`, or a
 * `register` getter that throws) is `unusable-hook`: the caller falls back to the capture backend
 * and diagnostics records why. It is never treated as "hooked", so a wrong guess degrades to the
 * proven path instead of silently doing nothing.
 *
 * ## Honest installation
 *
 * Success is claimed only when the provider was actually accepted: an array `push` must have added
 * it (a no-op `push` is a failure), a `register` that returns `false` is a rejection, and a throw
 * from `push`, from `register` or from the `register` getter is an `install-failed` with the
 * message recorded. Every failure falls back to capture. `acceptedProviders` counts what was
 * really accepted, so diagnostics can tell "installed" from "asked".
 *
 * ## Dedupe does not mutate the host registry
 *
 * The registry is keyed by identity in a `WeakSet` held in the process-global state, so a frozen
 * registry still receives exactly one fan-out provider across arms and package copies. A
 * non-enumerable marker is written as a best-effort second signal, never as the authority.
 *
 * When the host removes the slot, the recorded state stops counting as installed: diagnostics
 * follow the live registry rather than a stale memory of it.
 */

import type { CaptureOutcome } from "./capture.ts";
import type { CustomizeRow } from "./types.ts";
import { recordObservedHostCategories } from "./bus.ts";
import {
  buildRows,
  contextFromHost,
  isRecord,
  planRowPlacement,
  type RowBuildFailure,
} from "./rows.ts";

/** The host registry key from S4. Read only; the bridge never creates it. */
const HOOK_REGISTRY = Symbol.for("gentle-pi.customize-row-providers");
/** Best-effort non-enumerable marker on the registry: this package pushed its fan-out provider. */
const HOOK_ARMED = Symbol.for("gentle-shell-bridge.hook.armed.v1");
/** Process-global state for diagnostics, shared across package copies. */
const HOOK_STATE = Symbol.for("gentle-shell-bridge.hook.state.v1");

/** Stable id of the single provider the bridge pushes into a host registry. */
export const FAN_OUT_PROVIDER_ID = "gentle-shell-bridge";

/**
 * The provider pushed into the host registry. Its shape is a guess constrained by the unproven
 * registry: the fan-out already knows every row's category, so it carries no category of its own.
 */
export interface HookFanOutProvider {
  readonly id: string;
  rows(ctx?: unknown): CustomizeRow[];
}

export type HookShape = "array" | "register" | "unusable";

export type HookOutcome = "hooked" | "no-hook" | "unusable-hook" | "install-failed";

export interface InstallHookResult {
  /** True when the registry now holds — or already held — the bridge's fan-out provider. */
  installed: boolean;
  outcome: HookOutcome;
  shape?: HookShape;
  /** Why a present registry was not usable, or why installation failed. */
  reason?: string;
}

export interface HookDiagnostics {
  /** True only while the registry this process installed into is still the live registry. */
  installed: boolean;
  shape?: HookShape;
  lastOutcome?: HookOutcome;
  /** Why the last attempt did not succeed. */
  reason?: string;
  /** How many fan-out providers this process has actually got accepted. */
  acceptedProviders: number;
  /** Outcome of the most recent fan-out build, in the same shape the capture backend records. */
  lastCapture?: CaptureOutcome;
  /** Failures recorded during the most recent fan-out build. */
  lastFailures: RowBuildFailure[];
}

interface HookState {
  installed: boolean;
  /** Identity of the registry this process installed into. */
  installedRegistry?: object;
  /** Identity dedupe for registries that cannot be marked (frozen objects included). */
  installedRegistries: WeakSet<object>;
  shape?: HookShape;
  lastOutcome?: HookOutcome;
  reason?: string;
  acceptedProviders: number;
  lastCapture?: CaptureOutcome;
  lastFailures: RowBuildFailure[];
}

function hookHost(): Record<symbol, unknown> {
  // SAFETY: `globalThis` accepts symbol keys, and every value stored under HOOK_STATE is written
  // by `hookState()` below; a foreign value is rejected there before use.
  return globalThis as unknown as Record<symbol, unknown>;
}

function hookState(): HookState {
  const host = hookHost();
  const existing = host[HOOK_STATE];
  if (isHookState(existing)) return existing;
  const created: HookState = {
    installed: false,
    installedRegistries: new WeakSet<object>(),
    acceptedProviders: 0,
    lastFailures: [],
  };
  host[HOOK_STATE] = created;
  return created;
}

function isHookState(value: unknown): value is HookState {
  return (
    isRecord(value) &&
    typeof value.installed === "boolean" &&
    value.installedRegistries instanceof WeakSet &&
    Array.isArray(value.lastFailures)
  );
}

/** Read the host slot without letting a hostile global getter escape. */
function readRegistry(): { registry: unknown; error?: string } {
  try {
    return { registry: hookHost()[HOOK_REGISTRY] };
  } catch (error) {
    return { registry: undefined, error: errorMessage(error) };
  }
}

/** Diagnostics snapshot for `status` (S6) and for this backend's tests. */
export function getHookDiagnostics(): HookDiagnostics {
  const state = hookState();
  const { registry, error } = readRegistry();
  const installed =
    state.installed && state.installedRegistry !== undefined && registry === state.installedRegistry;
  const diagnostics: HookDiagnostics = {
    installed,
    shape: state.shape,
    lastOutcome: error === undefined ? state.lastOutcome : "unusable-hook",
    reason: error === undefined ? state.reason : error,
    acceptedProviders: state.acceptedProviders,
    lastFailures: [...state.lastFailures],
  };
  if (state.lastCapture !== undefined) diagnostics.lastCapture = state.lastCapture;
  return diagnostics;
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. The registry marker stays. */
export function resetHookStateForTests(): void {
  const state = hookState();
  state.installed = false;
  state.installedRegistry = undefined;
  state.installedRegistries = new WeakSet<object>();
  state.shape = undefined;
  state.lastOutcome = undefined;
  state.reason = undefined;
  state.acceptedProviders = 0;
  state.lastCapture = undefined;
  state.lastFailures = [];
}

/**
 * Install the fan-out provider into the host registry, if the host exposes a usable one.
 * Idempotent per registry identity: a second arm — or a second copy of this package — never pushes
 * a second provider, even when the registry cannot be marked because it is frozen.
 */
export function installHookBackend(): InstallHookResult {
  const state = hookState();
  const { registry, error } = readRegistry();

  if (error !== undefined) {
    forgetInstalled(state);
    state.lastOutcome = "unusable-hook";
    state.reason = `reading the registry slot threw: ${error}`;
    return { installed: false, outcome: "unusable-hook", reason: state.reason };
  }

  if (registry === undefined) {
    // The host removed the slot (or never had one): stop reporting the previous hook as live.
    forgetInstalled(state);
    state.shape = undefined;
    state.lastOutcome = "no-hook";
    state.reason = undefined;
    return { installed: false, outcome: "no-hook" };
  }

  const shape = classifyRegistry(registry);
  state.shape = shape;

  if (shape === "unusable") {
    forgetInstalled(state);
    state.lastOutcome = "unusable-hook";
    state.reason = describeUnusable(registry);
    return { installed: false, outcome: "unusable-hook", shape, reason: state.reason };
  }

  const target = registry as object;
  if (state.installedRegistries.has(target)) {
    state.installed = true;
    state.installedRegistry = target;
    state.lastOutcome = "hooked";
    state.reason = undefined;
    return { installed: true, outcome: "hooked", shape };
  }

  const provider = createFanOutProvider(state);
  let accepted = false;
  let reason: string | undefined;

  try {
    if (shape === "array") {
      const array = registry as unknown[];
      (array as { push: (provider: unknown) => unknown }).push(provider);
      // A no-op or lying `push` must not be mistaken for acceptance.
      accepted = Array.prototype.includes.call(registry, provider);
      if (!accepted) reason = "the registry's push did not add the provider";
    } else {
      const registered = (
        registry as { register: (provider: unknown) => unknown }
      ).register.call(registry, provider);
      accepted = registered !== false;
      if (!accepted) reason = "the registry's register returned false";
    }
  } catch (installError) {
    accepted = false;
    reason = `installing the provider threw: ${errorMessage(installError)}`;
  }

  if (!accepted) {
    forgetInstalled(state);
    state.lastOutcome = "install-failed";
    state.reason = reason ?? "the registry did not accept the provider";
    return { installed: false, outcome: "install-failed", shape, reason: state.reason };
  }

  // Identity dedupe first: a frozen registry refuses the marker, and the WeakSet is authoritative.
  state.installedRegistries.add(target);
  try {
    Object.defineProperty(target, HOOK_ARMED, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Unmarkable host object: the WeakSet above still prevents a second provider.
  }

  state.installed = true;
  state.installedRegistry = target;
  state.acceptedProviders += 1;
  state.lastOutcome = "hooked";
  state.reason = undefined;
  return { installed: true, outcome: "hooked", shape };
}

function forgetInstalled(state: HookState): void {
  state.installed = false;
  state.installedRegistry = undefined;
}

function classifyRegistry(value: unknown): HookShape {
  if (Array.isArray(value)) return "array";
  if (!isRecord(value)) return "unusable";
  try {
    return typeof value.register === "function" ? "register" : "unusable";
  } catch {
    // A throwing getter is an unusable registry, not a crash.
    return "unusable";
  }
}

function describeUnusable(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return `registry is a ${value === null ? "null" : typeof value}, not an array or a registry object`;
  }
  try {
    const register = (value as Record<string, unknown>).register;
    return typeof register === "function"
      ? "registry rejected the provider"
      : "registry object has no callable register";
  } catch (error) {
    return `reading the registry's register property threw: ${errorMessage(error)}`;
  }
}

function createFanOutProvider(state: HookState): HookFanOutProvider {
  return {
    id: FAN_OUT_PROVIDER_ID,
    rows(hostCtx?: unknown): CustomizeRow[] {
      // Same ordered snapshot and same builder as the capture backend, so `registerRows`
      // behaves identically on either backend.
      const built = buildRows(contextFromHost(hostCtx));
      // This backend never sees the host array, so it has no host categories to honour. The resolver
      // still orders each category by S2, and every `start`/`after` falls back to the end with the
      // reason `/bridge-status` reports: this backend must not claim host-relative placement (S6).
      const plan = planRowPlacement([], built.providers, built.blocks);
      recordObservedHostCategories(plan.hostCategories);
      state.lastFailures = built.failures;
      state.lastCapture = { kind: "injected", injectedRows: plan.rows.length };
      return plan.rows;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
