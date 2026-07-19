/**
 * `collapseView`'s contract (control-plane-collapse.md §3/§5/§6; consolidation
 * README §4/§7 Wave 1, item 3) — the INV-1/2/4 property suite over the
 * fixture corpus + canonical four + the assess fragment + the real GEPA
 * extraction, the adversarial fold-collapse row, the Q2 merge/divergence
 * rules, and the GEPA census.
 *
 * REAL-PIPELINE-FIRST (mirrors compose-template.test.ts's own recipe): every
 * circuit here runs through parse → desugar → classify → extractProgram with
 * the REAL `defaultRegistry`, except the two hand-built Q2 fixtures (§6.4's
 * divergence class genuinely cannot be produced by real extraction — see
 * that describe block's own comment for why) and one hand-built `route` fan
 * (no cheap real route shape reaches this exact synthetic-choice form
 * outside `filter`, already covered elsewhere).
 *
 * `GEPA_SOURCE` is a LITERAL duplicate of `buildGepaSource` in
 * `circuit-gepa.stories.tsx`/`gepa-heads.test.ts` — the established
 * per-file-literal-copy precedent (a test importing a `.stories.tsx` module
 * would pull in Storybook's own registration side effects).
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import type { NodeId } from "../../coreform/types.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { extractProgram } from "../../extract/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import {
  collapseView,
  type ControlMachine,
  type ControlState,
  type LensEdge,
  type PortId,
  type StateId,
} from "../../model/collapse-view.js";
import type { ConstProv, FanProv, InputProv, MintProv, OpaqueProv, StaticProv } from "../../model/static-prov.js";
import { type ChannelAnchor, type ChannelTerminals, type Channels, channels, planeOf } from "../../verdict/circuit-verdict.js";
import { dataShaped, judgmentShaped } from "../../verdict/circuit-verdict.js";
import { FIXTURE_CORPUS } from "../extract/fixture-corpus.js";

const run = (src: string): StaticProv => extractProgram(classify(desugar(parseSexprs(src))).forms, defaultRegistry);

// ── the corpus (INV suites sweep all of these — mirrors compose-template.test.ts's own list) ──

const ASSESS = `
(define examples (list
    (dict :input "a" :expected "positive")
    (dict :input "b" :expected "negative")))
(define (metric prediction expected) (if (string-ci=? prediction expected) 1 0))
(define (ask instruction input)
  (:label (car (infer/chat "qwen3.5-9b"
                 (list (infer/chat/user (string-append instruction "\\n\\n" input)))
                 (s/object (s/field/string "label"))
                 (string-append "predict/" instruction "/" input)))))
(define (evaluate instruction)
  (map (lambda (ex) (metric (ask instruction (:input ex)) (:expected ex))) examples))
(define (assess instruction) (dict :instruction instruction :scores (evaluate instruction)))
(assess "Label the text.")
`;

const CORPUS: readonly { readonly name: string; readonly source: string }[] = [
  ...FIXTURE_CORPUS.map((r) => ({ name: `fixture-corpus/${r.name}`, source: r.source })),
  { name: "canonical/genuine", source: `(let ((e (dict :v (car (infer "m" "v"))))) (number->string (:v e)))` },
  { name: "canonical/guardSwapForge", source: `(if (< (:v e) 1000) "SAFE" (number->string (:v e)))` },
  { name: "canonical/judgment", source: `(let ((e (dict :guilty (car (infer "m" "g"))))) (if (:guilty e) "GUILTY" "INNOCENT"))` },
  { name: "canonical/decoy", source: `(let ((e (dict :v (car (infer "m" "v")) :o "FAKE"))) (number->string (:o e)))` },
  { name: "assess", source: ASSESS },
  { name: "smuggled-const", source: `(string-append "id-" "FORGED")` },
];

// ── flatten the hierarchy: one global (state, edge) index across every level ──

interface FlatView {
  readonly stateById: Map<StateId, ControlState>;
  readonly edgesByState: Map<StateId, LensEdge[]>;
}

function flatten(view: ControlMachine, acc: FlatView = { stateById: new Map(), edgesByState: new Map() }): FlatView {
  for (const s of view.states) {
    acc.stateById.set(s.id, s);
    if (s.kind === "fan" && s.interior) flatten(s.interior, acc);
  }
  for (const e of view.lensEdges) {
    if (!acc.edgesByState.has(e.to.state)) acc.edgesByState.set(e.to.state, []);
    acc.edgesByState.get(e.to.state)!.push(e);
  }
  return acc;
}

function edgeAt(flat: FlatView, state: StateId, port: PortId): LensEdge {
  const edge = flat.edgesByState.get(state)?.find((e) => e.to.port === port);
  if (!edge) throw new Error(`no edge at state ${state}, port ${port}`);
  return edge;
}

/** Every `ControlMachine` reachable from `view` (itself plus every fan
 *  interior, recursively) — used by the whole-machine INV-2/INV-4 sweeps. */
