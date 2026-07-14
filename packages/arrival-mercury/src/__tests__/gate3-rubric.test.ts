/**
 * Gate 3's MACHINE-CHECKED rubric half (constitution §9: "machine-checked where
 * decidable … plus a one-page human sign-off checklist (V), once per gate").
 * The three named decidable items, each as a red-gated assertion over real
 * greenfield emissions; the human half lives at fixtures/gate3/SIGN-OFF.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileGreenfield, openOracleSession } from "../index.js";
import type { OracleSession } from "../index.js";

let session: OracleSession;
beforeAll(async () => {
  session = await openOracleSession();
}, 120_000);
afterAll(async () => {
  await session.dispose();
});

const compile = async (src: string): Promise<string> => compileGreenfield(session, src);

describe("Gate-3 rubric — machine-checked items (constitution §9)", () => {
  it("no IIFE where a block suffices: a statement-position let body renders as a plain function body, not an arrow IIFE", async () => {
    const out = await compile(`(define (f x) (let ((y 1)) (+ x y)))\n(f 1)`);
    // The let lands as const-in-function-body — an IIFE here would be the exact
    // "expression machinery in statement position" smell the rubric names.
    expect(out).not.toMatch(/\(\(\) =>/);
    expect(out).toContain("const y = 1");
  });

  it("import order is deterministic and sorted (FRAME's one-scan census)", async () => {
    const out = await compile(`(list (member 2 (list 1 2)) (assoc 1 (list (list 1 "a"))))`);
    const imports = [...out.matchAll(/import \{ ([^}]+) \}/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
    const sorted = [...imports].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(imports).toEqual(sorted);
  });

  it("guard-form policy: bare ternary iff facts.boolean — both directions on one source", async () => {
    const src = `(define (f x) (if (pair? x) 1 2))\n(f (list 1))`;
    const out = await compile(src);
    // The condition is a narrows App: extraction proves boolean at the If, so
    // the run register must emit the BARE ternary (no `!== false` residue) —
    // and the pair? predicate itself rides its own fact gate (shim here: the
    // define param carries no proven list fact).
    expect(out).toContain("? 1 : 2");
    expect(out).not.toContain("!== false ?");
  });
});
