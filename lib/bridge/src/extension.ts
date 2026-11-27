/**
 * The extension entry Pi loads (`pi.extensions` in package.json).
 *
 * Four responsibilities, no more:
 * 1. publish the runtime handshake and announce it. Importing `./api.ts` publishes the frozen API
 *    object at `Symbol.for("gentle-shell-bridge/api/v1")` at module load, before any
 *    `session_start`, so a plugin that registers from its own `session_start` handler finds the
 *    object or learns the bridge is absent. When Pi loads the plugin BEFORE this package — the
 *    real TUI order — an absent symbol is only "not yet", so the factory also announces the
 *    publication on `pi.events` (`gentle-shell-bridge:ready`), once per process and never for an
 *    incompatible slot (`announceBridgeReady`). A plugin therefore needs no path, no environment
 *    variable and no import.
 * 2. arm the row bridge on `session_start`, only when the context has a UI AND the required host
 *    package `gentle-pi` is present at RUNTIME (`pi.getCommands()` names `gentle:customize`, see
 *    `./presence.ts`). Arming is already idempotent (the capture target and the hook registry carry
 *    non-enumerable markers), so this module adds no second guard layer: a double load, a `/reload`
 *    or a rebind all resolve to "already armed". The same event flushes the notices buffered before
 *    any context existed through `ctx.ui.notify` — the in-TUI channel — exactly once per message.
 *    Without `gentle-pi` the bridge arms NOTHING, delivers one warning naming the package and stays
 *    quiet on later events while the absence lasts (S9, T12): the check runs before any arming.
 * 3. install the sidebar surface: the `Sections` rows provider (needs no `tui`) and a
 *    `ui.setWidget` factory whose only job is to be handed the real `tui` (see `armSidebar`).
 * 4. register the `status` command and print the formatter output.
 *
 * The API surface used here was confirmed against `docs/extensions.md`: `pi.on("session_start",
 * async (_event, ctx) => …)`, `pi.registerCommand(name, { description, handler })` with
 * `ctx.ui.notify(message, level)` inside the handler, and `ctx.ui.setWidget(key, (tui, theme) =>
 * Component)` — the only documented way an extension receives a `tui`.
 *
 * At import time the only global write is the API publication above: no arming, no registration,
 * no command.
 */

import { armBridge } from "./arm.ts";
import { announceBridgeReady, publishBridgeApi, type BridgeEventBus } from "./api.ts";
import { flushNotices } from "./notices.ts";
import { checkGentlePi, warnMissingGentlePi } from "./presence.ts";
import { isRecord } from "./rows.ts";
import { installCardStyleRows } from "./card-style-rows.ts";
import { installCardStyleTransform, installRailCardStyleTransform } from "./card-style-wiring.ts";
import { installSectionRows } from "./sections-rows.ts";
import { setSectionTheme } from "./section-panel.ts";
import { installSidebarBackend, noteSidebarUnavailable, type SidebarTuiLike } from "./sidebar.ts";
import { setRepaintHost } from "./repaint.ts";
import { clearPluginStatus, installPluginStatus } from "./plugin-lines.ts";
import { installSectionRail } from "./sidebar-render.ts";
import { installMessageDesignRows } from "./message-design-rows.ts";
import { installToolDesignRows } from "./tool-design-rows.ts";
import { installToolDesignResolver, type ToolDesignResolver } from "./tool-design-wiring.ts";
import { collectStatus, formatStatus } from "./status.ts";

/**
 * Command name. Pi has no built-in `/status` (verified against `docs/slash-commands.md`), and
 * gentle-shell owns the `gentle:` prefix, so a bare `bridge-status` cannot collide with either
 * while staying one short token in Pi's command menu.
 */
export const STATUS_COMMAND = "bridge-status";

/** The part of the session context this extension reads. */
export interface BridgeSessionContext {
  hasUI?: boolean;
  ui?: unknown;
}

