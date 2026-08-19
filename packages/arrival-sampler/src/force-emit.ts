// force-emit.ts — the singleton force-emit mechanic (pure kernel, primitive 1).
//
// Model-free interfaces + implementation. Token/ControlledEvaluateInputItem are imported as
// TYPES ONLY (erased at compile time). The interfaces are generic over backend id brand so the
// same types work for llama (`Token`) and scripted/test backends (`number`).

import type { Token } from "node-llama-cpp";

import type { ToolCallProfile } from "./mask-compiler.js";
import type { OracleScanner } from "./oracle-types.js";
import { scanPositionalKeyedTopLevel } from "./profile-gates.js";
import { isLiteralValue, trailingAtom } from "./scheme-atoms.js";

/** One {@link ForceEmitSequence} evaluate-input item, generic over the backend's id brand `Id` (the llama
 *  backend's `Token` by default, `number` for the scripted double). Mirrors node-llama's
 *  `ControlledEvaluateInputItem` — a bare id, or an `[id, { generateNext }]` pair — at the SINGLE shape the
 *  decode path uses, so the real `LlamaContextSequence.controlledEvaluate` still satisfies the interface. */
export type ControlledEvaluateInput<Id extends number = Token> =
  | Id
  | [token: Id, options: { generateNext?: { probabilities?: boolean } }];

/** The minimal model surface {@link tryForceEmitSingleton} needs (a tokenizer round-trip + a sequence
 *  commit) — and the SAME surface the abstract `DecodeBackend` exposes as `model`. Generic over the id brand
 *  `Id`: the real {@link LlamaModel} satisfies `ForceEmitModel<Token>`, the scripted backend supplies
 *  `ForceEmitModel<number>`, and a model-free test supplies a stub. */
export interface ForceEmitModel<Id extends number = Token> {
  /** Tokenize `text` to ids. `specialTokens` is forwarded; the force-emit always passes `false` (the forced
   *  text is ordinary scheme, never a chat-delimiter). */
  tokenize(text: string, specialTokens?: boolean): Id[];
  /** Detokenize ids back to a string — used to VERIFY the tokenization round-trips before committing. */
  detokenize(tokens: readonly Id[]): string;
}

/** The minimal sequence surface {@link tryForceEmitSingleton} needs: commit token(s) and read the successor
 *  distribution after the last (the `controlledEvaluate` shape), with the rollback boundary primitives.
 *  Generic over the id brand `Id`; the real `LlamaContextSequence` satisfies `ForceEmitSequence<Token>`. */
export interface ForceEmitSequence<Id extends number = Token> {
  readonly nextTokenIndex: number;
  controlledEvaluate(
    input: ControlledEvaluateInput<Id>[],
  ): Promise<Array<undefined | { next: { probabilities?: ReadonlyMap<Id, number> } }>>;
  eraseContextTokenRanges(ranges: { start: number; end: number }[]): Promise<void>;
}

/** The outcome of a force-emit: the string committed (always `forced.remaining`) and the successor
 *  distribution after the last forced token (so the loop resumes exactly as a normal step would). */
interface ForceEmitResult<Id extends number = Token> {
  readonly committed: string;
  readonly dist: ReadonlyMap<Id, number> | undefined;
}

/**
 * THE SINGLETON FORCE-EMIT (the positional-keyed mode's near-zero-cost mechanic, and the overnight spike
 * gate). At a slot where the oracle+profile admit EXACTLY ONE symbol (a forced required keyword, or a Σ value
 * singleton — see {@link forcedSymbol}), the model has no real choice: the constrained greedy decode would
 * walk to that one symbol regardless of its logits. So instead of running `pickConstrained` token-by-token,
 * we EMIT the symbol's remaining tokens directly (one `controlledEvaluate` committing all of them, reading
 * the successor distribution after the last) — skipping the model pick on the forced tokens.
 *
 * THE GUARANTEE, AND HOW HARD IT IS. The mechanic reproduces the EXACT PROGRAM STRING a non-skipped masked
 * greedy decode would produce at this slot — it appends precisely `forced.remaining`, the same characters the
 * masked walk would (the masked walk can only emit live-prefixes-of-the-one-symbol, so it lands on the same
 * string). It is NOT guaranteed to commit the same TOKEN IDS the model's masked walk would (the model might
 * tokenize the symbol differently than `model.tokenize` does); the program is a string and scoring is on the
 * string, so program-identity holds, token-identity does not. That is why this fires ONLY under a profile (an
 * opt-in shape) and ONLY at τ≤0 — never on the no-profile greedy path where loop-parity asserts token-level
 * identity.
 *
 * THE ROUND-TRIP GUARD (why this is SAFE even though node-llama-cpp does not promise a tokenizer round-trip).
 * Before committing, we tokenize `forced.remaining` and verify `detokenize(ids) === forced.remaining` EXACTLY
 * — node-llama-cpp warns it may add leading spaces around tokens, which would corrupt the program. If the
 * round-trip does not reproduce the exact string (a leading-space artifact, an unexpected merge), we return
 * null and the caller falls back to the normal `pickConstrained` decode. So the force-emit can NEVER write a
 * wrong string: it either reproduces the forced symbol byte-for-byte or declines and lets the model decode.
 *
 * Returns null (→ caller decodes normally) when: no singleton at this slot; the round-trip guard fails; or
 * the tokenization is empty. On a successful commit it returns the committed string + the new distribution.
 * On a `controlledEvaluate` failure that advanced the KV it rolls back to the pre-commit boundary, then
 * rethrows (the same G3 restore-or-abort contract the main step uses).
 */
