// Algebras-in-entities cell: Setoid + Ord + Semigroup on SchemeBytevector.
// The arbitrary biases toward the cases that make the laws bite — empty,
// single-byte, and prefix relationships (so Ord totality/antisymmetry and
// Setoid symmetry/transitivity are actually exercised). equalClone forges a
// fresh distinct-but-equal payload, exercising value equality a bare `===`
// would miss. (Boxing track S1 — docs/plan-2026-06-10-boxing-track.md.)
import fc from "fast-check";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { describe, expect, it } from "vitest";
import { ABytevector } from "../values/primitives/ABytevector.js";
import { ordLaws, semigroupLaws, setoidLaws } from "./algebra-laws.js";
import { tf } from "../values/tagless-final.js";

// Small byte arrays + edge cases: empty, prefixes, collisions on a small domain.
const arb = fc
  .oneof(
    fc.constantFrom<number[]>([], [0], [1], [1, 2], [1, 2, 3], [2], [255]),
    fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 4 }),
  )
  .map((bytes) => new ABytevector(CONSTANT_CTX, Uint8Array.from(bytes)));

const equalClone = (bv: ABytevector) => new ABytevector(CONSTANT_CTX, bv.__bytevector__.slice());

// INVARIANT: reflexivity/symmetry/transitivity of bytevector equality, incl. distinct-heap clones.
setoidLaws("SchemeBytevector", { arb, equalClone });
// INVARIANT: reflexivity/totality/antisymmetry/transitivity of lexicographic bytevector ordering.
ordLaws("SchemeBytevector", arb);
// INVARIANT: bytevector concat is associative.
semigroupLaws("SchemeBytevector", arb);

describe("SchemeBytevector Setoid/Ord/Semigroup — boundaries", () => {
  it("value equality over distinct heap payloads", () => {
    const a = new ABytevector(CONSTANT_CTX, Uint8Array.from([1, 2, 3]));
    const b = new ABytevector(CONSTANT_CTX, Uint8Array.from([1, 2, 3]));
    expect(a[tf("equals")](b)).toBe(true);
  });

  it("non-SchemeBytevector other → false for equals and lte", () => {
    const a = new ABytevector(CONSTANT_CTX, Uint8Array.from([1]));
    expect(a[tf("equals")](Uint8Array.from([1]))).toBe(false);
    expect(a[tf("equals")](42)).toBe(false);
    expect(a[tf("lte")](Uint8Array.from([1]))).toBe(false);
    expect(a[tf("lte")](null)).toBe(false);
  });

  it("lexicographic lte: a proper prefix precedes its extension", () => {
    const a = new ABytevector(CONSTANT_CTX, Uint8Array.from([1, 2]));
    const b = new ABytevector(CONSTANT_CTX, Uint8Array.from([1, 2, 0]));
    expect(a[tf("lte")](b)).toBe(true);
    expect(b[tf("lte")](a)).toBe(false);
  });

  it("lexicographic lte: first differing byte decides (unsigned)", () => {
    const a = new ABytevector(CONSTANT_CTX, Uint8Array.from([1, 200]));
    const b = new ABytevector(CONSTANT_CTX, Uint8Array.from([1, 255]));
    expect(a[tf("lte")](b)).toBe(true);
    expect(b[tf("lte")](a)).toBe(false);
  });

  it("concat appends bytes and is length-additive", () => {
    const a = new ABytevector(CONSTANT_CTX, Uint8Array.from([1, 2]));
    const b = new ABytevector(CONSTANT_CTX, Uint8Array.from([3]));
    const c = a[tf("concat")](b);
    expect([...c.__bytevector__]).toEqual([1, 2, 3]);
    expect(c.length).toBe(3);
  });

  it("TO_JS / toJs unwrap to the raw Uint8Array", () => {
    const bytes = Uint8Array.from([4, 5, 6]);
    const a = new ABytevector(CONSTANT_CTX, bytes);
    expect(a["arrival/toJS"]()).toBeInstanceOf(Uint8Array);
    expect([...a["arrival/toJS"]()]).toEqual([4, 5, 6]);
  });
});
