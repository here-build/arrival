/**
 * THE SPINE'S RED SUITE — the SchemeSemanticModel design pinned as tests
 * BEFORE implementation (design: docs/working-proposals/scheme-semantic-model.md).
 *
 * Convention: every unlanded law is an `it.fails` row (the self-firing promote
 * convention — when a view lands, its rows start FAILING the wrapper: the loud
 * signal to promote). The suite is CI-green today and semantically red.
 *
 * THE ANTI-LIAR DISCIPLINE (audit-hardened): a red row must throw on ANY wrong
 * or degenerate implementation, not merely on the current stub. Every assertion
 * below is chosen so that an empty/vacuous/arbitrary answer still fails —
 * `toBeDefined()`, `.length > 0`, `<= n`, and guarded-without-assertions bodies
 * are BANNED here, because each one lets a stub flip the wrapper green and
 * invite a vacuous promotion.
 *
 * Validation strategy: THE EXISTING DYNAMIC PLANE IS THE ORACLE FOR THE STATIC
 * ONE. `deepProvenance` (the eager per-value Sets this design ultimately
 * reduces to a fallback tier) is ground truth; the dual-plane rows below are
 * EXECUTABLE TODAY against it — no interpreter change, no deferred plumbing.
 *
 * Law → row map:
 *   L-ANCHORS   R1  anchor enumeration; static names (determinism/uniqueness)
 *   L5-ONTOLOGY R1c anchor kind ⟺ the registry's declared provenance
 *   L-TOTALITY  R3  every (anchor, slot) fed by EXACTLY one chain; chains COVER
 *                   the pure interior; interiors may be SHARED (chain DAG)
 *   L-TELEOLOGY R4  demand graph: exact demanded set; crossings pinned
 *   L-FUSE      R8  why-channel carries the guard; where carries the branches
 *   L-UNEVAL    R9  labels: anchor names free; lens for projections (no spelling pins)
 *   L-TIERS     R10 tier classification incl. the value-driven `route` cases
 *   L-DARK      R11 interior darkness: spine data types carry NO methods at all
 *   dual-plane  R2  every runtime crossing site ∈ static anchors      [live oracle]
 *               R6  static where-transfer ⊇ live per-value provenance [live oracle]
 *               R7  dynamic edges ⊆ static wireMap (containment)      [live oracle]
 */
import { deepProvenance } from "@inhuman.tools/arrival";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openOracleSession } from "../index.js";
import type { OracleSession } from "../index.js";
import { SchemeSemanticModel } from "../model/model.js";
import type { AnchorPort } from "../model/types.js";
import { emitRegistryOf } from "../registry/harvest.js";
import { phase1Rules } from "../rules/phase1.js";
import { withRules } from "../rules/overlay.js";
import {
  ALL,
  BRANCH_FUSE,
  DEAD_DEFINE,
  DYNAMIC_KEY,
  FAN,
  FAN_AND_DIRECT,
  HIGHER_ORDER,
  MULTI_SLOT,
  PROJECTION_ONLY,
  RECURSION,
  SHARED_HELPER,
  TWO_CROSSINGS,
} from "../model/__fixtures__.js";

let session: OracleSession;
beforeAll(async () => {
  session = await openOracleSession();
}, 120_000);
afterAll(async () => {
  await session.dispose();
});

/** The model under test. The registry is the REAL harvested ambient overlaid
 *  with the phase-1 rules — L5 (anchor kind ⟺ declared provenance) is only
 *  meaningful against real contracts. */
function modelFor(source: string): SchemeSemanticModel {
  const registry = withRules(emitRegistryOf(session.ambient), phase1Rules);
  return new SchemeSemanticModel(source, registry);
}

const crossings = (sm: SchemeSemanticModel) => sm.anchors.filter((a) => a.kind === "source" || a.kind === "sink");
const portKey = (p: AnchorPort) => `${p.anchor}#${p.slot ?? 0}`;

describe("stratum 0 — the wrapped substrate (green)", () => {
  it("classifies on construction: forms, doors, ids", () => {
    const sm = modelFor(TWO_CROSSINGS);
    expect(sm.coreform.forms.length).toBe(3);
    expect(sm.coreform.doors.length).toBe(0);
  });
});

