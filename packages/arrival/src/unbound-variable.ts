// unbound-variable — the ONE builder for the "Unbound variable" error object, shared
// by every arrival-side throw site (`AmbientRuntime.ts#get`, `eval/Resolver.ts#resolveSynth`,
// `eval/evaluator.ts#resolvedBindingOrThrow`), plus the TYPO-SUGGESTION mechanism that
// enriches it.
//
// The suggestion machinery below stays zero-imports (the throw sites sit at/below the
// eval layer, so this module must be importable from anywhere in the graph with no
// cycle risk — the same constraint the dissolved `env/polyglot-rich-errors/registry.ts`
// documented). The one exception is `UnboundVariableError` itself, promoted into
// `errors.ts` (the errors-as-doors extraction, 2026-07-11) — that class has zero
// imports of its own beyond `ArrivalError`, so importing it here carries no cycle risk
// either.
//
// There is deliberately no static curated table of "well-known" names here (the old
// dissolved registry kept one, matching typos against it). That table was declaration
// data smuggled into the error path — every row either duplicated a REAL binding
// (env/polyglot.ts, the SRFI/R7RS packs) or duplicated a DECLARED
// `symbol.notImplemented` door (env/polyglot-stubs.ts, env/srfi/srfi-stubs.ts,
// env/r7rs/host.ts); the one genuinely-absent row it had (SRFI-1's bare `fold`) is now
// a declared door in env/srfi/srfi-1.ts. Teaching about well-known-but-absent names is
// CAPABILITY DATA resolving through the ordinary chain now, not a special error path.
//
// What remains here is exactly the half that CANNOT be declared: a MISTYPED name has no
// declaration site. Suggestions derive from the resolution chain's ACTUAL vocabulary
// (every name bound in the env the miss happened against — passed in by the throw site),
// which is strictly better than the static table was:
//   • a typo of a REAL bound symbol suggests that symbol — including prelude-defined
//     names and per-env tool verbs the table never knew about;
//   • the declared notImplemented doors ARE bindings, so declaring a stub makes it
//     typo-suggestible for free through the same mechanism (suggest the door, and
//     calling the door teaches the reason);
//   • a typo of a LEXICALLY bound program name (a user `define`) suggests it too — the
//     Resolver passes its composed scope+capabilities vocabulary.
//
// GATING (load-bearing): a suggestion fires ONLY for a close miss of a name that
// actually exists in the vocabulary — an arbitrary unbound identifier (`csv-content`)
// matches nothing and gets the PLAIN message, with no hint appended. A wrong hint is
// poison; under-trigger, never guess.

import { UnboundVariableError } from "./errors.js";

/** Names the RESOLVER SYNTHESIZES structurally rather than binding (`c[ad]+r`
 *  composition, eval/Resolver.ts#cxrUnfold) — absent from every enumerable vocabulary
 *  by construction (the family is infinite), so the two base cases are seeded as
 *  always-present suggestion candidates: a typo like `cair` should still route to
 *  `car`. Kernel-structural, interpreter-universal — hardcoding them here is honest. */
const SYNTH_NAMES: readonly string[] = ["car", "cdr"];

/** How many nearby names a hint carries at most — enough to disambiguate a tie,
 *  few enough to stay one line (manifold's H-4 one-line-wall contract). */
const MAX_SUGGESTIONS = 3;

/** Lowercase + strip WORD-SEPARATOR noise only (`-`/`_`/whitespace) — collapses
 *  dash/underscore/case/spacing variance (`string_split` / `STRING-SPLIT` /
 *  `String Split` all collapse to the same key as `string-split`) so a
 *  spelling-convention miss is caught even when its raw edit distance is > 1.
 *  Every OTHER character stays significant: a trailing `?`/`!` is Scheme's own
 *  predicate/mutator sigil (`dict` vs `dict?` are distinct bindings), and
 *  punctuation-only spellings (`->`, `->>`, `~>`, `@`, `@?`) are the ENTIRE
 *  identity of those names. */
function canonicalize(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, "");
}

/** Locale-independent, code-unit-wise comparator (suggestion ordering must be
 *  deterministic across realms/locales; localeCompare is neither). */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Levenshtein edit distance, capped: returns as soon as it's provably > `max`,
 *  since the suggester only ever asks "is this ≤ 1 away". */
function editDistanceAtMost(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // whole row already past the cap
    prev = cur;
  }
  return prev[n];
}

/**
 * Nearby REAL names for an unbound miss, from the chain's actual vocabulary.
 * Two gates, canonical-form first:
 *   1. CANONICAL-FORM match — same letters/digits once case and `-`/`_`/space are
 *      stripped (a spelling-convention miss: `string_split`, `StringSplit`).
 *   2. EDIT-DISTANCE ≤ 1 on the raw strings — a genuine one-character typo
 *      (`reduse` → `reduce`). LENGTH FLOOR: both sides must be ≥ 3 chars — every
 *      1-char name is one substitution from every other, so a short unbound
 *      variable would get a wrong hint that SHADOWS the doors owning that case
 *      (scope-confusion, quoting).
 *
 * Candidate filter: string keys only (symbol-keyed bindings aren't spellable),
 * `%`-prefixed names excluded (kernel-internal convention, never a user target).
 * An unbound name can never be its own exact vocabulary member (it would have
 * resolved), but the self-exclusion is kept as a cheap invariant for glass callers
 * enumerating a DIFFERENT env than the one that missed.
 */
export function suggestFromVocabulary(unboundName: string, vocabulary: Iterable<string | symbol>): readonly string[] {
  const candidates = new Set<string>(SYNTH_NAMES);
  for (const key of vocabulary) {
    if (typeof key !== "string") continue;
    if (key.startsWith("%")) continue;
    candidates.add(key);
  }
  candidates.delete(unboundName);

  const canonical = canonicalize(unboundName);
  const canonicalHits: string[] = [];
  for (const candidate of candidates) {
    if (canonicalize(candidate) === canonical) canonicalHits.push(candidate);
  }
  if (canonicalHits.length > 0) return canonicalHits.toSorted(byCodeUnit).slice(0, MAX_SUGGESTIONS);

  if (unboundName.length < 3) return [];
  const nearHits: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length < 3) continue;
    if (editDistanceAtMost(unboundName, candidate, 1) <= 1) nearHits.push(candidate);
  }
  return nearHits.toSorted(byCodeUnit).slice(0, MAX_SUGGESTIONS);
}

/**
 * `unboundVariableError` — builds the thrown Error. `vocabulary` is the throw site's
 * enumeration of every name its resolution walk could have found (`AmbientRuntime
 * .allBoundNames()`, `Resolver.allBoundNames()`, the sealed chain's `names`);
 * omitted/empty ⇒ the plain wall, no hint machinery at all (the evaluator's
 * defensive unreachable-branch throw).
 *
 * The hint (when a near name exists) rides both `.message` (the thrown Error, e.g.
 * surfaced in a stack trace) and `.publicMessage` (the model/agent-facing string an
 * MCP tool surface reads); with no hint both fall back to the plain wording — a pure
 * addition, never a regression.
 *
 * `enriched` is a THIRD, STRUCTURED signal alongside the two wording fields:
 * unambiguously true iff a did-you-mean suffix was appended. It exists so a consumer
 * that needs "did arrival already enrich this?" asks a typed boolean instead of
 * sniffing the SHAPE of `.message`.
 */
export function unboundVariableError(name: string, vocabulary: Iterable<string | symbol> = []): UnboundVariableError {
  return new UnboundVariableError(name, suggestFromVocabulary(name, vocabulary));
}
