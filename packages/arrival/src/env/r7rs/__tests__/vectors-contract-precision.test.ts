// vectors-contract-precision.test.ts — RUNTIME proof that the scheme/vectors Contract-
// precision audit's fixes land on the REAL exported ops (not a synthetic mirror — see the
// sibling `vectors.test-d.ts` for the type-level mechanism proofs, which must stay synthetic
// because NativeSymbolDef erases `I`/`O` on any real export). Mirrors numeric-contract-
// precision.test.ts / contract-precision-fixes.test.ts's established pattern: a schema's
// PRECISION is only observable at runtime (zod's own `safeParse`) — native ops never run this
// validation during evaluation, so this is a HARVEST/type-surface proof, not a behavior change.
//
// ★A genuine zod subtlety, calibrated empirically against the pinned 4.3.6 (`node -e` against
// the real package, not assumed): `z.value` (`z.custom<SchemeValue>()`, called with NO
// predicate) accepts EVERYTHING at runtime — byte-identical to the `z.unknown()` it replaces
// (scheme-zod.ts's own doc comment on `value` says this explicitly). So three of the six
// vectors.ts fixes — `vector`'s elements, and `vector-ref`/`vector->list`'s RETURN — have NO
// runtime-observable delta; they are STATIC-ONLY precision gains (the decoded TS type tightens
// from `unknown` to `SchemeValue`), provable only in `vectors.test-d.ts`. `z.svector` DOES carry
// a real predicate (`arrival/tagless-final/vector?` presence, checked structurally), so
// `vector-append`'s elements, `vector-ref`'s vec arg, and `vector-map`/`vector-for-each`'s rest
// elements ARE runtime-discriminating — those three are what this file exercises.
import { describe, expect, it } from "vitest";
import vectorsPack from "../vectors.js";
import { VECTOR_FOR_EACH_HOF, VECTOR_MAP_HOF } from "../../../common/hof-sig.js";
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import type { AEntity } from "../../../common/symbol.js";
import { AVector } from "../../../values/primitives/AVector.js";
import { AExact } from "../../../values/primitives/AExact.js";
import { CONSTANT_CTX } from "../../../values/primitives/RunContext.js";

const symbols = vectorsPack.spec.symbols as Record<string, AEntity>;

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`vectors pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`vectors pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

const fn = () => {};
const realVector = new AVector(CONSTANT_CTX, []);
const idx = new AExact(CONSTANT_CTX, 0n);

describe("scheme/vectors Contract precision — the real exported ops reject wrongly-typed args (z.svector-backed fixes)", () => {
  // INVARIANT: vector-append's elements must be vector-protocol objects, rejecting a
  // non-vector
  it("vector-append: elements must be vector-protocol objects — a non-vector used to slip through the old z.array(z.unknown())", () => {
    const def = nativeDef("vector-append");
    expect(def.in.safeParse([realVector, realVector]).success).toBe(true);
    expect(def.in.safeParse(["not-a-vector"]).success).toBe(false);
  });

  // INVARIANT: vector-ref's vec argument must be a vector-protocol object, rejecting a
  // non-vector
  it("vector-ref: the vec arg (position 0) must be a vector-protocol object — a non-vector used to slip through the old z.unknown()", () => {
    const def = nativeDef("vector-ref");
    expect(def.in.safeParse([realVector, idx]).success).toBe(true);
    expect(def.in.safeParse(["not-a-vector", idx]).success).toBe(false);
  });

  // INVARIANT: vector-map's rest (vector) elements must be vector-protocol objects,
  // genuinely variadic over 2+ vectors
  it("vector-map: rest (vector) elements must be vector-protocol objects — a non-vector used to slip through the old combined z.tuple([head], z.unknown())", () => {
    const def = nativeDef("vector-map");
    expect(def.in.safeParse([fn, realVector]).success).toBe(true);
    expect(def.in.safeParse([fn, realVector, realVector]).success).toBe(true); // genuinely variadic — 2+ vectors
    expect(def.in.safeParse([fn, "not-a-vector"]).success).toBe(false);
  });

  // INVARIANT: vector-for-each shares vector-map's rest-precision fix
  it("vector-for-each: same rest-precision fix as vector-map", () => {
    const def = nativeDef("vector-for-each");
    expect(def.in.safeParse([fn, realVector]).success).toBe(true);
    expect(def.in.safeParse([fn, "not-a-vector"]).success).toBe(false);
  });
});

describe("scheme/vectors Contract precision — sanity: the six fixed ops still accept well-formed calls", () => {
  // Not a RED/GREEN precision proof (z.value has no predicate — see the file header) — just
  // confirming the schema tightening didn't accidentally reject a legitimate call shape.
  // INVARIANT: vector still accepts a flat list of scheme values (static-only precision gain)
  it("vector: accepts a flat list of scheme values", () => {
    const def = nativeDef("vector");
    expect(def.in.safeParse([idx, realVector]).success).toBe(true);
  });

  // INVARIANT: vector-ref's output stays representation-blind by design
  it("vector-ref: output accepts any scheme value (representation-blind by design)", () => {
    const def = nativeDef("vector-ref");
    expect(def.out.safeParse([idx]).success).toBe(true);
  });

  // INVARIANT: vector->list's input stays gated on z.svector while its output stays
  // representation-blind
  it("vector->list: input still gated on z.svector (unchanged); output accepts any scheme value", () => {
    const def = nativeDef("vector->list");
    expect(def.in.safeParse([realVector]).success).toBe(true);
    expect(def.in.safeParse(["not-a-vector"]).success).toBe(false);
    expect(def.out.safeParse([idx]).success).toBe(true);
  });
});

describe("scheme/vectors Contract.type overrides — the harvest signature for the two HOFs whose z.custom callable HEAD is UNREPRESENTABLE (printer throws, degrading the whole signature to `(...args: unknown[]) => unknown` and losing the vector rest + the vector/void return)", () => {
  // vector-map/vector-for-each declare `input: [z.custom<callable>()], inputRest: z.svector`. The
  // callable head is unrepresentable to the harvest printer, so the WHOLE signature degrades to
  // the catch-all — throwing away the proc-first shape, the `readonly unknown[][]` rest (the same
  // image z.svector harvests as everywhere else in this file — cf. vector-append), and the
  // vector / void return. `Contract.type` restores the real shape (callable → `(...args:
  // unknown[]) => unknown`; a void HOF return → bare `void`).
  // INVARIANT: vector-map's harvested signature is proc-first over a vector rest,
  // returning a new vector (pins implementation, not behavior)
  it("vector-map: proc-first over a vector rest → a new vector", () => {
    expect(signatureOf(nativeDef("vector-map"))).toBe(VECTOR_MAP_HOF);
  });
  // INVARIANT: vector-for-each's harvested signature is proc-first over a vector rest,
  // returning void (pins implementation, not behavior)
  it("vector-for-each: proc-first over a vector rest, for effect → void", () => {
    expect(signatureOf(nativeDef("vector-for-each"))).toBe(VECTOR_FOR_EACH_HOF);
  });
});
