// symbol.macro — a non-evaluating MACRO binding. One of the per-tag factory files
// re-assembled into the `symbol` namespace by `./index.ts`; the shared types live in
// `./_bake.js`. No bake fn: a macro def wraps a raw JS `Macro` expander.

import { Macro } from "../../eval/Macro.js";
import { type MacroSymbolDef } from "./_bake.js";

/** A non-evaluating MACRO binding: a `name` template + a `(transformer)` call, mirroring
 *  the other symbol kinds (`symbol.macro` + a `name` template + `(fn)`). The transformer is a
 *  raw JS `Macro` expander (not scheme source); assembly binds the constructed `Macro` as-is. */
export function macro(strings: TemplateStringsArray) {
  const name = strings[0];
  return (fn: ConstructorParameters<typeof Macro>[1]): MacroSymbolDef => ({
    kind: "macro",
    name,
    macro: new Macro(name, fn),
  });
}
