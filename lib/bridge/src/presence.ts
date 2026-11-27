/**
 * T12/S9 — runtime presence of the REQUIRED host package, `gentle-pi`.
 *
 * The bridge exists to feed gentle-pi's `/gentle:customize` surface, so without gentle-pi it has
 * nothing to feed: no rows, no sections, no card styles, no tool designs, no wrappers. The answer is
 * never read from disk — a path can name one checkout on one machine — and never from
 * `gentle-pi.card-style`, which `setCardStyle` writes lazily (its absence proves nothing).
 *
 * The sanctioned runtime check is `pi.getCommands()` including the command gentle-pi registers:
 * gentle-shell itself asks the same question the same way
 * (`extensions/gentle-design.ts:137`, `extensions/gentle-guide.ts:62`). Every extension is loaded
 * before Pi fires `session_start`, so that event is the first moment the answer is real, and it is
 * asked again on every later `session_start` so a host that appears late is picked up.
 *
 * ## The three things this module owns
 *
 * 1. **The predicate** (`hasGentlePi`): true only for a command list that names
 *    `gentle:customize`. A missing `getCommands`, a throwing one, a non-array result, an entry
 *    without a name and an unrelated list all mean MISSING. It never throws: a broken host must not
 *    take the session handler with it.
 * 2. **The process-global record** (`getGentlePiPresence`): what `/bridge-status` reports. It is
 *    `undefined` until the first check, so a report for a process that never ran a session keeps its
 *    historical output byte for byte. The slot is keyed by a `Symbol.for` for the same reason as the
 *    bus and the notice buffer: Pi loads every extension with `moduleCache: false`, so module scope
 *    is per-copy while the answer belongs to the process.
 * 3. **The warning budget** (`checkGentlePi`): ONE `ctx.ui.notify` warning per absence, and a fresh
 *    one if the host disappears again after having been present. Repeated `session_start` events for
 *    the same absence deliver nothing, so a re-bind cannot spam the user.
 *
 * Nothing here arms or disarms anything: the extension decides what to do with the answer, and the
 * disabled path simply never reaches the arming code.
 */

/** The command `gentle-pi` registers; its presence in `pi.getCommands()` is the runtime answer. */
export const GENTLE_PI_COMMAND = "gentle:customize";

/**
 * Why a host does not count as gentle-pi. The text is user-facing (it is the tail of
 * `gentle-pi: missing — <reason>` and of the warning), so it names what was actually observed.
 */
export type GentlePiAbsenceReason =
  | "the host has no getCommands()"
  | "getCommands() returned no command list"
  | `getCommands() threw: ${string}`
  | `getCommands() lists no ${typeof GENTLE_PI_COMMAND}`;

/** The verdict, with the reason carried only when the host is missing. */
export type GentlePiPresence =
  | { present: true }
  | { present: false; reason: GentlePiAbsenceReason };

/** What one check concluded, and whether it owes the one warning for a new absence. */
export interface GentlePiCheck {
  present: boolean;
  /** Present only when missing: why the host does not count as gentle-pi. */
  reason?: GentlePiAbsenceReason;
  /**
   * `true` exactly for the check that STARTS an absence. The caller delivers the one warning when it
   * is `true` and stays silent otherwise, so repeated `session_start` events cannot repeat it while a
   * later disappearance does warn again.
   */
  warnNow: boolean;
}

/** The record `/bridge-status` reports; see `getGentlePiPresence`. */
export interface GentlePiPresenceRecord {
  present: boolean;
  /** Present only when missing. */
  reason?: GentlePiAbsenceReason;
}

/** The process-global slot. `v1` is part of the key, like the API, the bus and the notice buffer. */
const PRESENCE_KEY: symbol = Symbol.for("gentle-shell-bridge/presence/v1");

interface PresenceState {
  /** `false` until the first check, which is why the report has no presence line before then. */
  checked: boolean;
  present: boolean;
  reason?: GentlePiAbsenceReason;
  /** An absence warning is outstanding: one per absence, re-armed by a present check. */
  warningOutstanding: boolean;
}

function presenceHost(): Record<symbol, PresenceState | undefined> {
  // SAFETY: this module is the only writer of the slot, and `presenceState()` re-checks the shape
  // before trusting a value left by another copy or an older load.
  return globalThis as unknown as Record<symbol, PresenceState | undefined>;
}

/** The process-global state, created on first use; a foreign value is replaced. */
function presenceState(): PresenceState {
  const host = presenceHost();
  const existing = host[PRESENCE_KEY];
  if (
    existing !== undefined &&
    typeof existing.checked === "boolean" &&
    typeof existing.present === "boolean" &&
    typeof existing.warningOutstanding === "boolean"
  ) {
    return existing;
  }
  const created: PresenceState = { checked: false, present: false, warningOutstanding: false };
  host[PRESENCE_KEY] = created;
  return created;
}

