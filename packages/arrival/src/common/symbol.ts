// symbol — the stable entry for the `arrival.symbol*` EnvCapability symbol-definition API.
//
// This module is the package's public seam (`@here.build/arrival/symbol` subpath + the root
// re-export). It surfaces TWO things, unchanged from when they lived in one file:
//
//   • the `symbol` NAMESPACE — `export * as symbol from "./symbols/index.js"`, where each tag
//     (`native`/`rosetta`/`tagless`/…) is its own module. The shape is IDENTICAL to the former
//     object literal: `symbol.native\`name: doc\`(…)`, `symbol.rosetta\`…\``, etc. resolve the same
//     for every consumer (`env/r7rs/*`, `env/srfi/*`, `env/macros.ts`, the inference verbs, MCP).
//     The split (one factory per file under `./symbols/`, barrel-re-exported) is purely so the
//     bundler can drop the tags a consumer doesn't touch — the old literal referenced every member
//     in one module, so `sideEffects:false` tree-shaking couldn't prune any.
//
//   • the contract/`SymbolDef` TYPES — re-exported from `./symbols/_bake.js` (the shared machinery
//     the factory files stand on). Kept on THIS path so `capability.ts` (`SymbolDef`), the type-
//     layer printer (`SymbolDef`), and the `symbol.test-d.ts` proofs (`DecodedArgs`/`DecodedReturn`)
//     import them from the same stable specifier they always have.
//
// TYPE-LEVEL PROOFS of the contract inference (a zod contract → the decoded impl arg/return types)
// live in the vitest TYPE-TEST `src/__tests__/symbol.test-d.ts`, run under `vitest --typecheck`
// (the `test-d` script / vitest.typecheck.config.ts) — both package tsconfigs EXCLUDE the test
// dirs, so a plain `*.test.ts` would never be typechecked; `tsconfig.typecheck.json` re-includes
// the `*.test-d.ts` proofs, so a type regression fails CI as a real test instead of riding the build.

// The authored-extension symbol API. `import { symbol } from "@here.build/arrival/symbol"` (or
// the package root) → `symbol.native` + a `name: doc` template + `(contract, impl)`.
export * as symbol from "./symbols/index.js";

// The contract machinery + the baked `SymbolDef` union and its members. Surfaced here (not from
// `./symbols/_bake.js` directly) so the public type path is the stable `common/symbol.js`.
export type {
  VectorSpec,
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
  SymbolDef,
  BakeRuntimeOpts,
  InvocationContext,
} from "./symbols/_bake.js";