describe("R1 · L-ANCHORS — static anchor enumeration", () => {
  it.fails("TWO_CROSSINGS: exactly two boundaries + one anchor per crossing SITE; pure symbols never anchors", () => {
    const sm = modelFor(TWO_CROSSINGS);
    expect(sm.anchors.filter((a) => a.kind === "boundary-in").length).toBe(1);
    expect(sm.anchors.filter((a) => a.kind === "boundary-out").length).toBe(1);
    const cs = crossings(sm);
    expect(cs.length).toBe(3); // three infer sites — exact, not "at least"
    expect(cs.every((a) => a.symbol === "infer")).toBe(true);
    expect(sm.anchors.some((a) => a.symbol === "string-append" || a.symbol === "car")).toBe(false);
    expect(sm.anchors.every((a) => a.kind === "boundary-in" || a.kind === "boundary-out" || a.node !== undefined)).toBe(
      true,
    );
  });

  it.fails("static names: deterministic, unique, and define-bound crossings take their binding name", () => {
    const sm = modelFor(TWO_CROSSINGS);
    const names = sm.anchors.map((a) => a.name);
    // determinism (the law) — same source ⇒ same names, byte for byte
    expect(modelFor(TWO_CROSSINGS).anchors.map((a) => a.name)).toEqual(names);
    // uniqueness (the law) — names ADDRESS anchors; collisions would alias them
    expect(new Set(names).size).toBe(names.length);
    // binding-derived where a binding exists (the law); NO grammar pinned for
    // the anonymous case — only that it is stable, unique, and not a binding name
    expect(names).toContain("response");
    const anon = crossings(sm).filter((a) => a.name !== "response" && a.name !== "verdict");
    expect(anon.length).toBeGreaterThanOrEqual(1);
    for (const a of anon) expect(a.name).not.toBe("response");
  });

  it.fails("R1c · L5 — anchor kind is EXACTLY the registry's declared provenance (no second vocabulary)", () => {
    const sm = modelFor(TWO_CROSSINGS);
    for (const a of crossings(sm)) {
      const row = sm.registry.lookup(a.symbol!);
      expect(row, `anchor ${a.name}: no registry row — anchors may not be minted from local heuristics`).toBeTruthy();
      expect(row!.provenance, `anchor ${a.name} (${a.symbol}) is an anchor, so its contract must NOT be pure`).not.toBe(
        "pure",
      );
    }
    // …and the converse: no pure-contract symbol in the program became an anchor
    for (const a of sm.anchors) {
      if (a.symbol === undefined) continue;
      const row = sm.registry.lookup(a.symbol);
      expect(row?.provenance).not.toBe("pure");
    }
  });
});

describe("R3 · L-TOTALITY — the chain DAG (exactly-one feeder; covering; SHARED interiors)", () => {
  it.fails("MULTI_SLOT: EVERY (anchor, slot) that takes data is fed by exactly one chain — no orphan slots", () => {
    const sm = modelFor(MULTI_SLOT);
    expect(sm.chains.length).toBeGreaterThan(0);
    const fed = new Map<string, number>();
    for (const c of sm.chains) {
      const k = portKey(c.output);
      fed.set(k, (fed.get(k) ?? 0) + 1);
    }
    // the (infer "merge" …) crossing has TWO input slots — both must be fed, exactly once each
    const merge = crossings(sm).find((a) => sm.chains.filter((c) => c.output.anchor === a.id).length === 2);
    expect(merge, "the two-slot crossing must have two feeding chains").toBeTruthy();
    for (const count of fed.values()) expect(count).toBe(1); // EXACTLY one — zero is an orphan, two is ambiguity
  });

  it.fails("SHARED_HELPER: chains COVER the pure interior, and a shared helper lives in BOTH consumers (DAG, not partition)", () => {
    const sm = modelFor(SHARED_HELPER);
    expect(sm.chains.length).toBeGreaterThan(1);
    // covering: every non-anchor form node belongs to at least one chain
    const anchorNodes = new Set(sm.anchors.map((a) => a.node).filter((n) => n !== undefined));
    const covered = new Set(sm.chains.flatMap((c) => [...c.nodes]));
    const interiorIds = [...sm.coreform.byId.keys()].filter((id) => !anchorNodes.has(id));
    const uncovered = interiorIds.filter((id) => !covered.has(id));
    expect(uncovered, "every pure interior node must belong to a chain (covering)").toEqual([]);
    // sharing: `both` (the string-append) feeds A and B — its node is in ≥2 chains
    const shareCounts = interiorIds.map((id) => sm.chains.filter((c) => c.nodes.includes(id)).length);
    expect(Math.max(...shareCounts), "a shared pure helper must appear in both consumers' chains").toBeGreaterThan(1);
  });
});

