// symbol.keyword — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js.

import { parseNameDoc, type KeywordSymbolDef } from "./_bake.js";

/** kernel KEYWORD — a special form made first-class. No contract/impl: the template
 *  carries only `name: doc`; `lower()` binds `new Keyword(name)`, and the evaluator
 *  dispatches `SPECIAL_FORMS[name]` on the resolved marker. */
export function keyword(tpl: TemplateStringsArray, ...sub: unknown[]): KeywordSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return { kind: "keyword", name, doc };
}
