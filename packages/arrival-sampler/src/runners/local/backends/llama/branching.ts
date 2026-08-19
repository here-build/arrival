// backends/llama/branching.ts — implementation of uncertainty branching (B1) for the llama backend.
//
// Trigger logic, per-arm depth-first decode with rewind, and resolver handoff. Part of the branching
// strategy. Depends down on kernel.

import { type Token } from "node-llama-cpp";

import type { ForceEmitModel, ForceEmitSequence } from "../../../../force-emit.js";
import { isCandidateLive, trailingAtom, type ToolCallProfile } from "../../../../mask-compiler.js";
import type { OracleScanner, OracleState } from "../../../../oracle-types.js";
import { extractSchemeForm } from "../../../generate.js";
import { hasPrefill } from "../../../../typed-scanner-async.js";
import { pickConstrained } from "../../pick-constrained.js";

// --- uncertainty branching (B1 frontier): the four-gate trigger + depth-first fork ------------------

/** §1 T1 — the top-2 PROBABILITY margin below which a split counts as "real, not noise" (60/35-or-closer). */
const BRANCH_TOP2_MARGIN = 0.25;
/** §1 T2 — the min-p-style MASS FLOOR: a candidate joins the fan-out only if its probability clears this.
 *  Bounds fan-out by the model's own dispersion; ignores the 2%-tail tokens that aren't real alternatives. */
const BRANCH_MASS_FLOOR = 0.15;
/** §2 branch factor — at most the top-2 DISTINCT lexer-entities at a fork (a 3-way intent tie at a slot is
 *  near-nonexistent in these tasks; V0 caps at 2). */
const BRANCH_WIDTH = 2;

/** A fork-arm candidate the trigger emitted: the first token, its string, prob, and the distinct set of
 *  bound symbols it keeps reachable (its "entity" — two arms are distinct iff these sets differ).
 *  EXPORTED so `BranchStrategy` (which drives the fork) can name the captured arms `branchTrigger` returns. */
export interface ForkArm {
  readonly token: Token;
  readonly str: string;
  readonly prob: number;
  /** The symbols in `validSymbols(prefix·str)` this fragment can still become — the arm's lexer-entity. */
  readonly reach: ReadonlySet<string>;
}

/** A stable signature of a reach-set for grouping arms by entity (sorted ∪ — order-independent). */
export function reachKey(reach: ReadonlySet<string>): string {
  // `[...reach]` is a fresh array; `toSorted` returns a sorted copy (lib es2023) — the order-independent
  // ∪ signature of the reach-set, never touching the input.
  return [...reach].toSorted((a, b) => a.localeCompare(b)).join(" ");
}

/**
 * §1 T3 — the symbols a candidate operator/arg fragment can still resolve to: the members of
 * `validSymbols(prefix·candStr)` for which the trailing atom is a live prefix. This is the oracle's OWN
 * answer to "where does this token land" (the gate the design says we get for free) — NOT a string guess.
 * Empty ⇒ the candidate is a literal/number or Σ is unmodelled (no symbol entity); such a candidate is not
 * an intent fork on a *tool* and is excluded from the distinct-entity grouping.
 */
function symbolReach(scanner: OracleScanner, prefix: string, candStr: string): ReadonlySet<string> {
  const next = prefix + candStr;
  const valid = scanner.analyze(next).validSymbols();
  if (valid === null) return new Set();
  const frag = trailingAtom(next);
  if (frag === "") return new Set();
  const reach = new Set<string>();
  for (const sym of valid) if (sym.startsWith(frag)) reach.add(sym);
  return reach;
}

/**
 * THE BRANCH TRIGGER (§1, all four gates). Returns the top-`BRANCH_WIDTH` DISTINCT-entity fork arms iff
 * the next-token distribution at `prefix` is a genuine intent fork: (T1) the top-2 prob margin is below
 * {@link BRANCH_TOP2_MARGIN}; (T4) the cursor is at an operator or argument slot of an application; (T2)
 * ≥2 feasible candidates clear {@link BRANCH_MASS_FLOOR}; (T3) those candidates steer to DIFFERENT bound
 * symbols (distinct {@link symbolReach} sets — not BPE spellings of one symbol). Returns null when ANY
 * gate fails (the common case — most steps are decisive), so the loop forks on essentially nothing easy.
 *
 * The arms are prob-descending (arm 0 = the greedy/highest-probability entity), the order the resolver's
 * tie-goes-to-the-model default relies on. Each arm carries ONE representative token (the highest-prob
 * token of its entity group) — decoding from it commits toward that entity; the rest of that symbol is
 * decoded greedily by the arm's sub-decode.
 */
