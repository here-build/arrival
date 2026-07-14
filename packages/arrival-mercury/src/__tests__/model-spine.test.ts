/**
 * THE SPINE'S RED SUITE — the SchemeSemanticModel design pinned as tests
 * BEFORE implementation (design: docs/working-proposals/scheme-semantic-model.md).
 *
 * Convention: every unlanded law is an `it.fails` row (the corpus's
 * self-firing promote convention — when a view lands, its rows start FAILING
 * the wrapper, the loud signal to promote to plain `it`). The suite is
 * CI-green today and semantically red: it asserts the design, not the stubs.
 *
 * Validation strategy (the part that makes this testable at all): THE
 * EXISTING DYNAMIC PLANE IS THE ORACLE FOR THE STATIC ONE. Mechanism-1's
 * eager per-value Sets and the trace — the machinery this design ultimately
 * retires — first serve as ground truth: dual-plane rows record a live run
 * and assert the model's static claims contain/reproduce the dynamic
 * observations (the v0.2 shadow playbook, at model scope). v1 needs zero
 * interpreter changes.
 *
 * Law → row map:
 *   L-ANCHORS   R1  static anchor enumeration (registry provenance ≠ pure + boundaries)
 *   L-INSTANCE  R2  every runtime invocation's site ∈ static anchors        [dual-plane]
 *   L-TOTALITY  R3  chains partition live pure forms; one chain per input   (L4)
 *   L-TELEOLOGY R4  demand graph shakes dead defines; sinks always demanded
 *   L-RECON     R5  sliceOf re-derivation reproduces recorded values        [dual-plane] (L2)
 *   L-AGREE     R6  transferOf(where) == live per-slot provenance sets      [dual-plane]
 *   L-CONTAIN   R7  dynamic edges ⊆ static wireMap                          [dual-plane] (L1)
 *   L-FUSE      R8  why-channel: condition atoms fuse into branch results   (hand-golden;
 *                   no dynamic oracle exists — mechanism-1 is where-only)
 *   L-UNEVAL    R9  wire labels: lens path for projections; anchor-named
 *                   minimal scheme for transforms; uneval round-trips (≡ slice)
 *   L-TIERS     R10 tier classification: straight-line→1, branch→2+guards,
 *                   computed-callee→3 with explicit program
 *   L-DARK      R11 interior darkness at the API surface: no per-interior-value
 *                   hook exists anywhere on the spine types
 */
import { describe, expect, it } from "vitest";

import { emitRegistryOf } from "../registry/harvest.js";
import { withRules } from "../rules/overlay.js";
import { phase1Rules } from "../rules/phase1.js";
import { openOracleSession, runOracle } from "../index.js";
import type { OracleSession } from "../index.js";
import { SchemeSemanticModel } from "../model/model.js";
import { ALL, BRANCH_FUSE, DEAD_DEFINE, FAN, HIGHER_ORDER, PROJECTION_ONLY, TWO_CROSSINGS } from "../model/__fixtures__.js";

// v1 model construction: registry from the phase1 overlay over an empty base —
// enough for anchor taxonomy (infer rows carry provenance); the full harvested
// ambient enters with the dual-plane rows.
function modelFor(source: string): SchemeSemanticModel {
  const registry = withRules(emitRegistryOf([]), phase1Rules);
  return new SchemeSemanticModel(source, registry);
}

describe("stratum 0 — already green (the wrapped substrate)", () => {
  it("classifies on construction: forms, doors, ids", () => {
    const sm = modelFor(TWO_CROSSINGS);
    expect(sm.coreform.forms.length).toBe(3);
    expect(sm.coreform.doors.length).toBe(0);
  });
});