function everyMachine(view: ControlMachine, acc: ControlMachine[] = []): ControlMachine[] {
  acc.push(view);
  for (const s of view.states) if (s.kind === "fan" && s.interior) everyMachine(s.interior, acc);
  return acc;
}

// ── the independent reconstruction (INV-1) — same per-kind rules as
//    channelsFresh (circuit-verdict.ts), read from the view instead of the
//    raw tree. Each LensEdge already caches `channels(child)` in FULL (both
//    halves, over the whole reachable subtree) — see collapse-view.ts's own
//    doc on `LensEdge.terminals` for why a single projected value cannot
//    losslessly support this reconstruction. ──

const EMPTY: ChannelTerminals = { anchors: [], consts: 0, opaques: 0 };

function unionTerminals(parts: readonly ChannelTerminals[]): ChannelTerminals {
  const anchors: ChannelAnchor[] = [];
  let consts = 0;
  let opaques = 0;
  for (const p of parts) {
    anchors.push(...p.anchors);
    consts += p.consts;
    opaques += p.opaques;
  }
  return { anchors, consts, opaques };
}

function channelsOfState(flat: FlatView, id: StateId): Channels {
  const state = flat.stateById.get(id)!;
  const port = (p: PortId) => edgeAt(flat, id, p).terminals;

  switch (state.kind) {
    case "input":
      return { content: { anchors: [{ kind: "input", integrity: "evidence", site: state.site }], consts: 0, opaques: 0 }, selection: EMPTY };

    case "opaque":
      return { content: { anchors: [], consts: 0, opaques: 1 }, selection: EMPTY };

    case "mint": {
      const closed = (state.closedPorts ?? []).map(port);
      return {
        content: { anchors: [{ kind: "mint", integrity: state.integrity!, site: state.site }], consts: 0, opaques: 0 },
        selection: unionTerminals(closed.flatMap((c) => [c.content, c.selection])),
      };
    }

    case "decision": {
      const arms = (state.armPorts ?? []).map(port);
      const guards = (state.guardPorts ?? []).map(port);
      const judgmentConsts = (state.judgmentAlts ?? []).map((): ChannelTerminals => ({ anchors: [], consts: 1, opaques: 0 }));
      return {
        content: unionTerminals([...arms.map((a) => a.content), ...judgmentConsts]),
        selection: unionTerminals([...arms.map((a) => a.selection), ...guards.map((g) => g.content), ...guards.map((g) => g.selection)]),
      };
    }

    case "fan": {
      const collection = port("collection");
      if (state.maskRow !== undefined) {
        // §6.6 — the synthetic mask choice's OWN content is always the
        // collection's content wholesale (the mask's one alt is the null-key
        // element mux, which narrows to "whole" and returns the collection's
        // channels verbatim — see this test's header). Route always
        // promotes collection.content into selection too.
        const mask = edgeAt(flat, id, "mask").terminals;
        return {
          content: collection.content,
          selection: unionTerminals([collection.content, collection.selection, mask.content, mask.selection]),
        };
      }
      const body = channelsOfEgress(flat, state.interior!);
      const selectionParts = [body.selection, collection.selection];
      if (state.collapse === "route") selectionParts.push(collection.content);
      return {
        content: unionTerminals([body.content, collection.content]),
        selection: unionTerminals(selectionParts),
      };
    }

    case "egress":
      throw new Error("channelsOfState: egress is never itself a channel source — resolved via channelsOfEgress");
  }
}

