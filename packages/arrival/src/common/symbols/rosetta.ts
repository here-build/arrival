// symbol.rosetta — a host fn in JS-LAND (decoded via the contract codecs). One of the
// per-tag factory files re-assembled into the `symbol` namespace by `./index.ts`; the
// shared bake fn + contract types live in `./_bake.js`.

import {
  bakeRosetta,
  parseNameDoc,
  type BakeRuntimeOpts,
  type Contract,
  type Impl,
  type RosettaSymbolDef,
  type VectorSpec,
} from "./_bake.js";

/** Rosetta host fn in JS-LAND (decoded via the contract codecs). ctx-free for this step. */
export function rosetta(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec>(
    contract: Contract<I, O>,
    impl: Impl<I, O>,
    opts?: BakeRuntimeOpts,
  ): RosettaSymbolDef => bakeRosetta({ kind: "rosetta", name, doc, contract, impl }, opts);
}
