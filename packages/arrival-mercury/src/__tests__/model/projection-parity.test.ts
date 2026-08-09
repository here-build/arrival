/**
 * Projection parity — the three `StaticProv` projections (`circuit-sexpr.ts`,
 * `circuit-mermaid.ts`, `to-wireframe.ts`) must AGREE on whether a `choice`'s
 * selection structure (its guards + kept, non-taken alternatives) is VISIBLE.
 *
 * A cross-model audit found a drift risk on this security review surface: the
 * SEXPR projection already renders a non-taken alt explicitly (the `(gray …)`
 * wrap, `circuit-sexpr.ts`), but MERMAID rendered alts as plain solid `|alt|`
 * edges (indistinguishable from ordinary data flow) and WIREFRAME exposed no
 * distinct channel for them at all — a reviewer could see the choice's
 * structure in one projection and lose it in the other two. This suite pins
 * the fix: for each source below, every projection either shows the choice's
 * alternative structure distinctly, or shows no choice at all — never a
 * three-way split.
 *
 * Sources run through the REAL pipeline (parse → desugar → classify →
 * extractProgram with `defaultRegistry`) — the same recipe
 * `extract-corpus.test.ts` uses — never a hand-built `StaticProv`, so this is
 * a genuine end-to-end check, not a fixture the three renderers were tuned to
 * individually.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { circuitToMermaid } from "../../model/circuit-mermaid.js";
import { circuitToSexpr } from "../../model/circuit-sexpr.js";
import type { StaticProv } from "../../model/static-prov.js";
import { toWireframe } from "../../model/to-wireframe.js";

const run = (source: string): StaticProv => {
  const { forms } = classify(desugar(parseSexprs(source)));
  return extractProgram(forms, defaultRegistry);
};

/** Site-blind (never keys on NodeId, same discipline as fixture-corpus.ts's
 *  `mismatch`): TRUE iff a `choice` node exists anywhere in the circuit,
 *  however deep. Used only as a sanity check that a case's `hasChoice` label
 *  actually matches what the real pipeline produced — never a projection's
 *  own reasoning. */
function containsChoice(prov: StaticProv): boolean {
  switch (prov.kind) {
    case "choice":
      return true;
    case "input":
    case "const":
    case "opaque":
      return false;
    case "mint":
      return prov.closed.some(containsChoice);
    case "fused":
      return prov.sources.some(containsChoice);
    case "mux":
      return containsChoice(prov.source);
    case "build":
      return prov.parts.some((part) => containsChoice(part.prov));
    case "string":
      return prov.runs.some(containsChoice);
    case "fan":
      return containsChoice(prov.collection) || containsChoice(prov.body);
  }
}

/** SEXPR shows a choice's alternative structure iff the `(gray …)` device
 *  appears anywhere (`circuit-sexpr.ts`'s `renderChoice`). */
const sexprShowsSelection = (out: string): boolean => out.includes("(gray ");

/** MERMAID shows it iff BOTH a dashed `guard` edge and a dashed `alt` edge
 *  are present (`circuit-mermaid.ts`'s `renderChoice`, post-parity-fix: alts
 *  are dashed too, told apart from guards only by label). */
const mermaidShowsSelection = (out: string): boolean => out.includes('-.->|"guard"|') && out.includes('-.->|"alt"|');

/** WIREFRAME shows it iff `choiceWireRole` has at least one entry
 *  (`to-wireframe.ts`'s `projectChoice`; the map is populated ONLY for a
 *  `choice`-projected node's own wires). */
const wireframeShowsSelection = (sideMaps: { readonly choiceWireRole?: ReadonlyMap<string, "guard" | "alt"> }): boolean =>
  (sideMaps.choiceWireRole?.size ?? 0) > 0;

interface Case {
  readonly name: string;
  readonly source: string;
  readonly hasChoice: boolean;
}

const CASES: readonly Case[] = [
  { name: "plain data flow", source: `(+ (:a e) (:b e))`, hasChoice: false },
  { name: "a guarded choice", source: `(if (:guilty e) "A" "B")`, hasChoice: true },
  { name: "a guardless const", source: `"FAKE"`, hasChoice: false },
];

describe("projection parity — choice selection structure: all three agree, or none show it", () => {
  for (const { name, source, hasChoice } of CASES) {
    it(`${name} (\`${source}\`): sexpr/mermaid/wireframe agree on selection-structure visibility`, () => {
      const prov = run(source);
      // Sanity: the case's label matches what the real pipeline actually produced.
      expect(containsChoice(prov)).toBe(hasChoice);

      const sexpr = circuitToSexpr(prov);
      const mermaid = circuitToMermaid(prov);
      const { sideMaps } = toWireframe(prov);

      const sexprVisible = sexprShowsSelection(sexpr);
      const mermaidVisible = mermaidShowsSelection(mermaid);
      const wireframeVisible = wireframeShowsSelection(sideMaps);

      // Each projection's own answer must match the ground truth...
      expect(sexprVisible).toBe(hasChoice);
      expect(mermaidVisible).toBe(hasChoice);
      expect(wireframeVisible).toBe(hasChoice);

      // ...which means, transitively, all three agree with EACH OTHER — the
      // actual parity property a reviewer relies on: never see it in one
      // projection and lose it in another.
      expect(sexprVisible).toBe(mermaidVisible);
      expect(mermaidVisible).toBe(wireframeVisible);
    });
  }

  it("no false positives: a plain-data program (no choice anywhere) shows NO selection markers in any projection", () => {
    const prov = run(`(+ (:a e) (:b e))`);
    expect(containsChoice(prov)).toBe(false);

    const sexpr = circuitToSexpr(prov);
    const mermaid = circuitToMermaid(prov);
    const { sideMaps } = toWireframe(prov);

    expect(sexpr).not.toContain("(gray ");
    expect(sexpr).not.toContain("choice");
    expect(mermaid).not.toContain("-.->"); // no selection-styled edge anywhere — no mint, no choice
    expect(mermaid).not.toContain("choice");
    expect(sideMaps.choiceWireRole === undefined || sideMaps.choiceWireRole.size === 0).toBe(true);
  });

  it("no false positives: a guardless const (no choice anywhere) shows NO selection markers in any projection", () => {
    const prov = run(`"FAKE"`);
    expect(containsChoice(prov)).toBe(false);

    const sexpr = circuitToSexpr(prov);
    const mermaid = circuitToMermaid(prov);
    const { sideMaps } = toWireframe(prov);

    expect(sexpr).not.toContain("(gray ");
    expect(sexpr).not.toContain("choice");
    expect(mermaid).not.toContain("-.->");
    expect(mermaid).not.toContain("choice");
    expect(sideMaps.choiceWireRole === undefined || sideMaps.choiceWireRole.size === 0).toBe(true);
  });

  it("the guarded choice: wireframe's choiceWireRole classifies both roles present (guard AND alt, never just one)", () => {
    const prov = run(`(if (:guilty e) "A" "B")`);
    const { sideMaps } = toWireframe(prov);
    const roles = new Set(sideMaps.choiceWireRole?.values() ?? []);
    expect(roles.has("guard")).toBe(true);
    expect(roles.has("alt")).toBe(true);
  });
});
