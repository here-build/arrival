// rules.ts — the scheme-for-dummies RULE REGISTRY (pure kernel, primitive 1): the stable IDs every constrained-decode gate decision is
// attributed to, so a sweep can answer "rule R fired in X% of FAILING vs Y% of SUCCESSFUL decodes for model M"
// (per-model × per-rule activation). The prose catalog is docs/working-proposals/scheme-for-dummies-rules.md;
// THIS is the canonical machine list it tracks.
//
// HOW ATTRIBUTION FLOWS. Each gate returns its DECISIVE rule (a `RuleId | null`, null ⇒ no decision); the Σ
// gate returns `{ admit, rule }` (a forgive rule admits, an enforce rule masks). `classifyCandidate` fires an
// {@link OnRuleHit} with the first decisive rule (it short-circuits, so the decisive rule is unambiguous). The
// decode loop enriches each {@link RuleHit} into a {@link RuleFireEvent} with the model/entry/step/rank/prob it
// owns. Zero-overhead when the tap is undefined — every site guards on it (the `onExplain`/`omittedTopN`
// contract).

/** A stable catalog rule ID — the tightenings (ENFORCE) and forgivenesses (FORGIVE/HYBRID) the constrained
 *  tool-call gate layers on top of arrival's base structural + Σ oracle. */
export type RuleId =
  // ENFORCE — the tool-call grammar tightening (violatesToolCallGrammar)
  | "R-UNQUOTE-QUASI"
  | "R-POST-QUOTE-PAREN"
  | "R-PHANTOM-LIST"
  | "R-HEAD-IS-SYMBOL"
  // ENFORCE — the collection-literal validity mirrors (the reader's own rejections, enforced at Σ so the
  // sampler admits EXACTLY what the reader reads — see spec/corpus/collection-literals-read.jsonl). Each
  // mirrors a stable reader error code. (R-NO-BRACKETS — the blanket `[`/`]` ban — was RETIRED when the
  // reader gained `[a b c]` vector / `{:k v}` dict literals: it had become a style rule, and every
  // sampler-forced token off the model's top choice is off-policy contamination. Σ's contract is
  // validity, never style.)
  | "R-BRACKET-MISMATCH" // E-BRACKET-MISMATCH — a closer that doesn't pair the innermost open bracket
  | "R-DICT-KEY" // E-DICT-BAD-KEY — a dict key must open as keyword `:k`, string, or unquote form
  | "R-DICT-ARITY" // E-DICT-ODD-ARITY — `}` closing a dict with an odd element count (a key sans value)
  | "R-DICT-DUP-KEY" // E-DICT-DUP-KEY — a completed literal key repeating an earlier literal key
  | "R-LITERAL-DOT" // E-LITERAL-DOT — a dotted pair `.` inside a vector/dict literal
  | "R-EXPECTING-DATUM" // E-EXPECTING-DATUM — a closer while an unquote still awaits its datum
  // ENFORCE — the type-derived structure gates (violatesValueStructure / violatesElementStructure)
  | "R-ARRAY-REJECTS-SCALAR"
  | "R-SCALAR-REJECTS-LIST"
  | "R-STRINGSLOT-REJECTS-NONSTRING"
  | "R-REACHABILITY-ARRAY-HEAD"
  | "R-ELEM-FORCE-QUOTE" // HYBRID — forgives a single bare word by quoting it, masks a multi-word split
  // ENFORCE — the opt-in per-call profile shapes (violatesProfile)
  | "R-KWARGS-ARITY"
  | "R-KWARGS-KEY-NARROW"
  | "R-POSKEYED-ORDER"
  // ENFORCE — the Σ layer (passesSigmaOnState) + the EOS gate
  | "R-ELEM-ENUM-NARROW"
  | "R-LITERAL-NOT-OPERATOR"
  | "R-EOS-CLOSEABLE"
  // FORGIVE — admits something Σ / structure would otherwise mask
  | "R-BARE-WORD-STRING"
  | "R-LITERAL-ARG-EXEMPT"
  | "R-KEYWORD-ACCESSOR"
  | "R-QUOTE-LIST-ARRAY"
  | "R-ATOM-STAYS-OPEN"
  | "R-FENCE-STEER";

export type RuleKind = "enforce" | "forgive" | "hybrid";

/** The catalog axis for every rule. `enforce` rules MASK; `forgive` rules ADMIT (a decisive override of a
 *  would-be mask); `hybrid` forgives one shape and masks its over-reaching twin (R-ELEM-FORCE-QUOTE). */