function channelsOfEgress(flat: FlatView, machine: ControlMachine): Channels {
  if (machine.egress.kind === "state") return channelsOfState(flat, machine.egress.ref);
  const edge = machine.lensEdges.find((e) => e.id === machine.egress.ref);
  if (!edge) throw new Error("channelsOfEgress: dangling egress edge id");
  return edge.terminals;
}

function dataShapedOfView(view: ControlMachine): boolean {
  const flat = flatten(view);
  const c = channelsOfEgress(flat, view).content;
  return c.consts === 0 && c.opaques === 0 && c.anchors.length > 0 && c.anchors.every((a) => a.integrity === "evidence");
}

function guardGroundsInEvidenceOfView(edge: LensEdge): boolean {
  const { content, selection } = edge.terminals;
  if (content.opaques > 0 || selection.opaques > 0) return false;
  return content.anchors.some((a) => a.integrity === "evidence") || selection.anchors.some((a) => a.integrity === "evidence");
}

function judgmentShapedOfView(view: ControlMachine): boolean {
  if (view.egress.kind !== "state") return false;
  const flat = flatten(view);
  const state = flat.stateById.get(view.egress.ref)!;
  if (state.kind !== "decision") return false;
  if ((state.armPorts?.length ?? 0) > 0) return false; // every leaf alt must be bare-const
  if ((state.judgmentAlts?.length ?? 0) === 0) return false;
  if ((state.guardPorts?.length ?? 0) === 0) return false;
  return state.guardPorts!.every((p) => guardGroundsInEvidenceOfView(edgeAt(flat, state.id, p)));
}

function anchorSitesOf(c: Channels): Set<NodeId> {
  return new Set([...c.content.anchors, ...c.selection.anchors].map((a) => a.site));
}

// ── the independent "ground truth" walkers over the raw StaticProv (INV-2) ──

function sitesOfKind(p: StaticProv, kind: StaticProv["kind"], acc: Set<NodeId>, seen: Set<StaticProv>): void {
  if (seen.has(p)) return;
  seen.add(p);
  if (p.kind === kind) acc.add(p.site);
  switch (p.kind) {
    case "input":
    case "const":
    case "opaque":
      return;
    case "mint":
      p.closed.forEach((c) => sitesOfKind(c, kind, acc, seen));
      return;
    case "fused":
      p.sources.forEach((c) => sitesOfKind(c, kind, acc, seen));
      return;
    case "mux":
      sitesOfKind(p.source, kind, acc, seen);
      return;
    case "build":
      p.parts.forEach((pt) => sitesOfKind(pt.prov, kind, acc, seen));
      return;
    case "string":
      p.runs.forEach((c) => sitesOfKind(c, kind, acc, seen));
      return;
    case "choice":
      p.guards.forEach((g) => sitesOfKind(g, kind, acc, seen));
      p.alts.forEach((a) => sitesOfKind(a, kind, acc, seen));
      return;
    case "fan":
      sitesOfKind(p.collection, kind, acc, seen);
      sitesOfKind(p.body, kind, acc, seen);
      return;
  }
}

const rawSitesOfKind = (p: StaticProv, kind: StaticProv["kind"]): Set<NodeId> => {
  const acc = new Set<NodeId>();
  sitesOfKind(p, kind, acc, new Set());
  return acc;
};

