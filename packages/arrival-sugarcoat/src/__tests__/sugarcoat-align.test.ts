import { describe, expect, it } from "vitest";

import { alignSugarcoatClassic } from "../sugarcoat-align.js";
import { schemeToSugarcoat } from "../sugarcoat-render.js";

/** Translate the position of `needle`'s first char in `sugarcoat` to classic and
 *  read back what classic token sits there — the round-trip a hover query makes. */
function classicTokenAt(sugarcoat: string, needle: string): string | null {
  const a = alignSugarcoatClassic(sugarcoat);
  if (a === null) return null;
  const pos = sugarcoat.indexOf(needle);
  if (pos === -1) throw new Error(`needle '${needle}' not in sugarcoat text`);
  const cPos = a.toClassic(pos);
  if (cPos === null) return null;
  const m = /^[\w\-!$%&*+./<=>?@^~]+/.exec(a.classic.slice(cPos));
  return m ? m[0] : a.classic[cPos];
}

describe("alignSugarcoatClassic", () => {
  it("derives the canonical classic from the sugarcoat buffer", () => {
    const sugarcoat = schemeToSugarcoat(`(define (double n) (* n 2))`);
    const a = alignSugarcoatClassic(sugarcoat);
    expect(a).not.toBeNull();
    expect(a!.classic).toContain("(define (double n)");
    expect(a!.classic).toContain("(* n 2)");
  });

  it("maps positions through exact atom pairs, offset-precise", () => {
    const sugarcoat = schemeToSugarcoat(`(define (double n) (* n 2))`);
    expect(classicTokenAt(sugarcoat, "double")).toBe("double");
    // Mid-atom: position on 'u' of double still lands inside the classic atom.
    const a = alignSugarcoatClassic(sugarcoat)!;
    const pos = sugarcoat.indexOf("double") + 2;
    const cPos = a.toClassic(pos)!;
    expect(a.classic.slice(cPos - 2, cPos + 4)).toBe("double");
  });

  it("maps atoms inside curly-infix back to the prefix form", () => {
    // {n - 1} in sugarcoat ↔ (- n 1) in classic: n and 1 are exact pairs.
    const sugarcoat = schemeToSugarcoat(`(define (dec n) (- n 1))`);
    expect(sugarcoat).toContain("{n - 1}");
    expect(classicTokenAt(sugarcoat, "n -")).toBe("n");
  });

  it("declines positions on sugar (the infix glyph) instead of guessing", () => {
    const sugarcoat = schemeToSugarcoat(`(define (eq-check a b) (equal? a b))`);
    expect(sugarcoat).toContain("==");
    const a = alignSugarcoatClassic(sugarcoat)!;
    expect(a.toClassic(sugarcoat.indexOf("=="))).toBeNull();
  });

  it("lifts a classic span inside sugar to the enclosing paired node", () => {
    const sugarcoat = schemeToSugarcoat(`(define (eq-check a b) (equal? a b))`);
    const a = alignSugarcoatClassic(sugarcoat)!;
    // The classic `equal?` atom has no exact sugarcoat twin (rendered `==`) — a
    // diagnostic on it lifts to a containing span, still inside the sugarcoat text.
    const eqPos = a.classic.indexOf("equal?");
    const span = a.toSugarcoat(eqPos, "equal?".length);
    expect(span).not.toBeNull();
    const lifted = sugarcoat.slice(span!.start, span!.start + span!.length);
    expect(lifted).toContain("==");
  });

  it("round-trips spans through elided let bindings", () => {
    const classic = `(define (f xs) (let ((head (car xs)) (rest (cdr xs))) (cons head rest)))`;
    const sugarcoat = schemeToSugarcoat(classic);
    expect(sugarcoat).not.toContain("(("); // bindings elided in the view
    const a = alignSugarcoatClassic(sugarcoat)!;
    const cPos = a.toClassic(sugarcoat.indexOf("head"))!;
    expect(a.classic.slice(cPos, cPos + 4)).toBe("head");
    // And back: the classic `rest` binder maps to the sugarcoat `rest` line.
    const rPos = a.classic.indexOf("rest");
    const span = a.toSugarcoat(rPos, 4)!;
    expect(sugarcoat.slice(span.start, span.start + span.length)).toBe("rest");
  });

  it("maps string literals (spans include the quotes on both sides)", () => {
    // `list` (not string-append) so the literal stays classic: a `string-append`
    // with a hole now surfaces as an `@{…}` at-expression (the "hello" loses its
    // quotes inside the at-body), which is a different surface than the quote-span
    // mapping this test exercises.
    const sugarcoat = schemeToSugarcoat(`(define greeting (list "hello" name))`);
    const a = alignSugarcoatClassic(sugarcoat)!;
    const sPos = sugarcoat.indexOf('"hello"');
    const cPos = a.toClassic(sPos + 1)!; // inside the string
    expect(a.classic.slice(cPos - 1, cPos + 6)).toBe('"hello"');
  });

  it("returns null on a mid-edit unparseable buffer", () => {
    expect(alignSugarcoatClassic("define (f x\n  {x +")).toBeNull();
  });

  it("survives sugarcoat-only edits: alignment is over the buffer as typed", () => {
    // Hand-written sugarcoat (not a render output) still aligns — the classic is
    // derived from THIS buffer, not recovered from any stored original.
    const sugarcoat = "define (triple n)\n  {n * 3}";
    const a = alignSugarcoatClassic(sugarcoat)!;
    expect(a.classic).toBe("(define (triple n) (* n 3))");
    const cPos = a.toClassic(sugarcoat.indexOf("triple"))!;
    expect(a.classic.slice(cPos, cPos + 6)).toBe("triple");
  });
});
