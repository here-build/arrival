/**
 * The compose projection's contract (provenance-beautiful-child Wave 1, item
 * 1): `toComposeTemplate`/`renderComposeText` (compose-phase.md §4-§7),
 * `planeOf` (consolidation C1), the shared census (C2), and the honesty
 * invariants INV-2 (compose half) + INV-7 over the corpus.
 *
 * REAL-PIPELINE-FIRST, same recipe as projection-parity.test.ts: every
 * circuit here runs through parse → desugar → classify → extractProgram with
 * the REAL `defaultRegistry` — never a hand-built StaticProv — except where
 * a collapse kind is unreachable cheaply (one hand-built `route` fan,
 * flagged inline). Sites are never hardcoded (NodeIds are mint-order,
 * "unknowable by hand" — fixture-corpus.ts); the lens stubs and site
 * assertions are built FROM the extracted structure.
 *
 * The three §7 worked examples are pinned as fixtures:
 *   (a) V's dict — the unit test (one struct, two field formulas, two input
 *       holes, three lit tokens; tier-1 and tier-2 text pins)
 *   (b) the assess fragment — where-clause for `examples` (branching shared
 *       build), binder `ex` (identity-keyed to buildFan's element mux), the
 *       seed const same-site thrice
 *   (c) the smuggled-const string — every token lit-marked
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import type { NodeId } from "../../coreform/types.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { extractProgram } from "../../extract/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { census } from "../../model/census.js";
import { circuitToSexpr } from "../../model/circuit-sexpr.js";
import {
  type ComposeExpr,
  type ComposeHole,
  type ComposeTemplate,
  renderComposeText,
  type SourceLens,
  toComposeTemplate,
} from "../../model/compose-template.js";
import type { FanProv, MuxProv, StaticProv } from "../../model/static-prov.js";
import { planeOf } from "../../verdict/circuit-verdict.js";
import { FIXTURE_CORPUS } from "../extract/fixture-corpus.js";

const run = (src: string): StaticProv => extractProgram(classify(desugar(parseSexprs(src))).forms, defaultRegistry);

// ── walkers (test-side, exhaustive 10-arm — the package's own totality discipline) ──

/** Every ConstProv site reachable anywhere in the circuit (through actives too). */
function circuitConstSites(p: StaticProv, acc: Set<number>, seen: Set<StaticProv>): void {
  if (seen.has(p)) return;
  seen.add(p);
  switch (p.kind) {
    case "const":
      acc.add(p.site as number);
      return;
    case "input":
    case "opaque":
      return;
    case "mint":
      p.closed.forEach((c) => circuitConstSites(c, acc, seen));
      return;
    case "fused":
      p.sources.forEach((c) => circuitConstSites(c, acc, seen));
      return;
    case "mux":
      circuitConstSites(p.source, acc, seen);
      return;
    case "build":
      p.parts.forEach((pt) => circuitConstSites(pt.prov, acc, seen));
      return;
    case "string":
      p.runs.forEach((c) => circuitConstSites(c, acc, seen));
      return;
    case "choice":
      p.guards.forEach((g) => circuitConstSites(g, acc, seen));
      p.alts.forEach((a) => circuitConstSites(a, acc, seen));
      return;
    case "fan":
      circuitConstSites(p.collection, acc, seen);
      circuitConstSites(p.body, acc, seen);
      return;
  }
}

/** INV-7's independent ground truth: every channel-active node reachable
 *  from `p` WITHOUT passing through another channel-active node (descent
 *  through transparent kinds only; actives collect and STOP). */
function activeFrontier(p: StaticProv, acc: Set<StaticProv>, seen: Set<StaticProv>): void {
  if (seen.has(p)) return;
  seen.add(p);
  switch (p.kind) {
    case "input":
    case "mint":
    case "choice":
    case "fan":
    case "opaque":
      acc.add(p);
      return;
    case "const":
      return;
    case "fused":
      p.sources.forEach((c) => activeFrontier(c, acc, seen));
      return;
    case "mux":
      activeFrontier(p.source, acc, seen);
      return;
    case "build":
      p.parts.forEach((pt) => activeFrontier(pt.prov, acc, seen));
      return;
    case "string":
      p.runs.forEach((c) => activeFrontier(c, acc, seen));
      return;
  }
}

