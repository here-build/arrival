// symbol.notImplemented — per-tag factory file assembled into `symbol` by ./index.ts;
// shared types live in ./_bake.js.

import { parseNameDoc, type DoorSymbolDef } from "./_bake.js";

/** errors-as-doors — an OMITTED verb carrying only a teaching reason, no contract/impl.
 *  Signature + return shape are SOURCE-COMPATIBLE across the W0 `DoorCause` design
 *  (docs/design-history/symbol-define-static-program-validation.md §W0): this factory
 *  still bakes `{kind, name, reason}` alone — it has no owning capability to stamp yet
 *  (it runs inside a `symbols` record literal, before the `EnvCapability` wrapping it
 *  exists). `common/capability.ts`'s door bind arm derives `.cause` from the binding
 *  capability at apply time. */
export function notImplemented(tpl: TemplateStringsArray, ...sub: unknown[]): DoorSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return { kind: "door", name, reason: doc ?? "" };
}
