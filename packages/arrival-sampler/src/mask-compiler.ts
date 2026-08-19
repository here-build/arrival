// mask-compiler.ts — the char-vs-token bridge and core gate composer (pure kernel, primitive 1).
//
// This is the canonical implementation of `isCandidateLive`, `compileMask`, Σ + structural gates.
// It is deliberately substrate-free (no node, no llama, browser-safe).
//
// Provenance: this is the foundation-side home of sift's `src/sampler/mask-compiler.ts`. The
// dependency arrow runs foundation → foundation (arrival-sampler → arrival-scheme), NEVER importing
// sift. sift's copy should later re-export from here (see README, "sift-dedup note"). Browser-safe:
// no Node-only APIs.
//
// The oracle works on SOURCE CHARACTERS; a model emits BPE TOKENS that don't align to scheme tokens
// (one model token may be "(net" = paren + partial symbol). So the mask is never "is this token
// valid" — it is **feasible(acceptedPrefix + tokenString)**: does appending this token's string
// leave a live prefix (extendable to some valid program)? That single query, run over the model's
// vocabulary, IS the per-step structural logit mask. Mid-symbol feasibility is the oracle's job;
// iterating the vocab is ours.
//
// Σ (bound-symbol) masking is layered ON TOP of structural feasibility here, because arrival's
// `scanner.feasible` is structural-only by design (`feasible` is env-independent — see
// arrival-scheme oracle/scanner.ts). To make an UNBOUND OPERATOR ungeneratable, we consult
// `analyze(next).validSymbols()`: if the candidate leaves the cursor mid-atom at a Σ-constrained
// position (operator/argument of an application), the in-progress atom fragment must be a PREFIX of
// some bound symbol (numbers/literals are exempt — Σ doesn't bind them). When `validSymbols()` is
// null (structural-only oracle, or a top/quote position) the Σ gate is skipped — graceful
// degradation, identical to the structural mask.
//
// EOS is handled separately: the end-of-sequence token is allowed iff the program is COMPLETE-ABLE
// at the cursor (`analyze(prefix).closeable`) — so a truncated, unbalanced program is
// ungeneratable, which is the whole point.

import type { OracleScanner, OracleSession, OracleState } from "./oracle-types.js";
import { violatesProfile } from "./profile-gates.js";
import type { OnRuleHit, RuleId } from "./rules.js";
import {
  ATOM_TERMINATOR,
  isLiteralValue,
  isLiveMemberPrefix,
  isLiveSymbolPrefix,
  trailingAtom,
} from "./scheme-atoms.js";
import { scanToolCallGrammar, violatesElementStructure, violatesValueStructure } from "./structural-gates.js";

// Back-compat re-exports — the export surface stays UNCHANGED (except the force-emit singleton symbols,
// now homed in force-emit.ts) so every importer of the symbols moved out of this file keeps resolving
// them here.
export { trailingAtom } from "./scheme-atoms.js";
export { violatesValueStructure } from "./structural-gates.js";

/**
 * THE KWARGS TOOL-CALL PROFILE — an OPT-IN, per-call tightening (pure kernel / primitive 1).
 * Turns the optional-argument decision into a STRUCTURAL one enforced by the sampler.
 * The base grammar admits any bare value; with a profile the gate enforces the exact shape:
 *
 *   (fn  pos1 pos2 … pos_requiredCount   [:optkey value]…)
 *
 * i.e. EXACTLY `requiredCount` positional arguments (the schema's required params, forced present, in
 * declaration order), then 0+ optional params each written as a `:keyword value` pair (keywords drawn from
 * `optionalKeywords`, any order, omittable). After the required positionals the only legal continuations at
 * the top-level argument slot are **`:` (open a kwarg) or `)` (done)** — a bare positional value past the
 * required count is masked, so the model CANNOT mis-fill an optional positional slot (the failure this mode
 * exists to kill).
 *
 * The profile is consulted ONLY by {@link passesSigmaOnState} and ONLY when present. Every other call
 * path is byte-identical. See the bfcl `grammar-kwargs` / `positional-keyed` modes (primitive 3).
 *
 * POSITIONAL-KEYED variant — when {@link requiredKeywords} is present, the call shape is instead
 *
 *   (fn  :req1 v1  :req2 v2  … :req_n vn   [:optkey value]…)
 *
 * i.e. EVERY argument (required AND optional) is a `:keyword value` pair, the required keywords FORCED in
 * declaration order (the i-th top-level keyword MUST be `requiredKeywords[i]`), then optional keywords from
 * `optionalKeywords`. A bare positional is ALWAYS illegal here; the call may close ONLY once every required
 * keyword has been placed. The gate that enforces this is {@link violatesPositionalKeyedProfile}; in this
 * variant `requiredCount` is ignored (the kwargs `violatesKwargsProfile` path never runs). Each required
 * keyword's value slot then has EXACTLY ONE feasible symbol — its keyword — which the decoder may
 * force-emit, skipping the model on the forced keyword tokens (see the bfcl `positional-keyed` mode).
 */
