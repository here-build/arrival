// symbol.tagless — a dispatcher to the receiver's own tagless-final term method. One
// of the per-tag factory files re-assembled into the `symbol` namespace by `./index.ts`;
// the shared bake fn + types live in `./_bake.js`.

import { bakeTagless, parseNameDoc, type TaglessSymbolDef } from "./_bake.js";

/** Tagless host op — `symbol.tagless\`name: doc\`` binds a symbol that dispatches to the receiver's
 *  own `arrival/tagless-final/name` term method (the LAST scheme arg is the receiver; a missing
 *  method THROWS — the hard op, dual of the graceful `taglessGuard`). The name is supplied at the
 *  call site directly — NO central Record. Tagless dispatch is pure (NO JS impl): the real per-op
 *  types/impls live as `arrival/tagless-final/<name>` members on the terms (primitives/AValue.ts),
 *  the source of truth — `tagless-final.ts` derives the op-name type from there. The name is free
 *  here (mirrors `taglessGuard`); the algebra, not this binder, is the completeness gate. */
export function tagless(tpl: TemplateStringsArray, ...sub: unknown[]): TaglessSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return bakeTagless({ kind: "tagless", name, doc });
}