/** Collect every ComposeExpr node in a tree (pre-order). */
function exprNodes(e: ComposeExpr, acc: ComposeExpr[]): void {
  acc.push(e);
  switch (e.kind) {
    case "lit":
    case "hole":
    case "binder":
      return;
    case "access":
      exprNodes(e.base, acc);
      return;
    case "op":
      e.args.forEach((a) => exprNodes(a, acc));
      return;
    case "runs":
      e.runs.forEach((r) => exprNodes(r, acc));
      return;
    case "struct":
      e.fields.forEach((f) => exprNodes(f.value, acc));
      return;
  }
}

/** All expr trees of a template: the root plus every shared hole's formula. */
function allExprs(t: ComposeTemplate): ComposeExpr[] {
  const acc: ComposeExpr[] = [];
  exprNodes(t.root, acc);
  for (const h of t.holes.values()) if (h.formula) exprNodes(h.formula, acc);
  return acc;
}

const holesOf = (t: ComposeTemplate): ComposeHole[] => [...t.holes.values()];
const litSitesOf = (t: ComposeTemplate): Set<number> =>
  new Set(allExprs(t).flatMap((e) => (e.kind === "lit" ? [e.site as number] : [])));

// ── the corpus (INV suites sweep all of these) ───────────────────────────────

const V_DICT = `(dict :score (+ 1 (:v e)) :label (string-append "prefix" (:name e) "suffix"))`;

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

/** Canonical-four literals (duplicated from circuit-sharing.test.ts's own
 *  constant for the same reason it duplicates them from the stories: a test
 *  importing another `.test.ts` would re-run that file's registrations). */
const CORPUS: readonly { readonly name: string; readonly source: string }[] = [
  ...FIXTURE_CORPUS.map((r) => ({ name: `fixture-corpus/${r.name}`, source: r.source })),
  { name: "canonical/genuine", source: `(let ((e (dict :v (car (infer "m" "v"))))) (number->string (:v e)))` },
  { name: "canonical/guardSwapForge", source: `(if (< (:v e) 1000) "SAFE" (number->string (:v e)))` },
  { name: "canonical/judgment", source: `(let ((e (dict :guilty (car (infer "m" "g"))))) (if (:guilty e) "GUILTY" "INNOCENT"))` },
  { name: "canonical/decoy", source: `(let ((e (dict :v (car (infer "m" "v")) :o "FAKE"))) (number->string (:o e)))` },
  { name: "v-dict", source: V_DICT },
  { name: "assess", source: ASSESS },
  { name: "smuggled-const", source: `(string-append "id-" "FORGED")` },
  { name: "smuggled-const-anchored", source: `(string-append "id-" (:v e) "-FORGED")` },
  { name: "shared-branching-build", source: `(define xs (list (:a e) (:b e))) (dict :p xs :q xs)` },
  { name: "shared-unary-mux", source: `(define xs (:v e)) (dict :a xs :b xs)` },
];

// ── planeOf (C1) ─────────────────────────────────────────────────────────────