export interface ToolCallProfile {
  /** How many positional arguments the call must carry before any keyword — the schema's required-param
   *  count. Once this many top-level positionals are placed, a further BARE value is masked. Ignored in the
   *  POSITIONAL-KEYED variant (`requiredKeywords` present), where there are no bare positionals at all. */
  readonly requiredCount: number;
  /** The legal optional-argument keywords (WITHOUT the leading `:`). After a `:` at the top-level argument
   *  slot the in-progress keyword fragment must be a prefix of one of these (overrides the blanket
   *  `:`-admit, but only when a profile is present). */
  readonly optionalKeywords: readonly string[];
  /** POSITIONAL-KEYED variant (opt-in): the REQUIRED-argument keywords (WITHOUT the leading `:`), in
   *  DECLARATION ORDER. When present, {@link violatesPositionalKeyedProfile} replaces the kwargs gate: the
   *  i-th top-level keyword must equal `requiredKeywords[i]` (forced in order), no bare positional is ever
   *  legal, and the call closes only after all of these are placed. Absent ⇒ the kwargs/positional shape
   *  (`requiredCount` positionals first) is enforced and this path is inert. */
  readonly requiredKeywords?: readonly string[];
}

/** The minimal view of a model tokenizer the mask needs: enumerate (id → string) and name the
 *  EOS id. A real backend adapts its tokenizer to this (see tokenizer-adapter.ts); a test supplies
 *  a toy vocab. */
export interface Tokenizer {
  /** Every non-special vocabulary entry as (id, decoded string). EOS/control tokens excluded. */
  entries(): Iterable<{ id: number; str: string }>;
  /** The end-of-sequence token id (gated by `closeable`). */
  eosId: number;
}

/** The compiled mask for one decode step: the set of token ids the sampler may choose from. */
export interface TokenMask {
  /** Allowed token ids (including `eosId` iff the program is closeable here). */
  allowed: Set<number>;
  /** How many vocab entries the oracle admitted (excl. EOS) — for telemetry / over-constraint
   *  alarms (an empty structural mask is a bug, never a valid state mid-program). */
  admitted: number;
  /** True iff EOS is permitted here (the program is complete-able). */
  canEnd: boolean;
}

/** The Σ gate as a pure function of the cursor STATE at `next` and the trailing atom `frag` of `next`,
 *  returning whether the candidate is admitted AND the decisive catalog rule (a forgive rule admits past Σ;
 *  R-ELEM-ENUM-NARROW / R-LITERAL-NOT-OPERATOR mask). Called directly by {@link classifyCandidate} (re-scan)
 *  and {@link classifyCandidateSession} (which already holds an `OracleState` from `session.state`) so the two
 *  paths run the IDENTICAL decision — they can never diverge because they share this one body. UNCHANGED by the kwargs profile:
 *  the kwargs shape is a STRUCTURAL tightening enforced beside {@link violatesToolCallGrammar} (it must
 *  fire even when a string/literal is being OPENED, where `midToken` is false), not inside Σ. */
