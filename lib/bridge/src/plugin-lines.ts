/**
 * The INTEGRATIONS line (I1–I7): exactly one footer row per plugin that registers with this bridge.
 *
 * Pi renders an extension's own `ctx.ui.setStatus(key, text)` map: a row is the WHOLE opaque status
 * string the extension set (`extensions/gentle-shell.ts:357-385`, `lib/shell-bar.ts:289-298`). So a
 * plugin that contributes ten rows, sections, styles and transforms still gets ONE line here — this
 * module owns that line, and the plugin never writes one.
 *
 * ## Attribution without configuration (I2, I8, I11)
 *
 * A registration arrives through `./bus.ts`, which captures the calling module from the stack ONCE
 * per registration: the first frame outside this package's `src/`. That module is then resolved to
 * its owning package by walking up from its directory to the nearest `package.json` with a non-empty
 * `name`, and BOTH that answer and the plugin IDENTITY it implies are cached per module — a
 * plugin's second registration costs one map lookup, never another stack walk or disk read. The
 * identity is the package root, or the registering module when no package owns it (I8); the record,
 * and the footer key, are keyed from it, never from a display name (I10).
 *
 * Four outcomes:
 *
 * - **a package** other than this one: a plugin. Its display name is derived from the package name.
 * - **this package**: plumbing, not a plugin. The bridge's own providers, sections and fallbacks
 *   never claim a footer row.
 * - **no owning package** (a single copied file, e.g. `~/.pi/agent/extensions/foo.ts`): FAIL CLOSED.
 *   No line is set, and `/bridge-status` says why. The only way such a module gets a line is the
 *   author naming it explicitly, which is not an invented name.
 * - **the Pi distribution** (I11): the package that owns the running `pi` entry point, or one whose
 *   manifest declares the `pi` executable, is never a plugin identity. A shared extensions
 *   directory inside the Pi installation therefore fails closed exactly like an unattributable
 *   module, and only an explicit name gives it a row.
 *
 * ## The name (I3, I9)
 *
 * The name obeys the same shape rule as every other row name (`./row-names.ts`): one to three plain
 * words with no arrow, colon, dot, pipe, slash or bracket. A derived name is cleaned from the
 * package name — scope dropped, separators and marks become word breaks, the first word capitalised,
 * clamped to three words — so a derived name can never break the rule; when nothing usable is left,
 * the plugin gets no line. An EXPLICIT name is validated, never rewritten: a rejected name produces
 * no line at all, never a rejected name in the footer.
 *
 * An explicit name is STICKY for the identity: the first registration that declares one fixes the
 * name for the identity's single row, and later registrations inherit it whether or not they repeat
 * it. A later DIFFERENT name never creates a second row and never renames: the first name stands and
 * the conflict is reported in `/bridge-status`. That is deliberate — a name is attribution, not
 * mutable state, and a rename ships as an edit plus `/reload`, a new registration lifetime.
 *
 * ## The state (I4)
 *
 * `ready` is derived, never promised: one rejected registration — an invalid id, a row label that
 * broke the shape rule — and the same key is repainted as `degraded`. `/bridge-status` names the
 * rejected items.
 *
 * ## The lifecycle (I5, I6)
 *
 * The line is painted when the plugin first registers, or on `session_start` when the registration
 * happened before any `ctx.ui` existed; every later change repaints the SAME key, so the host updates
 * one row in place. `session_shutdown` clears each painted key with `undefined`. A `ctx.ui` without
 * `setStatus` (a fake, a different host) makes this whole feature a reported no-op: nothing here may
 * throw into a plugin's registration path.
 *
 * ## What the row is, and is not
 *
 * The text is OPAQUE to the host: it is rendered as one string, its ANSI sequences are stripped
 * (`lib/shell-bar.ts:151-155`) and it is painted with the host's own status role. So the bridge puts
 * any glyph INSIDE the text (`Name · ready`), never in colour: colour belongs to the host.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_ROW_NAME_WORDS,
  getRowNameRejections,
  rowNameProblem,
  type RowNameRejection,
  type RowNameSurface,
} from "./row-names.ts";

/** Prefix every key this module writes carries; the host's own keys can never match it. */
export const PLUGIN_LINE_PREFIX = "gentle-shell-bridge.plugin.";

