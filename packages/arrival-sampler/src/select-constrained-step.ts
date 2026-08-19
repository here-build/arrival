// select-constrained-step.ts — the ONE per-step constrained decision (pure kernel, primitive 1).
//
// Shared by every backend (the O(vocab) reference + all real decode paths).
// Backend-specific ranking source and what is done with the result (`keepSet` vs `kept`) is injected;
// the feasibility logic, widening, fallback, and EOS gate are not.
//
// This file + mask-compiler.ts are the heart of the substrate-free sampler.
//
// WHY THIS EXISTS: the reference `compileMask` (full vocab) and the real decode paths (bounded ranked walk)
// previously duplicated the identical logic (top-K candidates → isCandidateLive → keep up to keepN →
// widen once → structural-closer fallback → EOS if closeable). Extracting it here makes divergence
// structurally impossible.
//
// The only backend-specific differences kept OUT of this function:
//   • how ranked candidates are produced (the `rankedIds` thunk)
//   • what the caller does with the result (`keepSet` for mask, `kept[0]` for greedy, etc.)
//
// Pure + sync. The async type layer is filled upstream so `slotState` is already present.

import { isCandidateLive, isCandidateLiveSession, type ToolCallProfile } from "./mask-compiler.js";
import type { OracleScanner, OracleState } from "./oracle-types.js";

/** Single-closer tokens tried in the last-ditch structural fallback (a closeable program may still want
 *  one of these to make structural progress when the model is dead-set on invalid content). */
const STRUCTURAL_CLOSERS = new Set([")", "]", "}"]);

/** The inputs to {@link selectConstrainedStep}. Everything the per-step decision needs, with the two
 *  backend-specific axes (ranking source + id→string) injected so the body stays substrate-free.
 *
 *  Generic over the id type `Id` (a `number` brand). The kernel handles ids OPAQUELY (collect / Set / compare
 *  via the injected callbacks), so each backend can supply its own id type (e.g. llama `Token` or plain numbers). */
export interface SelectConstrainedStepArgs<Id extends number = number> {
  /** The Σ-live oracle scanner (`makeOracle(grantEnv)` / the async typed scanner). */
  readonly scanner: OracleScanner;
  /** The accepted generated prefix this step extends (decoded suffix, prompt sliced off). */
  readonly prefix: string;
  /** The model's preference-ranked candidate ids up to `limit`, BEST FIRST. Called at most twice — once
   *  with `topK`, then (only on the widen fallback) with `wideK` — so each backend ranks lazily and
   *  tier-appropriately (the caller's ranked list). MUST be descending by the model's score. EOS ids (if present)
   *  are gated by `closeable` without string lookup; others go through {@link idToString}. */
  readonly rankedIds: (limit: number) => Iterable<Id>;
  /** id → decoded string (or undefined for special ids). Callers supply their own mapping (e.g. detokenize). */
  readonly idToString: (id: Id) => string | undefined;
  /** All non-special ids (full vocab) for the last-ditch structural-closer scan. When the ranked window
   *  yields nothing, we must search the entire set for live closers (they can rank very low). */
  readonly allIds: () => Iterable<Id>;
  /** The VALUE-SLOT state for this step (the prefix's `analyze`/session `state`), computed ONCE by the
   *  caller and threaded into every per-candidate liveness check for the type-derived list-structure gate.
   *  Never re-analyzed per candidate. A base structural oracle leaves `slotIsArray` unset ⇒ the gate is a
   *  no-op (grammar mode byte-identical). */
  readonly slotState: OracleState;
  /** Whether the program is closeable (EOS legal) at `prefix` — `slotState.closeable`, passed explicitly
   *  so the EOS gate and the structural-fallback throw read the same value the caller already computed. */
  readonly closeable: boolean;
  /** How many VALID candidates to keep. `1` ⇒ greedy-constrained (first feasible only, early return);
   *  `Infinity` ⇒ keep all valid in the scan window (top-valid / sampling). */
  readonly keepN: number;
  /** Top-K candidates to walk before the widen fallback (the model's K most-likely). */
  readonly topK: number;
  /** Widened K tried ONCE when zero of the top-K are valid (the fallback). */
  readonly wideK: number;
  /** EOS handling, split into the two DISJOINT needs of the two backends (each supplies exactly one):
   *   • `isEos` — IN-WALK detection (llama): an id for which this returns true is the "end here" event,
   *     live iff `closeable` (no string lookup), counting toward `keepN` at its model rank. The llama
   *     distribution carries EOS as ordinary entries (a Set of several control ids, each detokenizing to
   *     ""), so its greedy/sampling PICK must see EOS compete in rank order; it passes
   *     `(id) => eosTokens.has(id)`. A backend whose ranked stream EXCLUDES EOS does NOT supply this (its
   *     `idToString` returns undefined for an EOS id, so EOS is skipped in the walk anyway — supplying
   *     `isEos` would instead make EOS a feasible PICK, which is wrong for the mask-by-keepSet substrate).
   *   • `addId` — POST-WALK: force-add EOS id to `keepSet` when `closeable` (for mask-style backends where
   *     EOS never appears in the ranked window). Pick-style backends see EOS compete naturally and omit this.
   *  Omitted entirely ⇒ no EOS handling. */
  readonly eos?: {
    readonly isEos?: (id: Id) => boolean;
    readonly addId?: Id;
  };
  /** OPT-IN KWARGS / POSITIONAL-KEYED PROFILE. Threaded UNCHANGED into every liveness check. Omitted ⇒
   *  byte-identical to the Σ-only path. */
  readonly profile?: ToolCallProfile;
  /** Force the stateless re-scan path even when `scanner.session` is available. `false` (default) ⇒ prefer
   *  the resumable session path (the perf optimization): open ONE session over `prefix` and walk with
   *  `isCandidateLiveSession`. `true` ⇒ re-scan from the whole prefix per candidate (the correctness-first
   *  fallback / the parity test's escape hatch / a scanner with no `session`). */
  readonly forceRescan?: boolean;
}