function passesSigmaOnState(
  st: OracleState,
  frag: string,
  literalFrame = false,
  keyAtom = false,
): { admit: boolean; rule: RuleId | null } {
  // Σ only constrains an atom being typed at an operator/argument slot of a real application.
  if (!st.midToken) return { admit: true, rule: null };
  if (st.position !== "operator" && st.position !== "argument") return { admit: true, rule: null };
  // COLLECTION-LITERAL ELEMENT (the cursor is inside a `[…]`/`{…}` literal): there is NO operator slot —
  // every position is a value position. The base scanner still models the literal as a generic application
  // frame, so it classifies the FIRST element as "operator" and its Σ set is operator-FILTERED
  // (callables-only) — masking a value symbol there would be exactly the off-policy contamination the
  // minimal-intervention principle forbids. Σ DEGRADES on that first element (admit; eval owns unbound
  // symbols, same as the reader). Later elements report "argument" and keep the argument-filtered check.
  if (literalFrame && st.position === "operator") return { admit: true, rule: null };
  // DICT-KEY atom (the suffix-keyword flip): a key is a DECLARATION, never a reference — the reader
  // accepts ANY `key:` symbol there and Σ (bound symbols) has no jurisdiction. Admit the in-progress
  // key atom pending its trailing colon; the structural mirror (finishAtom) owns a key-less completion.
  if (keyAtom) return { admit: true, rule: null };
  if (st.formKind !== "application") {
    // Σ degrades on a non-application surface (a quote-list `'(…)`) — EXCEPT an enum-typed array
    // ELEMENT, whose closed member set the type layer stamped onto the state (CUT A). Enforce it
    // DIRECTLY here (the scanner's validSymbols-narrowing needs a non-null base Σ, which a quote
    // surface lacks) so a non-member is masked on the QUOTE surface too; the `(list …)` surface
    // enforces via the application path below. Surface-symmetric with the force-quote gate.
    if (st.elementEnum != null && st.elementEnum.length > 0 && frag !== "") {
      // The element-enum domain holds RAW string-literal VALUES (`"Scenic View"`), but the model emits the
      // value's SCHEME-ATOM spelling (`Scenic_View`). Compare in atom space (project each member) so a
      // multi-word member is not split at its first separator; a genuine non-member still matches nothing.
      const ok = isLiveMemberPrefix(frag, st.elementEnum);
      return { admit: ok, rule: ok ? null : "R-ELEM-ENUM-NARROW" };
    }
    return { admit: true, rule: null };
  }
  const valid = st.validSymbols();
  if (valid === null) return { admit: true, rule: null }; // Σ not modelled (structural-only oracle or top/quote) — degrade.
  if (frag === "") return { admit: true, rule: null }; // boundary, not mid-atom (shouldn't happen given midToken, defensive).
  // `:`-keyword accessors are a member-read form, callable-like — valid at operator OR argument position.
  if (frag.startsWith(":")) return { admit: true, rule: "R-KEYWORD-ACCESSOR" };
  // Numbers / `#`-literals are valid VALUES but not callables — exempt ONLY as arguments. At operator
  // position they fall through to the callable-prefix check and are rejected (no callable is named `1`
  // or `#t`), so `(1 …)` / `(#t …)` become ungeneratable (this kills the `(1)` root-collapse).
  if (st.position === "argument" && isLiteralValue(frag)) return { admit: true, rule: "R-LITERAL-ARG-EXEMPT" };
  // SCALAR-STRING EXEMPTION (type-gated): at an ARGUMENT slot the TYPE LAYER stamped as a free-form
  // `string`/`any` (`slotIsStringy === true`, NOT array, NOT number-only), a BARE WORD is a fair
  // materialization of the string value — `(fn men)` ≡ `(fn "men")` (the membrane/scorer lowers it). So
  // admit it here even though it is an UNBOUND symbol: the model's rank-0 bare value-word (`men`,
  // `classical`) is RIGHT, and Σ would otherwise mask it and force the `'(…)` list corruption. STRICTLY
  // type-gated: number slots (`slotIsStringy` false/null), operator position, and the no-type grammar path
  // (`slotIsStringy` unset) all fall through to the bound-symbol check UNCHANGED — a bare word stays masked
  // where it is genuinely wrong. Enum slots resolve `false` (their members are bound value-symbols that pass
  // the check below unaided), so the exemption never loosens a closed enum. The `"` string opener is a
  // separate, structurally-feasible path (nothing masks it) — multi-word values still quote. The forgive is
  // DECISIVE only when the bare word is UNBOUND (otherwise Σ would admit it anyway via the prefix check).
  if (st.position === "argument" && st.slotIsStringy === true) {
    const bound = isLiveSymbolPrefix(frag, valid);
    return { admit: true, rule: bound ? null : "R-BARE-WORD-STRING" };
  }
  const live = isLiveSymbolPrefix(frag, valid);
  if (live) return { admit: true, rule: null };
  // A literal masked at the OPERATOR head is R-LITERAL-NOT-OPERATOR (`(1 …)` / `(#t …)`); a generic
  // unbound-symbol mask has no catalog rule (null — the plain "sigma" class).
  return { admit: false, rule: st.position === "operator" && isLiteralValue(frag) ? "R-LITERAL-NOT-OPERATOR" : null };
}