describe("R1 · L-ANCHORS — static anchor enumeration", () => {
  it.fails("TWO_CROSSINGS: boundary-in, boundary-out, and one anchor per infer site — pure symbols absent", () => {
    const sm = modelFor(TWO_CROSSINGS);
    const kinds = sm.anchors.map((a) => a.kind);
    expect(kinds.filter((k) => k === "boundary-in").length).toBe(1);
    expect(kinds.filter((k) => k === "boundary-out").length).toBe(1);
    const crossings = sm.anchors.filter((a) => a.kind === "source" || a.kind === "sink");
    expect(crossings.length).toBe(3); // three infer sites
    expect(crossings.every((a) => a.symbol === "infer")).toBe(true);
    // string-append / car are pure — never anchors
    expect(sm.anchors.some((a) => a.symbol === "string-append" || a.symbol === "car")).toBe(false);
  });

  it.fails("static atom NAMES: define-bound crossings take the binding name; anonymous get stable synthesized names", () => {
    const sm = modelFor(TWO_CROSSINGS);
    const names = sm.anchors.map((a) => a.name);
    expect(names).toContain("response"); // (define response (infer …))
    // the trailing bare (infer "classify" …) is anonymous — synthesized, stable:
    const anon = sm.anchors.find((a) => a.symbol === "infer" && a.name !== "response");
    expect(anon?.name).toMatch(/^infer#\d+$/);
    // determinism: same source ⇒ same names
    expect(modelFor(TWO_CROSSINGS).anchors.map((a) => a.name)).toEqual(names);
  });
});

describe("R3 · L-TOTALITY — chains partition the live pure forms", () => {
  it.fails("every crossing input slot is fed by exactly one chain", () => {
    const sm = modelFor(TWO_CROSSINGS);
    const inputs = sm.anchors
      .filter((a) => a.kind === "source" || a.kind === "sink")
      .flatMap((a) => sm.chains.filter((c) => c.output.anchor === a.id));
    // (infer "classify" verdict): the verdict chain; (infer "summarize" …): literal-fed chains
    expect(inputs.length).toBeGreaterThan(0);
    for (const a of sm.anchors) {
      const feeders = sm.chains.filter((c) => c.output.anchor === a.id && c.output.slot === 0);
      if (a.kind === "sink" || a.kind === "source") expect(feeders.length).toBeLessThanOrEqual(1);
    }
  });

  it.fails("chain interiors are disjoint (a pure node belongs to exactly one chain)", () => {
    const sm = modelFor(TWO_CROSSINGS);
    const seen = new Set<number>();
    for (const c of sm.chains)
      for (const n of c.nodes) {
        expect(seen.has(n as unknown as number)).toBe(false);
        seen.add(n as unknown as number);
      }
  });
});

describe("R4 · L-TELEOLOGY — the demand graph is static teleology", () => {
  it.fails("DEAD_DEFINE: the unused define's chain is shaken; all crossings stay (sinks/sources pinned by effect)", () => {
    const sm = modelFor(DEAD_DEFINE);
    const g = sm.demandGraph;
    const crossingIds = sm.anchors.filter((a) => a.symbol === "infer").map((a) => a.id);
    for (const id of crossingIds) expect(g.demanded.has(id)).toBe(true);
    // the (string-append "never" "read") chain feeds nothing demanded:
    expect(g.demandedChains.size).toBeLessThan(sm.chains.length);
  });
});

describe("R8 · L-FUSE — why-provenance (hand-golden; no dynamic oracle exists)", () => {
  it.fails("BRANCH_FUSE: the gate's anchor enters the WHY channel of the final chain; taken-branch anchors are the WHERE", () => {
    const sm = modelFor(BRANCH_FUSE);
    const final = sm.anchors.find((a) => a.symbol === "infer" && a.name.includes("final"));
    const chain = sm.chains.find((c) => c.output.anchor === final?.id);
    const t = sm.transferOf(chain!);
    expect(t.tier).toBe(2); // branch ⇒ alternatives with guards
    if (t.tier === 2) {
      const gate = sm.anchors.find((a) => a.name === "gate")!;
      for (const alt of t.alternatives) {
        expect(alt.why.some((p) => p.anchor === gate.id)).toBe(true); // condition fuses into WHY
        expect(alt.where.some((p) => p.anchor === gate.id)).toBe(false); // …not WHERE
        expect(alt.guard).toBeTruthy(); // each alternative carries its guard uneval
      }
    }
  });
});

describe("R9 · L-UNEVAL — wire labels are tiny human-grade compilations", () => {
  it.fails("PROJECTION_ONLY: an identity/mux chain unevals to a bare lens path, not a program", () => {
    const sm = modelFor(PROJECTION_ONLY);
    const consume = sm.anchors.find((a) => a.name.includes("consume") || a.symbol === "infer");
    const chain = sm.chains.find((c) => c.output.anchor === consume?.id && c.inputs.length > 0);
    const u = sm.unevalOf(chain!);
    expect(u.tier).toBe(1);
    expect(u.label).toMatch(/result\[0\]|\(car result\)/); // lens-path spelling (exact form pinned at green time)
    expect(u.label.length).toBeLessThan(40); // a label, not a listing
  });

  it.fails("TWO_CROSSINGS: a transform chain unevals to minimal scheme with ANCHOR NAMES free", () => {
    const sm = modelFor(TWO_CROSSINGS);
    const classify = sm.anchors.filter((a) => a.symbol === "infer").at(-1)!;
    const chain = sm.chains.find((c) => c.output.anchor === classify.id && c.inputs.length > 0)!;
    const u = sm.unevalOf(chain);
    expect(u.label).toContain("response"); // the producer anchor's static name, free
    expect(u.label).toContain("string-append");
  });

  it.fails("uneval round-trip: evaluating the label's program over recorded inputs ≡ the slice (L2 grounding)", async () => {
    // The label IS runnable minimal scheme — the read-register contract.
    const sm = modelFor(TWO_CROSSINGS);
    const classify = sm.anchors.filter((a) => a.symbol === "infer").at(-1)!;
    const chain = sm.chains.find((c) => c.output.anchor === classify.id && c.inputs.length > 0)!;
    const u = sm.unevalOf(chain);
    const slice = sm.sliceOf(chain);
    // Round-trip harness lands with the green phase; the LAW is pinned now:
    // (let ((response <recorded>)) <u.label>) ≡ slice(<recorded>)
    expect(u.label.length).toBeGreaterThan(0);
    expect(slice.params).toEqual(["response"]);
  });
});

describe("R10 · L-TIERS — classification", () => {
  it.fails("straight-line projection ⇒ tier 1 with a lens", () => {
    const sm = modelFor(PROJECTION_ONLY);
    const chain = sm.chains.find((c) => c.inputs.length > 0)!;
    const t = sm.transferOf(chain);
    expect(t.tier).toBe(1);
    if (t.tier === 1) expect(t.lens).toBeDefined();
  });

  it.fails("HIGHER_ORDER: computed callee ⇒ tier 3 carrying the provenance program (never a silent JOIN)", () => {
    const sm = modelFor(HIGHER_ORDER);
    const use = sm.anchors.filter((a) => a.symbol === "infer").at(-1)!;
    const chain = sm.chains.find((c) => c.output.anchor === use.id && c.inputs.length > 0)!;
    const t = sm.transferOf(chain);
    expect(t.tier).toBe(3);
    if (t.tier === 3) expect(t.program.source).toContain("f");
  });

  it.fails("FAN: one anchor site; the transfer keeps the parametric z-axis (single-wire, never unrolled)", () => {
    const sm = modelFor(FAN);
    const perItem = sm.anchors.find((a) => a.name.includes("per-item") || a.symbol === "infer")!;
    expect(sm.anchors.filter((a) => a.symbol === "infer" && a.span === perItem.span).length).toBe(1);
    const join = sm.anchors.filter((a) => a.symbol === "infer").at(-1)!;
    const chain = sm.chains.find((c) => c.output.anchor === join.id && c.inputs.length > 0)!;
    const t = sm.transferOf(chain);
    if (t.tier === 1) expect(t.lens?.some((s) => s.kind === "z")).toBe(true);
  });
});

describe("R11 · L-DARK — interior darkness at the API surface", () => {
  it("no spine type exposes a per-interior-value hook (design law L3, enforced at the surface)", () => {
    // The Transfer/Chain/Anchor shapes carry ports, programs, and lenses —
    // never a per-value or per-step callback. This test is GREEN from day
    // one and guards the design against convenience hooks creeping in.
    const sm = modelFor(TWO_CROSSINGS);
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(sm));
    for (const banned of ["onValue", "tapInterior", "stampValue", "perStep"]) {
      expect(surface).not.toContain(banned);
    }
  });
});

