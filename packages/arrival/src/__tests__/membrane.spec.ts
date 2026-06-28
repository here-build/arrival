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
import { setMembraneWarnings } from "../membrane-warn";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import {
  // Wrapper layer
  TO_JS,
  fromJS,
  toJS,
  isSchemeValue,
  isBytevectorLike,
} from "../membrane";
import { AJSObject } from "../values/primitives/AJSObject.js";
import { AJSArray } from "../values/primitives/AJSArray.js";
import { nil } from "../values/primitives/ANil";
import { theVoid } from "../values/primitives/AVoid.js";
import { ABool } from "../values/primitives/ABool.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { APair } from "../values/primitives/APair.js";

// ============================================================================
// WRAPPER LAYER TESTS
// ============================================================================

describe("Wrapper Layer", () => {
  describe("isSchemeValue", () => {
    it("recognizes nil", () => {
      expect(isSchemeValue(nil)).toBe(true);
    });

    it("recognizes native Scheme types", () => {
      expect(isSchemeValue(new AExact(CONSTANT_CTX, 42n))).toBe(true);
      expect(isSchemeValue(new AInexact(CONSTANT_CTX, 3.14))).toBe(true);
      expect(isSchemeValue(new AString(CONSTANT_CTX, "hello"))).toBe(true);
      expect(isSchemeValue(new ASymbol(CONSTANT_CTX, "foo"))).toBe(true);
      expect(isSchemeValue(new APair(CONSTANT_CTX, 1, 2))).toBe(true);
    });

    it("recognizes wrappers as Scheme values", () => {
      expect(isSchemeValue(new AJSObject(CONSTANT_CTX, {}))).toBe(true);
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

    it("MATERIALIZES primitives to boxed AValues (host-agnostic — never a raw leak)", () => {
      expect(fromJS(true)).toBeInstanceOf(ABool);
      expect(fromJS(42)).toBeInstanceOf(AExact);
      expect(fromJS("hello")).toBeInstanceOf(AString);
      expect(fromJS(42n)).toBeInstanceOf(AExact);
      // a UNIQUE symbol has no portable identity → #void; a REGISTERED one → the keyword :test
      expect(fromJS(Symbol("test"))).toBe(theVoid);
      expect(fromJS(Symbol.for("test"))).toBeInstanceOf(ASymbol);
    });

    it("passes through Scheme values", () => {
      const exact = new AExact(CONSTANT_CTX, 42n);
      expect(fromJS(exact)).toBe(exact);

      const pair = new APair(CONSTANT_CTX, 1, 2);
      expect(fromJS(pair)).toBe(pair);
    });

    it("borrows arrays as a vector (AJSArray) keeping source identity", () => {
      const arr = [1, 2, 3];
      const wrapped = fromJS(arr);
      expect(wrapped).toBeInstanceOf(AJSArray);
      expect((wrapped as AJSArray).source).toBe(arr); // borrow keeps the source by identity
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

    it("materializes a borrowed function to #void (not callable — not a portable value)", () => {
      expect(fromJS(() => 42)).toBe(theVoid);
    });

    it("warns when a non-portable value materializes to #void; setMembraneWarnings(false) silences it", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        fromJS(() => 42); // a function
        fromJS(undefined); // undefined
        fromJS(Symbol("x")); // a unique symbol
        expect(spy).toHaveBeenCalledTimes(3);
        spy.mockClear();
        setMembraneWarnings(false);
        fromJS(() => 42);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        setMembraneWarnings(true);
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

    it("prevents double-wrapping", () => {
      const obj = { a: 1 };
      const wrapped = fromJS(obj);
      const doubleWrapped = fromJS(wrapped);
      expect(doubleWrapped).toBe(wrapped);
    });
  });

  describe("toJS", () => {
    it("converts nil to null", () => {
      expect(toJS(nil)).toBe(null);
    });

    it("unwraps SchemeJSObject", () => {
      const obj = { a: 1 };
      const wrapped = new AJSObject(CONSTANT_CTX, obj);
      expect(toJS(wrapped)).toBe(obj);
    });

    it("converts SchemeString to string", () => {
      expect(toJS(new AString(CONSTANT_CTX, "hello"))).toBe("hello");
    });

    it("converts SchemeExact to number (safe integers)", () => {
      // SchemeExact.valueOf() returns number for safe integers
      expect(toJS(new AExact(CONSTANT_CTX, 42n))).toBe(42);
    });

    it("converts SchemeInexact to number", () => {
      expect(toJS(new AInexact(CONSTANT_CTX, 3.14))).toBe(3.14);
    });

    it("passes through primitives", () => {
      expect(toJS(42)).toBe(42);
      expect(toJS("hello")).toBe("hello");
      expect(toJS(true)).toBe(true);
    });

    it("keeps SchemeSymbol as-is", () => {
      const sym = new ASymbol(CONSTANT_CTX, "foo");
      expect(toJS(sym)).toBe(sym);
    });

    it("keeps Pair as-is", () => {
      const pair = new APair(CONSTANT_CTX, 1, 2);
      expect(toJS(pair)).toBe(pair);
    });
  });

  describe("SchemeJSObject", () => {
    it("has TO_JS symbol", () => {
      const obj = new AJSObject(CONSTANT_CTX, {});
      expect(TO_JS in obj).toBe(true);
      expect(obj[TO_JS]()).toEqual({});
    });

    it("gets properties with lazy wrapping", () => {
      const inner = { b: 2 };
      const obj = new AJSObject(CONSTANT_CTX, { a: 1, inner });

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

    it("rejects writes — the membrane is read-only (pure-dataflow sandbox)", () => {
      const source: any = { a: 1 };
      const obj = new AJSObject(CONSTANT_CTX, source);
      expect(() => obj.set("a", 42)).toThrow(/writes are banned/);
      expect(source.a).toBe(1); // nothing crossed the boundary
      expect(() => obj.delete("a")).toThrow(/mutations are banned/);
      expect(source.a).toBe(1);
    });

    it("materializes a function-valued field to #void (visible, not callable), allows getter reads", () => {
      const source = {
        data: 7,
        get computed() {
          return 99;
        },
        method() {
          return "danger";
        },
      };
      const obj = new AJSObject(CONSTANT_CTX, source);
      expect((obj.get("data") as { valueOf(): unknown }).valueOf()).toBe(7); // data read (boxed)
      expect((obj.get("computed") as { valueOf(): unknown }).valueOf()).toBe(99); // getter invoked → value
      expect(obj.get("method")).toBe(theVoid); // method → #void + warn (was invisible nil; now visible, still uncallable)
    });

    it("checks property existence (own properties only)", () => {
      const obj = new AJSObject(CONSTANT_CTX, { a: 1 });
      expect(obj.has("a")).toBe(true);
      expect(obj.has("b")).toBe(false);
    });

    it("blocks inherited properties from Object.prototype", () => {
      const obj = new AJSObject(CONSTANT_CTX, { a: 1 });
      // These are inherited from Object.prototype - blocked by sandbox
      expect(obj.has("toString")).toBe(false);
      expect(obj.has("hasOwnProperty")).toBe(false);
      expect(obj.has("constructor")).toBe(false);
    });

    it("gets keys", () => {
      const obj = new AJSObject(CONSTANT_CTX, { a: 1, b: 2 });
      expect(obj.keys()).toEqual(["a", "b"]);
    });

    it("has toString", () => {
      const obj = new AJSObject(CONSTANT_CTX, {});
      expect(obj.toString()).toBe("#<js-object>");
    });
  });

  describe("Identity Preservation (roundtrip)", () => {
    it("preserves object identity through roundtrip", () => {
      const original = { a: 1 };
      const wrapped = fromJS(original);
      const unwrapped = toJS(wrapped);
      expect(unwrapped).toBe(original);
    });

    it("does NOT round-trip a borrowed function — it materializes to #void (retired interop)", () => {
      expect(fromJS(() => 42)).toBe(theVoid);
    });

    it("preserves array identity through the borrow (.source + toJS round-trip)", () => {
      const original = [1, 2, 3];
      const wrapped = fromJS(original);
      expect((wrapped as AJSArray).source).toBe(original);
      expect(toJS(wrapped)).toBe(original); // toJS unwraps via the TO_JS protocol → the same array
    });

    it("preserves Uint8Array identity (pass-through)", () => {
      const original = new Uint8Array([1, 2, 3]);
      const wrapped = fromJS(original);
      expect(wrapped).toBe(original);
    });
  });
});