/** The part of the command context this extension reads. */
export interface BridgeCommandContext {
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

export type BridgeSessionHandler = (event: unknown, ctx: BridgeSessionContext) => unknown;
export type BridgeCommandHandler = (args: string, ctx: BridgeCommandContext) => unknown;

/** Key of the widget whose only purpose is to receive the host's `tui`. */
export const SIDEBAR_WIDGET_KEY = "gentle-shell-bridge.sidebar";

/** What one sidebar wiring attempt achieved (also reported by `/bridge-status`). */
export type SidebarArmOutcome =
  | "widget-installed"
  | "awaiting-factory"
  | "no-set-widget"
  | "set-widget-threw";

export interface SidebarArmResult {
  outcome: SidebarArmOutcome;
  /** Present when nothing could be installed. */
  reason?: string;
}

/** The `ctx.ui` members this module reads. */
interface BridgeUiSurface {
  setWidget?: (key: string, factory: (tui: unknown, theme: unknown) => unknown) => void;
}

/**
 * Reach the sidebar rail through Pi's one documented hand-out of a `tui`.
 *
 * Pi has no `tui` getter (`ExtensionUIContext` in `dist/core/extensions/types.d.ts` exposes `TUI` only
 * as a factory parameter), and gentle-shell itself obtains one the same way
 * (`extensions/gentle-agents.ts:2165-2175`). So: register a widget factory, keep the `tui` it
 * receives, and return a component that renders NO rows.
 *
 * UNCONFIRMED: whether a widget whose component renders zero rows leaves the editor area visually
 * untouched has not been observed in a real Pi TUI. It is the reason this component paints nothing
 * at all rather than a small marker.
 *
 * Failure paths are reported, never thrown: a missing `setWidget` or a factory the host never runs
 * records `no-widget-surface` for `/bridge-status`, and the row side keeps working.
 */
export function armSidebar(ui: unknown): SidebarArmResult {
  let captured: SidebarTuiLike | undefined;
  try {
    // Reading `setWidget` can itself throw (a getter on the host's UI object), so the whole
    // acquisition happens inside this guard: a broken accessor must never escape the session
    // handler and take the row side with it.
    const surface = isRecord(ui) ? (ui as BridgeUiSurface) : undefined;
    const setWidget = surface?.setWidget;
    if (surface === undefined || typeof setWidget !== "function") {
      noteSidebarUnavailable("ctx.ui has no setWidget, so a tui cannot be acquired");
      return { outcome: "no-set-widget" };
    }

    // `this` matters: Pi's setWidget is a method on the UI context.
    //
    // The factory's SECOND argument is Pi's theme (`dist/core/extensions/types.d.ts:113`: `(tui:
    // theme) => Component`), the same documented hand-out gentle-shell's own parts take their theme
    // from. The bridge keeps it so a section header and its rows paint in the host's roles instead
    // of the terminal's defaults (N11); without it the drawing is uncoloured and `/bridge-status`
    // says so.
    setWidget.call(surface, SIDEBAR_WIDGET_KEY, (tui: unknown, theme?: unknown) => {
      captured = isRecord(tui) ? (tui as SidebarTuiLike) : undefined;
      setSectionTheme(theme);
      // The renderer and the interception are installed from inside the factory: that is the first
      // moment a `tui` exists, and the resolver keeps working for a later re-install.
      installSectionRail();
      installSidebarBackend(() => captured);
      // The same hand-out is the only way to the conversation component (S4) and to the rail
      // component (R1), so both card-style wrappers arm here too — never at module load, never twice
      // (their marker decides), and every absence is a reported outcome instead of a throw inside
      // the host's factory. The captured `tui` is also what a bridge-owned write asks for a frame
      // through (R3), so it is remembered first: a later rail attach (the fullscreen layout may not
      // be mounted yet) reads it from there.
      setRepaintHost(captured);
      installCardStyleTransform(captured);
      installRailCardStyleTransform(captured);
      return { render: () => [], invalidate: () => {} };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    noteSidebarUnavailable(`setWidget threw: ${reason}`);
    return { outcome: "set-widget-threw", reason };
  }

  if (captured === undefined) {
    // The host accepted the factory but has not run it yet: there is nothing to intercept until it
    // does, and the reason is recorded instead of guessed.
    noteSidebarUnavailable("the setWidget factory has not run yet, so no tui is available");
    return { outcome: "awaiting-factory" };
  }
  return { outcome: "widget-installed" };
}

/** One entry of Pi's command list, as this module reads it: only the name is ever inspected. */
export interface BridgeCommandEntry {
  readonly name?: string;
}

/**
 * Pi's command list (`pi.getCommands()`). The host is a TRUST BOUNDARY: `./presence.ts` re-validates
 * every shape (a non-array answer, an entry without a name, a throwing accessor), so nothing here
 * relies on the declared type being honoured.
 */
export type BridgeCommandList = readonly BridgeCommandEntry[];

/** The part of Pi's `ExtensionAPI` this extension uses. */
export interface BridgeExtensionApi {
  on(event: "session_start" | "session_shutdown", handler: BridgeSessionHandler): void;
  registerCommand(
    name: string,
    command: { description?: string; handler: BridgeCommandHandler },
  ): void;
  /**
   * Pi's command list (`docs/extensions.md`): the runtime evidence of which extensions are loaded.
   * The bridge reads it for the REQUIRED host package (S9): an entry named `gentle:customize` means
   * `gentle-pi` is there. Optional, because a bare harness may expose no command surface at all —
   * which is MISSING, not an error.
   */
  getCommands?(): BridgeCommandList;
  /** Pi's cross-extension bus (`docs/extensions.md:1965-1972`); absent only in a bare harness. */
  events?: BridgeEventBus;
  /**
   * Pi's tool-renderer hook (`docs/extensions.md:2123`;
   * `dist/core/extensions/types.d.ts:546`): the sanctioned way to choose how a tool's card is drawn.
   * Optional, so a bare harness stays a valid host — a missing hook is a reported outcome, never a
   * throw inside `session_start`.
   */
  registerToolRenderer?(resolver: ToolDesignResolver): void;
}

export default function gentleShellBridge(pi: BridgeExtensionApi): void {
  // The module load above already published the object; this factory is the first moment `pi` —
  // and therefore `pi.events` — exists, so it is where the process is told. Both calls are
  // idempotent: publishing again hands back the slot's object, and the announcement happens once
  // per process even when two copies of this package are loaded.
  publishBridgeApi();
  announceBridgeReady(pi.events);

  pi.on("session_start", (_event, ctx) => {
    // Without a UI there is no customize menu to reach, so there is nothing to arm. There is also
    // no `notify` to show a buffered notice with: those stay pending for the next UI session.
    if (ctx.hasUI !== true) return;

    // S9/T12 — the REQUIRED host package, checked at RUNTIME and BEFORE anything is armed. Every
    // extension is loaded before `session_start`, so this answer is real; the check runs again on
    // every later event, which is how a host that appears late is picked up (and how a host that
    // disappears again is reported). `checkGentlePi` records the answer for `/bridge-status` and
    // decides the warning budget; a disabled bridge warns once per absence and then stays silent.
    const presence = checkGentlePi(pi);
    // The in-TUI diagnostics channel. A notice produced at module load (an incompatible API slot)
    // has been waiting for this moment; delivered notices stay in the buffer, so `/bridge-status`
    // keeps reporting them afterwards.
    flushNotices(ctx.ui);
    if (!presence.present) {
      // Nothing below this line runs: no capture, no rows, no resolver, no widget, no footer line
      // (S9). The one warning names the missing package; the reason rides with it.
      if (presence.warnNow) {
        warnMissingGentlePi(ctx.ui, presence.reason ?? "the host does not advertise gentle-pi");
      }
      return;
    }
    armBridge(ctx.ui);
    // The `Sections` provider needs no `tui`, so it is installed even when the rail cannot be
    // reached: the user can still see and toggle a section. Re-installing is idempotent — the bus
    // replaces a provider with the same id in place.
    installSectionRows();
    // The card-style fallback line needs no `tui`: it is the bridge's own `Bridge card style` line,
    // registered only while the host's own line cannot be extended (the capture decides that, and
    // disposes this provider the moment it extends the host's line instead).
    installCardStyleRows();
    // The per-tool DESIGN bus (S4, S5, S7), at this same arming point:
    //
    // - the customize rows need no `tui`, so they are installed here like every other row surface;
    // - the ONE `pi.registerToolRenderer` resolver is installed here too, and nowhere else. Pi
    //   resolves renderers when it CONSTRUCTS a card, so this is early enough for every card of the
    //   session; returning `next()` composes with gentle-shell instead of replacing it. Both calls
    //   are idempotent through process-global markers, so a second load or a rebind registers
    //   neither twice.
    installToolDesignRows();
    installToolDesignResolver(pi);
    // The MESSAGE-design lines, at this same arming point and for the same reason: the rows need
    // no `tui`, and a design registered later shows up on the next menu build. Installing twice is
    // a no-op through a process-global marker.
    installMessageDesignRows();
    armSidebar(ctx.ui);
    // The ONE INTEGRATIONS line each plugin gets (I1–I6). A plugin that registered before any `ui`
    // existed is painted here; a plugin that registers later repaints its own key in place. A host
    // whose `ctx.ui` has no `setStatus` is recorded as unavailable instead of throwing (I6).
    installPluginStatus(ctx.ui);
  });

  // The footer row is session state, like everything the bridge paints: the host is told to drop
  // every key this module set (`undefined`) before the next bind, and the records survive so the
  // next `session_start` paints the same keys again (I5).
  pi.on("session_shutdown", () => {
    clearPluginStatus();
  });

  pi.registerCommand(STATUS_COMMAND, {
    description: "Show gentle-shell-bridge providers, backend, capture, store and plugin line diagnostics",
    handler: (_args, ctx) => {
      const report = formatStatus(collectStatus()).join("\n");
      ctx.ui?.notify?.(report, "info");
    },
  });
}