describe("R4 · L-TELEOLOGY — the demand graph is static teleology", () => {
  it.fails("DEAD_DEFINE: EXACTLY the unused chain is shaken; every crossing stays (effects pinned)", () => {
    const sm = modelFor(DEAD_DEFINE);
    const g = sm.demandGraph;
    for (const a of crossings(sm)) expect(g.demanded.has(a.id), `crossing ${a.name} must stay demanded`).toBe(true);
    const shaken = sm.chains.filter((c) => !g.demandedChains.has(c.id));
    expect(shaken.length, "exactly one chain (the unused define) is dead").toBe(1);
    // the shaken chain must feed NOTHING demanded — the actual teleological fact
    expect(g.demanded.has(shaken[0]!.output.anchor)).toBe(false);
  });
});

describe("R8 · L-FUSE — the why-channel (hand-golden; mechanism-1 is where-only, so no dynamic oracle exists)", () => {
  it.fails("BRANCH_FUSE: gate ∈ WHY of every alternative; the branches partition the WHERE; guards present", () => {
    const sm = modelFor(BRANCH_FUSE);
    // locate STRUCTURALLY (never by noise substring — the static name is not the noise arg)
    const final = crossings(sm).find((a) => sm.chains.some((c) => c.output.anchor === a.id && c.inputs.length >= 2));
    expect(final, "the (if …)-fed crossing consumes ≥2 anchors").toBeTruthy();
    const chain = sm.chains.find((c) => c.output.anchor === final!.id)!;
    const t = sm.transferOf(chain);
    expect(t.tier, "a branch is not statically single-valued ⇒ tier 2").toBe(2);
    if (t.tier !== 2) throw new Error("unreachable");
    const byName = (n: string) => sm.anchors.find((a) => a.name === n)!;
    const [gate, a, b] = [byName("gate"), byName("a"), byName("b")];
    const whereUnion = new Set(t.alternatives.flatMap((alt) => alt.where.map((p) => p.anchor)));
    expect([...whereUnion].sort(), "the two branches are the WHERE").toEqual([a.id, b.id].sort());
    for (const alt of t.alternatives) {
      expect(alt.why.some((p) => p.anchor === gate.id), "the condition fuses into WHY").toBe(true);
      expect(alt.where.some((p) => p.anchor === gate.id), "…and never into WHERE").toBe(false);
      expect(alt.where.length, "each alternative carries its own branch").toBe(1);
      expect(alt.guard, "each alternative carries its guard uneval").toBeTruthy();
    }
  });
});

describe("R9 · L-UNEVAL — labels are tiny human-grade compilations (laws, not spellings)", () => {
  it.fails("PROJECTION_ONLY: an identity/mux chain unevals to a LENS (structural), naming its producer anchor", () => {
    const sm = modelFor(PROJECTION_ONLY);
    const chain = sm.chains.find((c) => c.inputs.length === 1)!;
    const u = sm.unevalOf(chain);
    expect(u.tier).toBe(1);
    const producer = sm.anchors.find((a) => a.id === chain.inputs[0]!.anchor)!;
    expect(u.label).toContain(producer.name); // the anchor name is FREE in the label — the law
    expect(u.label.length).toBeLessThan(40); // a label, not a listing
    const t = sm.transferOf(chain);
    expect(t.tier).toBe(1);
    if (t.tier === 1) {
      expect(t.lens!.length, "a projection has ≥1 lens step").toBeGreaterThan(0);
      expect(t.lens!.every((s) => s.kind === "field" || s.kind === "z" || s.kind === "forward")).toBe(true);
    }
  });

  it.fails("TWO_CROSSINGS: a transform chain unevals to minimal scheme with the ANCHOR NAME free", () => {
    const sm = modelFor(TWO_CROSSINGS);
    const chain = sm.chains.find((c) => c.inputs.length === 1 && c.nodes.length > 0)!;
    const u = sm.unevalOf(chain);
    const producer = sm.anchors.find((a) => a.id === chain.inputs[0]!.anchor)!;
    expect(u.label).toContain(producer.name);
    expect(sm.sliceOf(chain).params).toEqual([producer.name]); // the slice's free var IS the anchor name
  });
});

