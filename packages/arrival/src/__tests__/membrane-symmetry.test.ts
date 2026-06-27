/**
 * Two-API membrane symmetry tests.
 *
 * The codebase has two parallel JS↔Scheme conversion surfaces:
 *
 *   - rosetta.ts:  schemeToJs / jsToScheme — used by rosetta wrappers + sandbox env.
 *   - membrane.ts: AValue.fromJs + boxer dispatch / membrane.toJS — used by
 *                  FFI codecs (Operator/Codec) and the AValue subtype boxers.
 *
 * They should compose: jsToScheme → schemeToJs round-trips, fromJs → toJs round-trips,
 * and the two APIs agree on the SHAPE of converted values.
 *
 * They don't, today, in several places. These tests document the divergence:
 *  - rosetta `jsToScheme` does NOT box `string`/`number`/`boolean`/`bigint`
 *    primitives (returns them raw). schemeToJs unwraps the same primitives by
 *    type-checking specific AValue subtypes — so a primitive in/primitive out
 *    looks "round-trip correct" by accident even though the cross-membrane
 *    SHAPE is different from what `AValue.fromJs` would produce.
 *  - membrane `isSchemeValue` lists AValue subtypes by explicit
 *    `instanceof` checks. Any AValue subtype that isn't listed will mis-route.
 *    Nil is technically listed by `=== nil`, but clones miss (see
 *    clone-identity.test.ts for the meta-bug).
 *
 * Tests intended to pass are GREEN; documented divergences are it.fails.
 */

import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AValue } from "../values/primitives/AValue.js";
import { fromJs } from "../values/primitives/boxing.js";
import { is_nil } from "../eval/guards";
import { fromJS, isSchemeValue, toJS } from "../membrane";
import { AJSFunction, AJSObject } from "../values/primitives/js-wrappers.js";
import { jsToScheme, schemeToJs } from "../rosetta";
import { ABool, schemeFalse, schemeTrue } from "../values/primitives/ABool.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AExact, AInexact } from "../values/numbers";
import { APair } from "../values/primitives/APair.js";
import { ANil, nil } from "../values/primitives/ANil";
import { ACharacter } from "../values/primitives/ACharacter";
import { QuotedPromise } from "../values/primitives/QuotedPromise.js";

// =========================================================================
// AValue.fromJs boxer dispatch — coverage of every registered tag
// =========================================================================

describe("AValue.fromJs — boxer dispatch produces the expected subtype per typeof tag", () => {
  // Boxer registry resolution: typeof string → "string" boxer (SchemeString.ts:139)
  it("string → SchemeString", () => {
    const result = fromJs(CONSTANT_CTX, "hello");
    expect(result).toBeInstanceOf(AString);
    expect((result as AString).valueOf()).toBe("hello");
  });

  // typeof 42 === "number" — registered in operators/index.ts (via the
  // numbers module). Safe integer path → SchemeExact with bigint num.
  it("number (safe integer) → SchemeExact", () => {
    const result = fromJs(CONSTANT_CTX, 42);
    expect(result).toBeInstanceOf(AExact);
    expect((result as AExact).num).toBe(42n);
  });

  // Non-integer float → SchemeInexact (real part).
  it("number (float) → SchemeInexact", () => {
    const result = fromJs(CONSTANT_CTX, 3.14);
    expect(result).toBeInstanceOf(AInexact);
    expect((result as AInexact).real).toBe(3.14);
  });

  // typeof 1n === "bigint" → SchemeExact regardless of size.
  it("bigint → SchemeExact", () => {
    const result = fromJs(CONSTANT_CTX, 123n);
    expect(result).toBeInstanceOf(AExact);
    expect((result as AExact).num).toBe(123n);
  });

  // SchemeBool.ts:32-34 — empty-provenance fast path REUSES the schemeTrue/schemeFalse
  // singletons. Non-empty provenance mints a fresh SchemeBool.
  it("boolean (empty provenance) → singleton SchemeBool", () => {
    expect(fromJs(CONSTANT_CTX, true)).toBe(schemeTrue);
    expect(fromJs(CONSTANT_CTX, false)).toBe(schemeFalse);
  });

  it("boolean (non-empty provenance) → fresh SchemeBool with provenance", () => {
    const prov = new Set<number>([99]);
    const result = fromJs(CONSTANT_CTX, true, prov);
    expect(result).toBeInstanceOf(ABool);
    expect(result).not.toBe(schemeTrue);
    expect((result as ABool).value).toBe(true);
    expect([...result.provenance]).toEqual([99]);
  });

  // types.ts:212-213 — null and undefined both → Nil (boxed).
  // Empty provenance: returns a fresh Nil (NOT the singleton — see types.ts:87
  // — withProvenance always allocates). This is exactly the clone-leak shape.
  it("null → Nil instance", () => {
    const result = fromJs(CONSTANT_CTX, null);
    expect(result).toBeInstanceOf(ANil);
    expect(is_nil(result)).toBe(true);
  });

  it("undefined → Nil instance", () => {
    const result = fromJs(CONSTANT_CTX, undefined);
    expect(result).toBeInstanceOf(ANil);
    expect(is_nil(result)).toBe(true);
  });

  // membrane.ts:647-656 — "object" boxer. Arrays cons up into a Pair chain;
  // plain objects wrap as SchemeJSObject.
  it("array → Pair chain", () => {
    const result = fromJs(CONSTANT_CTX, [1, 2, 3]);
    expect(result).toBeInstanceOf(APair);
    const p = result as APair;
    expect((p.car as AExact).num).toBe(1n);
  });

  it("plain object → SchemeJSObject wrapper", () => {
    const obj = { foo: 1 };
    const result = fromJs(CONSTANT_CTX, obj);
    expect(result).toBeInstanceOf(AJSObject);
    expect((result as AJSObject).source).toBe(obj);
  });

  it("function → SchemeJSFunction wrapper", () => {
    const fn = () => 42;
    const result = fromJs(CONSTANT_CTX, fn);
    expect(result).toBeInstanceOf(AJSFunction);
    expect((result as AJSFunction).source).toBe(fn);
  });

  // AValue input is returned as-is on the empty-provenance fast path.
  it("AValue input (empty provenance) is returned by identity", () => {
    const orig = new AString(CONSTANT_CTX, "x");
    expect(fromJs(CONSTANT_CTX, orig)).toBe(orig);
  });

  it("AValue input (with non-empty provenance) is cloned via withProvenance", () => {
    const orig = new AString(CONSTANT_CTX, "x");
    const prov = new Set<number>([7]);
    const result = fromJs(CONSTANT_CTX, orig, prov);
    expect(result).not.toBe(orig);
    expect(result).toBeInstanceOf(AString);
    expect([...result.provenance]).toEqual([7]);
  });
});