describe("planeOf — the one boundary, exhaustive over the 10-kind union (C1)", () => {
  it("transparent: fused / mux / build / string (real extract)", () => {
    expect(planeOf(run(`(+ (:a e) 1)`))).toBe("transparent"); // fused
    expect(planeOf(run(`(:v e)`))).toBe("transparent"); // mux
    expect(planeOf(run(`(list 1 2)`))).toBe("transparent"); // build
    expect(planeOf(run(`(string-append "a" (:v e))`))).toBe("transparent"); // string
  });

  it("active: input / mint / choice / opaque (real extract)", () => {
    expect(planeOf(run(`e`))).toBe("active"); // input (free evidence handle)
    expect(planeOf(run(`(infer "m" "p")`))).toBe("active"); // mint
    expect(planeOf(run(`(if (:g e) "A" "B")`))).toBe("active"); // choice
    expect(planeOf(run(`(frobnicate 1)`))).toBe("active"); // opaque (unknown head)
  });

  it("const is its own plane — the fabrication mark, neither inlined structure nor a state", () => {
    expect(planeOf(run(`"x"`))).toBe("const");
  });

  it("fan: collapse:\"combine\" is DATA-plane (the lens-1 exception) — a real (fold + 0 …) through buildFan's AC path", () => {
    const combineFan = run(`(fold + 0 (:xs e))`);
    expect(combineFan).toMatchObject({ kind: "fan", collapse: "combine" });
    expect(planeOf(combineFan)).toBe("transparent");
  });

  it("fan: lowered stays active (real extract — the hidden-const fold)", () => {
    const loweredFan = run(`(fold (lambda (acc x) (if (eq? x "s") "FABRICATED" x)) "" (:xs e))`);
    expect(loweredFan).toMatchObject({ kind: "fan", collapse: "lowered" });
    expect(planeOf(loweredFan)).toBe("active");
  });

  it("fan: route stays active (hand-built — no cheap real route shape in the corpus)", () => {
    const S = 0 as NodeId;
    const collection: StaticProv = { kind: "mux", site: S, key: "xs", source: { kind: "input", site: S, name: "e" } };
    const routeFan: StaticProv = {
      kind: "fan",
      site: S,
      collection,
      body: { kind: "mux", site: S, key: null, source: collection },
      collapse: "route",
    };
    expect(planeOf(routeFan)).toBe("active");
  });
});

// ── fixture (a): V's dict — the unit test (spec §7a) ─────────────────────────

describe("worked example (a) — V's dict renders as one struct with two field formulas", () => {
  const prov = run(V_DICT);
  const t = toComposeTemplate(prov);

  it("ONE struct root with exactly the two field formulas", () => {
    expect(t.root.kind).toBe("struct");
    if (t.root.kind !== "struct") throw new Error("expected struct");
    expect(t.root.ctor).toBe("dict");
    expect(t.root.fields.map((f) => f.key)).toEqual(["score", "label"]);
    expect(t.root.fields[0]!.value.kind).toBe("op"); // fused → operator formula
    expect(t.root.fields[1]!.value.kind).toBe("runs"); // string → ordered template
  });

  it("two input holes — two tokens, one label (two distinct InputProv objects, both named e)", () => {
    const holes = holesOf(t);
    expect(holes).toHaveLength(2);
    expect(holes.every((h) => h.reason === "input" && h.label === "e")).toBe(true);
    // distinct objects — the probe's cancellation counting survives as hole count
    expect(holes[0]!.prov).not.toBe(holes[1]!.prov);
    // and each is referenced through its own access token
    const holeRefs = allExprs(t).filter((e) => e.kind === "hole");
    expect(holeRefs).toHaveLength(2);
  });

  it("three lit tokens — 1, \"prefix\", \"suffix\" — and nothing unmarked (lit is the only literal kind)", () => {
    const lits = allExprs(t).filter((e) => e.kind === "lit");
    expect(lits).toHaveLength(3);
    // sites are distinct (three different program-text literals)
    expect(new Set(lits.map((l) => (l.kind === "lit" ? l.site : -1))).size).toBe(3);
  });

  it("tier-1 text pin — generic operators, honest to the circuit alone", () => {
    expect(renderComposeText(t)).toBe("{score: ⊗(⚠, ⟨e⟩.v), label: str(⚠, ⟨e⟩.name, ⚠)}");
  });

  it("tier-2 text pin — the spec's verbatim beauty, via a hand-stubbed lens built from the template's own sites", () => {
    if (t.root.kind !== "struct") throw new Error("expected struct");
    const scoreOp = t.root.fields[0]!.value;
    const labelRuns = t.root.fields[1]!.value;
    if (scoreOp.kind !== "op" || labelRuns.kind !== "runs") throw new Error("expected op + runs");
    const lit = (e: ComposeExpr): NodeId => {
      if (e.kind !== "lit") throw new Error("expected lit");
      return e.site;
    };
    const heads = new Map<NodeId, string>([
      [scoreOp.site, "+"],
      [labelRuns.site, "string-append"],
    ]);
    const literals = new Map<NodeId, string>([
      [lit(scoreOp.args[0]!), "1"],
      [lit(labelRuns.runs[0]!), '"prefix"'],
      [lit(labelRuns.runs[2]!), '"suffix"'],
    ]);
    const lens: SourceLens = {
      literalTextAt: (site) => literals.get(site),
      headAt: (site) => heads.get(site),
      bindingNameAt: () => undefined,
    };
    expect(renderComposeText(t, lens)).toBe('{score: 1⚠ + ⟨e⟩.v, label: "prefix"⚠ ⧺ ⟨e⟩.name ⧺ "suffix"⚠}');
  });

  it("tier-1 without a lens stays generic even where tier-2 would beautify — no lens, no spellings", () => {
    expect(renderComposeText(t)).not.toContain("+");
    expect(renderComposeText(t)).not.toContain("prefix");
  });
});