/** The per-step decision, read differently by each backend (mask backends use `keepSet`; pick backends
 *  use `kept`). Generic over the caller's id type `Id` (see the args). */
interface SelectConstrainedStepResult<Id extends number = number> {
  /** The kept (valid) ids in WALK ORDER (model-preference descending). `kept[0]` is the first feasible —
   *  the constrained argmax — and its index in the ranked list is the "iterations-until-feasible" metric.
   *  EOS, if it appeared in the window AND was closeable, is present here at its model rank. */
  readonly kept: Id[];
  /** The same valid ids as a Set, PLUS `eos.addId` force-added when `closeable` (the mask substrate's view:
   *  every id NOT in this set is masked to `-Infinity`; EOS is admitted iff ending is legal). */
  readonly keepSet: Set<Id>;
  /** The scan widened to `wideK` this step (zero valid in the base top-K). */
  readonly widened: boolean;
  /** Even the widened scan had zero valid tokens ⇒ the structural-completion fallback fired. */
  readonly fallback: boolean;
}

/** A diagnostic hook fired once when the structural fallback engages (the model is dead-set on invalid
 *  tokens). A mask-style backend wires its `console.warn`; a pick-style backend can pass a no-op or its own. */
type StructuralFallbackReporter = (info: {
  readonly prefix: string;
  readonly closeable: boolean;
  /** How many structural closers the fallback admitted (0 when closeable — EOS carries the completion). */
  readonly admittedClosers: number;
  /** The widened K that still found nothing (for the diagnostic message). */
  readonly wideK: number;
}) => void;

/**
 * Walk `rankedIds(limit)` (model-preference descending) and collect the ids whose decoded string is live
 * at `prefix`, up to `keepN`. The oracle is consulted at most `limit` times — the O(K) property both
 * backends rely on. Stops early once `keepN` valid tokens are found (greedy `keepN=1` ⇒ first feasible).
 *
 * Two paths, IDENTICAL verdict (proven by session-parity.test.ts):
 *  - SESSION (perf, default when `scanner.session` exists and `forceRescan` is off): open ONE session over
 *    the committed `prefix`, then per candidate `clone().advance(str)` and read the verdict off the clone's
 *    `state` (which reads `base.state` internally — no `slotState` needed). O(str) per candidate.
 *  - RE-SCAN (correctness-first / no-session / parity escape hatch): each `isCandidateLive` recomputes from
 *    the whole `prefix + str`, threading `slotState` for the structure gate.
 *
 * EOS competes at its model rank: when an id equals `eosId` it is live iff `closeable` (no string lookup),
 * and counts toward `keepN` like any feasible token (so a greedy backend can pick EOS when it outranks
 * every feasible content token — the natural "stop here" the llama distribution carries).
 */
function collectValid<Id extends number>(args: SelectConstrainedStepArgs<Id>, limit: number): Id[] {
  const { scanner, prefix, rankedIds, idToString, slotState, closeable, keepN, eos, profile, forceRescan } = args;
  const useSession = forceRescan !== true && scanner.session !== undefined;
  const base = useSession ? scanner.session!(prefix) : undefined;
  // Is appending candidate `id` (with decoded string `str`) live at `prefix`? EOS (no string) is live iff
  // closeable; a content id routes through the session or re-scan liveness predicate (IDENTICAL verdict).
  const isLive = (id: Id, str: string | undefined): boolean => {
    if (eos?.isEos?.(id) === true) return closeable; // the "end here" event — no string continuation.
    if (str === undefined) return false; // a special/control id with no string (and not our EOS) — skip.
    return base === undefined
      ? isCandidateLive(scanner, prefix, str, profile, slotState)
      : isCandidateLiveSession(base, prefix, str, profile);
  };
  const kept: Id[] = [];
  for (const id of rankedIds(limit)) {
    if (isLive(id, idToString(id)) && kept.push(id) >= keepN) break;
  }
  return kept;
}

