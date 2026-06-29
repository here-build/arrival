// symbol.taglessGuard — a graceful predicate dispatcher (#f when the receiver declares
// no such method). One of the per-tag factory files re-assembled into the `symbol`
// namespace by `./index.ts`; the shared bake fn + types live in `./_bake.js`.

import { bakeTaglessGuard, parseNameDoc, type TaglessGuardSymbolDef } from "./_bake.js";

/** A tagless GUARD binder — `symbol.taglessGuard\`name: doc\`` binds a predicate that dispatches
 *  to the receiver's own `arrival/tagless-final/name`, returning #f when it declares none. Unlike
 *  `tagless` (a Record keyed by the closed algebra), the name is FREE — a per-type predicate
 *  (`vector?`, `null?`-style), not a declared sequence op. */
export function taglessGuard(tpl: TemplateStringsArray, ...sub: unknown[]): TaglessGuardSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return bakeTaglessGuard({ name, doc });
}