// ── fixture (b): the assess fragment (spec §7b) ──────────────────────────────

describe("worked example (b) — assess: where-clause, binder, same-site seed const", () => {
  const prov = run(ASSESS);
  const c = census(prov);
  const t = toComposeTemplate(prov);

  // navigate the real extraction once, shared by the cases below
  if (prov.kind !== "build") throw new Error("expected build root");
  const fan = prov.parts.find((p) => p.key === "scores")!.prov as FanProv;
  const seedConst = prov.parts.find((p) => p.key === "instruction")!.prov;
  const body = fan.body;
  if (body.kind !== "choice") throw new Error("expected choice body");
  const guard = body.guards[0]!;
  if (guard.kind !== "fused") throw new Error("expected fused guard");
  const expectedMux = guard.sources.find((s) => s.kind === "mux" && s.key === "expected") as MuxProv;
  const element = expectedMux.source; // buildFan's ONE distinguished element mux

  it("sanity: the element IS buildFan's distinguished mux{key:null} over the fan's own collection (R3's identity anchor)", () => {
    expect(element).toMatchObject({ kind: "mux", key: null });
    if (element.kind !== "mux") throw new Error("expected mux");
    expect(element.source).toBe(fan.collection);
  });

  it("the root template: instruction is a lit, scores is the fan hole", () => {
    expect(t.root.kind).toBe("struct");
    if (t.root.kind !== "struct") throw new Error("expected struct");
    expect(t.root.fields[0]!.value.kind).toBe("lit");
    const scoresVal = t.root.fields[1]!.value;
    expect(scoresVal.kind).toBe("hole");
    if (scoresVal.kind !== "hole") throw new Error("expected hole");
    expect(t.holes.get(scoresVal.hole)).toMatchObject({ reason: "fan", prov: fan });
  });

  it("the where-clause: `examples` (the branching shared build) lifts to ONE shared hole whose formula is the literal table", () => {
    const shared = holesOf(t).filter((h) => h.reason === "shared");
    expect(shared).toHaveLength(1);
    const h = shared[0]!;
    expect(h.prov).toBe(fan.collection); // the program's own (define examples …)
    expect(h.formula).toBeDefined();
    expect(h.formula!.kind).toBe("struct");
    if (h.formula!.kind !== "struct") throw new Error("expected struct");
    expect(h.formula!.ctor).toBe("vector");
    expect(h.formula!.fields).toHaveLength(2);
    // ten…er, four marked tokens: a wall of literals is how a human reads a data table (R4)
    const lits = ((): ComposeExpr[] => {
      const acc: ComposeExpr[] = [];
      exprNodes(h.formula!, acc);
      return acc.filter((e) => e.kind === "lit");
    })();
    expect(lits).toHaveLength(4);
  });

  it("the where-clause label ♯k carries the census id — cross-readable to circuit-sexpr's :id k for the SAME object", () => {
    const h = holesOf(t).find((x) => x.reason === "shared")!;
    const cid = c.idOf.get(h.prov);
    expect(cid).toBeDefined();
    expect(h.label).toBe(`♯${cid}`);
    const sexpr = circuitToSexpr(prov);
    expect(sexpr).toContain(`(build :id ${cid} `); // examples' first occurrence, tagged
    expect(sexpr).toContain(`(ref ${cid})`); // and its later occurrence(s)
  });

  it("unary shared nodes copy, n-ary lift: the element mux and the ex-input mux are census-shared but produce NO where-clause (R2)", () => {
    // census sees them shared…
    const sharedMuxes = [...c.idOf.keys()].filter((n) => n.kind === "mux");
    expect(sharedMuxes.length).toBeGreaterThanOrEqual(2);
    // …but only the n-ary build lifted; every shared hole is fused/string/build
    for (const h of holesOf(t).filter((x) => x.reason === "shared")) {
      expect(["fused", "string", "build"]).toContain(h.prov.kind);
    }
  });

  it("binder `ex` inside the fan hole: the guard's formula renders the element as the binder token (identity-keyed)", () => {
    const binders = new Map<StaticProv, string>([[element, "ex"]]);
    const guardT = toComposeTemplate(guard, { binders });
    expect(renderComposeText(guardT)).toBe("⊗(⟦infer/chat №1⟧.car.label, ex.expected)");
    // the binder token is there by IDENTITY, not by shape — and the mint is the only hole
    const holes = holesOf(guardT);
    expect(holes).toHaveLength(1);
    expect(holes[0]!).toMatchObject({ reason: "mint", label: "infer/chat" });
  });

  it("the seed const appears same-site THRICE across the composed surface: root field + prompt run + cache-key run (R2 leaf copy)", () => {
    expect(seedConst.kind).toBe("const");
    expect(c.countOf.get(seedConst)).toBe(3);
    const seedSite = seedConst.site as number;
    // (1) the root template's instruction lit
    const rootLits = litSitesOf(t);
    expect(rootLits.has(seedSite)).toBe(true);
    // (2)+(3) the mint card's closed formulas — prompt and cache key
    const labelMux = guard.sources.find((s) => s !== expectedMux)!;
    let mint: StaticProv = labelMux;
    while (mint.kind === "mux") mint = mint.source;
    expect(mint.kind).toBe("mint");
    if (mint.kind !== "mint") throw new Error("expected mint");
    const binders = new Map<StaticProv, string>([[element, "ex"]]);
    const closedLitSites = mint.closed.map((arg) => litSitesOf(toComposeTemplate(arg, { binders })));
    const appearances = closedLitSites.filter((sites) => sites.has(seedSite)).length;
    expect(appearances).toBe(2); // the prompt string AND the cache key, never the model/schema args
  });

  it("tier-1 render of the whole root template (pin): the compression concentrates attention on the marks", () => {
    expect(renderComposeText(t)).toBe(
      "{instruction: ⚠, scores: ⟳№1}\nwhere ♯1 = [{input: ⚠, expected: ⚠}, {input: ⚠, expected: ⚠}]",
    );
  });

  it("tier-2 where-clause naming: a lens that resolves the binding name renders ♯examples (the author's own define)", () => {
    const h = holesOf(t).find((x) => x.reason === "shared")!;
    const lens: SourceLens = {
      literalTextAt: () => undefined,
      headAt: () => undefined,
      bindingNameAt: (site) => (site === h.prov.site ? "examples" : undefined),
    };
    expect(renderComposeText(t, lens)).toContain("where ♯examples = ");
  });
});

