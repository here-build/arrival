// symbol.notImplemented — errors-as-doors: an OMITTED verb carrying only a teaching
// reason. One of the per-tag factory files re-assembled into the `symbol` namespace by
// `./index.ts`; the shared types + helpers live in `./_bake.js`.

import { parseNameDoc, type DoorSymbolDef } from "./_bake.js";

/** errors-as-doors — an OMITTED verb. No contract/impl, just the teaching reason. */
export function notImplemented(tpl: TemplateStringsArray, ...sub: unknown[]): DoorSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return { kind: "door", name, reason: doc ?? "" };
}
