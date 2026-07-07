// symbol.macro — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js.

import { Macro } from "../../eval/Macro.js";
import { type MacroSymbolDef } from "./_bake.js";

/** A non-evaluating MACRO binding: a `name` template + a `(transformer)` call. The
 *  transformer is a raw JS `Macro` expander (not scheme source); assembly binds the
 *  constructed `Macro` as-is. */
export function macro(strings: TemplateStringsArray) {
  const name = strings[0];
  return (fn: ConstructorParameters<typeof Macro>[1]): MacroSymbolDef => ({
    kind: "macro",
    name,
    macro: new Macro(name, fn),
  });
}
