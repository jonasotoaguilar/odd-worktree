/**
 * A fake host for the capture backend, modelling `gentle-shell.ts:3550-3562` and
 * `lib/visual-customize-view.ts:387`.
 *
 * The host builds its `rows` array, derives categories from it with a single synchronous
 * `rows.map(...)` inside the factory — the one moment the array is reachable — and returns a
 * plain adapter `{ render, handleInput, invalidate, dispose }` that hides the rows. Duck-typing
 * `options.rows` on the adapter never matches, exactly like the real host.
 *
 * The adapter renders from the live array, so a test asserts what the user would see after an
 * injection, not just what the bridge captured.
 */

import type { CustomizeRow, InlineHelpers, RowLabel } from "../src/types.ts";

export type CustomFactory = (ui: unknown, theme: unknown, ...rest: unknown[]) => unknown;

/** The `custom` surface Pi hands extensions; own property or inherited, depending on shape. */
export interface FakeUiTarget {
  custom?: (factory: CustomFactory, ...rest: unknown[]) => unknown;
}

export interface FakeAdapter {
  render: () => string[];
  handleInput: (data: string) => unknown;
  invalidate: () => void;
  dispose: () => void;
}

export type FakeRow = CustomizeRow;

export interface FakeHostOptions {
  /** The host's own menu rows. Must hold at least the capture threshold's worth of rows. */
  rows?: FakeRow[];
  /** `own` puts `custom` on the instance; `prototype` leaves the instance inheriting it. */
  customShape?: "own" | "prototype";
  /** `promise` makes the factory return a promise, as the real chain allows. */
  factoryResult?: "adapter" | "promise";
  /** Throw inside the factory after the category map ran. */
  throwInsideFactory?: boolean;
  /** Map only a non-row array inside the factory, never the rows array. */
  mapOnlyNonRows?: boolean;
  /** Theme handed to the factory as its second argument. */
  theme?: unknown;
  /** Extra factory arguments after the theme (the host passes keybindings and `close`). */
  extraFactoryArgs?: unknown[];
}

export interface FakeHost {
  readonly ui: FakeUiTarget;
  /** The factory itself, so a nesting test can re-enter a wrapped `custom` call. */
  readonly factory: CustomFactory;
  /** What Pi does: `ui.custom(factory, options)`. */
  buildMenu: () => unknown;
  /** The live array the adapter renders from (rows the host built plus anything injected). */
  liveRows: () => FakeRow[];
  /** Categories the host derived from that array in the factory's single `rows.map(...)`. */
  categories: () => string[];
  /** Labels the user would see right now. */
  rendered: () => string[];
  invalidateCount: () => number;
  disposeCount: () => number;
  factoryCallCount: () => number;
  /** Enter on the first visible row whose rendered label matches, including the view's repaint. */
  press: (label: string) => Promise<void>;
  /** Enter on the first visible row matching, so a test can target a choice value, not a label. */
  pressRow: (match: (row: FakeRow) => boolean) => Promise<void>;
  /**
   * The `●`/`○` lines the real renderer draws: consecutive rows sharing `choice.setting` become one
   * line (`lib/visual-customize-view.ts:583-595`), so this reads `current()` at render time.
   */
  toggleLines: () => string[];
}

const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

const labelText = (label: RowLabel | undefined): string => {
  if (typeof label === "function") return label();
  return label ?? "";
};

const isVisible = (row: FakeRow): boolean => {
  if (row.visible === undefined) return true;
  try {
    return row.visible();
  } catch {
    return false; // the renderer fails closed
  }
};

/** Four rows: one more than the capture threshold, spread over three categories. */
const defaultRows = (): FakeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  { category: "Cards", label: "Card output: builtin", action: () => {} },
  { category: "Banner", label: "Banner: builtin", action: () => {} },
  { category: "Layout", label: "Layout: builtin", action: () => {} },
];

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const rows: FakeRow[] = options.rows ?? defaultRows();
  const theme = "theme" in options ? options.theme : { name: "fake-theme" };
  const extraFactoryArgs = options.extraFactoryArgs ?? [{ keybindings: "fake" }, () => {}];
  const customShape = options.customShape ?? "own";
  const factoryResult = options.factoryResult ?? "adapter";

  let invalidateCount = 0;
  let disposeCount = 0;
  let factoryCallCount = 0;
  let categories: string[] = [];

  const render = (): string[] => rows.filter(isVisible).map((row) => labelText(row.label));

  const runAction = async (row: FakeRow): Promise<void> => {
    await row.action?.(inlineHelpers);
    invalidateCount += 1; // the real view repaints after any action (visual-customize-view.ts:579)
  };

  const adapter = (): FakeAdapter => ({
    render,
    handleInput: (data: string) => (data === "enter" ? press(render()[0] ?? "") : undefined),
    invalidate: () => {
      invalidateCount += 1;
    },
    dispose: () => {
      disposeCount += 1;
    },
  });

  const pressRow = async (match: (row: FakeRow) => boolean): Promise<void> => {
    const row = rows.filter(isVisible).find(match);
    if (row === undefined) throw new Error("fake host: no visible row matched the predicate");
    await runAction(row);
  };

  const press = (label: string): Promise<void> =>
    pressRow((candidate) => labelText(candidate.label) === label);

  const toggleLines = (): string[] => {
    const visible = rows.filter(isVisible);
    const lines: string[] = [];
    let index = 0;
    while (index < visible.length) {
      const setting = visible[index].choice?.setting;
      if (setting === undefined) {
        index += 1;
        continue;
      }
      let end = index;
      while (end + 1 < visible.length && visible[end + 1].choice?.setting === setting) end += 1;
      const marks = visible
        .slice(index, end + 1)
        .map((row) => {
          const mark = row.choice?.current() === true ? "●" : "○";
          return `${mark} ${row.choice?.value ?? ""}`.trim();
        });
      lines.push(`${setting} ${marks.join(" ")}`);
      index = end + 1;
    }
    return lines;
  };

  const factory: CustomFactory = (_ui, _theme, ..._rest) => {
    factoryCallCount += 1;
    // The one reachable moment (lib/visual-customize-view.ts:387): the view derives its
    // categories from `options.rows` with a single synchronous `map` call inside the factory.
    if (options.mapOnlyNonRows === true) {
      [1, 2, 3].map((value) => value * 2); // a plain array of numbers: not a row array
    } else {
      categories = rows.map((row) => row.category ?? "Settings");
    }
    if (options.throwInsideFactory === true) throw new Error("factory exploded");

    const built = adapter();
    return factoryResult === "promise" ? Promise.resolve(built) : built;
  };

  const invoke = (factoryArg: CustomFactory): unknown => factoryArg(ui, theme, ...extraFactoryArgs);

  const ownShape: FakeUiTarget = {
    custom: (factoryArg: CustomFactory) => invoke(factoryArg),
  };
  const prototypeShape: FakeUiTarget = Object.create({
    custom(this: unknown, factoryArg: CustomFactory) {
      return invoke(factoryArg);
    },
  }) as FakeUiTarget;

  const ui: FakeUiTarget = customShape === "prototype" ? prototypeShape : ownShape;

  return {
    ui,
    factory,
    buildMenu: () => {
      if (typeof ui.custom !== "function") throw new Error("fake host: ui.custom disappeared");
      return ui.custom(factory);
    },
    liveRows: () => rows,
    categories: () => [...categories],
    rendered: render,
    invalidateCount: () => invalidateCount,
    disposeCount: () => disposeCount,
    factoryCallCount: () => factoryCallCount,
    press,
    pressRow,
    toggleLines,
  };
}