function constSitesOfView(view: ControlMachine): Set<NodeId> {
  const sites = new Set<NodeId>();
  for (const m of everyMachine(view)) {
    for (const e of m.lensEdges) for (const s of e.absorbedConsts) sites.add(s);
    for (const s of m.states) if (s.judgmentAlts) for (const site of s.judgmentAlts) sites.add(site);
  }
  return sites;
}

function stateSitesOfKind(view: ControlMachine, kind: ControlState["kind"]): Set<NodeId> {
  const sites = new Set<NodeId>();
  for (const m of everyMachine(view)) for (const s of m.states) if (s.kind === kind) sites.add(s.site);
  return sites;
}

// ── INV-1 — channel preservation ─────────────────────────────────────────

describe("INV-1 — the view's reconstructed channels agree with channels(prov) directly", () => {
  for (const { name, source } of CORPUS) {
    it(`${name}`, () => {
      const prov = run(source);
      const view = collapseView(prov);
      expect(dataShapedOfView(view)).toBe(dataShaped(prov));
      expect(judgmentShapedOfView(view)).toBe(judgmentShaped(prov));
      expect(anchorSitesOf(channelsOfEgress(flatten(view), view))).toEqual(anchorSitesOf(channels(prov)));
    });
  }
});

// ── INV-2 — no laundering ─────────────────────────────────────────────────

describe("INV-2 — every const/opaque/anchor site is accounted for exactly once, by kind", () => {
  for (const { name, source } of CORPUS) {
    it(`${name}`, () => {
      const prov = run(source);
      const view = collapseView(prov);

      expect(constSitesOfView(view)).toEqual(rawSitesOfKind(prov, "const"));
      expect(stateSitesOfKind(view, "opaque")).toEqual(rawSitesOfKind(prov, "opaque"));

      // every input/mint SITE reachable anywhere is a state (Q2 merges by
      // site, so this compares SETS of sites, not counts).
      expect(stateSitesOfKind(view, "input")).toEqual(rawSitesOfKind(prov, "input"));
      expect(stateSitesOfKind(view, "mint")).toEqual(rawSitesOfKind(prov, "mint"));

      // opaque never absorbs.
      for (const m of everyMachine(view)) for (const e of m.lensEdges) expect(e.absorbedOpaques).toEqual([]);
    });
  }
});

// ── INV-4 — the seal never depends on the render (module-graph rule) ────

describe("INV-4 — collapse-view.ts is imported by render/tests only (S5-lint style)", () => {
  it("seal.ts has no import of collapse-view.js", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../../seal.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["'].*collapse-view(\.js)?["']/);
  });

  it("circuit-verdict.ts has no import of collapse-view.js", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../../verdict/circuit-verdict.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["'].*collapse-view(\.js)?["']/);
  });

  it("field-prov.ts has no import of collapse-view.js", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../../verdict/field-prov.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["'].*collapse-view(\.js)?["']/);
  });

  it("collapse-view.ts itself never imports seal.ts (one-way dependency)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../../model/collapse-view.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["'].*\/seal(\.js)?["']/);
  });
});

// ── the adversarial row — the fold-collapse forge surfaces INSIDE the fan ──

