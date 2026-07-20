// symbol.notImplemented — per-tag factory file assembled into `symbol` by ./index.ts;
// shared types live in ./_bake.js. docs/environments.md §SYMBOL-KINDS — the door row
// (errors-as-doors); §DEGRADATION — a notImplemented door is a permanent omission (empty `needs`).

import { parseNameDoc, type DoorSymbolDef } from "./_bake.js";

/** errors-as-doors — an OMITTED verb carrying only a teaching reason, no contract/impl.
 *  Bakes `{kind, name, reason}` alone: it has no owning capability to stamp a `DoorCause`
 *  yet, because it runs inside a `symbols` record literal, before the `EnvCapability`
 *  wrapping it exists. `common/capability.ts`'s door bind arm derives `.cause` from the
 *  binding capability at apply time. */
export function notImplemented(tpl: TemplateStringsArray, ...sub: unknown[]): DoorSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return { kind: "door", name, reason: doc ?? "" };
}