/** Why a candidate continuation is (in)admissible — the rejection reason behind {@link isCandidateLive}.
 *  `"feasible"` ⇒ admitted; `"structural"` ⇒ the grammar/balance rejected it (`scanner.feasible` false);
 *  `"sigma"` ⇒ structurally fine but the Σ bound-symbol gate rejected it (an unbound operator/argument
 *  atom). The metrics layer reads this to classify what a model *tried* before the mask vetoed it. */
export type CandidateClass = "feasible" | "structural" | "sigma";

/**
 * Classify a single candidate continuation (`prefix + candidateStr`) by the SAME two checks
 * {@link isCandidateLive} runs — structural `scanner.feasible` first, then the Σ gate — but return the
 * REASON rather than a boolean. `isCandidateLive` delegates here so there is exactly one oracle path
 * (no drift between the mask and the metrics classifier).
 */
export function classifyCandidate(
  scanner: OracleScanner,
  prefix: string,
  candidateStr: string,
  profile?: ToolCallProfile,
  slotState?: OracleState,
  onRuleHit?: OnRuleHit,
): CandidateClass {
  const next = prefix + candidateStr;
  if (!scanner.feasible(next)) return "structural";
  const g = scanToolCallGrammar(next); // tool-call sublanguage tightening (+ the literal-frame Σ hint)
  if (g.rule) {
    onRuleHit?.({ ruleId: g.rule, decision: "masked", candidate: candidateStr });
    return "structural";
  }
  // MID-ATOM CONTINUATION GUARD (the BUG-2 over-mask fix). The caller's `slotState` is RE-BASED
  // (`analyze(prefix + " ")`, see greedyDescend) whenever the true cursor is mid-atom at an arg/operator slot:
  // it force-closes the in-progress atom so the type-derived gates describe the NEXT value a candidate may
  // OPEN. That re-base is correct ONLY when the candidate actually CLOSES the atom (it leads with a terminator
  // → a fresh value opens). When the candidate merely EXTENDS the atom already in progress (`(fn 19`⊢`45`,
  // `(get_rou`⊢`te`, `(fn -`⊢`2`, `(fn 4.`⊢`5`), no fresh value opens — the re-based stamp is for a slot that
  // hasn't started — so the structure gates must NOT read the candidate's first char as a value-opener. Doing
  // so is the BUG-2 corruption: `1945`→`1` (spiral / full-width-unicode escape), `-2`→`2` and `4.5`→`4`
  // (silent wrong-but-valid). The discriminator is pure in `(prefix, candidateStr)`: the prefix ends mid-atom
  // iff its trailing atom is non-empty, and the candidate extends it iff its first char is NOT a terminator.
  // Σ (which re-scans `next` itself, mid-atom-aware) still governs the continuation, so a wrong symbol/number
  // continuation is still masked there — only the value-OPENER structure gates are skipped.
  const candidateFirst = candidateStr.charAt(0);
  const continuesAtom = trailingAtom(prefix) !== "" && candidateFirst !== "" && !ATOM_TERMINATOR.test(candidateFirst);
  // R-ATOM-STAYS-OPEN — the anti-misfire FORGIVE: a mid-atom continuation skips the value-opener structure
  // gates (they would otherwise read the continuation's first char as a fresh opener). Fire it as ADMITTED
  // when the protection is ACTIVE (the slotState gates would have run on this step) — i.e. a stamp is present.
  if (continuesAtom && slotState !== undefined)
    onRuleHit?.({ ruleId: "R-ATOM-STAYS-OPEN", decision: "admitted", candidate: candidateStr });
  // TYPE-DERIVED LIST-STRUCTURE gate — opt-in via the VALUE-SLOT state the caller computed ONCE this step
  // (a mask-style processor's `analyze(prefix)`; the session path uses `base.state` below). Never per-candidate
  // analyze. No-op until the type layer stamps `slotState.slotIsArray` ⇒ grammar/profile byte-identical.
  if (slotState !== undefined && !continuesAtom) {
    const v = violatesValueStructure(slotState, candidateStr);
    if (v) {
      onRuleHit?.({ ruleId: v, decision: "masked", candidate: candidateStr });
      return "structural";
    }
    // ARRAY-ELEMENT force-quote gate (CUT A) — same VALUE-SLOT state, keyed off `elementIsStringy`. Masks a
    // bare-word / nested-list element START at a string-element slot so the quoted form is forced upfront
    // (a bare multi-word element whitespace-splits at the scorer). No-op until the type layer stamps
    // `elementIsStringy` ⇒ grammar/profile byte-identical.
    const e = violatesElementStructure(slotState, candidateStr);
    if (e) {
      onRuleHit?.({ ruleId: e, decision: "masked", candidate: candidateStr });
      return "structural";
    }
  }
  // KWARGS / POSITIONAL-KEYED PROFILE (opt-in): a STRUCTURAL tightening — fires even when a string/literal
  // is being OPENED (midToken=false), so it lives here beside the grammar tightening, not inside Σ. Absent
  // profile ⇒ skipped entirely (byte-identical to the Σ-only `grammar` path). The POSITIONAL-KEYED variant
  // (`requiredKeywords` present) replaces the kwargs gate: every arg is a `:keyword value` pair.
  if (profile !== undefined) {
    const p = violatesProfile(next, profile);
    if (p) {
      onRuleHit?.({ ruleId: p, decision: "masked", candidate: candidateStr });
      return "structural";
    }
  }
  const sig = passesSigmaOnState(scanner.analyze(next), trailingAtom(next), g.literalFrame, g.keyAtom);
  if (sig.rule) onRuleHit?.({ ruleId: sig.rule, decision: sig.admit ? "admitted" : "masked", candidate: candidateStr });
  if (!sig.admit) return "sigma";
  return "feasible";
}

