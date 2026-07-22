// symbol.value — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js. docs/environments.md §SYMBOL-KINDS — the `value` row (a raw
// DATA binding made first-class: the discriminated successor of the retired untagged
// `{ value }` SymbolDeclaration arm).

import { parseNameDoc, type ValueSymbolDef } from "./_bake.js";

/** raw VALUE binding — a host-supplied constant bound by name, never a scheme call target.
 *  No contract/impl: the template carries `name: doc`; the payload call carries the value
 *  verbatim (a bare JS leaf is boxed by `bindValue`'s fromJS tail at bind, a pre-boxed
 *  scheme value passes through). The home of host sentinels (`mcp/break`'s MCP_BREAK) and
 *  pre-marshalled data roots (a device sim's seeded contact list) — anything a capability
 *  binds as DATA rather than declares as a verb. */
export function value(tpl: TemplateStringsArray, ...sub: unknown[]): (v: unknown) => ValueSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return (v: unknown): ValueSymbolDef => ({ kind: "value", name, doc, value: v });
}
