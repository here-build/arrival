// Algebras-in-entities cell: Setoid + Ord on SchemeString. The arbitrary biases
// toward the hard cases — empty string, unicode, and a small domain so
// collisions make symmetry/transitivity/antisymmetry bite. equalClone forges a
// fresh distinct-but-equal instance, exercising the value-equality (string-copy)
// contract a bare `===` would miss.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AString } from "../values/primitives/AString.js";
import { ordLaws, setoidLaws } from "./algebra-laws.js";

const FL = "fantasy-land/equals";
const LTE = "arrival/tagless-final/lte";

// Small domain + edge cases: "" (empty), astral unicode, ASCII collisions.
const arb = fc
  .oneof(
    fc.constantFrom("", "a", "b", "ab", "🦄", "🦄a", "naïve", "Z"),
    fc.string({ maxLength: 4 }),
  )
  .map((s) => new AString(s));

const equalClone = (s: AString) => new AString(s.valueOf());

setoidLaws("SchemeString", { arb, equalClone });
ordLaws("SchemeString", arb);

describe("SchemeString Setoid/Ord — totality boundaries", () => {
  it("value equality over distinct heap instances", () => {
    const a = new AString("🦄");
    const b = new AString("🦄");
    expect((a as never)[FL](b)).toBe(true);
  });

  it("equals is representation-blind (plain string matches by content); lte stays type-strict", () => {
    const a = new AString("a");
    // equals: a boxed string equals the SAME value UNBOXED (a plain JS string) — the representation-
    // blindness that fixes dedup over chain-boxed strings (sift/closure.scm). Content still discriminates.
    expect((a as never)[FL]("a")).toBe(true); // plain string, equal content → equal (was false)
    expect((a as never)[FL]("b")).toBe(false); // plain string, different content → not equal
    expect((a as never)[FL](42)).toBe(false); // non-string → not equal (total)
    // lte (Ord) is unchanged: still type-strict. Cross-representation ORDERING is a separate question
    // from the equality bug; left strict deliberately.
    expect((a as never)[LTE]("a")).toBe(false);
    expect((a as never)[LTE](null)).toBe(false);
  });

  it("lexicographic lte agrees with JS string order", () => {
    const a = new AString("ab");
    const b = new AString("b");
    expect((a as never)[LTE](b)).toBe(true);
    expect((b as never)[LTE](a)).toBe(false);
  });
});