describe("the adversarial row — the fold-collapse forge surfaces as a decision state inside the fan's interior", () => {
  const source = FIXTURE_CORPUS.find((r) => r.name === "hidden-const fold (longcat)")!.source;

  it("sanity: the row is present and landed", () => {
    expect(source).toContain("FABRICATED");
  });

  it("the fan's interior contains a decision state with the FABRICATED const in judgmentAlts", () => {
    const prov = run(source);
    const view = collapseView(prov);
    expect(view.egress.kind).toBe("state");
    const flat = flatten(view);
    const fanState = flat.stateById.get((view.egress as { kind: "state"; ref: StateId }).ref)!;
    expect(fanState.kind).toBe("fan");
    expect(fanState.collapse).toBe("lowered"); // never "combine" — the forge stays visible
    expect(fanState.maskRow).toBeUndefined(); // not a route mask — a genuine nested decision
    const interior = fanState.interior!;
    expect(interior).toBeDefined();
    expect(interior.egress.kind).toBe("state");
    const decision = flat.stateById.get((interior.egress as { kind: "state"; ref: StateId }).ref)!;
    expect(decision.kind).toBe("decision");
    expect(decision.judgmentAlts?.length).toBe(1); // the FABRICATED const
    // the const is accounted (INV-2), never laundered into the guard's formula
    expect(constSitesOfView(view)).toEqual(rawSitesOfKind(prov, "const"));
  });
});

// ── Q2 rules ──────────────────────────────────────────────────────────────

describe("Q2 — same-level structural-equality merge and the shadowed-input divergence class", () => {
  it("same-site instances with genuinely identical structure merge (instances > 1)", () => {
    // Two sibling build slots reaching the SAME (kind, site) MINT shape
    // through DIFFERENT objects: one DefineFn (`label`) beta-reduced twice
    // (betaReduce mints a fresh Bound — and so a fresh MintProv — per call
    // site, confirmed below), but BOTH calls pass the SAME shared top-level
    // `define` as the argument, so `extract`'s own memo (`ExtractCtx.memo`,
    // keyed by Bound identity) resolves it to the IDENTICAL ConstProv both
    // times. Every leaf `label`'s body touches (its own "m" literal, and now
    // the argument too) is therefore identical by SITE across both
    // instances, so `shapeFingerprint` agrees and Q2 merges them.
    const source = `
(define shared-arg "p")
(define (label x) (:label (car (infer "m" x))))
(dict :a (label shared-arg) :b (label shared-arg))
`;
    const prov = run(source);
    if (prov.kind !== "build") throw new Error("expected build root");
    const a = prov.parts.find((p) => p.key === "a")!.prov;
    const b = prov.parts.find((p) => p.key === "b")!.prov;
    expect(a).not.toBe(b); // distinct objects — betaReduce mints fresh Bounds per call site

    const view = collapseView(prov);
    const mintStates = view.states.filter((s) => s.kind === "mint");
    expect(mintStates).toHaveLength(1);
    expect(mintStates[0]!.instances).toBe(2);
  });

  it("a shadowed-input divergent pair (same site, different kind) never merges — hand-built, since real extraction always sites a Ref by its OWN AST position (§6.4)", () => {
    // §6.4's exact class: the SAME program point (site) resolving to an
    // INPUT in one instantiation and a CONST in another (lexical shadowing
    // across two beta-reductions of a shared helper). Real extraction
    // always keys `site` off the SOURCE node that PRODUCED the value (a
    // Lit's own id, a Ref's own id) — see arm-atoms.ts's `extractRef`, which
    // recurses into the ARGUMENT's own CoreForm rather than re-stamping the
    // callee's site — so two genuinely different sources never coincide on
    // one site through ordinary beta-reduction. This test therefore
    // constructs the two instances directly (mirroring circuit-verdict.
    // test.ts's own hand-built-fixture convention for exactly this class of
    // edge case) to prove collapseView's OWN merge logic refuses to launder
    // it, independent of whether today's extractor can reach this shape.
    const SHARED_SITE = 77 as NodeId;
    const inputAtShared: InputProv = { kind: "input", site: SHARED_SITE, name: "e" };
    const constAtShared: ConstProv = { kind: "const", site: SHARED_SITE };
    // Two mints (distinct sites of their own) whose `closed` arg is the ONE
    // shared-site node, in each of its two divergent shapes.
    const mintA: MintProv = { kind: "mint", site: 1 as NodeId, head: "infer", integrity: "evidence", closed: [inputAtShared] };
    const mintB: MintProv = { kind: "mint", site: 2 as NodeId, head: "infer", integrity: "evidence", closed: [constAtShared] };
    const root: StaticProv = { kind: "build", site: 3 as NodeId, ctor: "dict", parts: [{ key: "a", prov: mintA }, { key: "b", prov: mintB }] };

    const view = collapseView(root);
    const mintStates = view.states.filter((s) => s.kind === "mint");
    expect(mintStates).toHaveLength(2); // NOT merged — the divergence blocks it
    expect(mintStates.every((s) => s.instances === 1)).toBe(true);
  });
});