/**
 * Keys gentle-shell paints itself and removes from INTEGRATIONS (`extensions/gentle-shell.ts:357-385`):
 * `gentle-fast` and `gentle-jobs` are filtered out of the list, `gentle:mode` and `gentle:yolo` are
 * shown as the permissions row instead. Reusing one would make a plugin's line disappear or be
 * re-read as a permission mode, so the bridge's prefix is deliberately disjoint from all four.
 */
export const HOST_OWN_STATUS_KEYS: readonly string[] = [
  "gentle-fast",
  "gentle-jobs",
  "gentle:mode",
  "gentle:yolo",
];

/** Which surface a plugin registered. Diagnostics only: the footer never shows it. */
export type PluginSurface =
  | "rows"
  | "section"
  | "card style"
  | "transform"
  | "tool design"
  | "message design";

/** One registration the bridge refused, reported by `/bridge-status` (I4). */
export interface PluginRejection {
  surface: PluginSurface;
  /** The registration's id as the author wrote it, for finding the call. */
  id: string;
  reason: string;
}

/** A later registration that declared a different name for an identity whose name was fixed (I9). */
export interface PluginNameConflict {
  surface: PluginSurface;
  id: string;
  /** The later declaration; reported, never applied. */
  name: string;
  /** The name the identity already had, kept for the whole registration lifetime. */
  kept: string;
}

/** One plugin, as `/bridge-status` lists it and as the footer line holds it. */
export interface PluginLineRecord {
  /** The footer key: stable for the plugin's lifetime, never shown to the user. */
  key: string;
  /** The row text's name, when one could be derived or was given explicitly. */
  name?: string;
  nameSource?: "derived" | "explicit";
  /** The owning package's `name`, when there is one. Diagnostics. */
  packageName?: string;
  /** The module that registered. Diagnostics — never a row name (I2). */
  modulePath: string;
  status: "ready" | "degraded";
  accepted: number;
  rejected: PluginRejection[];
  /** Later registrations that declared a different name; the first name was kept (I9). */
  nameConflicts: PluginNameConflict[];
  /** What the bridge last did with the key: painted, cleared with `undefined`, or never set. */
  line: "set" | "not-set" | "cleared";
  /** Only when `line` is not `set`: why the row is absent. */
  reason?: string;
}

export interface PluginLineReport {
  availability: "installed" | "not-armed" | "unavailable";
  /** Only when the feature could not be installed: the host shape that was missing. */
  reason?: string;
  plugins: PluginLineRecord[];
}

type Owner =
  | { kind: "package"; root: string; name: string; modulePath: string }
  | { kind: "pi"; root: string; name: string; modulePath: string }
  | { kind: "module"; modulePath: string }
  | { kind: "bridge" };

type Attribution =
  | (Extract<Owner, { kind: "package" | "pi" | "module" }> & { identity: PluginIdentity })
  | Extract<Owner, { kind: "bridge" }>;

/**
 * What a plugin IS (I8, I10): its owning package root, or the registering module when no package
 * owns it. Resolved once per module and cached with the attribution; the row key hashes THIS, never
 * the display name, so renaming never produces a second key.
 */
interface PluginIdentity {
  /** `pkg:<root>` or `mod:<module>`: the record a registration joins. */
  id: string;
  /** The raw seed the key is hashed from: the package root or the module path. */
  seed: string;
}

/** The parts of a `package.json` attribution needs. */
interface PackageManifest {
  name: string;
  /** `bin`, as declared; a `pi` executable means this package provides Pi (I11). */
  bin?: unknown;
}

interface PluginRecordInternal extends PluginLineRecord {
  /** Package root or module path: two registrations of one plugin share it. */
  identity: string;
  /** A name is sticky: the first usable explicit declaration fixes it for the identity (I9). */
  seenRegistration: boolean;
  /** Why no usable name exists; formatted for the report, never used as a name. */
  nameProblem?: string;
  /** Set when the host's `setStatus` threw for this key (I6). */
  paintError?: string;
  /** The text last handed to the host for this key, so an unchanged state is not repainted (I5). */
  paintedText?: string;
}

interface PluginLinesState {
  plugins: PluginRecordInternal[];
  /** module path → owning package (or the fail-closed answer), so it is resolved once. */
  modules: Map<string, Attribution>;
  /** The host's `setStatus`, bound to the object it came from, when it is available. */
  ui?: (key: string, text?: string) => void;
  /** Why `ui` is absent: the feature is skipped and this is what the report says. */
  unavailableReason?: string;
  /** Keys this module painted, so shutdown clears exactly them. */
  painted: Set<string>;
  /** The package that owns the running `pi` entry point, resolved once (`root` undefined = none). */
  entryPackage?: { root?: string };
}

