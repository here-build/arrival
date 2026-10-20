/**
 * Container provenance survives vector adoption and vector concat — the pair/AJSArray
 * charts already conserved it; the AVector paths used to drop it.
 */
import { describe, expect, it } from "vitest";
import "../../index.js";
import { AVector } from "../../values/primitives/AVector.js";
import { APair } from "../../values/primitives/APair.js";
import { adoptSpine } from "../adopt-spine.js";

describe("container provenance conservation", () => {
  it("adoptSpine(AVector) keeps the vector's provenance on the spine head", () => {
    const spine = adoptSpine(new AVector([], new Set([7])));
    expect(spine).not.toBeInstanceOf(APair); // empty → nil, nothing to stamp
    const head = adoptSpine(new AVector([new AVector([])], new Set([7, 9])));
    expect(head).toBeInstanceOf(APair);
    expect([...(head as APair<any, any>).provenance].sort()).toEqual([7, 9]);
  });

  it("AVector concat unions both operands' provenance", () => {
    const a = new AVector([], new Set([1]));
    const b = new AVector([], new Set([2]));
    const c = a["arrival/tagless-final/concat"](b);
    expect([...c.provenance].sort()).toEqual([1, 2]);
  });
});
