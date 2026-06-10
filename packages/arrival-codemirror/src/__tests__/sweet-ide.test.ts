// sweet-ide — the sweet-lens backend compositor against the REAL type lens.
// Three lenses end-to-end: sweet ↔ classic (alignSweetClassic) ↔ virtual TS ↔
// tsc. Diagnostics, hover, completion, and goto-def all answered for a SWEET
// buffer in SWEET coordinates.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { schemeToSweet } from "@here.build/arrival-chain/sweet";
import { createSchemeLanguageService } from "@here.build/arrival-type-lens";
import { describe, expect, it } from "vitest";

import { sweetIdeBackend } from "../sweet-ide.js";

const backend = sweetIdeBackend(createSchemeLanguageService());

describe("sweetIdeBackend — diagnostics in sweet coordinates", () => {
  it("(car 5) typed in sweet → the squiggle lands on the sweet `5`", async () => {
    const sweet = schemeToSweet(`(define z (car 5))`);
    const diags = await backend.getSemanticDiagnostics(sweet);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(sweet.slice(d.start, d.start + d.length)).toBe("5");
    expect(d.severity).toBe("error");
  });

  it("a misuse inside curly-infix maps back into the braces", async () => {
    // {n + "x"}: string into numeric + — the error span must land in the sweet
    // text, on (or containing) the offending literal inside the curly.
    const sweet = schemeToSweet(`(define (f n) (+ n "x"))`);
    expect(sweet).toContain('{n + "x"}');
    const diags = await backend.getSemanticDiagnostics(sweet);
    expect(diags.length).toBeGreaterThan(0);
    const d = diags[0]!;
    expect(sweet.slice(d.start, d.start + d.length)).toContain('"x"');
  });

  it("an error in an elided-let body maps through the dropped parens", async () => {
    // Body (+ n 1 …) is 3+ elements (not binding-shaped) so the bindings elide.
    const sweet = schemeToSweet(`(define (g s) (let ((n (string-length s))) (string-upcase n)))`);
    const diags = await backend.getSemanticDiagnostics(sweet);
    expect(diags.length).toBeGreaterThan(0);
    expect(sweet.slice(diags[0]!.start, diags[0]!.start + diags[0]!.length)).toBe("n");
  });

  it("a mid-edit unparseable sweet buffer answers empty, never throws", async () => {
    expect(await backend.getSemanticDiagnostics("define (f x\n  {x +")).toEqual([]);
  });
});

describe("sweetIdeBackend — hover in sweet coordinates", () => {
  it("hovering an inferred-param function shows its signature", async () => {
    const sweet = schemeToSweet(`(define (shout msg) (string-upcase msg))\n\n(define loud (shout "hi"))`);
    const pos = sweet.lastIndexOf("shout"); // the USE site, inside (shout "hi")
    const info = await backend.getQuickInfoAtPosition(sweet, pos);
    expect(info).not.toBeNull();
    expect(info!.displayText).toContain("(msg: string) => string");
    // The hover span is in SWEET coordinates, over the hovered atom.
    expect(sweet.slice(info!.span!.start, info!.span!.start + info!.span!.length)).toBe("shout");
  });

  it("hovering sugar (an infix glyph) declines instead of misanswering", async () => {
    const sweet = schemeToSweet(`(define (same a b) (equal? a b))`);
    expect(sweet).toContain("==");
    expect(await backend.getQuickInfoAtPosition(sweet, sweet.indexOf("=="))).toBeNull();
  });
});

describe("sweetIdeBackend — completion in sweet coordinates", () => {
  it("a typed prefix completes (cursor at the end of a partial atom)", async () => {
    const sweet = "define (f s)\n  string-app";
    const pos = sweet.length;
    const entries = await backend.getCompletionsAtPosition(sweet, pos);
    expect(entries.map((e) => e.name)).toContain("string-append");
  });

  it("the Σ∩T rich context flows through (argument slot in sweet)", async () => {
    if (!backend.getCompletionContext) throw new Error("rich completion missing on seam");
    const sweet = "define (f s)\n  string-upcase s";
    // Cursor right after `string-upcase ` — the argument slot. Position the
    // cursor ON the `s` argument's end to ride the exact-pair mapping.
    const pos = sweet.length;
    const ctx = await backend.getCompletionContext(sweet, pos);
    expect(ctx.position).toBe("argument");
    expect(ctx.slot?.callee).toBe("string-upcase");
  });

  it("the whitespace-after-callee anchor completes the empty argument slot", async () => {
    if (!backend.getCompletionContext) throw new Error("rich completion missing on seam");
    // `(string-upcase |)` — empty slot; the cursor sits on sweet whitespace
    // with no classic twin, so the anchor injects the seam after the callee.
    const sweet = "define (f s)\n  (string-upcase )";
    const ctx = await backend.getCompletionContext(sweet, sweet.length - 1);
    expect(ctx.position).toBe("argument");
    expect(ctx.slot?.callee).toBe("string-upcase");
  });
});

describe("sweetIdeBackend — goto-definition in sweet coordinates", () => {
  it("a local use site jumps to the sweet position of its define", async () => {
    const sweet = schemeToSweet(`(define (helper x) (* x 2))\n\n(define result (helper 3))`);
    const usePos = sweet.lastIndexOf("helper");
    const defs = await backend.getDefinitionAtPosition(sweet, usePos);
    expect(defs.length).toBeGreaterThan(0);
    const d = defs[0]!;
    expect(d.span).not.toBeNull();
    // The backend's definition span covers the whole define FORM (classic-lens
    // parity); lifted to sweet it's the form's sweet extent — the jump target.
    const target = sweet.slice(d.span!.start, d.span!.start + d.span!.length);
    expect(target).toContain("define (helper x)");
    expect(d.span!.start).toBeLessThan(sweet.indexOf("result"));
  });
});

describe("sweetIdeBackend — semantic classifications in sweet coordinates", () => {
  it("classifies the parameter at its sweet position, exact-length only", async () => {
    if (!backend.getSemanticClassifications) throw new Error("classifications missing on seam");
    const sweet = schemeToSweet(`(define (double n) (* n 2))`);
    const spans = await backend.getSemanticClassifications(sweet);
    const params = spans.filter((s) => s.kind === "parameter");
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) expect(sweet.slice(p.start, p.start + p.length)).toBe("n");
  });
});
