// symbols — the `symbol` namespace, one tagged-template factory per file.
//
// `../symbol.js` does `export * as symbol from "./symbols/index.js"`, so this barrel's
// named exports ARE the `symbol.<tag>` surface: `symbol.native\`…\``, `symbol.rosetta\`…\``,
// etc. resolve to the matching factory file. Splitting one-per-file + barrel-re-export lets
// the bundler include only the accessed tag's module (ESM + `sideEffects:false`), where the
// old single object literal referenced every member and pinned them all in.
//
// The shared machinery (the `bake*` fns + contract types) lives in `./_bake.js`; each factory
// imports what it needs from there. The cut is acyclic — nothing here imports `../symbol.js`.

export { native } from "./native.js";
export { rosetta } from "./rosetta.js";
export { tagless } from "./tagless.js";
export { taglessGuard } from "./taglessGuard.js";
export { sequence } from "./sequence.js";
export { notImplemented } from "./notImplemented.js";
export { keyword } from "./keyword.js";
export { macro } from "./macro.js";
