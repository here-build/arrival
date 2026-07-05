// symbol.native — a native host fn over SCHEME VALUES. One of the per-tag factory
// files re-assembled into the `symbol` namespace by `./index.ts`; the shared bake fn
// + contract types live in `./_bake.js`.
//
// The tagged template carries `name: human description`; it returns a GENERIC fn so
// TS infers the contract first, then checks the impl against the DECODED types. A
// wrong-typed impl is a COMPILE error — that inference is the load-bearing proof.

import {
  bakeNative,
  parseNameDoc,
  type Contract,
  type Impl,
  type NativeSymbolDef,
  type RestSpec,
  type VectorSpec,
} from "./_bake.js";

/** Native host fn over SCHEME VALUES (no ctx, no validation). The schemas are
 *  scheme-identity; the impl receives the terms. `Rest` (inferred from `contract.inputRest`,
 *  defaulting to `undefined`) is the fixed-prefix-plus-rest split — see `Contract`/`Impl` in
 *  `_bake.ts`. Absent `inputRest` ⇒ `Rest` stays `undefined` and `impl`'s signature is
 *  byte-identical to before `inputRest` existed. */
export function native(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: Contract<I, O, Rest>,
    impl: Impl<I, O, Rest>,
  ): NativeSymbolDef => bakeNative({ kind: "native", name, doc, contract, impl });
}