/**
 * The SESSION counterpart of {@link classifyCandidate}: classify `base.clone().advance(candidateStr)`
 * by the SAME two checks, but resumed from a session over the committed prefix instead of re-scanning
 * the whole `prefix + candidateStr`. `base` is a session whose accumulated prefix equals the
 * committed prefix; this clones it, advances by `candidateStr`, and reads the verdict off the clone's
 * `state` — O(candidateStr) per candidate, not O(prefix).
 *
 * Provable verdict-parity with `classifyCandidate(scanner, prefix, candidateStr)`:
 *  - STRUCTURAL: `scanner.feasible(next)` is `!scan(next).overClosed` (arrival scanner.ts). The
 *    clone's `state.overClosed` is computed from the same `scan(prefix + candidateStr)`, so
 *    `!state.overClosed === scanner.feasible(next)` byte-for-byte.
 *  - Σ: `scanner.analyze(next)` and `clone.state` are both `makeState(scan(next), next, env)` — the
 *    SAME object shape — and the gate body ({@link passesSigmaOnState}) is shared. The trailing atom
 *    `frag` is a pure function of `next = prefix + candidateStr`, recomputed identically here.
 */
export function classifyCandidateSession(
  base: OracleSession,
  prefix: string,
  candidateStr: string,
  profile?: ToolCallProfile,
  onRuleHit?: OnRuleHit,
): CandidateClass {
  const probe = base.clone();
  probe.advance(candidateStr);
  const st = probe.state;
  const next = prefix + candidateStr;
  if (st.overClosed) return "structural"; // !feasible ⇔ overClosed (arrival: feasible = !overClosed).
  const g = scanToolCallGrammar(next); // same tightening as the re-scan path (pure in `next` ⇒ parity)
  if (g.rule) {
    onRuleHit?.({ ruleId: g.rule, decision: "masked", candidate: candidateStr });
    return "structural";
  }
  // TYPE-DERIVED LIST-STRUCTURE gate — reads the PREFIX state (`base.state`, computed ONCE when the session
  // opened; free), so the session path pays nothing extra. No-op until `slotIsArray` is stamped, so
  // session-parity with the re-scan path holds (the base oracle leaves `slotIsArray` unset on both sides).
  const v = violatesValueStructure(base.state, candidateStr);
  if (v) {
    onRuleHit?.({ ruleId: v, decision: "masked", candidate: candidateStr });
    return "structural";
  }
  // ARRAY-ELEMENT force-quote gate (CUT A) — reads the SAME prefix state (`base.state`), keyed off
  // `elementIsStringy`. Pure in `(state, candidateStr)`, so session and re-scan stay verdict-identical.
  const e = violatesElementStructure(base.state, candidateStr);
  if (e) {
    onRuleHit?.({ ruleId: e, decision: "masked", candidate: candidateStr });
    return "structural";
  }
  // KWARGS / POSITIONAL-KEYED PROFILE (opt-in) — the SAME structural tightening the re-scan path applies (a
  // pure function of `next`, so session and re-scan stay verdict-identical). Absent profile ⇒ skipped.
  if (profile !== undefined) {
    const p = violatesProfile(next, profile);
    if (p) {
      onRuleHit?.({ ruleId: p, decision: "masked", candidate: candidateStr });
      return "structural";
    }
  }
  const sig = passesSigmaOnState(st, trailingAtom(next), g.literalFrame, g.keyAtom);
  if (sig.rule) onRuleHit?.({ ruleId: sig.rule, decision: sig.admit ? "admitted" : "masked", candidate: candidateStr });
  if (!sig.admit) return "sigma";
  return "feasible";
}