export function branchTrigger(
  scanner: OracleScanner,
  prefix: string,
  probabilities: ReadonlyMap<Token, number>,
  eosTokens: ReadonlySet<Token>,
  model: ForceEmitModel,
  closeable: boolean,
  limit: number,
  profile?: ToolCallProfile,
  slotState?: OracleState,
): ForkArm[] | null {
  const st = slotState ?? scanner.analyze(prefix);
  // T4 — only fork at a tool-choice (operator) or argument-shape (argument) slot. A free-text string
  // interior (`midToken` inside a quote) or a top/quote position is not a discriminable intent fork.
  if (st.position !== "operator" && st.position !== "argument") return null;

  // T1 — the split must be real: top-1 vs top-2 prob margin below the floor. A decisive step (margin
  // ~0.98) is not a fork. (Closers/EOS count toward the head here — a content-vs-closer split is a
  // proxy/lookahead case, not a distinct-ENTITY fork, and is filtered out by the T3 grouping below.)
  const it = probabilities.entries();
  const p1: [Token, number] | undefined = it.next().value;
  const p2: [Token, number] | undefined = it.next().value;
  if (p1 === undefined || p2 === undefined) return null;
  if (p1[1] - p2[1] >= BRANCH_TOP2_MARGIN) return null;

  // T2+T3 — collect feasible candidates over the mass floor, compute each one's symbol-entity, and group
  // by entity (prob-descending within and across groups). A real fork needs ≥2 DISTINCT entity groups.
  const seenEntity = new Map<string, ForkArm>(); // entity-key → its highest-prob representative arm.
  let rank = 0;
  for (const [tok, prob] of probabilities) {
    if (++rank > limit) break;
    if (prob < BRANCH_MASS_FLOOR) break; // prob-descending → once below the floor, all rest are too.
    if (eosTokens.has(tok)) continue; // EOS is the "end here" event, not a tool entity.
    const str = model.detokenize([tok]);
    if (str === "" || !isContentStr(str)) continue; // closers/empties aren't entity forks.
    if (!isCandidateLive(scanner, prefix, str, profile, st)) continue; // only oracle-feasible arms (free R0 prune).
    const reach = symbolReach(scanner, prefix, str);
    if (reach.size === 0) continue; // literal/number/no-Σ → not a tool-entity fork.
    const key = reachKey(reach);
    if (!seenEntity.has(key)) seenEntity.set(key, { token: tok, str, prob, reach });
  }
  // closeable is unused by the gate proper (EOS excluded) — kept in the signature for symmetry with the
  // loop's other pickers and to document that ending-here is deliberately NOT a branch arm.
  void closeable;

  if (seenEntity.size < BRANCH_WIDTH) return null; // <2 distinct entities ⇒ not an intent fork (T2/T3).
  // Prob-descending across entity groups; keep the top-BRANCH_WIDTH (arm 0 = greedy entity).
  const arms = [...seenEntity.values()].toSorted((a, b) => b.prob - a.prob).slice(0, BRANCH_WIDTH);
  return arms;
}

/**
 * Depth-first decode of ONE fork arm to completion (the §2 frontier mechanism). Commits `firstTok` at the
 * fork, then runs the SHIPPED greedy(+proxy) constrained kernel — the identical per-step decision the main
 * loop uses (`pickConstrained` + the Tier-0 premature-closer proxy) — until EOS / `maxNewTokens`, returning
 * the extracted program. The arm does NOT re-fork (V0 budget is per-program). The sequence is left ADVANCED
 * (the arm's tokens committed onto the KV); the CALLER `eraseContextTokenRanges`-rewinds back to the fork.
 *
 * Parity note: an arm decoded greedily from a committed first token is byte-identical to what the main
 * greedy loop would have produced had it taken that token — same kernel, same oracle, same model. So the
 * greedy arm (arm 0) reproduces exactly the greedy program; branching only ever ADDS the alternative arm.
 */