export const RULE_KIND: Record<RuleId, RuleKind> = {
  "R-UNQUOTE-QUASI": "enforce",
  "R-POST-QUOTE-PAREN": "enforce",
  "R-PHANTOM-LIST": "enforce",
  "R-HEAD-IS-SYMBOL": "enforce",
  "R-BRACKET-MISMATCH": "enforce",
  "R-DICT-KEY": "enforce",
  "R-DICT-ARITY": "enforce",
  "R-DICT-DUP-KEY": "enforce",
  "R-LITERAL-DOT": "enforce",
  "R-EXPECTING-DATUM": "enforce",
  "R-ARRAY-REJECTS-SCALAR": "enforce",
  "R-SCALAR-REJECTS-LIST": "enforce",
  "R-STRINGSLOT-REJECTS-NONSTRING": "enforce",
  "R-REACHABILITY-ARRAY-HEAD": "enforce",
  "R-ELEM-FORCE-QUOTE": "hybrid",
  "R-KWARGS-ARITY": "enforce",
  "R-KWARGS-KEY-NARROW": "enforce",
  "R-POSKEYED-ORDER": "enforce",
  "R-ELEM-ENUM-NARROW": "enforce",
  "R-LITERAL-NOT-OPERATOR": "enforce",
  "R-EOS-CLOSEABLE": "enforce",
  "R-BARE-WORD-STRING": "forgive",
  "R-LITERAL-ARG-EXEMPT": "forgive",
  "R-KEYWORD-ACCESSOR": "forgive",
  "R-QUOTE-LIST-ARRAY": "forgive",
  "R-ATOM-STAYS-OPEN": "forgive",
  "R-FENCE-STEER": "forgive",
};

/** The tool-call GRAMMAR tightening rules (`violatesToolCallGrammar`) — the "shape of a call" axis (quoting,
 *  brackets, phantom lists, the operator-head-is-a-symbol constraint). Mirrors the `RuleId` union's own
 *  "ENFORCE — the tool-call grammar tightening" comment group (this IS that group, made machine-checkable).
 *  Consumed by `buildStepExplain`'s opt-in nucleus classifier to report a candidate's `grammarOK`. */
export const GRAMMAR_RULE_IDS: ReadonlySet<RuleId> = new Set<RuleId>([
  "R-UNQUOTE-QUASI",
  "R-POST-QUOTE-PAREN",
  "R-PHANTOM-LIST",
  "R-HEAD-IS-SYMBOL",
  "R-BRACKET-MISMATCH",
  "R-DICT-KEY",
  "R-DICT-ARITY",
  "R-DICT-DUP-KEY",
  "R-LITERAL-DOT",
  "R-EXPECTING-DATUM",
]);

/** The TYPE-DERIVED structure gates (`violatesValueStructure` / `violatesElementStructure`) — the "value
 *  shape matches the declared type" axis (array-vs-scalar, string-slot, reachability, element-quoting).
 *  Mirrors the `RuleId` union's "ENFORCE — the type-derived structure gates" comment group. Consumed by
 *  `buildStepExplain`'s opt-in nucleus classifier to report a candidate's `typeOK`. */
export const TYPE_STRUCTURE_RULE_IDS: ReadonlySet<RuleId> = new Set<RuleId>([
  "R-ARRAY-REJECTS-SCALAR",
  "R-SCALAR-REJECTS-LIST",
  "R-STRINGSLOT-REJECTS-NONSTRING",
  "R-REACHABILITY-ARRAY-HEAD",
  "R-ELEM-FORCE-QUOTE",
]);

/** Whether a rule firing MASKED the candidate (enforce) or ADMITTED it past a would-be mask (forgive). */
export type RuleDecision = "masked" | "admitted";

/** One rule firing at a single candidate decision point — the gate layer's contribution, before the decode
 *  loop enriches it with its context. `decision` follows the kind: enforce ⇒ masked, forgive ⇒ admitted. */
export interface RuleHit {
  readonly ruleId: RuleId;
  readonly decision: RuleDecision;
  /** The detokenized candidate chunk this fire is about (for spot-audit). */
  readonly candidate: string;
}

/** The per-candidate tap `classifyCandidate` calls when a rule is decisive. Undefined ⇒ no instrumentation. */
export type OnRuleHit = (hit: RuleHit) => void;

/** The full per-fire record the sweep aggregates — a {@link RuleHit} enriched with the decode context the loop
 *  owns. `rank` is the candidate's index in the prob-desc walk (0 = argmax); `prob` its model probability (the
 *  over-masking weight when an enforce rule drops a high-prob token). */
export interface RuleFireEvent {
  readonly ruleId: RuleId;
  readonly kind: RuleKind;
  readonly decision: RuleDecision;
  readonly candidate: string;
  readonly model: string;
  readonly entry: string;
  readonly step: number;
  readonly rank: number;
  readonly prob: number;
}