/**
 * Last-ditch structural fallback (zero valid tokens even in the widened scan). Never mask the whole vocab
 * — that hangs generation. Admit the structural completion only: if NOT closeable, every single structural
 * closer `)`/`]`/`}` the oracle still accepts (so generation can make structural progress); EOS is added
 * by {@link selectConstrainedStep} when closeable. Returns the admitted closer ids (in scan/model order) —
 * the caller appends them to BOTH `kept` (so a pick-by-kept backend like llama can choose one) and the
 * keepSet (so a mask-by-keepSet backend admits them). Throws (rather than hangs) only when
 * nothing structural is admissible AND the prefix is not closeable — the genuine over-constrained state.
 *
 * Historical unification note: the structural fallback now walks the full vocab for live closers in both
 * mask-style and pick-style paths. (loop-parity never exercises this — it fires only when the model puts
 * ZERO feasible mass in its top-wideK.)
 */
function structuralFallback<Id extends number>(
  args: SelectConstrainedStepArgs<Id>,
  report?: StructuralFallbackReporter,
): Id[] {
  const { scanner, prefix, allIds, idToString, closeable, wideK } = args;
  const closers: Id[] = [];
  if (!closeable) {
    // Scan the WHOLE vocab for any single structural closer the oracle still accepts — a live `)`/`]`/`}`
    // may rank arbitrarily low by the model's score (the fallback fires precisely because the model put no
    // feasible mass in its top-wideK), so the ranked window would miss it. The oracle, not the rank,
    // decides admissibility. The closer check is PURE-STRUCTURAL (no profile, no slotState) — a closer is a
    // balance event, not a value, so the kwargs/structure gates do not apply; this matches the original
    // structural fallback behavior that walked the full id space with the 3-arg `isCandidateLive`.
    for (const id of allIds()) {
      const str = idToString(id);
      if (str !== undefined && STRUCTURAL_CLOSERS.has(str) && isCandidateLive(scanner, prefix, str)) {
        closers.push(id);
      }
    }
  }
  report?.({ prefix, closeable, admittedClosers: closers.length, wideK });
  if (closers.length === 0 && !closeable) {
    throw new Error(
      `[arrival-sampler] over-constrained: no valid token, no closer, and EOS disallowed at prefix ${JSON.stringify(
        prefix,
      )}. The oracle rejected everything mid-program — check the grant env / oracle wiring.`,
    );
  }
  return closers;
}

/**
 * THE shared per-step constrained decision. Returns `{ kept, keepSet, widened, fallback }`:
 *
 *  1. Walk `rankedIds(topK)`, collecting live candidates up to `keepN` (session or re-scan path).
 *  2. WIDEN: if zero valid, walk `rankedIds(wideK)` once (sets `widened`).
 *  3. STRUCTURAL FALLBACK: if still zero valid, admit live structural closers / throw if over-constrained
 *     (sets `fallback`); the closers fold into `kept`.
 *  4. Seed `keepSet` from the final `kept`.
 *  5. EOS gate: if `closeable` and `eos.addId` given, add EOS to `keepSet`.
 *
 * The caller decides what to DO: mask-style backends use `keepSet` to decide what to allow;
 * pick-style backends use `kept[0]` for greedy or sample from `kept`.
 */
export function selectConstrainedStep<Id extends number = number>(
  args: SelectConstrainedStepArgs<Id>,
  report?: StructuralFallbackReporter,
): SelectConstrainedStepResult<Id> {
  let kept = collectValid(args, args.topK);
  let widened = false;
  let fallback = false;

  // Fallback A: zero valid in top-K → widen ONCE to wideK.
  if (kept.length === 0) {
    widened = true;
    kept = collectValid(args, args.wideK);
  }

  // Fallback B: even the widened scan had zero valid tokens. Never mask the whole vocab (hangs). Admit
  // live structural closers (or throw if over-constrained) and fold them into `kept` — so the pick-by-kept
  // backend can choose one — as well as into `keepSet` below.
  if (kept.length === 0) {
    fallback = true;
    kept = structuralFallback(args, report);
  }

  // The mask substrate's view: every id NOT in this set is masked. Seeded from the final `kept` (which now
  // includes any fallback closers).
  const keepSet = new Set<Id>(kept);

  // EOS gate: admit ending here iff the program is closeable (mirrors the in-walk EOS handling for the
  // mask substrate, which never saw EOS in its ranked id stream). Only the mask-by-keepSet backend
  // supplies `addId`; the pick-by-kept backend (llama) already saw EOS compete in the walk.
  if (args.closeable && args.eos?.addId !== undefined) keepSet.add(args.eos.addId);

  return { kept, keepSet, widened, fallback };
}
