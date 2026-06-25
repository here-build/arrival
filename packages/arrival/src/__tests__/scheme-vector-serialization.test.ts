// Boxing track S10: a boxed vector/bytevector must NOT leak its {kind,__vector__,
// provenance} object shape across the Scheme→JS boundary (the MCP/trace
// serialization path), and provenance must propagate through a vector's elements
// (the whole point of boxing — goal (b)). Locks the rosetta schemeToJs/jsToScheme +
// deepProvenance vector handling. (docs/plan-2026-06-10-boxing-track.md.)
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AValue } from "../values/primitives/AValue.js";
import { ABytevector } from "../values/primitives/ABytevector.js";
import { AVector } from "../values/primitives/AVector.js";
import { jsToScheme, schemeToJs } from "../rosetta.js";

describe("boxed vector/bytevector — Scheme→JS serialization (schemeToJs)", () => {
  it("a boxed vector unwraps to a raw JS array (no object leak)", () => {
    const v = new AVector(CONSTANT_CTX, [1, 2, 3]);
    expect(schemeToJs(v)).toEqual([1, 2, 3]);
    expect(Array.isArray(schemeToJs(v))).toBe(true);
  });

  it("a nested boxed vector unwraps recursively", () => {
    const v = new AVector(CONSTANT_CTX, [new AVector(CONSTANT_CTX, [1, 2]), 3]);
    expect(schemeToJs(v)).toEqual([[1, 2], 3]);
  });

  it("a boxed bytevector unwraps to its Uint8Array", () => {
    const bv = new ABytevector(CONSTANT_CTX, Uint8Array.from([4, 5, 6]));
    const out = schemeToJs(bv);
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([4, 5, 6]);
  });
});

describe("boxed vector — provenance propagation (jsToScheme)", () => {
  it("deep-stamps element provenance, keeps it a vector", () => {
    const v = new AVector(CONSTANT_CTX, [1, 2, 3]);
    const prov = new Set<number>([42]);
    const stamped = jsToScheme(v, {}, prov) as AVector;
    expect(stamped).toBeInstanceOf(AVector);
    // Container carries provenance...
    expect([...stamped.provenance]).toEqual([42]);
    // ...and each element (now a boxed AValue) carries it too.
    for (const el of stamped.__vector__) {
      expect(el).toBeInstanceOf(AValue);
      expect([...(el as AValue).provenance]).toEqual([42]);
    }
  });
});