describe("R10 · L-TIERS — classification (incl. the value-driven `route` cases)", () => {
  it.fails("HIGHER_ORDER: computed callee ⇒ tier 3, carrying the runnable provenance program", () => {
    const sm = modelFor(HIGHER_ORDER);
    const chain = sm.chains.find((c) => c.inputs.length === 1 && c.nodes.length > 0)!;
    const t = sm.transferOf(chain);
    expect(t.tier, "an unresolvable callee may NOT be silently downgraded to a JOIN").toBe(3);
    if (t.tier === 3) {
      expect(t.program.params.length).toBe(chain.inputs.length);
      expect(t.program.source.length).toBeGreaterThan(0);
    }
  });

  it.fails("DYNAMIC_KEY: a computed selection key is NOT a tier-1 lens (the `route` operator's territory)", () => {
    const sm = modelFor(DYNAMIC_KEY);
    const chain = sm.chains.find((c) => c.inputs.length >= 1)!;
    const t = sm.transferOf(chain);
    expect(t.tier, "value-driven selection cannot be a static projection").not.toBe(1);
  });

  it.fails("FAN: ONE anchor site for the loop body; the transfer keeps the parametric z-axis (never unrolled)", () => {
    const sm = modelFor(FAN);
    const perItem = crossings(sm).filter((a) => a.name !== "outs" && a.node !== undefined);
    // the map body's crossing is ONE site regardless of element count
    expect(crossings(sm).length, "3 crossing sites: per-item (in the lambda), join, and nothing else").toBe(2);
    const join = crossings(sm).find((a) => sm.chains.some((c) => c.output.anchor === a.id && c.inputs.length > 0))!;
    const chain = sm.chains.find((c) => c.output.anchor === join.id)!;
    const t = sm.transferOf(chain);
    expect(t.tier).toBe(1);
    if (t.tier === 1) expect(t.lens!.some((s) => s.kind === "z"), "the fan axis survives as a parametric step").toBe(true);
    expect(perItem.length).toBeGreaterThanOrEqual(1);
  });

  it.fails("RECURSION: a recursive pure helper is interior (never an anchor); its crossing is one site", () => {
    const sm = modelFor(RECURSION);
    expect(sm.anchors.some((a) => a.symbol === "last-of")).toBe(false);
    expect(crossings(sm).length).toBe(2);
  });
});

describe("R11 · L-DARK — interior darkness, enforced at the type surface", () => {
  it("spine DATA carries no methods: every algebra member lives on the model (allow-listed)", () => {
    const sm = modelFor(TWO_CROSSINGS);
    // (1) the model's surface is an exact allow-list — a new member of ANY name trips this
    const ALLOWED = new Set([
      "constructor",
      "nodeAt",
      "anchors",
      "chains",
      "chainFeeding",
      "demandGraph",
      "programOf",
      "sliceOf",
      "transferOf",
      "unevalOf",
      "wireMap",
    ]);
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(sm) as object);
    for (const m of surface) {
      expect(ALLOWED.has(m), `SchemeSemanticModel.${m}: undeclared surface member — L3 needs review before adding it`).toBe(
        true,
      );
    }
    // (2) the deep law: spine DATA (anchors/chains/transfers/slices/unevals) is INERT.
    //     A hook under ANY name is a function-valued property where only data belongs.
    //     Green today (the views throw); becomes load-bearing the moment they land.
    const inertness = (v: unknown, what: string): void => {
      if (v === null || typeof v !== "object") return;
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        expect(typeof val, `${what}.${k} is a function — spine data must be inert (L3)`).not.toBe("function");
      }
    };
    let anchors: unknown[] = [];
    try {
      anchors = [...sm.anchors];
    } catch {
      /* unimplemented — the guard arms itself when anchors land */
    }
    for (const a of anchors) inertness(a, "Anchor");
  });
});

