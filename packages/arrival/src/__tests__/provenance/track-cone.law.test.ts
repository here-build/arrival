/**
 * LAW (staged) — track containment (I1), track separation (I3), R2 demand-monotonicity
 * (docs/PROVENANCE.md §3 "Tracks" + §6 "Queries", §7 law table; docs/PROVENANCE-PLAN.md
 * Q5's stub-file mapping table).
 *
 * Q5 CREATES this file as pure `it.todo` staged spec. Per the grounded-audit-corrected
 * mapping, track-containment is TWO SEPARATE describe blocks (not one law flipping at
 * one gate) because its two arms genuinely flip at different Q-nodes: the STAMP arm
 * (checked against the eager oracle's stamp sets) flips at Q9, once the wireframe
 * builder (Q8a) exists for the oracle to agree against; the REPLAY arm (checked against
 * γ's replayed cone) flips at Q16, once replay itself exists. Collapsing them into one
 * describe block would hide that a Q9-only landing genuinely earns the stamp arm
 * without earning the replay arm.
 */
import { describe, it } from "vitest";

describe("track containment — STAMP arm (§3 I1 vs the eager oracle)", () => {
  // @ledger: Q9
  it.todo(
    "I1 over stamp sets: for interior n of track Ti, cone+(n) ∩ G ⊆ cone+(egress(Ti)) — " +
      "checked against the eager oracle's recorded stamp sets on the agreement corpus " +
      "(this is the STAMP arm; the REPLAY arm below is a separate gate)",
  );
});

describe("track containment — REPLAY arm (§3 I1 under γ)", () => {
  // @ledger: Q16
  it.todo(
    "I1 holds under replay: the SAME containment (cone+(n) ∩ G ⊆ cone+(egress(Ti))), " +
      "now checked against γ's replayed cone rather than the eager oracle's stamp sets",
  );
});

describe("effect-track empty cone (§3 I1 corollary: = ∅ for effect tracks)", () => {
  // @ledger: Q16
  it.todo(
    "for an EFFECT track (terminal, no egress), cone+(n) ∩ G = ∅ for every interior n — " +
      "I1's world-noninterference reading is explicitly EXCLUDED (§3 panel C3: sink " +
      "events are real observations; I1 confines provenance ids, not behavior)",
  );

  // @ledger: Q16
  it.todo(
    "the forward cone of any value CAPTURED by an effect track still includes the " +
      "region port — under-reporting is forbidden even though the track itself egresses " +
      "nothing (§3 I1 corollary)",
  );
});

describe("track separation (§3 I3: no spontaneous inter-track edges)", () => {
  // @ledger: Q16
  it.todo(
    "zero spontaneous inter-track edges except the ONE sanctioned accumulator chain " +
      "(egress(Tᵢ) → ingress(Tᵢ₊₁)) — every other composition (parallel element/control, " +
      "terminal effect) carries no inter-track edge at all",
  );

  // @ledger: Q16
  it.todo(
    "order is a structural fact of the host port, never a dataflow edge — an order-" +
      "dependent selector host (e.g. sort's comparator schedule) is modeled by the " +
      "host-schedule record, not by a fabricated edge between the tracks it compares " +
      "(§3 I3 LIMIT)",
  );
});

describe("R2 demand monotonicity (§6 demand lattice: value / count / field-k)", () => {
  // @ledger: Q17
  it.todo("cone(count) ⊆ cone(value) — a count-demand cone is never wider than the value-demand cone it's derived from");

  // @ledger: Q17
  it.todo("cone(field-k) ⊆ cone(whole) — a single-field demand cone is never wider than the whole-value demand cone");

  // @ledger: Q17
  it.todo(
    "count-demand traverses fact wires ONLY — touches ZERO element wires (§6: " +
      "\"struct-fact wires answer count-demand without touching elements\"; the routing " +
      "machinery lands at Q8c, this law itself flips at Q17 once query maturity lands)",
  );
});
