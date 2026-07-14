/**
 * The static wire descriptor's own contract
 * (docs/foundations/arrival-scheme/provenance-by-perturbation.md §3). The KEY row
 * is longcat's fabrication-in-the-middle: a guard that reads a crossing but returns
 * one of two hand-written literals must derive as SELECTION, never content — the
 * whole reason the three-way verdict exists instead of v1's "grounding = movement."
 */
import { describe, expect, it } from "vitest";

import { classify } from "../coreform/index.js";
import type { ClassifyResult } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { derive } from "../wire/derive.js";
import { dataShaped, judgmentShaped, verdictFor } from "../wire/policy.js";
import type { Literal, PVertice } from "../wire/types.js";

/** The full front pipeline: parse → desugar → classify (coreform.test.ts's own
 *  convention, mirrored so this suite reads identically to its neighbors). */
const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));

describe("derive() — the backward walk", () => {
  it("KEY ROW: (if (:guilty e) \"GUILTY\" \"INNOCENT\") derives as Case over two Literals with the vertex in the CONDITION — dataShaped FAILS (selection, not content), judgmentShaped PASSES iff the declared vocabulary is {GUILTY, INNOCENT}", () => {
    const leaves = derive(cf(`(if (:guilty e) "GUILTY" "INNOCENT")`));
    expect(leaves).toHaveLength(1);
    const { path, descriptor } = leaves[0]!;
    expect(path).toEqual([]);

    // The shape: Case(cond: <(:guilty e)>, alts: [Literal "GUILTY", Literal "INNOCENT"]).
    expect(descriptor.source.kind).toBe("Case");
    expect(descriptor.steps).toEqual([]);
    if (descriptor.source.kind !== "Case") throw new Error("unreachable");
    const { cond, alts } = descriptor.source;

    // The vertex sits in the CONDITION: (:guilty e) ⇒ PVertice("e") + one "guilty" step.
    expect(cond.source.kind).toBe("PVertice");
    expect((cond.source as PVertice).anchorName).toBe("e");
    expect(cond.steps).toEqual([{ op: "guilty", argIndex: 0, otherArgs: [] }]);

    // Both alternatives are the program's own hand-written constants.
    expect(alts).toHaveLength(2);
    expect(alts[0]!.source.kind).toBe("Literal");
    expect(alts[1]!.source.kind).toBe("Literal");
    expect((alts[0]!.source as Literal).lit.value).toEqual({ kind: "string", value: "GUILTY" });
    expect((alts[1]!.source as Literal).lit.value).toEqual({ kind: "string", value: "INNOCENT" });

    // dataShaped FAILS — this is selection, not content, no matter how real the
    // guard's own dependence on `e` is.
    expect(dataShaped(descriptor)).toBe(false);

    // judgmentShaped PASSES iff the declared vocabulary is exactly the emitted set.
    expect(judgmentShaped(descriptor, new Set(["GUILTY", "INNOCENT"]))).toBe(true);
    // An undeclared constant in a judgment slot is a fabrication: drop one label…
    expect(judgmentShaped(descriptor, new Set(["GUILTY"]))).toBe(false);
    // …or declare an unrelated vocabulary entirely.
    expect(judgmentShaped(descriptor, new Set(["ALLOWED", "DENIED"]))).toBe(false);

    expect(verdictFor(descriptor, { role: "data" })).toEqual({ kind: "fabrication", residue: expect.any(Array) });
    expect(verdictFor(descriptor, { role: "judgment", vocabulary: new Set(["GUILTY", "INNOCENT"]) })).toEqual({
      kind: "judgment-shaped",
    });
    expect(verdictFor(descriptor, { role: "judgment", vocabulary: new Set(["GUILTY"]) }).kind).toBe("fabrication");
  });

  it('(cons (:name e) "FABRICATED") — per-leaf: car is content-grounded, cdr is a bare literal', () => {
    const leaves = derive(cf(`(cons (:name e) "FABRICATED")`));
    expect(leaves).toHaveLength(2);

    const car = leaves.find((l) => l.path.length === 1 && l.path[0] === "car");
    const cdr = leaves.find((l) => l.path.length === 1 && l.path[0] === "cdr");
    expect(car).toBeDefined();
    expect(cdr).toBeDefined();

    // car: (:name e) ⇒ PVertice("e") + one "name" step — content-grounded.
    expect(car!.descriptor.source.kind).toBe("PVertice");
    expect((car!.descriptor.source as PVertice).anchorName).toBe("e");
    expect(car!.descriptor.steps).toEqual([{ op: "name", argIndex: 0, otherArgs: [] }]);
    expect(dataShaped(car!.descriptor)).toBe(true);

    // cdr: a bare hand-written constant — never grounded.
    expect(cdr!.descriptor.source.kind).toBe("Literal");
    expect((cdr!.descriptor.source as Literal).lit.value).toEqual({ kind: "string", value: "FABRICATED" });
    expect(cdr!.descriptor.steps).toEqual([]);
    expect(dataShaped(cdr!.descriptor)).toBe(false);

    // derive() with an explicit leafPath narrows to the one matching entry.
    expect(derive(cf(`(cons (:name e) "FABRICATED")`), ["cdr"])).toEqual([cdr]);
  });

  it('(string-append (:id e) "-FAKE") — the content path reaches the vertex, but the LAST step carries a literal otherArg: the residue is a NODE', () => {
    const leaves = derive(cf(`(string-append (:id e) "-FAKE")`));
    expect(leaves).toHaveLength(1);
    const { descriptor } = leaves[0]!;

    // The main path: PVertice("e") --id--> --string-append(otherArg="-FAKE")--> result.
    expect(descriptor.source.kind).toBe("PVertice");
    expect((descriptor.source as PVertice).anchorName).toBe("e");
    expect(descriptor.steps).toHaveLength(2);
    expect(descriptor.steps[0]).toEqual({ op: "id", argIndex: 0, otherArgs: [] });

    const lastStep = descriptor.steps[1]!;
    expect(lastStep.op).toBe("string-append");
    expect(lastStep.argIndex).toBe(0);
    expect(lastStep.otherArgs).toHaveLength(1);
    const residueArg = lastStep.otherArgs[0]!;
    expect(residueArg.argIndex).toBe(1);
    // The residue IS a node — the literal AST leaf itself, not a count of anything.
    expect(residueArg.descriptor.source.kind).toBe("Literal");
    expect((residueArg.descriptor.source as Literal).lit.value).toEqual({ kind: "string", value: "-FAKE" });

    // Even though the vertex is reached, dataShaped FAILS: a residue anywhere in the
    // construction — not just at the top — disqualifies the leaf.
    expect(dataShaped(descriptor)).toBe(false);
    const verdict = verdictFor(descriptor, { role: "data" });
    expect(verdict.kind).toBe("fabrication");
    if (verdict.kind === "fabrication") {
      expect(verdict.residue).toHaveLength(1);
      expect(verdict.residue[0]!.value).toEqual({ kind: "string", value: "-FAKE" });
    }
  });

  it("a clean content leaf with no residue anywhere IS dataShaped", () => {
    const leaves = derive(cf(`(string-append (:id e) (:name e))`));
    expect(leaves).toHaveLength(1);
    const { descriptor } = leaves[0]!;
    expect(descriptor.source.kind).toBe("PVertice");
    expect(dataShaped(descriptor)).toBe(true);
    expect(verdictFor(descriptor, { role: "data" })).toEqual({ kind: "data-shaped" });
  });

  it("static blind spots emit an honest Hole, never a silent guess", () => {
    const filterLeaves = derive(cf(`(filter pred lst)`));
    expect(filterLeaves).toHaveLength(1);
    expect(filterLeaves[0]!.descriptor.source).toEqual({ kind: "Hole", reason: "filter-survivor" });
    expect(dataShaped(filterLeaves[0]!.descriptor)).toBe(false);

    // A computed callee: the head is not a bound reference at all.
    const computedCalleeLeaves = derive(cf(`((pick-fn) e)`));
    expect(computedCalleeLeaves).toHaveLength(1);
    expect(computedCalleeLeaves[0]!.descriptor.source).toEqual({ kind: "Hole", reason: "computed-callee" });
  });

  it("a let-bound alias forwards transparently, including through a compound constructor", () => {
    const leaves = derive(cf(`(let ((p (cons (:name e) "FABRICATED"))) p)`));
    expect(leaves).toHaveLength(2);
    const car = leaves.find((l) => l.path[0] === "car")!;
    const cdr = leaves.find((l) => l.path[0] === "cdr")!;
    expect(dataShaped(car.descriptor)).toBe(true);
    expect(dataShaped(cdr.descriptor)).toBe(false);
  });
});

describe("and/or as value-returning control (craft-review #2 — was a Hole)", () => {
  it('(or (:cached e) "DEFAULT") is a Case selecting a vertex value or a literal — NOT dataShaped', () => {
    const leaves = derive(cf(`(or (:cached e) "DEFAULT")`));
    const { descriptor } = leaves[0]!;
    expect(descriptor.source.kind).toBe("Case"); // was "Hole" before the fix
    if (descriptor.source.kind === "Case") {
      // one alternative is a vertex value, one is the "DEFAULT" literal
      expect(descriptor.source.alts.some((a) => a.source.kind === "PVertice")).toBe(true);
      expect(descriptor.source.alts.some((a) => a.source.kind === "Literal")).toBe(true);
    }
    // a leaf that might be the literal "DEFAULT" is selection, not pure content
    expect(dataShaped(descriptor)).toBe(false);
  });

  it("(and (:a e) (:b e)) is a Case with both alts vertex-derived ⇒ dataShaped (content either way)", () => {
    const leaves = derive(cf(`(and (:a e) (:b e))`));
    const { descriptor } = leaves[0]!;
    expect(descriptor.source.kind).toBe("Case");
    expect(dataShaped(descriptor)).toBe(true); // no literal alternative
  });
});