// =========================================================================
// jsToScheme → schemeToJs round-trip
// =========================================================================

describe("jsToScheme → schemeToJs round-trip", () => {
  // Option C (2026-05-28): jsToScheme deep-stamps every constructed AValue —
  // primitives now route through `AValue.fromJs` (boxer registry) so a JS
  // string in produces a `SchemeString` carrying the supplied provenance.
  // Closes the shape divergence the membrane symmetry audit flagged.
  it("string is wrapped through jsToScheme into SchemeString", () => {
    const lipsified = jsToScheme(CONSTANT_CTX, "hello");
    expect(lipsified).toBeInstanceOf(AString);
  });

  // String pass-through round trips by accident — raw in, raw out.
  // This IS expected behavior today and is the green guard for the
  // primitive-passthrough contract.
  it("string round-trips by passthrough (raw → raw)", () => {
    expect(schemeToJs(jsToScheme(CONSTANT_CTX, "hello"))).toBe("hello");
  });

  it("number round-trips by passthrough", () => {
    expect(schemeToJs(jsToScheme(CONSTANT_CTX, 42))).toBe(42);
  });

  it("boolean round-trips by passthrough", () => {
    expect(schemeToJs(jsToScheme(CONSTANT_CTX, true))).toBe(true);
  });

  // Arrays are properly cons'd to Pair, then schemeToJs walks the spine
  // back into an array. The element-level cons'ing also wraps the leaves
  // through jsToScheme (so primitives stay primitives), and schemeToJs
  // recurses through the Pair spine.
  it("array round-trips through a Pair chain", () => {
    const result = schemeToJs(jsToScheme(CONSTANT_CTX, [1, 2, 3]));
    expect(result).toEqual([1, 2, 3]);
  });

  it("nested array round-trips", () => {
    const result = schemeToJs(jsToScheme(CONSTANT_CTX, [[1, 2], [3, 4]]));
    expect(result).toEqual([[1, 2], [3, 4]]);
  });

  // Plain objects are recursed: jsToScheme builds { k: jsToScheme(CONSTANT_CTX, v) }, schemeToJs
  // mirrors via Object.entries → schemeToJs(value). Round-trip is correct.
  it("plain object round-trips", () => {
    const result = schemeToJs(jsToScheme(CONSTANT_CTX, { a: 1, b: "two" }));
    expect(result).toEqual({ a: 1, b: "two" });
  });

  it("nested object round-trips", () => {
    const result = schemeToJs(jsToScheme(CONSTANT_CTX, { outer: { inner: 42 } }));
    expect(result).toEqual({ outer: { inner: 42 } });
  });

  // null → nil (rosetta.ts:160). The reverse direction is schemeToJs(nil) which
  // is the `value === nil` early return (rosetta.ts:70) — returns the nil
  // SINGLETON, not `null`. Documented divergence: rosetta does not invert
  // the null⇄nil contract symmetrically.
  it.fails("null round-trips to null (currently jsToScheme(CONSTANT_CTX, null) → nil, schemeToJs(nil) → nil singleton)", () => {
    expect(schemeToJs(jsToScheme(CONSTANT_CTX, null))).toBeNull();
  });
});

