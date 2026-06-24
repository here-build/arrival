// Algebras-in-entities cell (wave 2): SchemeString's structure-algebras —
// Functor (char map), Semigroup (string-append), Monoid ("" identity).
// Migrated from the fantasy-land-lips.ts monkey-patch INTO the SchemeString
// class body (plan-2026-06-10-algebras-in-entities.md).
//
// SchemeString HAS `fantasy-land/equals` (wave-1 Setoid), so the law harness's
// internal `equals` works directly — no custom eq needed.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AString } from "../values/primitives/AString.js";
import { functorLaws, monoidLaws, semigroupLaws } from "./algebra-laws.js";

const MAP = "fantasy-land/map";
const CONCAT = "fantasy-land/concat";
const EMPTY = "fantasy-land/empty";
const OF = "fantasy-land/of";

type FL = Record<string, any>;

// Small domain + edge cases: "" (empty), astral unicode, ASCII.
const arb = fc
  .oneof(fc.constantFrom("", "a", "b", "ab", "🦄", "naïve", "Z"), fc.string({ maxLength: 4 }))
  .map((s) => new AString(s));

// ----------------------------------------------------------------------
// Semigroup (string-append) — associativity. Functor — identity + composition
// over ASCII char transforms (uppercase/swap) to keep it code-point-clean.
// ----------------------------------------------------------------------
semigroupLaws("SchemeString", arb);

// Functor laws map per-character; use case-flip transforms (string→string).
functorLaws<AString, string>("SchemeString", {
  arb,
  f: (c) => c.toUpperCase(),
  g: (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()),
});

// ----------------------------------------------------------------------
// Monoid — "" is the identity for append.
// ----------------------------------------------------------------------
monoidLaws("SchemeString", arb, () => new AString(""));

describe("SchemeString — structure-algebra behavior", () => {
  it("concat appends underlying strings", () => {
    const r = (new AString("foo") as FL)[CONCAT](new AString("bar"));
    expect((r as AString).valueOf()).toBe("foobar");
  });
  it("empty() is the empty string", () => {
    const e = (AString as FL)[EMPTY]() as AString;
    expect(e.valueOf()).toBe("");
  });
  it("of(value) stringifies into a SchemeString", () => {
    const s = (AString as FL)[OF](42) as AString;
    expect(s).toBeInstanceOf(AString);
    expect(s.valueOf()).toBe("42");
  });
  it("map transforms each character", () => {
    const r = (new AString("abc") as FL)[MAP]((c: string) => c.toUpperCase());
    expect((r as AString).valueOf()).toBe("ABC");
  });
  it("map iterates by code point (astral chars map as single graphemes)", () => {
    const seen: string[] = [];
    (new AString("a🦄b") as FL)[MAP]((c: string) => {
      seen.push(c);
      return c;
    });
    expect(seen).toEqual(["a", "🦄", "b"]);
  });
  it("concat is pure (operands untouched)", () => {
    const a = new AString("x");
    const b = new AString("y");
    (a as FL)[CONCAT](b);
    expect(a.valueOf()).toBe("x");
    expect(b.valueOf()).toBe("y");
  });
});
