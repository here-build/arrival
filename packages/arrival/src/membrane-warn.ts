// Membrane warning toggle — emitted when a host value with no portable Scheme
// representation (a JS function / `undefined` / a unique symbol) crosses the membrane
// and materializes to #void. A LEAF (no deps): the value layer (boxing.ts's `function`
// boxer) and the membrane (rosetta.ts / membrane.ts) share the one flag without dragging
// the evaluator into the value-primitive import graph.

let membraneWarningsEnabled = true;

export function setMembraneWarnings(enabled: boolean): void {
  membraneWarningsEnabled = enabled;
}

/** `outcome` (optional) overrides the default "materialized to #void" clause — the
 *  inbound exotic claim (rosetta.ts) crosses a class instance to a borrowed wrapper
 *  rather than #void and says so; every existing caller keeps the default text
 *  byte-identical. */
export function warnMembrane(what: string, outcome?: string): void {
  if (membraneWarningsEnabled) {
    console.warn(
      `[arrival membrane] ${what} crossed into Scheme and ${
        outcome ??
        "materialized to #void — it has no portable " +
          "representation (the interpreter is host-agnostic; JS functions / undefined / unique symbols are not Scheme values)"
      }.`,
    );
  }
}
