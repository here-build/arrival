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
 * The membrane now MATERIALIZES faithfully: BOTH `jsToScheme` and `fromJS` box every
 * primitive (number/bigint→exact, boolean→ABool, string→AString) through the boxer
 * registry, map undefined / function / unique-symbol → #void (+ a console warning), and
 * Symbol.for('x') → the keyword `:x`. The sandbox never holds a raw JS value — the
 * deliberate, host-agnostic narrowing of JS interop. These tests pin that. Remaining notes:
 *  - membrane `isSchemeValue` lists AValue subtypes by explicit
 *    `instanceof` checks. Any AValue subtype that isn't listed will mis-route.
 *    Nil is technically listed by `=== nil`, but clones miss (see
 *    clone-identity.test.ts for the meta-bug).
 *
 * Tests intended to pass are GREEN; documented divergences are it.fails.
 */

import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { AValue } from "../../values/primitives/AValue.js";
import { fromJs } from "../boxing.js";
import { is_nil } from "../../eval/guards.js";
import { fromJS, isSchemeValue, toJS } from "../membrane.js";
import { AJSObject } from "../AJSObject.js";
import { AJSArray } from "../AJSArray.js";
import { jsToScheme, schemeToJs } from "../rosetta.js";
import { ALambda } from "../../values/primitives/ACallable.js";
import { ABool, schemeFalse, schemeTrue } from "../../values/primitives/ABool.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { APair } from "../../values/primitives/APair.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { theVoid } from "../../values/primitives/AVoid.js";
import { AVoid } from "../../values/primitives/AVoid.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";

// =========================================================================
// AValue.fromJs boxer dispatch — coverage of every registered tag
// =========================================================================