// =========================================================================
// isSchemeValue completeness — every native AValue subtype
// =========================================================================

describe("isSchemeValue completeness — every native AValue subtype is recognised", () => {
  // Membrane's isSchemeValue (membrane.ts:70-99) is a long `instanceof`
  // chain. Each test asserts the chain has a branch for the subtype.

  it("SchemeString → true", () => {
    expect(isSchemeValue(new AString(CONSTANT_CTX, "x"))).toBe(true);
  });

  it("SchemeSymbol → true", () => {
    expect(isSchemeValue(new ASymbol(CONSTANT_CTX, "foo"))).toBe(true);
  });

  it("SchemeCharacter → true", () => {
    expect(isSchemeValue(new ACharacter(CONSTANT_CTX, "a"))).toBe(true);
  });

  it("SchemeExact → true", () => {
    expect(isSchemeValue(new AExact(CONSTANT_CTX, 42n))).toBe(true);
  });

  it("SchemeInexact → true", () => {
    expect(isSchemeValue(new AInexact(CONSTANT_CTX, 3.14))).toBe(true);
  });

  it("SchemeBool (singletons) → true", () => {
    expect(isSchemeValue(schemeTrue)).toBe(true);
    expect(isSchemeValue(schemeFalse)).toBe(true);
  });

  it("Pair → true", () => {
    expect(isSchemeValue(new APair(CONSTANT_CTX, 1, nil))).toBe(true);
  });

  it("nil singleton → true (via the `=== nil` short-circuit)", () => {
    expect(isSchemeValue(nil)).toBe(true);
  });

  it("SchemeJSObject → true", () => {
    expect(isSchemeValue(new AJSObject(CONSTANT_CTX, {}))).toBe(true);
  });

  it("SchemeJSFunction → true", () => {
    expect(isSchemeValue(new AJSFunction(CONSTANT_CTX, () => 1))).toBe(true);
  });

  it("QuotedPromise → true", () => {
    expect(isSchemeValue(new QuotedPromise(Promise.resolve(1)))).toBe(true);
  });

  // Nil clones — should be recognized but aren't. See clone-identity.test.ts
  // for the full enumeration of `=== nil` sites. This is a duplicate of the
  // membrane.ts:71 site, deliberately kept here for the completeness map.
  it("Nil clone → true (see membrane.ts:71 + clone-identity.test.ts; fixed via `instanceof Nil`)", () => {
    const clone = nil.withProvenance(new Set<number>([1]));
    expect(isSchemeValue(clone)).toBe(true);
  });

  // Plain JS values should NOT be Scheme values. Negative cases keep the
  // boundary's other direction honest.
  it("plain string → false", () => {
    expect(isSchemeValue("hello")).toBe(false);
  });

  it("plain number → false", () => {
    expect(isSchemeValue(42)).toBe(false);
  });

  it("plain object → false", () => {
    expect(isSchemeValue({})).toBe(false);
  });

  it("plain array → false (arrays cons up via boxer, but a raw array is not Scheme)", () => {
    expect(isSchemeValue([1, 2, 3])).toBe(false);
  });

  it("null → false", () => {
    expect(isSchemeValue(null)).toBe(false);
  });

  it("undefined → false", () => {
    expect(isSchemeValue(undefined)).toBe(false);
  });
});

// =========================================================================
// fromJS / toJS — membrane.ts cross-boundary symmetry
// =========================================================================

describe("membrane fromJS / toJS — round-trip + wrapper-cache identity", () => {
  it("primitive round-trips: string", () => {
    expect(toJS(fromJS("hello"))).toBe("hello");
  });

  it("primitive round-trips: number", () => {
    expect(toJS(fromJS(42))).toBe(42);
  });

  it("primitive round-trips: bigint", () => {
    expect(toJS(fromJS(10n))).toBe(10n);
  });

  it("null round-trips through nil", () => {
    // fromJS(null) → nil (the singleton). toJS(nil) → null via `value === nil`.
    expect(toJS(fromJS(null))).toBe(null);
  });

  it("object round-trips through SchemeJSObject (same source reference)", () => {
    const obj = { a: 1 };
    const wrapped = fromJS(obj);
    expect(wrapped).toBeInstanceOf(AJSObject);
    expect(toJS(wrapped)).toBe(obj);
  });

  it("function round-trips through SchemeJSFunction (same source reference)", () => {
    const fn = () => 42;
    const wrapped = fromJS(fn);
    expect(wrapped).toBeInstanceOf(AJSFunction);
    expect(toJS(wrapped)).toBe(fn);
  });

  it("wrapper cache: same JS object → same wrapper instance", () => {
    const obj = { x: 1 };
    const a = fromJS(obj);
    const b = fromJS(obj);
    expect(a).toBe(b);
  });
});
