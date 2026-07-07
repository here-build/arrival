// @here.build/arrival-codemirror — CodeMirror 6 for arrival Scheme (classic + sweet).
//
// Exports the language (schemeSweet), param hints, structural editing, ghost,
// and IDE surface (linter/hover/completion/goto/sem-highlight) over a
// `SchemeIdeBackend` seam. The backend may be sync or async; arrival-type-lens
// (browser or worker) fits directly. All coordinates are classic Scheme.

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
export { sweetIdeBackend } from "./sweet-ide.js";
export {
  schemeIde,
  schemeLinter,
  schemeHover,
  schemeCompletion,
  schemeCompletionSource,
  schemeGotoDefinition,
  type SchemeGotoDefinitionOptions,
  schemeSemanticHighlight,
  classificationsToDecorations,
  toCmDiagnostics,
  toCmCompletions,
  type SchemeIdeBackend,
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
