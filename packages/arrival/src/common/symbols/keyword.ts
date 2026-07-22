// symbol.keyword — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js. docs/environments.md §SYMBOL-KINDS — the `keyword` row (a special
// form made first-class: evaluator-dispatched, aliasable, lexically shadowable).

import { parseNameDoc } from "./_bake.js";
import { AKernelKeyword } from "../../values/AKernelKeyword.js";

/** kernel KEYWORD — a special form made first-class. No contract/impl: the template
 *  carries only `name: doc`; mints `new AKernelKeyword(name)` directly, and the evaluator
 *  dispatches `SPECIAL_FORMS[name]` on the resolved marker. */
export function keyword(tpl: TemplateStringsArray, ...sub: unknown[]): AKernelKeyword {
  const { name } = parseNameDoc(tpl, sub);
  return new AKernelKeyword(name);
}