/** The session-path liveness predicate — {@link classifyCandidateSession} === "feasible". The
 *  bounded path uses this when `scanner.session` is available; otherwise it falls back to
 *  {@link isCandidateLive}. The two MUST agree (proven by `session-parity.test.ts`). `profile` is the
 *  opt-in kwargs tightening (threaded through identically to {@link isCandidateLive}). */
export function isCandidateLiveSession(
  base: OracleSession,
  prefix: string,
  candidateStr: string,
  profile?: ToolCallProfile,
  onRuleHit?: OnRuleHit,
): boolean {
  return classifyCandidateSession(base, prefix, candidateStr, profile, onRuleHit) === "feasible";
}

/**
 * The single-candidate liveness predicate: does appending `candidateStr` to the accepted `prefix`
 * leave a live program (STRUCTURAL feasibility `scanner.feasible(prefix + candidateStr)` AND the Σ
 * bound-symbol gate `passesSigmaOnState`)? This is the ONE check both decoders share — the eager
 * `compileMask` (vocab-wide reference) and the bounded real decode paths call the same `isCandidateLive`.
 * Delegates to {@link classifyCandidate} so the mask and metrics can never diverge.
 *
 * Incremental hook (correctness-first re-scan today): this recomputes from the whole `prefix` per
 * call. The perf path resumes a session — `OracleSession.clone().advance(candidateStr)` — instead of
 * re-scanning; that branch must yield the IDENTICAL verdict (see README).
 */
export function isCandidateLive(
  scanner: OracleScanner,
  prefix: string,
  candidateStr: string,
  profile?: ToolCallProfile,
  slotState?: OracleState,
  onRuleHit?: OnRuleHit,
): boolean {
  return classifyCandidate(scanner, prefix, candidateStr, profile, slotState, onRuleHit) === "feasible";
}

/**
 * Compile the per-step token mask: keep token `t` iff `isCandidateLive(scanner, prefix, t.str)`, and
 * admit EOS iff the program is closeable. This is the correctness-first REFERENCE form (one
 * `feasible` + one `analyze` per vocab entry — O(vocab) oracle calls/step). Real paths use the
 * bounded ranked walk via `selectConstrainedStep`.
 */
export function compileMask(scanner: OracleScanner, prefix: string, tok: Tokenizer): TokenMask {
  const allowed = new Set<number>();
  let admitted = 0;
  for (const { id, str } of tok.entries()) {
    if (isCandidateLive(scanner, prefix, str)) {
      allowed.add(id);
      admitted++;
    }
  }
  const canEnd = scanner.analyze(prefix).closeable;
  if (canEnd) allowed.add(tok.eosId);
  return { allowed, admitted, canEnd };
}
