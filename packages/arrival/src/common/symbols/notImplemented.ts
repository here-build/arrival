// symbol.notImplemented — per-tag factory file assembled into `symbol` by ./index.ts;
// shared types live in ./_bake.js.

import { parseNameDoc, type DoorSymbolDef } from "./_bake.js";

/** errors-as-doors — an OMITTED verb carrying only a teaching reason, no contract/impl. */
export function notImplemented(tpl: TemplateStringsArray, ...sub: unknown[]): DoorSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return { kind: "door", name, reason: doc ?? "" };
}
