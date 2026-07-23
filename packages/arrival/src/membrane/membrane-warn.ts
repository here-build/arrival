// Membrane warning toggle — emitted when a host value with no portable Scheme
// representation crosses the membrane and materializes to #void. A LEAF (no deps).
//
// V's 2026-07-23/24 rulings retired every LIVE producer on the actual js→scheme
// crossing path: `undefined` is a plain lens (no warn), a unique symbol doors
// (NoLensError, no warn), and a bare host function is now a genuine reverse-membrane
// callable (docs/membrane.md §CALLABLE-LENS, ACallable.ts's `hostFnToCallable` — no
// warn either). The ONE remaining caller is `values/primitives/deep-restamp.ts`'s
// re-stamp of a LEGACY bare-fn `AProcedure` already living in a scheme spine (a
// pre-`ACallable` `SchemeValue` survivor arm, never a fresh JS→scheme crossing — the
// callable lens has no purchase on something already inside the algebra). Stays a
// leaf (no deps) so that one caller doesn't have to pull in a heavier module.

let membraneWarningsEnabled = true;

export function setMembraneWarnings(enabled: boolean): void {
  membraneWarningsEnabled = enabled;
  if (!enabled) emitted.clear();
}

/**
 * Each distinct warning text, and how many times it has been emitted.
 *
 * This warning TEACHES — "a JS `undefined` has no portable Scheme representation" is worth
 * saying, but only ONCE per distinct shape: a large payload whose values all trip the same
 * warning can otherwise emit hundreds of thousands of identical lines and OOM the process
 * before it finishes. The same reasoning the note-sink exists for: a fact ABOUT the crossing
 * belongs to the RUN, not to each value that crosses it — repeating it per value does not
 * teach harder, it drowns the log and turns an O(1) diagnostic into an O(n) one on the hot path.
 *
 * So: first WARN_LIMIT of each distinct text, then one suppression line, then silence. Bounded by
 * the number of distinct warning shapes (a handful), not by the size of the data crossing.
 */
const emitted = new Map<string, number>();
const WARN_LIMIT = 3;

/** `outcome` (optional) overrides the default "materialized to #void" clause, for a
 *  caller whose crossing lands somewhere else. No production caller supplies one
 *  today (both live callers — deep-restamp.ts's `undefined`/legacy-bare-fn re-stamp
 *  arms — genuinely materialize to `#void`); kept general rather than hardcoding the
 *  one shape currently in use. Callers that omit it get the default clause. */
export function warnMembrane(what: string, outcome?: string): void {
  if (!membraneWarningsEnabled) return;

  const text = `[arrival membrane] ${what} crossed into Scheme and ${
    outcome ??
    "materialized to #void — it has no portable representation (the interpreter is " +
      "host-agnostic; a bare JS `undefined`, or a legacy bare-fn value already living " +
      "in a scheme spine, has no portable re-stamp target)"
  }.`;

  const seen = emitted.get(text) ?? 0;
  if (seen >= WARN_LIMIT) return;
  emitted.set(text, seen + 1);

  console.warn(text);
  if (seen + 1 === WARN_LIMIT) {
    console.warn(
      `[arrival membrane] (further identical crossings will not be reported — the fact is about the crossing, not about each value that makes it)`,
    );
  }
}
