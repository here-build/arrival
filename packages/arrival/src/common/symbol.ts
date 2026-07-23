// symbol — the stable entry for the `arrival.symbol*` EnvCapability symbol-definition API.
//
// This module is the package's public seam (`@inhuman.tools/arrival/symbol` subpath + the root
// re-export). CURATED (export restructure, docs/plans/stage-c-corpse-deletion.md
// §"Export restructure" — V's minimal-surface ruling): the ~12-name keep-set below is the
// capability-authoring contract a `symbols` callback's impl signature actually needs to name.
// Everything else this module used to re-export (the per-kind `*SymbolDef` record types, the
// tagless/rest/decode machinery, the metadata read-side, `symbol.alias`'s marker) is `_bake.js`/
// `metadata.js`/`alias.js`'s OWN surface now — an internal consumer imports those leaf modules
// directly (relative import; they were never barrel-exported to EXTERNAL consumers in the first
// place, since `_bake.ts`'s underscore prefix already signals "not a stable import path").
//
// It surfaces TWO things:
//
//   • the `symbol` NAMESPACE — `export * as symbol from "./symbols/index.js"`, one factory
//     module per tag (`native`/`rosetta`/`tagless`/…), barrel-re-exported so the bundler can
//     drop the tags a consumer doesn't touch (`sideEffects:false` tree-shaking).
//
//   • the contract/`AEntity` TYPES an impl signature names — `AEntity` (the type-layer
//     printer's + `SymbolDeclaration`'s contract-view type), `CallCtx` (a rosetta/native impl's
//     `this`), `Contract`/`VectorSpec`/`RestSpec` (the zod-tuple-to-decoded-args machinery an
//     impl signature is generic over), `CacheClass`/`ProvenanceRole` (the provenance/caching
//     declaration vocabulary), `DoorSymbolDef` (a door's own record shape, named directly by a
//     capability composing doors), `makeCallCtx`/`testCallCtx` (constructing a `CallCtx` by
//     hand — a capability composing a rosetta/native call outside the normal apply loop, and
//     the shared test harness constructor), `withContractFields` (attaching provenance-role
//     metadata to a contract).
//
// TYPE-LEVEL PROOFS of the contract inference (a zod contract → the decoded impl arg/return types)
// live in the vitest TYPE-TEST `src/__tests__/symbol.test-d.ts`, run under `vitest --typecheck`
// (the `test-d` script / vitest.typecheck.config.ts) — both package tsconfigs EXCLUDE `*.test-d.ts`
// specifically (tsconfig.json typechecks ordinary `*.test.ts` directly via `tsc --noEmit`), so a
// `.test-d.ts` proof would never be typechecked by the normal build/typecheck flow;
// `tsconfig.typecheck.json` re-includes the `*.test-d.ts` proofs, so a type regression fails CI as
// a real test instead of riding the build.

// The authored-extension symbol API. `import { symbol } from "@inhuman.tools/arrival/symbol"` (or
// the package root) → `symbol.native` + a `name: doc` template + `(contract, impl)`.
export * as symbol from "./symbols/index.js";

// The contract machinery + the baked `AEntity` union — the keep-set (see the header above for
// why each name stays).
export type { VectorSpec, RestSpec, Contract, ProvenanceRole, CacheClass, DoorSymbolDef, AEntity, CallCtx } from "./symbols/_bake.js";
export { makeCallCtx, testCallCtx } from "./symbols/_bake.js";
export { withContractFields } from "./symbols/_bake.js";
