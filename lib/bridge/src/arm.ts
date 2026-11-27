/**
 * Arm lifecycle (S3 bullet 1, S4): one entry point that picks a backend and arms it.
 *
 * Pi keeps ONE `ctx.ui` object per runner but rebuilds it on every bind
 * (`runner.ts:895-898`, `:573`, `:577-587`), so the bridge arms from `session_start` — possibly
 * more than once per process, and against a fresh UI object each rebind. Arming is therefore
 * idempotent per UI object: the capture backend marks the target it wrapped, and the hook backend
 * marks the host registry it pushed into.
 *
 * Backend choice, in order:
 * 1. the host registry (`installHookBackend`) when it exists and its shape is usable — nothing is
 *    patched, which is the whole reason to prefer it;
 * 2. otherwise the proven capture backend. A present-but-unusable registry is reported as
 *    `fallback-capture` with `reason: "hook-unusable"` instead of being ignored.
 *
 * Nothing here runs at import time: no backend arms itself, so importing the module (or the
 * package entry that will call it) has no side effect on the host.
 */

import { disableCaptureBackend, installCaptureBackend } from "./capture.ts";
import { installHookBackend } from "./hook.ts";

/** Which interception is active after arming. */
export type ArmBackend = "hook" | "capture" | "none";

/**
 * What arming decided. `status` (S6) reports this verbatim, so every branch that ends in "no rows
 * appeared" has a name here.
 */
export type ArmOutcome =
  | "hooked"
  | "capture-armed"
  | "already-armed"
  | "fallback-capture"
  | "no-ui";

export type ArmReason = "hook-unusable" | "ui-missing" | "custom-missing";

export interface ArmResult {
  outcome: ArmOutcome;
  backend: ArmBackend;
  /** Present when nothing armed cleanly, or when arming fell back to the capture backend. */
  reason?: ArmReason;
}

/**
 * Arm the bridge against a `ctx.ui`-shaped object and report what happened. Safe to call on every
 * `session_start`, and safe to call with a missing UI context (reported, never thrown).
 */
export function armBridge(ui: unknown): ArmResult {
  const hook = installHookBackend();
  if (hook.installed) {
    // An earlier arm may have wrapped a UI object that is still live. Disable the previous path
    // before the hook becomes active, so one menu cannot receive two copies of the rows.
    disableCaptureBackend();
    return { outcome: "hooked", backend: "hook" };
  }

  // Any present-but-unusable registry, or any failed installation into one, gets the proven
  // backend rather than silence. Only "no registry at all" is a clean capture arm.
  const fallback: ArmReason | undefined = hook.outcome === "no-hook" ? undefined : "hook-unusable";
  const capture = installCaptureBackend(ui);

  if (capture.armed) {
    return fallback === undefined
      ? { outcome: "capture-armed", backend: "capture" }
      : { outcome: "fallback-capture", backend: "capture", reason: fallback };
  }

  if (capture.outcome === "already-armed") {
    return fallback === undefined
      ? { outcome: "already-armed", backend: "capture" }
      : { outcome: "already-armed", backend: "capture", reason: fallback };
  }

  // Nothing to wrap: distinguish "no UI context at all" from "a UI without a customize surface".
  const hasUi = ui !== null && typeof ui === "object";
  return {
    outcome: "no-ui",
    backend: "none",
    reason: hasUi ? "custom-missing" : "ui-missing",
  };
}
