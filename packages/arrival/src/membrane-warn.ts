// Membrane warning toggle — emitted when a host value with no portable Scheme
// representation (a JS function / `undefined` / a unique symbol) crosses the membrane
// and materializes to #void. A LEAF (no deps): the value layer (boxing.ts's `function`
// boxer) and the membrane (rosetta.ts / membrane.ts) share the one flag without dragging
// the evaluator into the value-primitive import graph.

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

/** `outcome` (optional) overrides the default "materialized to #void" clause — the
 *  inbound exotic claim (rosetta.ts) crosses a class instance to a borrowed wrapper
 *  rather than #void and says so; every existing caller keeps the default text
 *  byte-identical. */
export function warnMembrane(what: string, outcome?: string): void {
  if (!membraneWarningsEnabled) return;

  const text = `[arrival membrane] ${what} crossed into Scheme and ${
    outcome ??
    "materialized to #void — it has no portable " +
      "representation (the interpreter is host-agnostic; JS functions / undefined / unique symbols are not Scheme values)"
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