/** The message of a thrown value, without trusting it to be an `Error`. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "an unprintable error";
  }
}

/** The `name` of one command entry, or `undefined` when the entry has none (or reading it throws). */
function commandName(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  try {
    const name = (entry as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined; // a non-string name is "no name"
  } catch {
    return undefined; // a throwing accessor is "no name", never a crash
  }
}

/** The command list `pi.getCommands()` returned, or why there is none. */
function readCommands(
  pi: unknown,
): { kind: "listed"; commands: readonly unknown[] } | { kind: "absent"; reason: GentlePiAbsenceReason } {
  if (typeof pi !== "object" || pi === null) {
    return { kind: "absent", reason: "the host has no getCommands()" };
  }
  let member: unknown;
  try {
    member = (pi as { getCommands?: unknown }).getCommands;
  } catch (error) {
    // Reading the accessor is the host's code too: it is reported like a throwing call.
    return { kind: "absent", reason: `getCommands() threw: ${messageOf(error)}` };
  }
  if (typeof member !== "function") {
    return { kind: "absent", reason: "the host has no getCommands()" };
  }
  let value: unknown;
  try {
    // `this` matters: `getCommands` is a method on Pi's extension API.
    value = (member as () => unknown).call(pi);
  } catch (error) {
    return { kind: "absent", reason: `getCommands() threw: ${messageOf(error)}` };
  }
  if (!Array.isArray(value)) {
    return { kind: "absent", reason: "getCommands() returned no command list" };
  }
  return { kind: "listed", commands: value };
}

/**
 * The presence verdict for this host, right now.
 *
 * True only when `pi.getCommands()` is an array with an entry whose `name` is exactly
 * `gentle:customize`. Every other shape — no member, a non-function member, a throw, a non-array
 * result, an entry without a name, a non-string name — is MISSING. Never throws.
 */
export function gentlePiPresence(pi: unknown): GentlePiPresence {
  const read = readCommands(pi);
  if (read.kind === "absent") return { present: false, reason: read.reason };
  for (const command of read.commands) {
    if (commandName(command) === GENTLE_PI_COMMAND) return { present: true };
  }
  return { present: false, reason: `getCommands() lists no ${GENTLE_PI_COMMAND}` };
}

/** The runtime predicate (S9). `true` only when the host advertises gentle-pi's command. */
export function hasGentlePi(pi: unknown): boolean {
  return gentlePiPresence(pi).present;
}

/**
 * Ask the host, record the answer in the process-global slot and decide the warning budget.
 *
 * This is the function `session_start` calls. It arms nothing and notifies nothing: the caller owns
 * the UI, and `warnNow` keeps the one-warning-per-absence rule in the process, not in one copy of the
 * module or one session handler.
 */
export function checkGentlePi(pi: unknown): GentlePiCheck {
  const verdict = gentlePiPresence(pi);
  const state = presenceState();
  state.checked = true;
  state.present = verdict.present;
  if (verdict.present) {
    state.reason = undefined;
    // The next absence is a NEW absence and owes its own warning.
    state.warningOutstanding = false;
    return { present: true, warnNow: false };
  }
  state.reason = verdict.reason;
  const warnNow = !state.warningOutstanding;
  state.warningOutstanding = true;
  return { present: false, reason: verdict.reason, warnNow };
}

/**
 * What the last check concluded, or `undefined` when no check has run in this process.
 *
 * `undefined` is the whole reason `/bridge-status` keeps its historical output for a process that
 * never reached `session_start`: no check, no presence line.
 */
export function getGentlePiPresence(): GentlePiPresenceRecord | undefined {
  const state = presenceState();
  if (!state.checked) return undefined;
  return state.present ? { present: true } : { present: false, reason: state.reason };
}

/** The one warning text, so the test and the report can quote what the user was shown. */
export function missingGentlePiWarning(reason: GentlePiAbsenceReason | string): string {
  return (
    `gentle-pi is missing (${reason}). gentle-shell-bridge requires gentle-pi — the package that ` +
    "registers /gentle:customize — so the bridge is disabled: no rows, no sections, no card " +
    "styles and no tool designs are armed until gentle-pi is installed."
  );
}

/**
 * Deliver the one warning for a new absence through `ctx.ui.notify`.
 *
 * Returns whether the message was handed to a UI. A context without `notify` (or with one that
 * throws) is a reported `false`, never an exception inside Pi's event handler: the absence is still
 * recorded, so `/bridge-status` answers the question even when the terminal never showed it.
 */
export function warnMissingGentlePi(ui: unknown, reason: GentlePiAbsenceReason | string): boolean {
  if (typeof ui !== "object" || ui === null) return false;
  let notify: unknown;
  try {
    notify = (ui as { notify?: unknown }).notify;
  } catch {
    return false;
  }
  if (typeof notify !== "function") return false;
  try {
    // `this` matters: Pi's notify is a method on the UI context.
    (notify as (message: string, level?: "warning") => void).call(
      ui,
      missingGentlePiWarning(reason),
      "warning",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Test-only seam: forget the process-global record and the warning budget. The extension never calls
 * this — a presence answer is a fact about the process, not per-session state.
 */
export function resetPresenceForTests(): void {
  delete presenceHost()[PRESENCE_KEY];
}