/**
 * Stable process-global slot, like the bus: two copies of this package must agree on the one line a
 * plugin gets, and the state has to survive jiti loading each copy separately.
 */
const PLUGIN_LINES_KEY = Symbol.for("gentle-shell-bridge.plugin-lines.v1");

/** This package's own boundaries, so its frames and its registrations are recognised as plumbing. */
const BRIDGE_SRC_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = dirname(BRIDGE_SRC_DIR);

function pluginLinesHost(): Record<symbol, PluginLinesState | undefined> {
  // SAFETY: only this module writes the key, and `pluginLinesState()` re-checks the shapes before
  // trusting a value left by another copy or an earlier load.
  return globalThis as unknown as Record<symbol, PluginLinesState | undefined>;
}

function pluginLinesState(): PluginLinesState {
  const host = pluginLinesHost();
  const existing = host[PLUGIN_LINES_KEY];
  if (
    existing !== undefined &&
    Array.isArray(existing.plugins) &&
    existing.modules instanceof Map &&
    existing.painted instanceof Set
  ) {
    return existing;
  }
  const created: PluginLinesState = { plugins: [], modules: new Map(), painted: new Set() };
  host[PLUGIN_LINES_KEY] = created;
  return created;
}

/** A plain, lower-case fragment usable inside a footer key. */
function slug(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized === "" ? "plugin" : normalized;
}

/**
 * The derived display name (I3): package scope dropped, every separator and mark a word break,
 * first word capitalised, clamped to the row-name word limit. `undefined` means nothing usable was
 * left, which is a no line — never an invented one.
 */
export function derivePluginName(packageName: string): string | undefined {
  const unscoped = packageName.replace(/^@[^/]*\//u, "");
  const words = unscoped
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word !== "")
    .slice(0, MAX_ROW_NAME_WORDS);
  if (words.length === 0) return undefined;
  const candidate = words
    .map((word, index) =>
      index === 0 ? `${word.slice(0, 1).toUpperCase()}${word.slice(1)}` : word.toLowerCase(),
    )
    .join(" ");
  return rowNameProblem(candidate) === undefined ? candidate : undefined;
}

/**
 * The footer key for an identity: the package root (or module path) is hashed in, so two packages
 * with the same derived name still get two rows and one plugin keeps the same key forever — a
 * rename, of the package or of an explicit name, repaints THIS key (I10).
 */
function pluginLineKey(identity: PluginIdentity): string {
  const stem = slug(basename(identity.seed, extname(identity.seed)));
  const digest = createHash("sha1").update(identity.id).digest("hex").slice(0, 8);
  return `${PLUGIN_LINE_PREFIX}${stem}.${digest}`;
}

function packageIdentity(root: string): PluginIdentity {
  return { id: `pkg:${root}`, seed: root };
}

function moduleIdentity(modulePath: string): PluginIdentity {
  return { id: `mod:${modulePath}`, seed: modulePath };
}

/** `package.json`'s name and bin in one directory, or `undefined` when there is none to read. */
function readPackageManifest(dir: string): PackageManifest | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "package.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const name = (parsed as { name?: unknown }).name;
    if (typeof name !== "string") return undefined;
    const trimmed = name.trim();
    if (trimmed === "") return undefined;
    return { name: trimmed, bin: (parsed as { bin?: unknown }).bin };
  } catch {
    return undefined;
  }
}