// ── planeOf/isActive sanity: combine fans never reach visitActive ────────

describe("a combine-collapse fan never becomes a state (planeOf's own exception)", () => {
  it("(fold + 0 (:xs e)) — collapse:\"combine\" — is fully absorbed into the egress lens edge", () => {
    const prov = run(`(fold + 0 (:xs e))`);
    expect(prov).toMatchObject({ kind: "fan", collapse: "combine" });
    expect(planeOf(prov)).toBe("transparent");
    const view = collapseView(prov);
    expect(view.egress.kind).toBe("edge"); // no fan state exists at all
    const nonEgress = view.states.filter((s) => s.kind !== "egress");
    expect(nonEgress).toHaveLength(1); // just the input `e` — no fan state anywhere
    expect(nonEgress[0]!.kind).toBe("input");
  });
});

// ── GEPA — the worked example, measured honestly (post-RV-1) ─────────────

describe("GEPA — the real extraction, census measured post-RV-1", () => {
  const GEPA_LABELS = ["positive", "negative", "neutral"] as const;
  const GEPA_EXAMPLES: { input: string; expected: (typeof GEPA_LABELS)[number] }[] = [
    { input: "this app changed my life", expected: "positive" },
    { input: "it crashes every single time", expected: "negative" },
    { input: "the update shipped on tuesday", expected: "neutral" },
    { input: "absolutely love the new design", expected: "positive" },
    { input: "worst purchase i have ever made", expected: "negative" },
    { input: "the meeting is at noon", expected: "neutral" },
    { input: "fantastic support team so helpful", expected: "positive" },
    { input: "billing double charged me again", expected: "negative" },
    { input: "documentation lists the endpoints", expected: "neutral" },
    { input: "genuinely delighted with the results", expected: "positive" },
  ];
  const GEPA_ROUNDS = 4;

  /** Literal duplicate of `circuit-gepa.stories.tsx`/`gepa-heads.test.ts`'s
   *  identically-named function — see this file's header for why a literal
   *  copy, not a cross-import, is this package's own established precedent. */
  function buildGepaSource(): string {
    const examplesScheme = `(list
${GEPA_EXAMPLES.map((e) => `    (dict :input ${JSON.stringify(e.input)} :expected ${JSON.stringify(e.expected)})`).join("\n")})`;
    return `
(define examples ${examplesScheme})

(define (metric prediction expected) (if (string-ci=? prediction expected) 1 0))

(define (ask instruction input)
  (:label (car (infer/chat "qwen3.5-9b"
                 (list (infer/chat/user (string-append instruction "\\n\\n" input)))
                 (s/object (s/field/string "label"))
                 (string-append "predict/" instruction "/" input)))))

(define (reflect instruction failures)
  (:instruction (car (infer/chat "qwen3.5-9b"
                       (list (infer/chat/user (string-append
                         "Rewrite it to fix the failures"
                         (if (null? failures) "" (string-append " like: " (:input (car failures))))
                         ". Current instruction: " instruction)))
                       (s/object (s/field/string "instruction"))
                       (string-append "improve/" instruction)))))

(define (evaluate instruction)
  (map (lambda (ex) (metric (ask instruction (:input ex)) (:expected ex))) examples))

(define (assess instruction) (dict :instruction instruction :scores (evaluate instruction)))

(define (failing candidate) (map car (filter (lambda (pair) (zero? (cadr pair))) (map list examples (:scores candidate)))))

(define (mutate candidate) (assess (reflect (:instruction candidate) (failing candidate))))

(define (dominates? a b)
  (and (every >= (:scores a) (:scores b))
       (some  >  (:scores a) (:scores b))))

(define (frontier pool)
  (filter (lambda (c) (not (some (lambda (other) (dominates? other c)) pool))) pool))

(define (iterate step pool n) (if (zero? n) pool (iterate step (step pool) (- n 1))))

(define (generation pool) (frontier (append pool (map mutate pool))))

(define (gepa seed rounds)
  (max-by (lambda (c) (apply + (:scores c)))
          (iterate generation (list (assess seed)) rounds)))

(gepa "Label the text." ${GEPA_ROUNDS})
`;
  }

  const prov = run(buildGepaSource());
  const view = collapseView(prov);

  it("INV-1/INV-2 hold over the real GEPA circuit too", () => {
    expect(dataShapedOfView(view)).toBe(dataShaped(prov));
    expect(judgmentShapedOfView(view)).toBe(judgmentShaped(prov));
    expect(constSitesOfView(view)).toEqual(rawSitesOfKind(prov, "const"));
    expect(stateSitesOfKind(view, "opaque")).toEqual(rawSitesOfKind(prov, "opaque"));
    for (const m of everyMachine(view)) for (const e of m.lensEdges) expect(e.absorbedOpaques).toEqual([]);
  });

  it("egress is a lens edge (the root max-by(...) is a mux — data-plane)", () => {
    expect(planeOf(prov)).toBe("transparent");
    expect(view.egress.kind).toBe("edge");
  });

  it("the measured post-RV-1 census — honest numbers, not the pre-ruling doc's", () => {
    const all = everyMachine(view);
    const allStates = all.flatMap((m) => m.states).filter((s) => s.kind !== "egress");
    const byKind = (k: ControlState["kind"]) => allStates.filter((s) => s.kind === k);

    const opaques = byKind("opaque");
    const mints = byKind("mint");
    const fans = byKind("fan");
    const decisions = byKind("decision");

    // Depth: how many fan-interior levels deep the machine nests.
    const depthOf = (m: ControlMachine, level = 1): number => {
      let max = level;
      for (const s of m.states) if (s.kind === "fan" && s.interior) max = Math.max(max, depthOf(s.interior, level + 1));
      return max;
    };

    // RV-1 (2026-07-16): s/* reclassified fuse — the two s/object schema-arg
    // walls the pre-ruling doc counted are gone. Post-ruling, only the two
    // walls RV-1 does NOT touch remain: the registry gap in frontier's
    // predicate (every/some never classified) and failing's map-car
    // fn/fn-unresolvable gap (the one real coverage hole the design's own
    // worked example calls out). Printed, not just asserted, so a future
    // reader can see the honest breakdown without re-running this file.
    console.log("GEPA post-RV-1 census:", {
      opaques: opaques.map((o) => o.reason),
      mints: mints.map((m) => ({ head: m.head, instances: m.instances })),
      fans: fans.map((f) => ({ collapse: f.collapse, origin: f.origin, instances: f.instances, hasMask: f.maskRow !== undefined })),
      decisions: decisions.map((d) => ({ judgmentAlts: d.judgmentAlts?.length, guards: d.guardPorts?.length, arms: d.armPorts?.length })),
      totalStates: allStates.length,
      depth: depthOf(view),
    });

    expect(opaques.every((o) => o.reason !== undefined)).toBe(true);
    // The two RV-1-dissolved s/object walls must be gone: no wall's reason
    // names the s/ namespace.
    expect(opaques.some((o) => o.reason?.startsWith("s/") || o.reason?.includes("s/object"))).toBe(false);
  });
});
