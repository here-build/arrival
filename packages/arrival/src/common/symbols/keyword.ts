// symbol.keyword — a kernel special form made first-class. One of the per-tag factory
// files re-assembled into the `symbol` namespace by `./index.ts`; the shared types live
// in `./_bake.js`. No bake fn: a keyword def is just `{ kind, name, doc }`.

import { parseNameDoc, type KeywordSymbolDef } from "./_bake.js";

/** kernel KEYWORD — a special form made first-class. No contract/impl: the tagged
 *  template carries only `name: doc`; `lower()` binds `new Keyword(name)` and the
 *  evaluator dispatches `SPECIAL_FORMS[name]` on the resolved marker. */
export function keyword(tpl: TemplateStringsArray, ...sub: unknown[]): KeywordSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return { kind: "keyword", name, doc };
}
