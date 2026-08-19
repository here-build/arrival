// terminal.ts — the TERMINAL VERB seam: a small set of communicative heads the constrained decode may emit to
// END a turn with a natural-language ANSWER instead of a tool call. This is the single capability that lets the
// oracle (a) ABSTAIN on an irrelevant request and (b) produce the FINAL ANSWER that closes an agentic loop —
// they are the same move: the model emits `(respond "…")` rather than `(some_tool …)`.
//
// The set is deliberately WIDER than one canonical verb. The model wasn't trained on our Scheme dialect, yet the
// live probe showed arch-1.5b NATIVELY reaching for `(display …)` / `(print …)` (common Scheme output idioms)
// exactly when it wanted to respond rather than call — and Σ was masking them. By the grammar-gate soundness
// invariant (never mask a token inside what the model correctly wants) that mask is a bug, so we admit the whole
// idiom family and let the model use whichever it reaches for. The prompt still NAMES the canonical one so that
// "you may finish with an answer" is discoverable.

/** The canonical terminal verb the prompt instructs the model to use for a final answer. */
export const CANONICAL_TERMINAL_VERB = "respond";

/** Every head treated as "the model is ending the turn with a natural-language answer" (canonical + idioms). */
export const TERMINAL_VERBS: ReadonlySet<string> = new Set([
  CANONICAL_TERMINAL_VERB,
  "answer",
  "display",
  "print",
  "say",
]);

/** Is `name` a terminal verb — a final-answer head, NOT a tool call? */
export function isTerminalVerb(name: string): boolean {
  return TERMINAL_VERBS.has(name);
}