// ── dual-plane rows (the existing dynamic plane as the oracle) ────────────
// These need the live tracer join (R2/R5/R6/R7). The MODEL half is pinned
// above; the dynamic half's plumbing (reading invocation sites + per-slot
// provenance sets out of a traced oracle run) lands with the green phase —
// pinned here as the contract so the suite's shape is complete.

describe("dual-plane laws (dynamic plane = the oracle) — plumbing lands with green", () => {
  it.fails("R2 · L-INSTANCE: every runtime invocation's site maps to a static anchor", async () => {
    const sm = modelFor(TWO_CROSSINGS);
    expect(sm.anchors.length).toBeGreaterThan(0); // un-reds with anchors; full row needs the trace join
  });

  it.fails("R5 · L-RECON: sliceOf over recorded crossing values reproduces the recorded downstream value", async () => {
    const sm = modelFor(TWO_CROSSINGS);
    const chain = sm.chains.find((c) => c.inputs.length > 0)!;
    expect(sm.sliceOf(chain).source.length).toBeGreaterThan(0);
  });

  it.fails("R6 · L-AGREE: transferOf's where-sets equal the live per-slot provenance (mechanism-1 as ground truth)", async () => {
    const sm = modelFor(TWO_CROSSINGS);
    const chain = sm.chains.find((c) => c.inputs.length > 0)!;
    expect(sm.transferOf(chain)).toBeDefined();
  });

  it.fails("R7 · L-CONTAIN: dynamic provenance edges ⊆ the static wireMap, across the micro-corpus", async () => {
    for (const source of Object.values(ALL)) {
      const sm = modelFor(source);
      expect(sm.wireMap.size).toBeGreaterThan(0);
    }
  });
});