// ── fixture (c): the smuggled const (spec §7c) ───────────────────────────────

describe("worked example (c) — the smuggled-const string: every token lit-marked", () => {
  it('(string-append "id-" "FORGED") — all tokens are marked lits; there is no way to write this without the marks', () => {
    const t = toComposeTemplate(run(`(string-append "id-" "FORGED")`));
    expect(t.root.kind).toBe("runs");
    if (t.root.kind !== "runs") throw new Error("expected runs");
    expect(t.root.runs).toHaveLength(2);
    expect(t.root.runs.every((r) => r.kind === "lit")).toBe(true);
    expect(t.holes.size).toBe(0);
    expect(renderComposeText(t)).toBe("str(⚠, ⚠)");
  });

  it('(string-append "id-" (:v e) "-FORGED") — a red token inside an anchored string is unmissable at one line', () => {
    const t = toComposeTemplate(run(`(string-append "id-" (:v e) "-FORGED")`));
    expect(renderComposeText(t)).toBe("str(⚠, ⟨e⟩.v, ⚠)");
    const kinds = allExprs(t).map((e) => e.kind);
    expect(kinds.filter((k) => k === "lit")).toHaveLength(2);
    expect(kinds.filter((k) => k === "hole")).toHaveLength(1);
  });
});

// ── the dead-projection mark (spec §6 — narrowMux's 0-hit sub-case, shared verbatim) ──

