// symbol.sequence — a ctx-aware op whose impl gets (schemeArgs, runCtx). One of the
// per-tag factory files re-assembled into the `symbol` namespace by `./index.ts`; the
// shared bake fn + types live in `./_bake.js`.

import {
  bakeSequence,
  parseNameDoc,
  type Contract,
  type SequenceImpl,
  type SequenceSymbolDef,
  type VectorSpec,
} from "./_bake.js";

/** Ctx-aware host op — the impl gets (schemeArgs, runCtx). For kernel-logic-bearing ops
 *  (heap-charge, run-strict) that aren't pure per-receiver dispatch. `impl`'s args/return are
 *  now checked against the contract via `SequenceImpl<I,O>` (was raw `unknown[]`/`unknown` —
 *  the same erasure gap `inputRest` closed for native/rosetta). */
export function sequence(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec>(
    contract: Contract<I, O>,
    impl: SequenceImpl<I, O>,
  ): SequenceSymbolDef => bakeSequence({ kind: "sequence", name, doc, contract, impl });
}
