// symbol.notImplemented — per-tag factory file assembled into `symbol` by ./index.ts;
// shared types live in ./_bake.js. docs/environments.md §SYMBOL-KINDS — the door row
// (errors-as-doors); §DEGRADATION — a notImplemented door is a permanent omission (empty `needs`).

import { parseNameDoc, type DoorSymbolDef } from "./_bake.js";
import { DoorProcedure } from "../../values/primitives/ACallable.js";

/** errors-as-doors — an OMITTED verb carrying only a teaching reason, no contract/impl.
 *  Mints a `DoorProcedure` over `{kind, name, reason}` alone: it has no owning capability to
 *  stamp a `DoorCause` yet, because it runs inside a `symbols` record literal, before the
 *  `EnvCapability` wrapping it exists. `common/capability.ts`'s door bind arm stamps
 *  `.door.cause` from the binding capability's OWN name, in place, the first time this
 *  (shared, module-singleton) value is bound — see that file's comment on the door case. */
export function notImplemented(tpl: TemplateStringsArray, ...sub: unknown[]): DoorProcedure {
  const { name, doc } = parseNameDoc(tpl, sub);
  const def: DoorSymbolDef = { kind: "door", name, reason: doc ?? "" };
  return new DoorProcedure(def);
}