export async function decodeArm(
  s: ForceEmitSequence,
  scanner: OracleScanner,
  forkPrefix: string,
  firstTok: Token,
  firstStr: string,
  eosTokens: ReadonlySet<Token>,
  model: ForceEmitModel,
  proxyInArm: boolean,
  topK: number,
  wideK: number,
  maxArmTokens: number,
  profile?: ToolCallProfile,
): Promise<{ program: string }> {
  let prefix = forkPrefix + firstStr;
  // Commit the arm's first token and read its successor distribution.
  const firstOut = await s.controlledEvaluate([[firstTok, { generateNext: { probabilities: true } }]]);
  let dist: ReadonlyMap<Token, number> | undefined = firstOut[0]?.next.probabilities;

  for (let step = 0; step < maxArmTokens; step++) {
    if (dist === undefined) break;
    const probabilities = dist;
    // Σ∩T warm-up inside the arm (mirrors the main loop) — an AsyncTypedScanner narrows the current slot.
    if (hasPrefill(scanner)) await scanner.prefill(prefix);
    // This ARM's value-slot state, computed once per arm-step (the arm has its OWN growing prefix) and
    // threaded into its pick + proxy exactly as the main loop does — so the structure gate applies in arms.
    const armSlotState = scanner.analyze(prefix);
    const closeable = armSlotState.closeable;

    const top1: [Token, number] | undefined = probabilities.entries().next().value;
    if (top1 === undefined) break;
    const preferTok = top1[0];
    const preferStr = model.detokenize([preferTok]);

    const picked = pickConstrained(
      scanner,
      prefix,
      probabilities,
      eosTokens,
      closeable,
      topK,
      wideK,
      model,
      0,
      () => 0,
      profile,
      armSlotState,
    );
    let chosenTok = picked.token;
    let chosenStr = picked.str;

    // The shipped Tier-0 premature-closer proxy, applied per-arm iff the base strategy carried it. (V0's
    // branch base is plain greedy, so this is off; kept so a future proxy+branch composition is faithful.)
    if (
      proxyInArm &&
      (eosTokens.has(preferTok) ? !closeable : !isCandidateLive(scanner, prefix, preferStr, profile, armSlotState)) &&
      isContentStr(preferStr) &&
      isCloserStr(chosenStr)
    ) {
      const content = pickBestFeasibleContent(
        scanner,
        prefix,
        probabilities,
        eosTokens,
        model,
        wideK,
        profile,
        armSlotState,
      );
      if (content) {
        chosenTok = content.token;
        chosenStr = content.str;
      }
    }

    if (eosTokens.has(chosenTok)) break;
    prefix += chosenStr;
    const out = await s.controlledEvaluate([[chosenTok, { generateNext: { probabilities: true } }]]);
    dist = out[0]?.next.probabilities;
  }
  return { program: extractSchemeForm(prefix) };
}

// --- expected-future proxy helpers (label-bias spike) ------------------------------------------------
// Shared content-classification predicates. The main loop, the lookahead tier, AND the arm sub-decode all
// gate "content vs closer" through these; exported so lookahead.ts and the generator import them from here
// (the single home — branching is the leaf, lookahead/the generator depend DOWN onto it).

/** A token that CLOSES the current structure: EOS (ends the program) or one beginning with a close
 *  bracket. Such a token commits to "done here" — the low-expected-future move the proxy guards against. */
export function isCloserStr(s: string): boolean {
  return s === "" || /^[)\]}]/.test(s.trimStart());
}

/** A CONTENT token: non-empty and not a closer — it extends the program (an atom, string, value, or an
 *  opening). The proxy fires only when the model WANTED content (its masked top pick was content). */
export function isContentStr(s: string): boolean {
  return s !== "" && !isCloserStr(s);
}

/** Walk the prob-descending distribution and return the highest-prob feasible CONTENT token (skipping EOS
 *  and closers), or null if none in the scan window. The proxy's replacement for a premature closer. */
export function pickBestFeasibleContent(
  scanner: OracleScanner,
  prefix: string,
  probabilities: ReadonlyMap<Token, number>,
  eosTokens: ReadonlySet<Token>,
  model: ForceEmitModel,
  limit: number,
  profile?: ToolCallProfile,
  slotState?: OracleState,
): { token: Token; str: string } | null {
  let rank = 0;
  for (const [tok] of probabilities) {
    if (++rank > limit) break;
    if (eosTokens.has(tok)) continue; // EOS is a closer
    const str = model.detokenize([tok]);
    if (str === "" || !isContentStr(str)) continue;
    if (isCandidateLive(scanner, prefix, str, profile, slotState)) return { token: tok, str };
  }
  return null;
}
