/**
 * LEDGER F8 — the suite's truth table, owned in one place (P15).
 *
 * green = design · it.fails = documented gap (flips loudly when fixed) ·
 * it.todo = staged spec. This file indexes every gap/staging/inversion in the
 * suite so "what does green mean" is answerable mechanically. Each entry names
 * its GATE — the ruling or migration that flips it — and the law row that
 * replaces it.
 *
 * STUB PHASE: the index is the table; enforcement (a meta-test walking the
 * suite for unindexed it.fails) lands with the sweep.
 */
import { describe, it } from "vitest";

interface LedgerRow {
  readonly id: string;
  readonly gate: string; // ruling (R1-R7) or migration (bare-value-purge, reverse-membrane, region-discipline, conservation-repair, G2)
  readonly replacedBy: string; // the v2 law row
}

const GAPS: readonly LedgerRow[] = [
  { id: "append drops element provenance", gate: "conservation-repair", replacedBy: "provenance/conservation" },
  { id: "cdr spine unstamped", gate: "conservation-repair", replacedBy: "provenance/conservation" },
  { id: "A13 count-cone over-attribution", gate: "G2", replacedBy: "provenance/conservation" },
  { id: "DR4 vector-map re-box mints empty provenance", gate: "conservation-repair", replacedBy: "laws/term-carrier map×AVector" },
  { id: "exact/list JSON.stringify throws (BigInt backing)", gate: "numeric-json design", replacedBy: "membrane/crossing" },
  { id: "live AHalfBaked escapes exec under speculate", gate: "force-on-egress", replacedBy: "membrane/crossing egress" },
  { id: "null↔nil round-trip asymmetry", gate: "R1-adjacent ruling", replacedBy: "membrane/crossing null row" },
  { id: "schema-to-ts vector union not deduped", gate: "printer dedup follow-up", replacedBy: "type-layer suite" },
] as const;

const INVERSIONS: readonly LedgerRow[] = [
  { id: "representation-blind equality (string/boolean boxed≡raw)", gate: "bare-value-purge", replacedBy: "laws/equality strict-door rows" },
  { id: "LAMBDA-branded fn passes jsToScheme by identity", gate: "reverse-membrane step 6", replacedBy: "membrane/crossing function row" },
  { id: "defineRosetta legacy arm authoring form", gate: "McpEnvCapability annotation-lifting", replacedBy: "capability baked-symbol suites" },
  { id: "bare-fn env.set harness wiring", gate: "reverse-membrane", replacedBy: "EnvCapability-wired fixtures" },
  { id: "z.procedure region-free callbacks", gate: "region-discipline", replacedBy: "membrane/region" },
  { id: "boolean raw exit via op-helpers short-circuit", gate: "R1", replacedBy: "membrane/crossing exit column" },
] as const;

describe("ledger — every gap names its gate", () => {
  it.each(GAPS.map((g) => [g.id, g] as const))("GAP %s", () => {
    /* index row — enforcement meta-test lands with the sweep */
  });
  it.each(INVERSIONS.map((g) => [g.id, g] as const))("INVERTS %s", () => {
    /* index row */
  });
  it.todo("meta: no it.fails exists in the suite without a ledger row (walker)");
  it.todo("meta: no ledger gate references a ruling/migration that has already landed (staleness alarm)");
});
