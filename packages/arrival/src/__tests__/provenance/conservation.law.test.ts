/**
 * LAW F2 — provenance conservation (P10) + mint-at-edge (P11).
 *
 * The second interpreter's conservation law, stated once, property-based:
 * no derivation drops lineage; only declared doors shed; only edges mint.
 *
 * STUB PHASE: it.todo + the known-violation rows pre-registered as the
 * it.fails targets the conservation repair will flip (manifest B: append,
 * cdr spine, A13 count-cone, DR4 vector-map).
 */
import { describe, it } from "vitest";

describe("conservation — every input id survives to the output or the trace", () => {
  it.todo("property: for generated pure programs over stamped sources, deep-collapsed output provenance ⊇ every input id");
  it.todo("[it.fails today] (append (list a) (list b)) — element ids survive the spine rebuild");
  it.todo("[it.fails today] (cdr (list a b)) — the tail spine carries b's id, not empty");
  it.todo("[it.fails today] (length (map id xs)) — count cone is the grouping fact, not every element id [GATE: G2]");
  it.todo("[it.fails today] vector-map — mapped elements keep their ORIGINAL boxes, not fresh empty-provenance re-boxes (DR4)");
  it.todo("container-box rows [RULING-GATED: R2]");
});

describe("mint-at-edge — ids appear only at declared crossings", () => {
  it.todo("property: interior pure ops over literals produce EMPTY provenance (no interior minting)");
  it.todo("property: one source consumed N times still carries exactly that source (pipe, not fan-in)");
  it.todo("a `pure: true` rosetta NEVER mints, even under a live invocation ctx (the seal-laundering guard)");
  it.todo("a source rosetta mints EXACTLY ONE fresh point per crossing, independent of arguments");
});

describe("named sheds — the only legal losses", () => {
  it.todo("(exact->inexact x) is the explicit lossiness door; document its provenance rule");
  it.todo("egress: schemeToJs leaves lineage in the trace keyed by scope; the JS value carries none");
});
