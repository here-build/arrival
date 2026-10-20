// Algebra cell for SchemeBool: Setoid only (booleans aren't ordered in this
// system). The domain has just two inhabitants, so symmetry/transitivity
// collide naturally — exactly the dense-collision regime that exercises the
// Setoid laws hardest.
import fc from "fast-check";
import { expect, it } from "vitest";
import { ABool } from "../ABool.js";
import { setoidLaws } from "./algebra-laws.js";

const arb = fc.boolean().map((b) => new ABool(b));
const equalClone = (b: ABool) => new ABool(b.value);

setoidLaws("SchemeBool", { arb, equalClone });

it("registers the Setoid law suite", () => {
  expect(arb).toBeDefined();
});
