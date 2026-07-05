// symbol.rosetta — a host fn in JS-LAND (decoded via the contract codecs). One of the
// per-tag factory files re-assembled into the `symbol` namespace by `./index.ts`; the
// shared bake fn + contract types live in `./_bake.js`.

import {
  bakeRosetta,
  parseNameDoc,
  type BakeRuntimeOpts,
  type Contract,
  type Impl,
  type RestSpec,
  type RosettaSymbolDef,
  type VectorSpec,
} from "./_bake.js";

/** Rosetta host fn in JS-LAND (decoded via the contract codecs). ctx-free for this step.
 *  `Rest` (inferred from `contract.inputRest`, defaulting to `undefined`) is the FIXED-prefix-
 *  plus-rest split — see `Contract`/`Impl` in `_bake.ts`. Absent `inputRest` ⇒ `Rest` stays
 *  `undefined` and `impl`'s signature is byte-identical to before `inputRest` existed. */
export function rosetta(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: Contract<I, O, Rest>,
    impl: Impl<I, O, Rest>,
    opts?: BakeRuntimeOpts,
  ): RosettaSymbolDef => bakeRosetta({ kind: "rosetta", name, doc, contract, impl }, opts);
}