describe("AValue.fromJs — boxer dispatch produces the expected subtype per typeof tag", () => {
  // Boxer registry resolution: typeof string → "string" boxer (SchemeString.ts:139)
  // INVARIANT: string → SchemeString via boxer dispatch
  it("string → SchemeString", () => {
    const result = fromJs(CONSTANT_CTX, "hello");
    expect(result).toBeInstanceOf(AString);
    expect((result as AString).valueOf()).toBe("hello");
  });

  // typeof 42 === "number" — registered in operators/index.ts (via the
  // numbers module). Safe integer path → SchemeExact with bigint num.
  // INVARIANT: a safe-integer number → SchemeExact
  it("number (safe integer) → SchemeExact", () => {
    const result = fromJs(CONSTANT_CTX, 42);
    expect(result).toBeInstanceOf(AExact);
    expect((result as AExact).num).toBe(42);
  });

  // Non-integer float → SchemeInexact (real part).
  // INVARIANT: a float number → SchemeInexact
  it("number (float) → SchemeInexact", () => {
    const result = fromJs(CONSTANT_CTX, 3.14);
    expect(result).toBeInstanceOf(AInexact);
    expect((result as AInexact).real).toBe(3.14);
  });

  // typeof 1n === "bigint" → opaque host value (docs/design-history/
  // arrival-one-number-rework.md §2.3), never boxed — rides the raw pass-through lane.
  // INVARIANT: bigint is not boxed — fromJs returns it unchanged (opaque host value, not a scheme number)
  it("bigint → opaque host passthrough (never boxed; not a scheme number)", () => {
    const result = fromJs(CONSTANT_CTX, 123n);
    expect(result).toBe(123n);
    expect(typeof result).toBe("bigint");
  });

  // SchemeBool.ts:32-34 — empty-provenance fast path REUSES the schemeTrue/schemeFalse
  // singletons. Non-empty provenance mints a fresh SchemeBool.
  // INVARIANT: boolean with empty provenance reuses the schemeTrue/schemeFalse singletons (pins implementation, not behavior)
  it("boolean (empty provenance) → singleton SchemeBool", () => {
    expect(fromJs(CONSTANT_CTX, true)).toBe(schemeTrue);
    expect(fromJs(CONSTANT_CTX, false)).toBe(schemeFalse);
  });

  // INVARIANT: boolean with non-empty provenance mints a fresh ABool carrying that provenance
  it("boolean (non-empty provenance) → fresh SchemeBool with provenance", () => {
    const prov = new Set<number>([99]);
    const result = fromJs(CONSTANT_CTX, true, prov);
    expect(result).toBeInstanceOf(ABool);
    expect(result).not.toBe(schemeTrue);
    expect((result as ABool).value).toBe(true);
    // Cast: `fromJs`'s return type widened to `AValue | bigint` (§2.3's opaque-host-value
    // law) — this call's runtime shape is always ABool (a boolean input never produces
    // the bigint arm), same idiom as the `.value` cast just above.
    expect([...(result as ABool).provenance]).toEqual([99]);
  });

  // The two JS bottoms map to the two distinct Scheme absences (Rosetta
  // concept-split): null → nil (empty list); undefined → void (unspecified).
  // Empty provenance still returns a fresh instance (withProvenance always
  // allocates) — the clone-leak shape.
  // INVARIANT: null → ANil instance
  it("null → Nil instance", () => {
    const result = fromJs(CONSTANT_CTX, null);
    expect(result).toBeInstanceOf(ANil);
    expect(result instanceof ANil).toBe(true);
  });

  // INVARIANT: undefined → AVoid instance
  it("undefined → Void instance", () => {
    const result = fromJs(CONSTANT_CTX, undefined);
    expect(result).toBeInstanceOf(AVoid);
  });

  // the "object" boxer. A JS array IS an R7RS vector → a borrowed AJSArray (no more list
  // coercion); a plain object wraps as SchemeJSObject.
  // INVARIANT: array → borrowed AJSArray vector, boxing lazily on access (pins implementation, not behavior)
  it("array → borrowed AJSArray vector (boxes lazily on access)", () => {
    const result = fromJs(CONSTANT_CTX, [1, 2, 3]);
    expect(result).toBeInstanceOf(AJSArray);
    expect((result as { kind: string }).kind).toBe("vector");
    expect((result as unknown as { __vector__: AExact[] }).__vector__[0].num).toBe(1);
  });

  // INVARIANT: plain object → AJSObject wrapper preserving source
  it("plain object → SchemeJSObject wrapper", () => {
    const obj = { foo: 1 };
    const result = fromJs(CONSTANT_CTX, obj);
    expect(result).toBeInstanceOf(AJSObject);
    expect((result as AJSObject).source).toBe(obj);
  });

  // INVARIANT: function → #void — the boxer registry never mints a callable wrapper
  it("function → #void (the boxer registry never mints a callable wrapper)", () => {
    expect(fromJs(CONSTANT_CTX, () => 42)).toBe(theVoid);
  });

  // ── THE LAMBDA-BRAND DISTINCTION (the require return-marshal leak) ────────────
  // A Scheme lambda used to be represented internally as a JS function carrying the
  // well-known LAMBDA brand (`Symbol.for("arrival/lambda")`, set by the evaluator on every
  // closure). It was ALREADY a scheme value, not host data crossing the boundary, so
  // `jsToScheme` had to pass it through BY IDENTITY — without that, a `require`d file
  // resolving as `{ kind: "eval", forms }` to a scheme lambda (the `.hbs`/`.prompt`
  // CALLABLE RULE shape) got VOIDED on its way back out through `require`'s own rosetta
  // return-marshal (the "require-returns-lambda voids" bug).
  //
  // [RETIRED 2026-07-09, reverse-membrane-for-callables.md §3 step 1] Every scheme lambda
  // — including named-let's loop binding, the LAMBDA brand's last live producer per the B4
  // audit — is a real `ALambda` value now (evaluator.ts's `evalLet`/`evalLambda`). The
  // LAMBDA brand had zero producers left and was deleted (well-known-symbols.ts, plus its
  // membrane.ts `isSchemeValue`/rosetta.ts `jsToScheme`/print.ts `functionRepr` readers).
  // The identity-pass-through law still holds — it's now unconditional on `instanceof
  // AValue` (jsToScheme's very first case), not a brand check — pinned below against a real
  // `ALambda`. The membrane's OTHER law is unchanged: an unbranded bare host function still
  // voids (also pinned below).
  // INVARIANT: a real scheme lambda (ALambda) passes through jsToScheme by identity (already a scheme value)
  // — historically pinned to the now-deleted LAMBDA brand; the law survives, the mechanism doesn't (pins implementation, not behavior)
  it("a real ALambda passes through jsToScheme by identity (it IS a scheme value)", () => {
    const lam = new ALambda({ name: "test-lambda", arity: { min: 0, max: 0 }, scope: undefined, runner: () => theVoid });
    expect(jsToScheme(CONSTANT_CTX, lam)).toBe(lam);
  });

  // INVARIANT: an unbranded (borrowed host) function still voids through jsToScheme
  it("a bare host function still voids through jsToScheme (borrowed host callback, by design)", () => {
    expect(jsToScheme(CONSTANT_CTX, () => 42)).toBe(theVoid);
  });

  // AValue input is returned as-is on the empty-provenance fast path.
  // INVARIANT: AValue input with empty provenance is returned by identity (fast path)
  it("AValue input (empty provenance) is returned by identity", () => {
    const orig = new AString(CONSTANT_CTX, "x");
    expect(fromJs(CONSTANT_CTX, orig)).toBe(orig);
  });

  // INVARIANT: AValue input with non-empty provenance is cloned via withProvenance, carrying the new provenance (pins implementation, not behavior)
  it("AValue input (with non-empty provenance) is cloned via withProvenance", () => {
    const orig = new AString(CONSTANT_CTX, "x");
    const prov = new Set<number>([7]);
    const result = fromJs(CONSTANT_CTX, orig, prov);
    expect(result).not.toBe(orig);
    expect(result).toBeInstanceOf(AString);
    // Cast: `fromJs`'s return type widened to `AValue | bigint` (§2.3's opaque-host-value
    // law) — this call's runtime shape is always AString (an AValue input re-stamps
    // through its own class, never the bigint arm).
    expect([...(result as AString).provenance]).toEqual([7]);
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
  // INVARIANT: a string is boxed into AString by jsToScheme
  it("string is wrapped through jsToScheme into SchemeString", () => {
    const lipsified = jsToScheme(CONSTANT_CTX, "hello");
    expect(lipsified).toBeInstanceOf(AString);
  });

  // String pass-through round trips by accident — raw in, raw out.
  // This IS expected behavior today and is the green guard for the
  // primitive-passthrough contract.
  // INVARIANT: string round-trips by passthrough (raw in, raw out)
  it("string round-trips by passthrough (raw → raw)", () => {
    expect(schemeToJs(jsToScheme(CONSTANT_CTX, "hello"))).toBe("hello");
  });

  // INVARIANT: number round-trips by passthrough
  it("number round-trips by passthrough", () => {
    expect(schemeToJs(jsToScheme(CONSTANT_CTX, 42))).toBe(42);
  });

  // INVARIANT: boolean round-trips by passthrough
  it("boolean round-trips by passthrough", () => {
    expect(schemeToJs(jsToScheme(CONSTANT_CTX, true))).toBe(true);
  });

  // Arrays are properly cons'd to Pair, then schemeToJs walks the spine
  // back into an array. The element-level cons'ing also wraps the leaves
  // through jsToScheme (so primitives stay primitives), and schemeToJs
  // recurses through the Pair spine.
  // INVARIANT: array round-trips through a Pair chain
  it("array round-trips through a Pair chain", () => {
    const result = schemeToJs(jsToScheme(CONSTANT_CTX, [1, 2, 3]));
    expect(result).toEqual([1, 2, 3]);
  });

  // INVARIANT: nested array round-trips
  it("nested array round-trips", () => {
    const result = schemeToJs(jsToScheme(CONSTANT_CTX, [[1, 2], [3, 4]]));
    expect(result).toEqual([[1, 2], [3, 4]]);
  });

  // Plain objects are recursed: jsToScheme builds { k: jsToScheme(CONSTANT_CTX, v) }, schemeToJs
  // mirrors via Object.entries → schemeToJs(value). Round-trip is correct.
  // INVARIANT: plain object round-trips
  it("plain object round-trips", () => {
    const result = schemeToJs(jsToScheme(CONSTANT_CTX, { a: 1, b: "two" }));
    expect(result).toEqual({ a: 1, b: "two" });
  });

  // INVARIANT: nested object round-trips
  it("nested object round-trips", () => {
    const result = schemeToJs(jsToScheme(CONSTANT_CTX, { outer: { inner: 42 } }));
    expect(result).toEqual({ outer: { inner: 42 } });
  });

  // null → nil (jsToScheme); schemeToJs(nil) → [] — the reverse delegates to
  // arrival/toJS, whose face is the empty list's ARRAY (nil-as-array, V ruling
  // 2026-07-13: emptiness must not flip a list's JS type to null; matches the
  // compiled world's '() representation). The round trip is asymmetric BY LAW:
  // ingress permissive (null → nil), egress canonical (nil → []).
  it("null enters as nil and exits as [] (ingress permissive, egress canonical)", () => {
    expect(schemeToJs(jsToScheme(CONSTANT_CTX, null))).toEqual([]);
  });
});

// =========================================================================
// isSchemeValue completeness — every native AValue subtype
// =========================================================================

describe("isSchemeValue completeness — every native AValue subtype is recognised", () => {
  // Membrane's isSchemeValue (membrane.ts:70-99) is a long `instanceof`
  // chain. Each test asserts the chain has a branch for the subtype.

  // INVARIANT: every native AValue subtype (String/Symbol/Character/Exact/Inexact/Bool/Pair/nil/JSObject) is recognized as a scheme value
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
    expect(isSchemeValue(new AExact(CONSTANT_CTX, 42))).toBe(true);
  });

  it("SchemeInexact → true", () => {
    expect(isSchemeValue(new AInexact(CONSTANT_CTX, 3.14))).toBe(true);
  });

  it("SchemeBool (singletons) → true", () => {
    expect(isSchemeValue(schemeTrue)).toBe(true);
    expect(isSchemeValue(schemeFalse)).toBe(true);
  });

  it("Pair → true", () => {
    expect(isSchemeValue(new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1), nil))).toBe(true);
  });

  it("nil singleton → true (via the `=== nil` short-circuit)", () => {
    expect(isSchemeValue(nil)).toBe(true);
  });

  it("SchemeJSObject → true", () => {
    expect(isSchemeValue(new AJSObject(CONSTANT_CTX, {}))).toBe(true);
  });

  // Nil clones — should be recognized but aren't. See clone-identity.test.ts
  // for the full enumeration of `=== nil` sites. This is a duplicate of the
  // membrane.ts:71 site, deliberately kept here for the completeness map.
  // INVARIANT: a Nil clone (via withProvenance) is recognized as a scheme value
  it("Nil clone → true (see membrane.ts:71 + clone-identity.test.ts; fixed via `instanceof Nil`)", () => {
    const clone = nil.withProvenance(new Set<number>([1]));
    expect(isSchemeValue(clone)).toBe(true);
  });

  // Plain JS values should NOT be Scheme values. Negative cases keep the
  // boundary's other direction honest.
  // INVARIANT: plain JS values (string/number/object/array/null/undefined) are NOT scheme values
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
  // INVARIANT: a string primitive round-trips through fromJS/toJS
  it("primitive round-trips: string", () => {
    // @ts-expect-error fromJS returns `FromJSResult` (wider than `SchemeValue`); toJS expects
    // SchemeValue. The runtime value IS a SchemeValue — the mismatch is in the declared union.
    expect(toJS(fromJS("hello"))).toBe("hello");
  });

  // INVARIANT: a number primitive round-trips through fromJS/toJS
  it("primitive round-trips: number", () => {
    // @ts-expect-error fromJS returns `FromJSResult` (wider than `SchemeValue`); see above.
    expect(toJS(fromJS(42))).toBe(42);
  });

  // INVARIANT: bigint is an opaque host value — the membrane routes it through unboxed,
  // identical both directions (never a scheme number; see coerce-numeric.spec.ts for the
  // arithmetic-coercion door and docs/design-history/arrival-one-number-rework.md §2.3).
  it("bigint crosses as an opaque host value (never boxed into an exact)", () => {
    // host-agnostic: 10n stays 10n — arrival never reinterprets a host bigint as a scheme
    // number. fromJS rides the same raw identity lane Uint8Array/ArrayBuffer/DataView use.
    const entered = fromJS(10n);
    expect(entered).toBe(10n);
    // Never boxed on entry, so schemeToJs's generic scalar fallback (not toJS's strict
    // door, which refuses a value that never crossed AS a scheme value) returns it
    // unchanged.
    // @ts-expect-error `entered`'s static type is `FromJSResult` (bigint included, per
    // the opaque-host-value law) — schemeToJs expects `SchemeValue`; the mismatch is in
    // the declared union's width, not a real unsoundness.
    expect(schemeToJs(entered)).toBe(10n);
  });

  // LAW (nil-as-array, V 2026-07-13): null enters as nil; nil exits as [] — the
  // empty list's array face. Asymmetric by design (ingress permissive, egress canonical).
  it("null enters as nil; nil exits as []", () => {
    // fromJS(null) → nil (the singleton). toJS(nil) → [] via ANil's arrival/toJS.
    // @ts-expect-error fromJS returns `FromJSResult` (wider than `SchemeValue`); see above.
    expect(toJS(fromJS(null))).toEqual([]);
  });

  // INVARIANT: an object round-trips through AJSObject preserving the exact source reference
  it("object round-trips through SchemeJSObject (same source reference)", () => {
    const obj = { a: 1 };
    const wrapped = fromJS(obj);
    expect(wrapped).toBeInstanceOf(AJSObject);
    // @ts-expect-error fromJS returns `FromJSResult` (wider than `SchemeValue`); see above.
    expect(toJS(wrapped)).toBe(obj);
  });

  // INVARIANT: a borrowed function does not cross the membrane — materializes to #void
  it("a borrowed function does NOT cross — it materializes to #void (not a portable value)", () => {
    expect(fromJS(() => 42)).toBe(theVoid);
  });

  // INVARIANT: the wrapper cache returns the same wrapper instance for the same JS object
  it("wrapper cache: same JS object → same wrapper instance", () => {
    const obj = { x: 1 };
    const a = fromJS(obj);
    const b = fromJS(obj);
    expect(a).toBe(b);
  });
});
