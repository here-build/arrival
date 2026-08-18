/**
 * Membrane wrapper-layer tests.
 *
 * The CODEC / Operator layer this file used to also cover (the `Codec` family,
 * `Operator`, `OperatorRegistry`, the operator instances, the pre-built registries)
 * has been deleted — the numeric core it served is carved into the `scheme/numeric`
 * pack (env/r7rs/numeric.ts) and witnessed at the scheme surface by numbers.spec /
 * r7rs-numbers. What remains is the WRAPPER layer (fromJS / toJS / isSchemeValue /
 * the membrane wrappers), which survives.
 */

import { describe, expect, it, vi } from "vitest";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import {
  // Wrapper layer
  fromJS,
  toJS,
  isSchemeValue,
  isBytevectorLike } from "../membrane.js";
import { AJSObject } from "../AJSObject.js";
import { AJSArray } from "../AJSArray.js";
import { nil } from "../../values/primitives/ANil.js";
import { theVoid } from "../../values/primitives/AVoid.js";
import { ABool } from "../../values/primitives/ABool.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { APair } from "../../values/primitives/APair.js";
import { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";

// ============================================================================
// WRAPPER LAYER TESTS
// ============================================================================

describe("Wrapper Layer", () => {
  describe("isSchemeValue", () => {
    it("recognizes nil", () => {
      expect(isSchemeValue(nil)).toBe(true);
    });

    it("recognizes native Scheme types", () => {
      expect(isSchemeValue(new AExact(42))).toBe(true);
      expect(isSchemeValue(new AInexact(3.14))).toBe(true);
      expect(isSchemeValue(new AString("hello"))).toBe(true);
      expect(isSchemeValue(new ASymbol("foo"))).toBe(true);
      expect(isSchemeValue(new APair(new AExact(1), new AExact(2)))).toBe(true);
    });

    it("recognizes wrappers as Scheme values", () => {
      expect(isSchemeValue(new AJSObject({}))).toBe(true);
    });

    it("rejects JS primitives and objects", () => {
      expect(isSchemeValue(42)).toBe(false);
      expect(isSchemeValue("hello")).toBe(false);
      expect(isSchemeValue({})).toBe(false);
      expect(isSchemeValue([])).toBe(false);
      expect(isSchemeValue(null)).toBe(false);
      expect(isSchemeValue(undefined)).toBe(false);
    });
  });

  // INVARIANT: Uint8Array/ArrayBuffer/DataView are recognized as bytevector-like;
  // non-binary types (array/object/string) are rejected as bytevector-like
  describe("isBytevectorLike", () => {
    it("recognizes Uint8Array", () => {
      expect(isBytevectorLike(new Uint8Array(10))).toBe(true);
    });

    it("recognizes ArrayBuffer", () => {
      expect(isBytevectorLike(new ArrayBuffer(10))).toBe(true);
    });

    it("recognizes DataView", () => {
      expect(isBytevectorLike(new DataView(new ArrayBuffer(10)))).toBe(true);
    });

    it("rejects non-binary types", () => {
      expect(isBytevectorLike([])).toBe(false);
      expect(isBytevectorLike({})).toBe(false);
      expect(isBytevectorLike("hello")).toBe(false);
    });
  });

  describe("fromJS", () => {
    it("converts null to nil; undefined to #void (no portable representation)", () => {
      expect(fromJS(null)).toBe(nil);
      expect(fromJS(undefined)).toBe(theVoid);
    });

    // INVARIANT: JS primitives (bool/number/string) materialize into boxed AValue subtypes,
    // never a raw leak; a registered symbol (Symbol.for) materializes to ASymbol. A UNIQUE
    // symbol and host bigint have no lens — they DOOR (NoLensError), they do not materialize.
    it("MATERIALIZES primitives to boxed AValues (host-agnostic — never a raw leak)", () => {
      expect(fromJS(true)).toBeInstanceOf(ABool);
      expect(fromJS(42)).toBeInstanceOf(AExact);
      expect(fromJS("hello")).toBeInstanceOf(AString);
      // a UNIQUE symbol has no lens (no portable identity) → door; a REGISTERED one → the keyword :test
      expect(() => fromJS(Symbol("test"))).toThrow(/no lens for a unique JS symbol/);
      expect(fromJS(Symbol.for("test"))).toBeInstanceOf(ASymbol);
    });

    // INVARIANT: host bigint DOORS (NoLensError kind `"bigint"`) — same spirit as
    // unique-symbol. Exact numbers are safe-int ratios; convert with Number/
    // bigintToNumber in the safe range (or pass inexact/string) before re-crossing.
    it("bigint DOORS — no lens for a host bigint (never boxed, never raw passthrough)", () => {
      expect(() => fromJS(42n)).toThrow(/no lens for a host bigint/);
    });

    it("refuses an already-boxed scheme value (strict one-way door)", () => {
      // fromJS is the JS→Scheme entry; an interpreter-minted value never crosses
      // it. The old pass-through masked which-side-am-I-on confusion in callers.
      const exact = new AExact(42);
      // @ts-expect-error type-level: an AValue argument resolves to never
      expect(() => fromJS(exact)).toThrow(/already-boxed/);

      const pair = new APair(new AExact(1), new AExact(2));
      // @ts-expect-error type-level: an AValue argument resolves to never
      expect(() => fromJS(pair)).toThrow(/already-boxed/);
    });

    it("borrows arrays as a vector (AJSArray) keeping source identity", () => {
      const arr = [1, 2, 3];
      const wrapped = fromJS(arr);
      expect(wrapped).toBeInstanceOf(AJSArray);
      expect((wrapped as AJSArray).source).toBe(arr);
    });

    it("passes through bytevector-like types", () => {
      const u8 = new Uint8Array(10);
      expect(fromJS(u8)).toBe(u8);

      const ab = new ArrayBuffer(10);
      expect(fromJS(ab)).toBe(ab);
    });

    it("passes through Promises", () => {
      const p = Promise.resolve(42);
      expect(fromJS(p)).toBe(p);
    });

    it("materializes a borrowed function to a callable (ARosettaProcedure, reverse-membrane lens)", () => {
      expect(fromJS(() => 42)).toBeInstanceOf(ARosettaProcedure);
    });

    // INVARIANT: no membrane warning fires anymore — V's ruling (2026-07-23/24) retired
    // the warn tier entirely off this path: `undefined` is a plain lens (no warn), a
    // unique symbol doors (NoLensError, no warn), and a bare host function — the last row
    // that still warned — is now the callable lens above (no warn either). Nothing left on
    // `fromJS`/`jsToScheme` still emits a membrane warning; `setMembraneWarnings`'s
    // toggle/dedupe behavior itself is pinned directly against `warnMembrane` in
    // membrane-warn-bounded.law.test.ts, unrelated to any live producer here.
    it("emits no console.warn materializing a borrowed function (the warn tier's last row is retired)", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        fromJS(() => 42);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("wraps objects in SchemeJSObject", () => {
      const obj = { a: 1 };
      const wrapped = fromJS(obj);
      expect(wrapped).toBeInstanceOf(AJSObject);
      expect((wrapped as AJSObject).source).toBe(obj);
    });

    it("returns same wrapper for same object (identity cache)", () => {
      const obj = { a: 1 };
      const wrapped1 = fromJS(obj);
      const wrapped2 = fromJS(obj);
      expect(wrapped1).toBe(wrapped2);
    });

    it("refuses re-entry of a wrapper — double-wrapping is impossible", () => {
      const obj = { a: 1 };
      const wrapped = fromJS(obj);
      // No longer a type error: `wrapped: FromJSResult` (membrane.ts) is a boundary-wide
      // union (includes Uint8Array/ArrayBuffer/DataView/Function/Promise, none of which
      // extend AValue), so `[T] extends [AValue]` no longer holds for the WHOLE union —
      // the runtime door below is still real, just no longer caught statically.
      expect(() => fromJS(wrapped)).toThrow(/already-boxed/);
    });
  });

  describe("toJS", () => {
    // LAW (nil-as-array, V 2026-07-13): nil's JS face is [] — the empty case of the one
    // list projection (egress canonical; ingress stays permissive with null → nil).
    it("converts nil to []", () => {
      expect(toJS(nil)).toEqual([]);
    });

    it("unwraps SchemeJSObject", () => {
      const obj = { a: 1 };
      const wrapped = new AJSObject(obj);
      expect(toJS(wrapped)).toBe(obj);
    });

    it("converts SchemeString to string", () => {
      expect(toJS(new AString("hello"))).toBe("hello");
    });

    it("converts SchemeExact to number (safe integers)", () => {
      // SchemeExact.valueOf() returns number for safe integers
      expect(toJS(new AExact(42))).toBe(42);
    });

    it("converts SchemeInexact to number", () => {
      expect(toJS(new AInexact(3.14))).toBe(3.14);
    });

    it("passes through primitives", () => {
      expect(toJS(new AExact(42))).toBe(42);
      expect(toJS(new AString("hello"))).toBe("hello");
      expect(toJS(new ABool(true))).toBe(true);
    });

    // Was a green pin of the apostrophe-prefixed-string exit shape with a stale
    // "todo symbols gets transformed into opaque symbol" comment (2026-07-09 suite
    // consolidation) — the SAME still-undecided design question
    // membrane/crossing.law.test.ts's "registered symbol (Symbol.for)" exit cell already
    // stages as `it.todo` (ASymbol's opaque-exit mapping still design-pending,
    // deferred separately from R1). Promoted to `it.todo` here too rather than pinning
    // one arbitrary shape as if it were the settled design.
    it.todo("converts SchemeSymbol via its own toJS protocol — opaque-symbol exit design pending");

    // INVARIANT: APair converts to a JS array
    it("keeps Pair as-is", () => {
      const pair = new APair(new AExact(1), new AExact(2));
      expect(toJS(pair)).toEqual([1, 2]);
    });
  });

  describe("SchemeJSObject", () => {
    it("has the arrival/toJS protocol key", () => {
      const obj = new AJSObject({});
      expect("arrival/toJS" in obj).toBe(true);
      expect(obj["arrival/toJS"]()).toEqual({});
    });

    // INVARIANT: .get(key) lazily boxes property values into AValue subtypes, inheriting the wrapper's provenance
    it("gets properties with lazy wrapping", () => {
      const inner = { b: 2 };
      const obj = new AJSObject({ a: 1, inner });

      // Option C (2026-05-28): `.get(key)` now boxes entries through
      // jsToScheme so they inherit the wrapper's provenance — a primitive
      // surfaces as the corresponding AValue subtype, not raw JS. `valueOf`
      // unwraps to the underlying JS value for callers that need it.
      const a = obj.get("a");
      expect(a).toBeInstanceOf(AExact);
      expect((a as AExact).valueOf()).toBe(1);
      const wrappedInner = obj.get("inner");
      expect(wrappedInner).toBeInstanceOf(AJSObject);
      expect((wrappedInner as AJSObject).source).toBe(inner);
    });

    // INVARIANT: .set()/.delete() are rejected — membrane is read-only, throwing "writes are banned"/
    // "mutations are banned"; nothing crosses the boundary (pins implementation, not behavior)
    it("rejects writes — the membrane is read-only (pure-dataflow sandbox)", () => {
      const source: any = { a: 1 };
      const obj = new AJSObject(source);
      expect(() => obj.set("a", new AExact(42))).toThrow(/writes are banned/);
      expect(source.a).toBe(1);
      expect(() => obj.delete("a")).toThrow(/mutations are banned/);
      expect(source.a).toBe(1);
    });

    it("materializes a function-valued field to a callable (ARosettaProcedure), allows getter reads", () => {
      const source = {
        data: 7,
        get computed() {
          return 99;
        },
        method() {
          return "danger";
        } };
      const obj = new AJSObject(source);
      expect((obj.get("data") as { valueOf(): unknown }).valueOf()).toBe(7);
      expect((obj.get("computed") as { valueOf(): unknown }).valueOf()).toBe(99);
      expect(obj.get("method")).toBeInstanceOf(ARosettaProcedure); // method → reverse-membrane lens, visible AND callable now
    });

    it("checks property existence (own properties only)", () => {
      const obj = new AJSObject({ a: 1 });
      expect(obj.has("a")).toBe(true);
      expect(obj.has("b")).toBe(false);
    });

    it("blocks inherited properties from Object.prototype", () => {
      const obj = new AJSObject({ a: 1 });
      // These are inherited from Object.prototype - blocked by sandbox
      expect(obj.has("toString")).toBe(false);
      expect(obj.has("hasOwnProperty")).toBe(false);
      expect(obj.has("constructor")).toBe(false);
    });

    it("gets keys", () => {
      const obj = new AJSObject({ a: 1, b: 2 });
      expect(obj.keys()).toEqual(["a", "b"]);
    });

    // INVARIANT: .toString() returns the fixed placeholder "#<js-object>" (pins implementation, not behavior)
    it("has toString", () => {
      const obj = new AJSObject({});
      expect(obj.toString()).toBe("#<js-object>");
    });
  });

  describe("Identity Preservation (roundtrip)", () => {
    it("preserves object identity through roundtrip", () => {
      const original = { a: 1 };
      const wrapped = fromJS(original);
      // @ts-expect-error fromJS returns `FromJSResult` (wider than `SchemeValue`); toJS expects
      // SchemeValue. The runtime value IS a SchemeValue (AJSObject) — the mismatch is in the union.
      const unwrapped = toJS(wrapped);
      expect(unwrapped).toBe(original);
    });

    // INVARIANT: a borrowed function crosses in as a callable, not the same fn object
    // (a genuine marshal wrapper is required to cross args/result at call time) — see
    // crossing.law.test.ts's "function (borrowed)" row for the full asymmetric-round-trip law.
    it("a borrowed function crosses IN as a callable (ARosettaProcedure) — not a #void, not identity-preserving", () => {
      expect(fromJS(() => 42)).toBeInstanceOf(ARosettaProcedure);
    });

    it("preserves array identity through the borrow (.source + toJS round-trip)", () => {
      const original = [1, 2, 3];
      const wrapped = fromJS(original);
      expect((wrapped as AJSArray).source).toBe(original);
      // @ts-expect-error fromJS returns `FromJSResult` (wider than `SchemeValue`); toJS expects
      // SchemeValue. The runtime value IS a SchemeValue (AJSArray) — the mismatch is in the union.
      expect(toJS(wrapped)).toBe(original); // toJS unwraps via the TO_JS protocol → the same array
    });

    it("preserves Uint8Array identity (pass-through)", () => {
      const original = new Uint8Array([1, 2, 3]);
      const wrapped = fromJS(original);
      expect(wrapped).toBe(original);
    });
  });
});
