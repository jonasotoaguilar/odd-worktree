/**
 * The diagnostics channel Pi actually owns: `ctx.ui.notify`, never stdout/stderr.
 *
 * Pi renders its diagnostics inside the TUI (its startup report lists `[Ext]`, `[Skill warnings]`,
 * …). An extension that writes to the console instead puts that text in the terminal *around*
 * Pi's startup, before the TUI takes the screen, where it is easy to miss and impossible to read
 * after the fact. So this module is the only place a bridge problem is reported out of band:
 *
 * - a message produced while a context exists is shown with `ctx.ui.notify(message, level)`;
 * - a message produced before any context exists (module load) is buffered
 *   here and flushed ONCE on the first `session_start` that has a UI;
 * - every message stays in the buffer afterwards, so `/bridge-status` still answers "what went
 *   wrong?" long after the notification scrolled away.
 *
 * The buffer is process-global for the same reason the bus is (`./bus.ts`): Pi loads every
 * extension through its own loader with `moduleCache: false`, so module scope is per-copy. It is
 * bounded, so a plugin that reports the same problem on every call cannot grow it without limit,
 * and identical `message` + `level` pairs are recorded once — a repeated warning is the same fact.
 */

/** The levels Pi's `notify` accepts. Every bridge notice is a problem report: default `warning`. */
export type NoticeLevel = "info" | "warning" | "error";

export interface NoticeEntry {
  message: string;
  level: NoticeLevel;
  /** `true` once `notify` accepted it; a delivered notice is never delivered twice. */
  emitted: boolean;
}

export interface NoticeSnapshot {
  entries: NoticeEntry[];
  /** Messages the bound had to evict before they were ever reported, so the loss stays visible. */
  dropped: number;
}

interface NoticeState {
  entries: NoticeEntry[];
  dropped: number;
}

/** How many notices are kept for `/bridge-status`. */
export const MAX_NOTICES = 20;

/**
 * Stable process-global slot. `v1` is part of the key for the same reason as the API symbol: a
 * future shape change takes a new key instead of mutating this one.
 */
const NOTICES_KEY: symbol = Symbol.for("gentle-shell-bridge/notices/v1");

function noticesHost(): Record<symbol, NoticeState | undefined> {
  // SAFETY: this module is the only writer of the slot, and `noticeState()` re-checks the shape
  // before trusting a value left by another copy or an older load.
  return globalThis as unknown as Record<symbol, NoticeState | undefined>;
}

/** The process-global notice state, created on first use; a foreign value is replaced. */
function noticeState(): NoticeState {
  const host = noticesHost();
  const existing = host[NOTICES_KEY];
  if (existing !== undefined && Array.isArray(existing.entries)) {
    if (typeof existing.dropped !== "number") existing.dropped = 0;
    return existing;
  }
  const created: NoticeState = { entries: [], dropped: 0 };
  host[NOTICES_KEY] = created;
  return created;
}

/**
 * Record one message for the TUI and for `/bridge-status`.
 *
 * Identical `message` + `level` pairs are recorded once. When the bound is reached the oldest
 * already-delivered entry is evicted first, so a message the user has not been shown yet is not
 * the one that goes; only when every entry is still pending is one dropped (and counted).
 */
export function recordNotice(message: string, level: NoticeLevel = "warning"): void {
  const text = message.trim();
  if (text === "") return;
  const state = noticeState();
  if (state.entries.some((entry) => entry.message === text && entry.level === level)) return;

  if (state.entries.length >= MAX_NOTICES) {
    const delivered = state.entries.findIndex((entry) => entry.emitted);
    if (delivered >= 0) state.entries.splice(delivered, 1);
    else {
      state.entries.shift();
      state.dropped += 1;
    }
  }
  state.entries.push({ message: text, level, emitted: false });
}

/**
 * Deliver every pending notice through `ui.notify`, once.
 *
 * A context without a `notify` (or without a UI at all) delivers nothing and marks nothing, so the
 * message waits for the next `session_start` that can show it. A `notify` that throws leaves that
 * message pending and keeps the rest of the list intact — a broken UI must not lose diagnostics.
 * Returns how many notices this call delivered.
 */
export function flushNotices(ui: unknown): number {
  if (typeof ui !== "object" || ui === null) return 0;
  const notify = (ui as { notify?: unknown }).notify;
  if (typeof notify !== "function") return 0;

  let delivered = 0;
  for (const entry of noticeState().entries) {
    if (entry.emitted) continue;
    try {
      // `this` matters: Pi's notify is a method on the UI context.
      (notify as (message: string, level?: NoticeLevel) => void).call(ui, entry.message, entry.level);
      entry.emitted = true;
      delivered += 1;
    } catch {
      // Leave it pending: the next session_start retries, and /bridge-status keeps reporting it.
    }
  }
  return delivered;
}

/** A copy of the buffer, for `/bridge-status`; callers can never mutate the live state. */
export function snapshotNotices(): NoticeSnapshot {
  const state = noticeState();
  return {
    entries: state.entries.map((entry) => ({ ...entry })),
    dropped: state.dropped,
  };
}

/**
 * Test-only seam: forget every buffered notice. The extension never calls this; a delivered
 * message is kept for `/bridge-status` for the life of the process.
 */
export function resetNoticesForTests(): void {
  delete noticesHost()[NOTICES_KEY];
}