export async function tryForceEmitSingleton<Id extends number = Token>(
  scanner: OracleScanner,
  prefix: string,
  profile: ToolCallProfile,
  model: ForceEmitModel<Id>,
  seq: ForceEmitSequence<Id>,
): Promise<ForceEmitResult<Id> | null> {
  const forced = forcedSymbol(scanner, prefix, profile, trailingAtom(prefix));
  if (forced === null) return null;
  // Tokenize the REMAINING suffix as ordinary text (never special tokens). Round-trip GUARD: the forced
  // tokens must detokenize to EXACTLY the remaining string — else a leading-space/merge artifact would
  // corrupt the program, so we decline and let the model decode this slot normally.
  const ids = model.tokenize(forced.remaining, false);
  if (ids.length === 0) return null;
  if (model.detokenize(ids) !== forced.remaining) return null;
  // Commit all forced tokens in ONE controlledEvaluate, requesting the successor distribution ONLY after the
  // last (the same shape the prefill uses). G3 restore-or-abort: capture the boundary; on a failure that
  // advanced the KV, erase back to it before rethrowing so a dirty KV never corrupts the returned program.
  const input: ControlledEvaluateInput<Id>[] = [
    ...ids.slice(0, -1),
    [ids.at(-1)!, { generateNext: { probabilities: true } }],
  ];
  const boundary = seq.nextTokenIndex;
  try {
    const out = await seq.controlledEvaluate(input);
    return { committed: forced.remaining, dist: out.at(-1)?.next.probabilities };
  } catch (error) {
    if (seq.nextTokenIndex > boundary) {
      await seq.eraseContextTokenRanges([{ start: boundary, end: seq.nextTokenIndex }]);
    }
    throw error;
  }
}

// ── SINGLETON FORCE-EMIT — the slot where exactly one symbol is feasible (skip the model on it) ──────────

/** A forced continuation: the FULL symbol that is the ONLY feasible continuation at the cursor, plus the
 *  `remaining` suffix still to type (the symbol minus the trailing atom already in the prefix). The decoder
 *  emits `remaining`'s tokens WITHOUT a model pick (see {@link forcedSymbol}). */
export interface ForcedSymbol {
  /** The complete symbol string (e.g. `:location`, or a Σ value-symbol like `celsius`). */
  readonly symbol: string;
  /** The portion still to emit = `symbol` with the already-typed trailing atom stripped (never empty —
   *  `forcedSymbol` returns null when nothing remains to force). */
  readonly remaining: string;
}