describe("the dead-projection mark — the verdict's own 0-hit fail-closed reading on the access token", () => {
  it("a provably-absent key over a literal container marks the access dead: `.z⊘`", () => {
    const t = toComposeTemplate(run(`(:z (dict :v 1))`));
    expect(t.root).toMatchObject({ kind: "access", key: "z", dead: true });
    expect(renderComposeText(t)).toBe("{v: ⚠}.z⊘");
  });

  it("the two-alphabet conservatism surfaces identically: (car (cons …)) is dead, matching the verdict's own opaque", () => {
    const t = toComposeTemplate(run(`(car (cons (:v e) (:w e)))`));
    expect(t.root).toMatchObject({ kind: "access", key: "car", dead: true });
  });

  it("a projection over a non-build source is NOT dead (no narrowing applies — the whole source flows)", () => {
    const t = toComposeTemplate(run(`(car (infer "m" "p"))`));
    expect(t.root).toMatchObject({ kind: "access", key: "car", dead: false });
  });

  it("a matched key is NOT dead — the field-access evidence idiom", () => {
    const t = toComposeTemplate(run(`(:v (dict :v (car (infer "m" "v")) :o "FAKE"))`));
    expect(t.root).toMatchObject({ kind: "access", key: "v", dead: false });
  });
});

// ── R2 copies: unary/leaf shared nodes copy with site-equality ───────────────

describe("R2 — shared unary/leaf nodes copy freely, identity recoverable as site-equality", () => {
  it("a shared mux copies (no where-clause), and both copies share the SAME site and the SAME base hole", () => {
    const t = toComposeTemplate(run(`(define xs (:v e)) (dict :a xs :b xs)`));
    expect(holesOf(t).filter((h) => h.reason === "shared")).toHaveLength(0);
    if (t.root.kind !== "struct") throw new Error("expected struct");
    const [a, b] = t.root.fields.map((f) => f.value);
    expect(a).toMatchObject({ kind: "access", key: "v" });
    expect(b).toMatchObject({ kind: "access", key: "v" });
    if (a!.kind !== "access" || b!.kind !== "access") throw new Error("expected access");
    expect(a!.site).toBe(b!.site); // site-equality — the (ref N) fact is recoverable
    expect(a!.base).toEqual(b!.base); // the ONE input under the shared mux → the same hole id
  });

  it("a shared BRANCHING build lifts instead: one where-clause, both references point at the one hole", () => {
    const prov = run(`(define xs (list (:a e) (:b e))) (dict :p xs :q xs)`);
    const t = toComposeTemplate(prov);
    const shared = holesOf(t).filter((h) => h.reason === "shared");
    expect(shared).toHaveLength(1);
    if (t.root.kind !== "struct") throw new Error("expected struct");
    const [p, q] = t.root.fields.map((f) => f.value);
    expect(p).toEqual({ kind: "hole", hole: shared[0]!.id });
    expect(q).toEqual({ kind: "hole", hole: shared[0]!.id });
    // and the census/sexpr cross-read holds here too
    const cid = census(prov).idOf.get(shared[0]!.prov);
    expect(shared[0]!.label).toBe(`♯${cid}`);
    const sexpr = circuitToSexpr(prov);
    expect(sexpr).toContain(`:id ${cid} `);
    expect(sexpr).toContain(`(ref ${cid})`);
  });
});

