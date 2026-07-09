// symbol — the stable entry for the `arrival.symbol*` EnvCapability symbol-definition API.
//
// This module is the package's public seam (`@here.build/arrival/symbol` subpath + the root
// re-export). It surfaces TWO things:
//
//   • the `symbol` NAMESPACE — `export * as symbol from "./symbols/index.js"`, one factory
//     module per tag (`native`/`rosetta`/`tagless`/…), barrel-re-exported so the bundler can
//     drop the tags a consumer doesn't touch (`sideEffects:false` tree-shaking).
//
//   • the contract/`AEntity` TYPES — re-exported from `./symbols/_bake.js` (the shared machinery
//     the factory files stand on). Kept on THIS path so `capability.ts` (`SymbolDeclaration`), the
//     type-layer printer (`AEntity`), and the `symbol.test-d.ts` proofs (`DecodedArgs`/`DecodedReturn`)
//     import them from one stable specifier.
//
// TYPE-LEVEL PROOFS of the contract inference (a zod contract → the decoded impl arg/return types)
// live in the vitest TYPE-TEST `src/__tests__/symbol.test-d.ts`, run under `vitest --typecheck`
// (the `test-d` script / vitest.typecheck.config.ts) — both package tsconfigs EXCLUDE the test
// dirs, so a plain `*.test.ts` would never be typechecked; `tsconfig.typecheck.json` re-includes
// the `*.test-d.ts` proofs, so a type regression fails CI as a real test instead of riding the build.

// The authored-extension symbol API. `import { symbol } from "@here.build/arrival/symbol"` (or
// the package root) → `symbol.native` + a `name: doc` template + `(contract, impl)`.
export * as symbol from "./symbols/index.js";

// `resolveMethod` — the shared tagless-final dispatch primitive `bakeTagless`/`bakeTaglessGuard`
// stand on. Also the intended shared primitive for a `symbol.sequence` impl that dispatches to a
// receiver's own term method (map/filter/sort) — surfaced here so those call sites reuse ONE
// resolver instead of each hand-rolling the identical `receiver as Record<string,unknown>` cast.
export { resolveMethod } from "./symbols/_bake.js";

// The contract machinery + the baked `AEntity` union and its members. Surfaced here (not from
// `./symbols/_bake.js` directly) so the public type path is the stable `common/symbol.js`.
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
  NativeSymbolDef,
  RosettaSymbolDef,
  TaglessSymbolDef,
  TaglessGuardSymbolDef,
  SequenceSymbolDef,
  DoorSymbolDef,
  KeywordSymbolDef,
  MacroSymbolDef,
  AEntity,
  BakeRuntimeOpts,
  CallCtx,
} from "./symbols/_bake.js";
export { makeCallCtx, testCallCtx, missingCallCtxDoor } from "./symbols/_bake.js";

// Re-export the generic form for convenience when using metadata.
export type { RosettaSymbolDef as RosettaSymbolDefWithMeta } from "./symbols/_bake.js";
