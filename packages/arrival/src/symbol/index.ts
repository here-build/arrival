// symbol — internal factory namespace module. Public consumers import from the package
// root (`@inhuman.tools/arrival`), which re-exports this namespace plus the
// contract/CallCtx keep-set.
//
// TYPE-LEVEL PROOFS of the contract inference live in `src/__tests__/symbol.test-d.ts`
// (vitest --typecheck / `test-d` script).

export * as symbol from "../common/symbols/index.js";
export type {
  VectorSpec,
  RestSpec,
  Contract,
  ProvenanceRole,
  CacheClass,
  DoorSymbolDef,
  AEntity,
} from "../common/symbols/_bake.js";
export type { CallCtx } from "../run/CallCtx.js";
export { makeCallCtx, testCallCtx } from "../run/CallCtx.js";
export { withContractFields } from "../common/symbols/_bake.js";
