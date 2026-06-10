// @here.build/arrival-codemirror — CodeMirror 6 support for arrival scheme.
//
// The language (classic + sweet superset, semantic tags only), the parameter
// inlay hints, and the IDE extensions (diagnostics / hover / completion /
// go-to-definition) over the `SchemeIdeBackend` seam — arrival-type-lens's
// language service plugs in as-is (`@here.build/arrival-type-lens/browser` in
// an SPA), or any structurally-equal backend (e.g. worker-hosted).

export { schemeSweet } from "./scheme-sweet.js";
export { paramHintsExtension } from "./param-hints.js";
export {
  schemeStructural,
  schemeStructuralKeymap,
  expandSelection,
  contractSelection,
  slurpForward,
  barfForward,
  spliceForm,
  killSexp,
  forceDeleteBackward,
  schemeIndentAt,
  type SchemeStructuralOptions,
} from "./structural.js";
export { schemeGhost, pickGhost, lineTailIsSafe, type SchemeGhostOptions } from "./ghost.js";
export {
  schemeIde,
  schemeLinter,
  schemeHover,
  schemeCompletion,
  schemeCompletionSource,
  schemeGotoDefinition,
  schemeSemanticHighlight,
  classificationsToDecorations,
  toCmDiagnostics,
  toCmCompletions,
  type SchemeIdeBackend,
  type SchemeNeuralRanker,
  type SchemeCompletionOptions,
  type SchemeIdeRichCompletion,
  type SchemeIdeCompletionContext,
  type SchemeIdeDiagnostic,
  type SchemeIdeQuickInfo,
  type SchemeIdeCompletionEntry,
  type SchemeIdeDefinition,
  type SchemeIdeClassifiedSpan,
  type SchemeIdeOptions,
  type SchemeLinterOptions,
  type SchemeSemanticHighlightOptions,
} from "./ide.js";
