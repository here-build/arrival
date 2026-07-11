// sexpr-color — subtle ANSI over serializer s-expr. The load-bearing invariant is
// identity-under-strip: coloring adds only escapes, never a byte of text.
import { describe, expect, it } from "vitest";

import { colorizeSexpr } from "../sexpr-color.js";
import { stripAnsi } from "./ansi-strip.js";

const SAMPLES = [
  '(1 2 3)',
  '(list "hello" "wo\\"rld" 42)',
  '(:verdict (car reactions))',
  '((a . b) [1 2] {x y})',
  '(define (f x) (* x x)) ; a comment\n(f 3)',
  '#| truncated: 40 more |#',
  '"unterminated string with (parens) and ;semicolons',
  '',
  '   \n\t  ',
  '(nested (deeply (list #t #f :key 3.14 -5 "s")))',
];

describe("colorizeSexpr — identity under strip", () => {
  for (const s of SAMPLES) {
    it(`round-trips: ${JSON.stringify(s).slice(0, 40)}`, () => {
      expect(stripAnsi(colorizeSexpr(s, "truecolor"))).toBe(s);
      expect(stripAnsi(colorizeSexpr(s, "256"))).toBe(s);
    });
  }
});

describe("colorizeSexpr — mode none is exact identity", () => {
  for (const s of SAMPLES) {
    it(`identity: ${JSON.stringify(s).slice(0, 40)}`, () => {
      expect(colorizeSexpr(s, "none")).toBe(s);
    });
  }
});

describe("colorizeSexpr — actually colors the structure", () => {
  it("emits escape codes for a paren'd expression on a color TTY", () => {
    const out = colorizeSexpr('(a b)', "truecolor");
    expect(out).not.toBe('(a b)');
    // eslint-disable-next-line no-control-regex -- asserting an escape IS present
    expect(out).toMatch(/\x1b\[/);
  });

  it("tints a keyword differently from a plain symbol", () => {
    const keyword = colorizeSexpr(":verdict", "truecolor");
    const symbol = colorizeSexpr("verdict", "truecolor");
    expect(keyword).not.toBe(symbol);
    // the plain symbol carries no hue (default foreground) — stays raw
    expect(symbol).toBe("verdict");
  });

  it("leaves whitespace untinted (minimal diff)", () => {
    // three spaces between atoms come back verbatim, no escapes wrapping them
    const out = colorizeSexpr("a   b", "truecolor");
    expect(out).toContain("   ");
  });
});
