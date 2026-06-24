// Algebras-in-entities cell: Setoid (+ Ord) on SchemeCharacter, Setoid on Nil.
// Proves the FL instances on the char/nil value-kernel classes via the A2
// law harness. Small char domain forces collisions so symmetry / transitivity
// / antisymmetry actually bite.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ANil, nil } from "../values/primitives/ANil.js";
import { ACharacter } from "../values/primitives/ACharacter.js";
import { setoidLaws, ordLaws } from "./algebra-laws.js";

const FL = "arrival/tagless-final/equals";
const LTE = "arrival/tagless-final/lte";

// Small grapheme domain (incl. punctuation/digits/letters) → collisions exercise
// the symmetric/transitive/antisymmetric branches; one astral char for unicode.
const charArb = fc
  .constantFrom(...["a", "b", "X", "Y", "Z", "0", "1", "2", "!", "@", "\u{1F600}"])
  .map((c) => new ACharacter(c));

setoidLaws("SchemeCharacter", {
  arb: charArb,
  equalClone: (c) => new ACharacter(c.__char__),
});
ordLaws("SchemeCharacter", charArb);

// Nil: bare singleton + provenance clones — all observably equal.
const nilArb = fc.constantFrom(nil, new ANil(), new ANil(new Set([1, 2])));
setoidLaws("Nil", { arb: nilArb, equalClone: () => new ANil() });

describe("SchemeCharacter Setoid/Ord — value semantics", () => {
  it("equal iff same grapheme", () => {
    expect((new ACharacter("a") as never)[FL](new ACharacter("a"))).toBe(true);
    expect((new ACharacter("a") as never)[FL](new ACharacter("b"))).toBe(false);
  });

  it("totality across the codepoint ordering", () => {
    const lo = new ACharacter("a");
    const hi = new ACharacter("b");
    expect((lo as never)[LTE](hi)).toBe(true);
    expect((hi as never)[LTE](lo)).toBe(false);
  });

  it("FL methods are total — non-char input returns false", () => {
    expect((new ACharacter("a") as never)[FL](42)).toBe(false);
    expect((new ACharacter("a") as never)[FL](nil)).toBe(false);
    expect((new ACharacter("a") as never)[LTE]("a")).toBe(false);
  });
});

describe("Nil Setoid — every Nil is equal", () => {
  it("singleton, fresh, and provenance-clone Nils all compare equal", () => {
    expect((nil as never)[FL](new ANil())).toBe(true);
    expect((new ANil() as never)[FL](nil)).toBe(true);
    expect((new ANil(new Set([7])) as never)[FL](new ANil())).toBe(true);
  });

  it("FL method is total — non-Nil input returns false", () => {
    expect((nil as never)[FL](new ACharacter("a"))).toBe(false);
    expect((nil as never)[FL](null)).toBe(false);
  });
});