/**
 * THE SINGLETON FORCE-EMIT ANALYSIS (the positional-keyed mode's near-zero-cost win). At a slot where EXACTLY
 * ONE symbol can legally continue the program, the model has no real choice — the constrained greedy decode
 * would walk to that one symbol regardless of the model's logits. {@link forcedSymbol} detects that slot and
 * returns the symbol so the decoder can emit its remaining tokens DIRECTLY (skipping the forward pass on the
 * forced tokens). Two singleton sources, both requiring a `profile`:
 *
 *   (1) THE FORCED KEYWORD (positional-keyed) — at a top-level argument boundary or mid-`:keyword`, with
 *       `placed < requiredKeywords.length` keywords closed, the gate ({@link violatesPositionalKeyedProfile})
 *       admits the SINGLE keyword `:requiredKeywords[placed]` and masks every other. So if the trailing atom
 *       is empty (a boundary) or a prefix of `:requiredKeywords[placed]`, that keyword is forced.
 *   (2) A Σ VALUE SINGLETON — at an operator/argument slot where `validSymbols()` is a singleton `{sym}` and
 *       the trailing atom is a prefix of `sym`, `sym` is the only bound symbol that fits (e.g. a 1-member
 *       enum narrowed by the type lens). NOT fired for a free-form slot (validSymbols null / >1 / a literal).
 *
 * Returns null when the slot is NOT a forced singleton (the normal masked decode runs). The guarantee is at
 * the PROGRAM-STRING level: forcing `symbol` reproduces the exact substring the constrained greedy decode
 * would have produced at this slot (it walks live-prefixes-of-`symbol` to the same string). It does NOT
 * promise the same TOKEN sequence (the model's tokenization of `symbol` may differ from the canonical one) —
 * so the caller fires this ONLY under a profile (an opt-in shape), never on the no-profile greedy path where
 * token-identity is asserted (loop-parity). The caller MUST also verify its tokenizer round-trips `symbol`
 * before committing (`detokenize(tokenize(symbol)) === symbol`) — node-llama-cpp does not guarantee it.
 *
 * `frag` is the trailing atom of `prefix` (passed in to avoid a recompute by the caller).
 */
export function forcedSymbol(
  scanner: OracleScanner,
  prefix: string,
  profile: ToolCallProfile,
  frag: string,
): ForcedSymbol | null {
  // (1) The forced keyword — only under the positional-keyed variant. (2) Else a Σ value singleton.
  return forcedKeyword(prefix, profile, frag) ?? forcedSigmaSingleton(scanner, prefix, frag);
}

/** Source (1): the forced REQUIRED KEYWORD under the positional-keyed variant — at a keyword-opening slot
 *  with `placed < requiredKeywords.length`, only `:requiredKeywords[placed]` is feasible. Returns null when
 *  the profile is not positional-keyed, the cursor is not at a keyword slot, or nothing remains to force. */
function forcedKeyword(prefix: string, profile: ToolCallProfile, frag: string): ForcedSymbol | null {
  if (profile.requiredKeywords === undefined) return null;
  const st = scanPositionalKeyedTopLevel(prefix);
  const placed = st.keywords.length;
  // A keyword-OPENING slot: a boundary where the next token is a fresh keyword (NOT a value-expecting boundary
  // right after a keyword), OR mid-`:keyword`. A mid-VALUE / mid-positional cursor or a value-expecting
  // boundary is NOT a keyword slot; a closed-call cursor has no continuation. CRITICALLY, the OPERATOR must be
  // placed first — at the bare-`(` operator slot (`!seenOperator`) the function symbol is the model's (Σ-
  // picked), NOT a forced keyword; forcing here emitted `(:requiredKeywords[0]` as the operator (the live bug).
  const atKeywordSlot =
    st.seenOperator &&
    (st.inProgress === "keyword" || (st.inProgress === "none" && !st.closedCall && st.prevArgKind !== "keyword"));
  if (!atKeywordSlot || placed >= profile.requiredKeywords.length) return null;
  const forced = `:${profile.requiredKeywords[placed]}`;
  // The already-typed trailing atom must be a prefix of the forced keyword (empty at a boundary). If the model
  // somehow typed PAST a prefix (impossible under the gate, defensive) nothing is forced.
  if (!forced.startsWith(frag)) return null;
  const remaining = forced.slice(frag.length);
  return remaining === "" ? null : { symbol: forced, remaining };
}

/** Source (2): a Σ VALUE SINGLETON at an operator/argument slot — `validSymbols()` is a singleton `{sym}` and
 *  the trailing atom is a prefix of `sym`, so `sym` is the only bound symbol that fits. Returns null for a
 *  free-form slot (Σ null / >1 / a literal/keyword fragment) or when nothing remains to force. */
function forcedSigmaSingleton(scanner: OracleScanner, prefix: string, frag: string): ForcedSymbol | null {
  const state = scanner.analyze(prefix);
  if (state.position !== "operator" && state.position !== "argument") return null;
  if (state.formKind !== "application") return null;
  const valid = state.validSymbols();
  if (valid?.size !== 1) return null;
  const only = [...valid][0]; // the single bound symbol.
  // A keyword fragment is never a Σ symbol (the gate, not Σ, owns `:`); a literal-value fragment isn't a
  // symbol either. The trailing atom must be a prefix of the one symbol.
  if (frag.startsWith(":") || isLiteralValue(frag)) return null;
  if (!only.startsWith(frag)) return null;
  const remaining = only.slice(frag.length);
  return remaining === "" ? null : { symbol: only, remaining };
}
