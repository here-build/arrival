// symbol.macro — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js. docs/environments.md §SYMBOL-KINDS — the `macro` row (a raw JS
// Macro/Syntax transformer bound as-is); `preludeOnly` binding is §PRELUDE.

import { Macro } from "../../eval/Macro.js";
import { type MacroSymbolDef } from "./_bake.js";

export interface MacroFactoryOptions {
  /** See `MacroSymbolDef.preludeOnly` — assembly-time-only binding. */
  readonly preludeOnly?: boolean;
}

/** A non-evaluating MACRO binding: a `name` template + a `(transformer)` call. The
 *  transformer is a raw JS `Macro` expander (not scheme source); assembly binds the
 *  constructed `Macro` as-is. Optional `opts.preludeOnly` routes the binding onto the
 *  kernel's prelude overlay (same as native/rosetta `preludeOnly`). */
export function macro(strings: TemplateStringsArray) {
  const name = strings[0]!;
  return (fn: ConstructorParameters<typeof Macro>[1], opts?: MacroFactoryOptions): MacroSymbolDef => ({
    kind: "macro",
    name,
    macro: new Macro(name, fn),
    preludeOnly: opts?.preludeOnly,
  });
}
