// symbol.notImplemented — errors-as-doors: an OMITTED verb carrying only a teaching
// reason. One of the per-tag factory files re-assembled into the `symbol` namespace by
// `./index.ts`; the shared bake fn + types live in `./_bake.js`.

import { bakeDoor, parseNameDoc, type DoorSymbolDef } from "./_bake.js";

/** errors-as-doors — an OMITTED verb. No contract/impl, just the teaching reason. */
export function notImplemented(tpl: TemplateStringsArray, ...sub: unknown[]): DoorSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return bakeDoor({ kind: "door", name, reason: doc ?? "" });
}
