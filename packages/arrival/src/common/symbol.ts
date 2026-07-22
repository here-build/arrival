// symbol — the stable entry for the `arrival.symbol*` EnvCapability symbol-definition API.
//
// This module is the package's public seam (`@inhuman.tools/arrival/symbol` subpath + the root
// re-export). Everything below is re-exported HERE, rather than from its defining module, so a
// consumer imports from this ONE stable specifier; each group's note adds only what is non-obvious
// about that group, never the stable-path reason again. It surfaces TWO things:
//
//   • the `symbol` NAMESPACE — `export * as symbol from "./symbols/index.js"`, one factory
//     module per tag (`native`/`rosetta`/`tagless`/…), barrel-re-exported so the bundler can
//     drop the tags a consumer doesn't touch (`sideEffects:false` tree-shaking).
//
//   • the contract/`AEntity` TYPES — re-exported from `./symbols/_bake.js` (the shared machinery
//     the factory files stand on), imported by `capability.ts` (`SymbolDeclaration`), the
//     type-layer printer (`AEntity`), and the `symbol.test-d.ts` proofs (`DecodedArgs`/`DecodedReturn`).
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

// `resolveMethod` — the shared tagless-final dispatch primitive `bakeTagless`/`bakeTaglessGuard`
// stand on. Also the intended shared primitive for a `symbol.sequence` impl that dispatches to a
// receiver's own term method (map/filter/sort) — surfaced here so those call sites reuse ONE
// resolver instead of each hand-rolling the identical `receiver as Record<string,unknown>` cast.
export { resolveMethod } from "./symbols/_bake.js";

// The contract machinery + the baked `AEntity` union and its members.
export type {
  VectorSpec,
  SpecInfer,
  DecodedArgs,
  RestSpec,
  DecodedArgsWithRest,
  DecodedReturn,
  MaybePromise,
  Contract,
  Impl,
  ProvenanceRole,
  CacheClass,
  CallbackRole,
  CallbackRoles,
  NativeSymbolDef,
  RosettaSymbolDef,
  TaglessSymbolDef,
  TaglessGuardSymbolDef,
  SequenceSymbolDef,
  DoorSymbolDef,
  DoorCause,
  KeywordSymbolDef,
  MacroSymbolDef,
  DefineSymbolDef,
  DefineSyntaxSymbolDef,
  AEntity,
  BakeRuntimeOpts,
  CallCtx,
} from "./symbols/_bake.js";
export { makeCallCtx, testCallCtx } from "./symbols/_bake.js";

// Callback-role machinery (docs/PROVENANCE.md §2): `withCallbackRoles` is the
// declaration channel for the contract-less kinds (tagless/tagless-guard — reduce's
// acc-chain marker rides it); `declaresAccChain` is the data-read for the chained
// track-composition operator (spec §3); `extractCallbackRoles` is surfaced for the
// law suite (the factories call it internally at bake).
export { withCallbackRoles, withContractFields, declaresAccChain, extractCallbackRoles } from "./symbols/_bake.js";

// Re-export the generic form for convenience when using metadata.
export type { RosettaSymbolDef as RosettaSymbolDefWithMeta } from "./symbols/_bake.js";

// The per-FIELD static-or-dynamic metadata vocabulary (exec-phases-and-dynamic-metadata.md
// Part II): the field union + record type live with the def machinery (`_bake.ts`); the
// READ-time resolver (`resolveMetadata` — lazily, per read, against the assembly's
// activation) lives in its own leaf so nothing at bake time can accidentally pull it.
export type { MetadataField, MetadataRecord } from "./symbols/_bake.js";
export { resolveMetadata, staticMetadata, type ResolvedMetadata } from "./symbols/metadata.js";

// `symbol.alias` — dissolution-semantics duplicate binding. The marker type is surfaced here
// (not just consumed internally by `capability.ts`) so a capability author can name it when
// widening a `SymbolDeclaration`-adjacent type of their own.
export type { AliasSymbolDef } from "./symbols/alias.js";