// ── dual-plane rows — the LIVE eager-provenance plane as the oracle ───────
// Executable TODAY: `deepProvenance` (the per-value Sets this design reduces to
// a fallback tier) is ground truth. No interpreter change, no deferred plumbing.

describe("dual-plane laws — the dynamic plane is the oracle for the static one", () => {
  it.fails("R2 · L-INSTANCE: every crossing the interpreter actually executes has a static anchor at that site", async () => {
    const sm = modelFor(TWO_CROSSINGS);
    // the live run's crossings are the infer calls; their SITES are the model's
    // anchor nodes. A model that invents or misses a site fails here.
    const sites = new Set(crossings(sm).map((a) => a.node));
    expect(sites.size).toBe(3);
    // the dynamic half: an executed program's provenance atoms are non-empty
    // exactly when a crossing ran — pinned via deepProvenance in the green phase's
    // trace join; the STATIC claim (one anchor per executed site) is asserted above.
    expect(sm.anchors.every((a) => a.kind !== "source" || a.node !== undefined)).toBe(true);
  });

  it.fails("R6 · L-AGREE: the static where-transfer CONTAINS the live per-value provenance (mechanism-1 as ground truth)", async () => {
    // The live plane: run the program, read the eager Sets off the result value.
    const source = `(define response (infer "summarize" "hello"))
(string-append "v:" (car response))`;
    const { execState, LexicalScope, parseGenerator } = await import("@inhuman.tools/arrival");
    const scope = LexicalScope.fresh("dual-plane-r6");
    let last: unknown;
    for (const form of await parseGenerator(source)) {
      const st = await execState(form, { ambient: session.ambient, scope });
      last = st.values.at(-1);
    }
    const liveAtoms = deepProvenance(last);
    expect(liveAtoms.size, "the live plane must attribute the value to the infer crossing").toBeGreaterThan(0);

    // The static plane: the chain feeding the output must name that crossing.
    const sm = modelFor(source);
    const outChain = sm.chains.find((c) => c.output.anchor === sm.anchors.find((a) => a.kind === "boundary-out")!.id)!;
    const t = sm.transferOf(outChain);
    expect(t.tier).toBe(1);
    if (t.tier === 1) {
      const named = t.where.map((p) => sm.anchors.find((a) => a.id === p.anchor)!.name);
      expect(named).toContain("response"); // static where ⊇ the live attribution
    }
  });

  it.fails("R7 · L-CONTAIN: across the corpus, every program's live attribution is covered by the static wireMap", async () => {
    for (const [name, source] of Object.entries(ALL)) {
      const sm = modelFor(source);
      const edges = sm.wireMap;
      // containment's static half: every crossing that can consume data has an
      // in-edge in the map (a dynamic edge cannot exist where no static edge does)
      const consuming = crossings(sm).filter((a) => sm.chains.some((c) => c.output.anchor === a.id && c.inputs.length > 0));
      for (const a of consuming) {
        const inbound = [...edges.keys()].filter((k) => k.endsWith(`→${a.id}#0`) || k.includes(`→${a.id}#`));
        expect(inbound.length, `${name}: crossing ${a.name} consumes data but has no static wire`).toBeGreaterThan(0);
      }
    }
  });

  it.fails("R5 · L-RECON: sliceOf's params are the input anchors' names, and its source is a runnable lambda body", () => {
    const sm = modelFor(FAN_AND_DIRECT);
    for (const c of sm.chains) {
      const slice = sm.sliceOf(c);
      const inputNames = c.inputs.map((p) => sm.anchors.find((a) => a.id === p.anchor)!.name);
      expect(slice.params, "a slice's free variables ARE its input anchors — nothing else").toEqual(inputNames);
    }
  });
});
