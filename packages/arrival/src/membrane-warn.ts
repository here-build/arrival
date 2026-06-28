// Membrane warning toggle — emitted when a host value with no portable Scheme
// representation (a JS function / `undefined` / a unique symbol) crosses the membrane
// and materializes to #void. A LEAF (no deps): the value layer (boxing.ts's `function`
// boxer) and the membrane (rosetta.ts / membrane.ts) share the one flag without dragging
// the evaluator into the value-primitive import graph. Extracted from rosetta.ts when the
// boxer registry dissolved into a direct `fromJs` switch.

let membraneWarningsEnabled = true;

export function setMembraneWarnings(enabled: boolean): void {
  membraneWarningsEnabled = enabled;
}

export function warnMembrane(what: string): void {
  if (membraneWarningsEnabled) {
    console.warn(
      `[arrival membrane] ${what} crossed into Scheme and materialized to #void — it has no portable ` +
        `representation (the interpreter is host-agnostic; JS functions / undefined / unique symbols are not Scheme values).`,
    );
  }
}
