// @here.build/arrival-sugarcoat — the sugarcoat-expression lens over scheme source.
//
// A zero-dependency leaf (its own S-expr parser; only tiny-invariant). The classic↔sugarcoat view:
// `schemeToSugarcoat` renders stored canonical scheme as a readable "sugarcoat" form (curly-infix, `=>`
// lambda, colon kwargs); `sugarcoatToScheme`/`readSugarcoat` fold an edited sugarcoat view back.
// Consumed by the studio editor toggle, codemirror, the chain-view compiler, sift's lowering, and
// provenance region-label rendering — none of which need (or pull) the eval engine.

// The curated lens surface (schemeToSugarcoat/sugarcoatToScheme/readSugarcoat/parseSexprs/printScheme/
// alignSugarcoatClassic/paramHints + their types).
export * from "./sugarcoat.js";

// Additional sugarcoat-render primitives some tools reach for directly (inline vs block rendering,
// kwarg (de)sugaring, structural node equality, the default options).
export {
  inlineSugarcoat,
  inlineScheme,
  formatSugarcoat,
  collectKwargHeads,
  inflateKwargs,
  flattenKwargs,
  nodeEq,
  DEFAULT_OPTS,
} from "./sugarcoat-render.js";

// Pair-accessor primitive — the one decomposition of a `c[ad]+r` word into its
// PULL/DROP chain, shared by the renderer (→ subscripts), the reader (← fusion),
// and the chain-view compiler (→ JS `[k]`/`.slice(k)`). One source of truth so the
// three faces can never drift.
export { decodeAccessor, encodeAccessor, accessorStepLetters, type PairStep } from "./sugarcoat-render.js";

// Lower-level sugarcoat reader utilities (single-expr read; top-form span scan) — used by the
// classic↔sugarcoat round-trip integration tests over the program corpus.
export { readSugarcoatExpr, topFormSpans, splitFormsWithBase, R7RS_ACCESSOR_DEPTH, type ReadOpts } from "./sugarcoat-read.js";
