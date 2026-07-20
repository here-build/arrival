// symbols — the `symbol` namespace: one tagged-template factory per file, re-exported here.
//
// `../symbol.js` does `export * as symbol from "./symbols/index.js"`, so these named exports
// ARE the `symbol.<tag>` surface. One-file-per-tag + barrel re-export lets the bundler include
// only the accessed tag's module (ESM + `sideEffects:false`); a single object literal would
// reference every member and pin them all in. Shared machinery (contract types + bake helpers)
// lives in `./_bake.js`; each factory imports what it needs. Acyclic — nothing here imports
// `../symbol.js`.
//
// docs/ASSEMBLY.md §SYMBOL-KINDS — the authoritative per-kind table (what each kind bakes to,
// the runtime value it binds). The map below is navigation only; each file owns its mechanism.
//
// THE MAP — what each tag declares (each file owns its mechanism in full):
//   native        impl over SCHEME VALUES, no validation (identity schemas for .d.ts harvest)
//   rosetta       impl in JS-land behind a decode → validate → encode membrane
//   tagless       no impl — dispatch to the operand's own tagless-final method
//   taglessGuard  tagless dispatch, but #f (not throw) when the receiver can't answer
//   sequence      ctx-aware op — impl gets scheme args + the run's RunContext
//   notImplemented an omitted verb (errors-as-doors): a teaching reason, no impl
//   keyword       a special form made first-class (evaluator-dispatched, shadowable)
//   macro         a raw JS `Macro`/`Syntax` transformer, bound as-is
//   define        a scheme-bodied value/procedure declaration carrying a real contract
//   defineSyntax  a scheme-bodied macro/expander declaration
//   alias         a duplicate binding of an existing symbol under a new name

export { native } from "./native.js";
export { rosetta } from "./rosetta.js";
export { tagless } from "./tagless.js";
export { taglessGuard } from "./taglessGuard.js";
export { sequence } from "./sequence.js";
export { notImplemented } from "./notImplemented.js";
export { keyword } from "./keyword.js";
export { macro } from "./macro.js";
export { define, defineSyntax } from "./define.js";
export { alias } from "./alias.js";
