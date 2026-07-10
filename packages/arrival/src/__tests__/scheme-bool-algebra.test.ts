// Algebra cell for SchemeBool: Setoid only (booleans aren't ordered in this
// system). The domain has just two inhabitants, so symmetry/transitivity
// collide naturally — exactly the dense-collision regime that exercises the
// Setoid laws hardest.
import fc from "fast-check";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { ABool } from "../values/primitives/ABool.js";
import { setoidLaws } from "./algebra-laws.js";

const arb = fc.boolean().map((b) => new ABool(CONSTANT_CTX, b));
const equalClone = (b: ABool) => new ABool(CONSTANT_CTX, b.value);

// INVARIANT: reflexivity, reflexivity-across-clone, symmetry, transitivity of boolean equality.
setoidLaws("SchemeBool", { arb, equalClone });
