/**
 * The shell API's programmatic entry point.
 *
 * odd-worktree's own extension entry (`extensions/odd-worktree-tools.ts`, the `pi.extensions`
 * manifest entry) imports `./extension.ts`, which publishes the runtime handshake and arms the shell
 * surfaces; these sources are the published artifact: there is no build step and no `dist/`. This
 * module is the API surface for plugins: rows, sidebar sections, card styles, transcript transforms,
 * per-tool card DESIGNS (one registration point for `pi.registerToolRenderer`) with the read-only
 * reader that answers which design a tool draws right now, per-message card DESIGNS beside them (one
 * registration point for a custom message's rows, `pi.registerMessageRenderer`'s `customType`) with
 * the same kind of reader for a message, the active card-style selection a design — or a plugin
 * outside one — honours (`resolveCardStyleSelection`), the optional store and the runtime handshake
 * (`bridgeApi`, `onBridgeApi`, the announcement event). A message design rewrites the rows the host's
 * own renderer drew, or owns the box when the type has no renderer at all, and a type nobody claimed
 * is never touched. Backend internals — the capture patch, the hook registry, the arm
 * lifecycle, the rail interception, the section renderer, the card-style line and transformer, the
 * transform pipeline and the bus snapshots — are reached through the extension entry, not
 * re-exported here. docs/shell-api/contract.md's Limits section is explicit about which names are the
 * contract.
 *
 * Importing this module also publishes the runtime handshake (`./api.ts`), the channel a plugin
 * uses when it does not import the package at all. A plugin that does import it calls
 * `bridgeApi()` from its `session_start` handler — the object, or `undefined` when the bridge is
 * not installed — or `onBridgeApi(handler, pi.events)`, which is the same answer plus the
 * announcement form: the handler runs immediately when the object is already published, and when
 * it is not, it runs when the bridge announces itself. There is no holding area either way.
 */
export {
  BRIDGE_READY_EVENT,
  VERSION,
  bridgeApi,
  isBridgeApi,
  onBridgeApi,
} from "./api.ts";
export type {
  BridgeApi,
  BridgeApiHandler,
  BridgeEventBus,
  BridgeEventUnsubscribe,
  BridgeReadyPayload,
} from "./api.ts";
export { registerCardStyle, registerRows, registerSection, registerTransform } from "./bus.ts";
export { registerToolDesign, resolveToolDesignSelection } from "./tool-designs.ts";
export {
  registerMessageDesign,
  resolveMessageDesignFollow,
  resolveMessageDesignSelection,
} from "./message-designs.ts";
export { resolveCardStyleSelection } from "./card-styles.ts";
export type { MessageDesignSelection } from "./message-designs.ts";
export type { ToolDesignSelection } from "./tool-designs.ts";
export { createStore, STORE_SCHEMA_VERSION } from "./store.ts";
export type { Store, StoreProblem, StoreProblemKind } from "./store.ts";
export type {
  CardFrame,
  CardFrameBottomContext,
  CardFrameLineContext,
  CardFrameTopContext,
  CardStyleRegistration,
  CardStyleSelection,
  CustomizeRow,
  InlineHelpers,
  MessageDesignContext,
  MessageDesignFollow,
  MessageDesignFollowAnswer,
  MessageDesignRegistration,
  MessageDesignRender,
  RowChoice,
  RowContext,
  RowLabel,
  RowOrigin,
  RowPreview,
  RowProvider,
  SectionContext,
  SectionLine,
  SectionPlacement,
  SectionRow,
  SidebarSection,
  Tone,
  ToolDesignCall,
  ToolDesignContext,
  ToolDesignRender,
  ToolDesignRegistration,
  ToolDesignScope,
  TransformContext,
  TransformCounts,
  TranscriptTransform,
} from "./types.ts";
