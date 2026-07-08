/**
 * LAW F3 — the membrane converts everything, once, uniformly (P4/P5/P9).
 *
 * Driven entirely by _tables/crossings.ts: entry form, exit form (ONE convention
 * column — R1-gated), round-trip promise. Plus the violation table: every
 * forbidden crossing throws its teaching door.
 *
 * STUB PHASE: it.todo grid. The exitForm column is "R1-PENDING" on every
 * boxed-type row — bodies land after V's exit-convention ruling; until then a
 * body would just re-pin one side of the contradiction (P15 forbids).
 */
import { describe, it } from "vitest";
import { CROSSINGS, VIOLATIONS } from "../laws/_tables/crossings.js";

describe.each(CROSSINGS.map((r) => [r.type, r] as const))("crossing: %s", (_t, row) => {
  it.todo(`entry (JS→scheme): becomes ${row.entryForm}`);
  if (row.exitForm !== "n/a") {
    it.todo(
      row.exitForm === "R1-PENDING"
        ? "exit (scheme→JS): single exit convention [RULING-GATED: R1]"
        : `exit (scheme→JS): becomes ${row.exitForm}`,
    );
  }
  it.todo(
    row.roundTrip
      ? "round-trip: exact (promised, tested as a law — P9)"
      : "one-way: total honest projection, no reconstruction markers (P9)",
  );
  it.todo("provenance: entry deep-stamps; exit leaves lineage in the trace, none on the JS value (P4)");
});

describe.each(VIOLATIONS.map((v) => [v.name, v] as const))("forbidden crossing: %s", (_n, v) => {
  it.todo(`throws the teaching door: ${String(v.door)} (P5 — loud at the crossing, never later)`);
});

describe("egress of deferred carriers", () => {
  // Absorbs deferred-value-egress.test.ts's todos + flips its green leak (manifest B).
  it.todo("[it.fails until force-on-egress] a live AHalfBaked never escapes exec, speculate on or off");
  it.todo("force-on-egress is deep: a carrier nested in a returned pair/vector is materialized");
  it.todo("a forced-at-egress carrier's elements carry the producing run's ctx");
});
