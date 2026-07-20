/**
 * LEDGER — staged spec: count-cone minimality vs. provenance-everything (R5).
 *
 * Survivor of `dataflow-thesis-probes.test.ts` (retired in the 2026-07-09 suite
 * consolidation): those FALSIFICATION PROBES pinned the current interpreter's behavior against the
 * confluent-dataflow-IR design note while the underlying design question (R5) was still
 * undecided. R5 is now RULED (docs/RULINGS.md): both cone queries are
 * required ("why is this an input" / "what changes if I adjust this output"), and the
 * target architecture is a generalized execution-plan wireframe — the AST statically
 * evaluated into a base wireframe with static wires collapsed into single provenance
 * edges, real runtime provenance wiring into the abstract flow.
 *
 * A probe of an undecided question is a staged spec, not a green test (docs/test-suite-architecture.md's own
 * framing) — now that the question IS decided, the probes' job is done; what remains is
 * an IMPLEMENTATION gate (the wireframe — docs/PROVENANCE.md §1), not a design gate.
 * These `it.todo` stubs mark that: designed, not yet buildable.
 *
 * The two probed questions, for when C3 lands:
 *   - DROP: does `(length (map f xs))` need to compute `f` today? (Baseline: yes, eagerly
 *     — `map` dispatches strictly, so `f` runs once per element even though `length`
 *     never reads the values.) The wireframe's static-wire collapse is what lets `length`
 *     read the cheap cardinality without forcing `f` at all.
 *   - ATTRIBUTION: does a count's provenance depend on which elements were counted, or is
 *     it minimal (cardinality-only, independent of element identity)? `fl-interop length`
 *     currently unions every element's provenance (the teleological-sealing decision:
 *     "provenance everything; exclusion must be impossible") — R5 rules this is the
 *     correct behavior UNTIL the wireframe's static-wire collapse makes a count's cone
 *     structurally minimal without sacrificing conservation (P10).
 */
import { it } from "vitest";

it.todo(
  "PROBE — DROP: (length (map f xs)) elides f entirely once the wireframe collapses the static map→length wire (gate: C3 execution-plan wireframe)",
);

it.todo(
  "PROBE — ATTRIBUTION: a count's provenance cone is minimal (cardinality-only), not entangled with element identity, once the wireframe lands (gate: C3 execution-plan wireframe)",
);