// ── INV-7: channel purity over the corpus ────────────────────────────────────

describe("INV-7 — channel purity: no channel-active kind appears as an interior expr node", () => {
  for (const { name, source } of CORPUS) {
    it(`${name}: the template's holes are exactly the circuit's active frontier`, () => {
      const prov = run(source);
      const t = toComposeTemplate(prov);

      // (i) every hole is honest about what it stands for
      for (const h of holesOf(t)) {
        if (h.reason === "shared") {
          expect(["fused", "string", "build"]).toContain(h.prov.kind);
          expect(h.formula).toBeDefined();
        } else {
          expect(h.prov.kind).toBe(h.reason);
          expect(h.formula).toBeUndefined();
        }
      }

      // (ii) the frontier law: actives reachable through transparent material
      // (from the root, and from every lifted where-clause interior) are ALL
      // holes — and nothing else is an active hole. This is the purity
      // theorem read off the structure: an active node can never sit interior
      // to a formula because it is always captured as a hole at first contact.
      const expected = new Set<StaticProv>();
      const seen = new Set<StaticProv>();
      activeFrontier(prov, expected, seen);
      for (const h of holesOf(t)) {
        if (h.reason === "shared") activeFrontier(h.prov, expected, new Set());
      }
      const actualActive = new Set(holesOf(t).filter((h) => h.reason !== "shared").map((h) => h.prov));
      expect(actualActive).toEqual(expected);

      // (iii) no dangling hole references
      for (const e of allExprs(t)) {
        if (e.kind === "hole") expect(t.holes.has(e.hole)).toBe(true);
      }
    });
  }
});

// ── INV-2 (compose half): const accounting ───────────────────────────────────

describe("INV-2 — no laundering: circuit consts ≡ template lits ∪ consts inside hole subcircuits", () => {
  for (const { name, source } of CORPUS) {
    it(`${name}: every const accounted, no lit without a ConstProv`, () => {
      const prov = run(source);
      const t = toComposeTemplate(prov);

      const circuitSites = new Set<number>();
      circuitConstSites(prov, circuitSites, new Set());

      const litSites = litSitesOf(t);
      const holeInteriorSites = new Set<number>();
      for (const h of holesOf(t)) circuitConstSites(h.prov, holeInteriorSites, new Set());

      // no lit without a ConstProv — lit ⟺ ConstProv by construction
      for (const site of litSites) expect(circuitSites.has(site)).toBe(true);

      // no const unaccounted — every circuit const surfaces as a lit token or
      // sits inside a hole's subcircuit (where the hole's own card renders it)
      const accounted = new Set([...litSites, ...holeInteriorSites]);
      for (const site of circuitSites) expect(accounted.has(site)).toBe(true);
    });
  }
});

// ── census sharing across projections (C2) ───────────────────────────────────

describe("C2 — one census: compose ♯k ids and circuit-sexpr :id k are the same numbering", () => {
  for (const { name, source } of CORPUS) {
    it(`${name}: every shared hole's ♯ label matches the census id the sexpr prints`, () => {
      const prov = run(source);
      const t = toComposeTemplate(prov);
      const c = census(prov);
      const sexpr = circuitToSexpr(prov);
      for (const h of holesOf(t).filter((x) => x.reason === "shared")) {
        const cid = c.idOf.get(h.prov);
        expect(cid).toBeDefined();
        expect(h.label).toBe(`♯${cid}`);
        expect(sexpr).toContain(`:id ${cid} `);
        expect(sexpr).toContain(`(ref ${cid})`);
      }
    });
  }

  it("hole ids are first-occurrence ordered and the holes map preserves insertion order", () => {
    const t = toComposeTemplate(run(ASSESS));
    const ids = holesOf(t).map((h) => h.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]).toBe(1); // 1-based, per the spec legend's №1
  });

  it("determinism: the same program renders the same template text twice", () => {
    const a = renderComposeText(toComposeTemplate(run(ASSESS)));
    const b = renderComposeText(toComposeTemplate(run(ASSESS)));
    expect(a).toBe(b);
  });
});
