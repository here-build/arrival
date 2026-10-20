/**
 * `deepProvenance` is an alias of `collapseProvenance` (P7: one carrier walk, owned by the
 * classes' `arrival/provenanceChildren` term). Pinned as equality over a corpus of carriers,
 * including a borrowed AJSArray holding a stamped element — the row the old `instanceof`
 * twin walk dropped.
 */
import { describe, it, expect } from "vitest";
import { deepProvenance } from "../deep-provenance.js";
import { collapseProvenance } from "../provenance-collapse.js";
import { AString } from "../../values/primitives/AString.js";
import { AVector } from "../../values/primitives/AVector.js";
import { APair } from "../../values/primitives/APair.js";
import { AJSArray } from "../../membrane/AJSArray.js";
import { nil } from "../../values/primitives/ANil.js";

const stamped = (s: string, ...points: number[]) => new AString(s, new Set(points));
const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b);

describe("deepProvenance ≡ collapseProvenance", () => {
  const cyclic: unknown[] = [stamped("c", 9)];
  cyclic.push(cyclic);
  const corpus: Record<string, unknown> = {
    null: null,
    primitive: 3,
    bareString: stamped("a", 1, 2),
    pairSpine: new APair(stamped("a", 1), new APair(stamped("b", 2), nil)),
    vector: new AVector([stamped("a", 1), stamped("b", 2)]),
    nestedVector: new APair(stamped("a", 1), new APair(new AVector([stamped("b", 2)]), nil)),
    rawArray: [stamped("a", 1), [stamped("b", 2)]],
    borrowedArray: new AJSArray(["a", "b"], new Set([1, 2])),
    borrowedArrayStampedElement: new AJSArray([stamped("x", 7)] as never, new Set([1])),
    cycle: cyclic,
  };
  for (const [name, v] of Object.entries(corpus)) {
    it(name, () => {
      expect(sorted(deepProvenance(v))).toEqual(sorted(collapseProvenance(v)));
    });
  }
});