/** The nearest directory above `from` (inclusive of its directory) that holds a named manifest. */
function nearestPackageRoot(from: string): string | undefined {
  let dir = dirname(from);
  for (;;) {
    if (readPackageManifest(dir) !== undefined) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Whether two paths name the same directory; symlinks are compared by their target. */
function sameDirectory(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Whether a `bin` declaration provides the `pi` executable (I11) — a declaration, not a name guess. */
function declaresPiBinary(bin: unknown): boolean {
  if (typeof bin === "string") {
    const file = basename(bin);
    const ext = extname(file);
    return (ext === "" ? file : basename(file, ext)) === "pi";
  }
  if (typeof bin !== "object" || bin === null) return false;
  const entries = bin as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(entries, "pi") && typeof entries.pi === "string";
}

/**
 * The package that provides the RUNNING `pi`: the one that owns `process.argv[1]` (the CLI entry),
 * resolved through symlinks and remembered once. A process with no such entry has none.
 */
function piEntryPackageRoot(): string | undefined {
  const state = pluginLinesState();
  if (state.entryPackage !== undefined) return state.entryPackage.root;
  let root: string | undefined;
  const entry = process.argv[1];
  if (typeof entry === "string" && entry !== "" && isAbsolute(entry)) {
    try {
      root = nearestPackageRoot(realpathSync(entry));
    } catch {
      root = undefined;
    }
  }
  state.entryPackage = { root };
  return root;
}

/**
 * The Pi distribution is the package that owns the running `pi` entry point, or one whose manifest
 * declares the `pi` executable. Recognised from those declarations, never from a package NAME: a
 * plugin may legitimately be called anything.
 */
function isPiDistribution(root: string, manifest: PackageManifest): boolean {
  const entryRoot = piEntryPackageRoot();
  if (entryRoot !== undefined && sameDirectory(entryRoot, root)) return true;
  return declaresPiBinary(manifest.bin);
}

/** Walk up from the module to its owning package (I8). No manifest means no owner: fail closed. */
function resolveOwner(modulePath: string): Owner {
  let dir = dirname(modulePath);
  for (;;) {
    const manifest = readPackageManifest(dir);
    if (manifest !== undefined) {
      if (dir === BRIDGE_ROOT) return { kind: "bridge" };
      if (isPiDistribution(dir, manifest)) {
        return { kind: "pi", root: dir, name: manifest.name, modulePath };
      }
      return { kind: "package", root: dir, name: manifest.name, modulePath };
    }
    const parent = dirname(dir);
    if (parent === dir) return { kind: "module", modulePath };
    dir = parent;
  }
}

/** Resolve the whole answer ONCE per module: owner, identity and (for a plugin) its record seed. */
function resolveAttribution(modulePath: string): Attribution {
  const owner = resolveOwner(modulePath);
  if (owner.kind === "bridge") return owner;
  if (owner.kind === "package") return { ...owner, identity: packageIdentity(owner.root) };
  // A Pi-owned module fails closed exactly like an unattributable one (I11), so its plugin is the
  // module itself, never the Pi distribution's package root.
  return { ...owner, identity: moduleIdentity(modulePath) };
}

/** The absolute file path in one stack frame, or `undefined` for an internal/native frame. */
function framePath(text: string): string | undefined {
  const open = text.lastIndexOf("(");
  const location = (open === -1 ? text : text.slice(open + 1, text.endsWith(")") ? -1 : undefined))
    .trim()
    .replace(/^(?:async|new|eval) /u, "");
  const match = /^(.+):(\d+):(\d+)$/u.exec(location);
  if (match === null) return undefined;
  let file = match[1];
  if (file.startsWith("node:") || file === "<anonymous>") return undefined;
  if (file.startsWith("file://")) {
    try {
      file = fileURLToPath(file);
    } catch {
      // A URL this Node cannot convert is still a location; the walk above may resolve it.
    }
  }
  if (!isAbsolute(file)) return undefined;
  return file;
}

/**
 * The first stack frame outside this package: the plugin module that called the registration. One
 * capture per registration, then the answer is cached per module.
 */
function callerModule(): string | undefined {
  const stack = new Error().stack;
  if (stack === undefined) return undefined;
  for (const raw of stack.split("\n")) {
    const frame = raw.trim();
    if (!frame.startsWith("at ")) continue;
    const path = framePath(frame.slice(3));
    if (path === undefined) continue;
    if (path === BRIDGE_SRC_DIR || path.startsWith(`${BRIDGE_SRC_DIR}${sep}`)) continue;
    return path;
  }
  return undefined;
}

function attributionOfCaller(): Attribution {
  let modulePath: string | undefined;
  try {
    modulePath = callerModule();
  } catch {
    modulePath = undefined;
  }
  // No caller frame means the bridge itself (an internal helper): never a plugin line.
  if (modulePath === undefined) return { kind: "bridge" };

  const state = pluginLinesState();
  const cached = state.modules.get(modulePath);
  if (cached !== undefined) return cached;

  let resolved: Attribution;
  try {
    resolved = resolveAttribution(modulePath);
  } catch {
    resolved = { kind: "module", modulePath, identity: moduleIdentity(modulePath) };
  }
  state.modules.set(modulePath, resolved);
  return resolved;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A value as diagnostics text: strings verbatim, everything else in a stable printable form. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** What a registration's optional `name` is: absent, a usable string, or a present non-string. */
type ExplicitName =
  | { kind: "absent" }
  | { kind: "text"; value: string }
  | { kind: "invalid" };

/** The registration's `id` as diagnostics text; a non-string (or unreadable) id is named as such. */
function registrationId(registration: unknown): string {
  if (typeof registration !== "object" || registration === null) return "undefined";
  try {
    const id = (registration as { id?: unknown }).id;
    if (typeof id === "string") return id;
    return id === undefined ? "undefined" : describeValue(id);
  } catch {
    return "unreadable id";
  }
}

/** Read the optional `name` without trusting the object the plugin handed us. */
function explicitNameOf(registration: unknown): ExplicitName {
  if (typeof registration !== "object" || registration === null) return { kind: "absent" };
  let candidate: unknown;
  try {
    candidate = (registration as { name?: unknown }).name;
  } catch {
    return { kind: "absent" };
  }
  if (candidate === undefined || candidate === null) return { kind: "absent" };
  return typeof candidate === "string" ? { kind: "text", value: candidate } : { kind: "invalid" };
}

/** The row-name rejection this registration just produced, if any (I4). */
function rowNameRejectionFor(
  surface: RowNameSurface,
  id: string,
): RowNameRejection | undefined {
  return getRowNameRejections().find(
    (rejection) => rejection.surface === surface && rejection.id === id,
  );
}

function ensureRecord(attribution: Exclude<Attribution, { kind: "bridge" }>): PluginRecordInternal {
  const state = pluginLinesState();
  const identity = attribution.identity;
  const existing = state.plugins.find((record) => record.identity === identity.id);
  if (existing !== undefined) return existing;

  const record: PluginRecordInternal = {
    identity: identity.id,
    key: pluginLineKey(identity),
    modulePath: attribution.modulePath,
    accepted: 0,
    rejected: [],
    nameConflicts: [],
    status: "ready",
    line: "not-set",
    seenRegistration: false,
  };

  if (attribution.kind === "package") {
    record.packageName = attribution.name;
    const derived = derivePluginName(attribution.name);
    if (derived === undefined) {
      record.nameProblem =
        `the package name ${JSON.stringify(attribution.name)} has no usable words to derive a ` +
        "row name from";
    } else {
      record.name = derived;
      record.nameSource = "derived";
    }
  } else if (attribution.kind === "pi") {
    // I11: the Pi installation is not a plugin. Its name is not a row name and nothing is derived
    // from it; only an explicit `name` from the module itself can give the row one.
    record.packageName = attribution.name;
    record.nameProblem =
      `the module is attributed to the Pi installation ${JSON.stringify(attribution.name)}, the ` +
      "package that provides `pi`; the Pi distribution is never a plugin identity, so no row is " +
      "derived from it. Pass `name` on a registration to name the plugin explicitly";
  } else {
    // Fail closed (I2): a copied single file has no owning package, so there is no name to derive
    // and nothing is invented. Only an explicit `name` can name it.
    record.nameProblem =
      "no package.json was found above the module, so there is no owning package name; pass " +
      "`name` on a registration to name it";
  }

  state.plugins.push(record);
  return record;
}

/**
 * Honour an explicit `name` for the identity, whichever registration declares it first (I9). The
 * first usable declaration fixes the name for the identity's single row; a repeat inherits it, and
 * a DIFFERENT later name never renames — it is reported as a conflict and the first name stands.
 */
function applyExplicitName(
  record: PluginRecordInternal,
  surface: PluginSurface,
  id: string,
  name: ExplicitName,
): void {
  if (name.kind === "absent") return;

  if (name.kind === "invalid") {
    // The first registration's invalid name withholds the line (existing behaviour); a later one is
    // reported without discarding a name the identity already has.
    if (record.seenRegistration) {
      record.rejected.push({
        surface,
        id,
        reason: "the explicit name was rejected: it is not a string",
      });
      return;
    }
    rejectExplicitName(record, surface, id, "not a string", "it is not a string");
    return;
  }

  if (record.nameSource === "explicit") {
    if (record.name === name.value) return;
    recordConflict(record, surface, id, name.value);
    return;
  }

  const problem = rowNameProblem(name.value);
  if (problem === undefined) {
    record.name = name.value;
    record.nameSource = "explicit";
    record.nameProblem = undefined;
    return;
  }
  if (!record.seenRegistration) {
    rejectExplicitName(record, surface, id, name.value, problem.reason);
    return;
  }
  record.rejected.push({
    surface,
    id,
    reason: `the explicit name ${JSON.stringify(name.value)} was rejected: ${problem.reason}`,
  });
}

/** Report a name that was declared too late to apply, once per (surface, id, name) (I9). */
function recordConflict(
  record: PluginRecordInternal,
  surface: PluginSurface,
  id: string,
  name: string,
): void {
  const kept = record.name ?? "";
  const duplicate = record.nameConflicts.some(
    (conflict) =>
      conflict.surface === surface && conflict.id === id && conflict.name === name,
  );
  if (duplicate) return;
  record.nameConflicts.push({ surface, id, name, kept });
}

/** A rejected explicit name is reported, and produces NO line — never a rejected name (I3). */
function rejectExplicitName(
  record: PluginRecordInternal,
  surface: PluginSurface,
  id: string,
  value: string,
  reason: string,
): void {
  record.name = undefined;
  record.nameSource = undefined;
  record.nameProblem =
    `the explicit name ${JSON.stringify(value)} breaks the row-name shape (${reason}), so no ` +
    "line is set: a rejected name is never shown";
  record.rejected.push({
    surface,
    id,
    reason: `the explicit name ${JSON.stringify(value)} was rejected: ${reason}`,
  });
}

/** The row text: the name and the derived state, both INSIDE the opaque string (I7). */
function lineText(record: PluginRecordInternal): string {
  return `${record.name ?? "plugin"} · ${record.status}`;
}

/**
 * Paint one plugin's line, or record why it cannot be painted. The derived status is recomputed
 * here so every repaint uses the same key with the current answer (I4, I5), and every host call is
 * contained: a footer that throws must cost the row, never the plugin's registration (I6).
 */
function paint(record: PluginRecordInternal): void {
  const state = pluginLinesState();
  record.status = record.rejected.length === 0 ? "ready" : "degraded";
  record.paintError = undefined;
  if (record.name === undefined) {
    record.line = "not-set";
    return;
  }
  const setStatus = state.ui;
  if (setStatus === undefined) {
    record.line = "not-set";
    return;
  }
  const text = lineText(record);
  // I5: repaint only when the derived status actually changed. The host's `setStatus` asks for a
  // frame, so a no-op registration must not cost one; the row is already right.
  if (record.line === "set" && record.paintedText === text) return;
  try {
    setStatus(record.key, text);
    record.line = "set";
    record.paintedText = text;
    state.painted.add(record.key);
  } catch (error) {
    record.line = "not-set";
    record.paintError = `setStatus threw: ${messageOf(error)}`;
  }
}

type SetStatusRead =
  | { kind: "available"; set: (key: string, text?: string) => void }
  | { kind: "unavailable"; reason: string };

function readSetStatus(ui: unknown): SetStatusRead {
  if (ui === null || typeof ui !== "object") {
    return { kind: "unavailable", reason: "ctx.ui is missing, so setStatus cannot be called" };
  }
  let member: unknown;
  try {
    member = (ui as { setStatus?: unknown }).setStatus;
  } catch (error) {
    return { kind: "unavailable", reason: `reading ctx.ui.setStatus threw: ${messageOf(error)}` };
  }
  if (typeof member !== "function") {
    return { kind: "unavailable", reason: "ctx.ui has no setStatus" };
  }
  const bound = member as (key: string, text?: string) => void;
  return {
    kind: "available",
    set: (key, text) => {
      bound.call(ui, key, text);
    },
  };
}

/**
 * Take the session's `ctx.ui` and paint every plugin already registered (I5): a plugin that
 * registered before any context existed gets its line now, and a UI without `setStatus` is recorded
 * as the feature's unavailability instead of throwing (I6). Returns whether the host surface exists.
 */
export function installPluginStatus(ui: unknown): boolean {
  const state = pluginLinesState();
  const read = readSetStatus(ui);
  if (read.kind === "available") {
    state.ui = read.set;
    state.unavailableReason = undefined;
  } else {
    state.ui = undefined;
    state.unavailableReason = read.reason;
  }
  for (const record of state.plugins) {
    // A rebind hands a new `ctx.ui` (and with it a fresh footer map), so what the old one was told
    // does not carry over: every key is painted again on the new object.
    record.paintedText = undefined;
    paint(record);
  }
  return read.kind === "available";
}

/** Clear every key this module painted with `undefined`, and forget the session's UI (I5). */
export function clearPluginStatus(): void {
  const state = pluginLinesState();
  const setStatus = state.ui;
  if (setStatus !== undefined) {
    for (const key of [...state.painted]) {
      try {
        setStatus(key, undefined);
      } catch {
        // The footer is already gone; there is nothing left to clear and nothing to report.
      }
    }
  }
  state.painted.clear();
  state.ui = undefined;
  for (const record of state.plugins) {
    if (record.line === "set") record.line = "cleared";
    record.paintedText = undefined;
    record.paintError = undefined;
  }
}

/** Why this record has no line right now, or `undefined` when it does. */
function lineReason(
  record: PluginRecordInternal,
  state: PluginLinesState,
): string | undefined {
  if (record.name === undefined) return record.nameProblem;
  if (record.line === "set") return undefined;
  if (record.paintError !== undefined) return record.paintError;
  if (state.ui === undefined) {
    return state.unavailableReason ?? "no ui yet: the line is painted on session_start";
  }
  return undefined;
}

/** A fresh copy of everything `/bridge-status` reports, so a caller cannot mutate the registry. */
export function getPluginLineReport(): PluginLineReport {
  const state = pluginLinesState();
  const availability: PluginLineReport["availability"] =
    state.ui !== undefined ? "installed" : state.unavailableReason === undefined ? "not-armed" : "unavailable";
  const reason = state.ui !== undefined ? undefined : state.unavailableReason;
  return {
    availability,
    ...(reason === undefined ? {} : { reason }),
    plugins: state.plugins.map((record) => {
      const reasonNow = lineReason(record, state);
      return {
        key: record.key,
        ...(record.name === undefined ? {} : { name: record.name }),
        ...(record.nameSource === undefined ? {} : { nameSource: record.nameSource }),
        ...(record.packageName === undefined ? {} : { packageName: record.packageName }),
        modulePath: record.modulePath,
        status: record.rejected.length === 0 ? "ready" : "degraded",
        accepted: record.accepted,
        rejected: record.rejected.map((rejection) => ({ ...rejection })),
        nameConflicts: record.nameConflicts.map((conflict) => ({ ...conflict })),
        line: record.line,
        ...(reasonNow === undefined ? {} : { reason: reasonNow }),
      };
    }),
  };
}

/**
 * The attribution boundary every registration goes through (`./bus.ts`, I2–I4).
 *
 * `store` is the real registration: this function wraps it so a failure still lands in the plugin's
 * record before it propagates (a plugin's invalid id must keep throwing exactly as before), and a
 * success is counted as accepted — or as rejected when the bus just recorded a row-name rejection for
 * it. The disposer is returned untouched: attribution never changes what a registration does.
 */
export function attributeRegistration(
  surface: PluginSurface,
  registration: unknown,
  rowNameSurface: RowNameSurface | undefined,
  store: () => () => void,
): () => void {
  const attribution = attributionOfCaller();
  // The bridge's own package is plumbing, and an unattributable internal helper claims nothing.
  if (attribution.kind === "bridge") return store();

  const record = ensureRecord(attribution);
  const id = registrationId(registration);
  applyExplicitName(record, surface, id, explicitNameOf(registration));

  let disposer: () => void;
  try {
    disposer = store();
  } catch (error) {
    record.rejected.push({ surface, id, reason: messageOf(error) });
    record.seenRegistration = true;
    paint(record);
    throw error;
  }

  const rowRejection =
    rowNameSurface === undefined ? undefined : rowNameRejectionFor(rowNameSurface, id);
  if (rowRejection === undefined) {
    record.accepted += 1;
  } else {
    record.rejected.push({
      surface,
      id,
      reason:
        `${rowRejection.field} ${JSON.stringify(rowRejection.value)} rejected: ` +
        rowRejection.reason,
    });
  }
  record.seenRegistration = true;
  paint(record);
  return disposer;
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetPluginLinesForTests(): void {
  const state = pluginLinesState();
  state.plugins.length = 0;
  state.modules.clear();
  state.painted.clear();
  state.ui = undefined;
  state.unavailableReason = undefined;
  state.entryPackage = undefined;
}
