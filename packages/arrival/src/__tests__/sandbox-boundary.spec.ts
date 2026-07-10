import { describe, it, expect } from "vitest";
import {
  INTEROP_BOUNDARY,
  InteropAccessError,
  accessMember,
  accessHas,
  accessKeys,
  NOT_FOUND,
  markInteropBoundary,
  isInteropBoundary,
} from "../interop-access.js";

describe("Sandbox Boundary", () => {
  describe("sandboxedAccess", () => {
    // INVARIANT: accessMember returns own properties
    it("returns own properties", () => {
      const obj = { name: "Alice", age: 30 };
      expect(accessMember(obj, "name")).toBe("Alice");
      expect(accessMember(obj, "age")).toBe(30);
    });

    // INVARIANT: accessMember returns the NOT_FOUND sentinel for missing properties (pins implementation, not behavior)
    it("returns NOT_FOUND for missing properties", () => {
      const obj = { name: "Alice" };
      expect(accessMember(obj, "missing")).toBe(NOT_FOUND);
    });

    // INVARIANT: accessMember returns NOT_FOUND for null/undefined targets
    it("returns NOT_FOUND for null/undefined", () => {
      expect(accessMember(null, "key")).toBe(NOT_FOUND);
      expect(accessMember(undefined, "key")).toBe(NOT_FOUND);
    });

    // INVARIANT: accessMember throws InteropAccessError for blocked property names (constructor/__proto__/prototype)
    it("throws SandboxViolationError for blocked property names", () => {
      const obj = { name: "Alice" };
      expect(() => accessMember(obj, "constructor")).toThrow(InteropAccessError);
      expect(() => accessMember(obj, "__proto__")).toThrow(InteropAccessError);
      expect(() => accessMember(obj, "prototype")).toThrow(InteropAccessError);
    });

    // INVARIANT: accessMember throws InteropAccessError for Object.prototype-inherited properties (toString/hasOwnProperty/valueOf)
    it("throws for inherited properties from Object.prototype", () => {
      const obj = { name: "Alice" };
      expect(() => accessMember(obj, "toString")).toThrow(InteropAccessError);
      expect(() => accessMember(obj, "hasOwnProperty")).toThrow(InteropAccessError);
      expect(() => accessMember(obj, "valueOf")).toThrow(InteropAccessError);
    });

    // INVARIANT: accessMember allows inherited properties from non-boundary prototypes
    it("allows inherited properties from non-boundary prototypes", () => {
      class MyClass {
        inheritedMethod() {
          return "inherited";
        }
      }
      const instance = new MyClass();
      (instance as { ownProp?: string }).ownProp = "own";

      expect(accessMember(instance, "ownProp")).toBe("own");
      expect(accessMember(instance, "inheritedMethod")).toBeInstanceOf(Function);
    });

    // INVARIANT: accessMember blocks a method inherited from a boundary-marked ancestor class
    // while own properties and non-boundary-inherited methods on a subclass stay accessible
    it("blocks when custom class is marked as boundary", () => {
      class SecureAPI {
        static [INTEROP_BOUNDARY] = true;
        secretMethod() {
          return "secret";
        }
      }

      class UserClass extends SecureAPI {
        publicMethod() {
          return "public";
        }
      }

      const instance = new UserClass();
      (instance as { ownProp?: string }).ownProp = "own";

      // Own property - accessible
      expect(accessMember(instance, "ownProp")).toBe("own");

      // Inherited from UserClass (not a boundary) - accessible
      expect(accessMember(instance, "publicMethod")).toBeInstanceOf(Function);

      // Inherited from SecureAPI (boundary) - blocked
      expect(() => accessMember(instance, "secretMethod")).toThrow(InteropAccessError);
    });
  });

  describe("sandboxedHas", () => {
    // INVARIANT: accessHas returns true for own properties
    it("returns true for own properties", () => {
      const obj = { name: "Alice" };
      expect(accessHas(obj, "name")).toBe(true);
    });

    // INVARIANT: accessHas returns false for missing properties
    it("returns false for missing properties", () => {
      const obj = { name: "Alice" };
      expect(accessHas(obj, "missing")).toBe(false);
    });

    // INVARIANT: accessHas returns false (not throw) for blocked properties
    it("returns false for blocked properties (doesn't throw)", () => {
      const obj = { name: "Alice" };
      expect(accessHas(obj, "constructor")).toBe(false);
      expect(accessHas(obj, "__proto__")).toBe(false);
    });

    // INVARIANT: accessHas returns false for Object.prototype-inherited properties
    it("returns false for Object.prototype inherited properties", () => {
      const obj = { name: "Alice" };
      expect(accessHas(obj, "toString")).toBe(false);
      expect(accessHas(obj, "hasOwnProperty")).toBe(false);
    });

    // INVARIANT: accessHas returns true for non-boundary inherited properties
    it("returns true for non-boundary inherited properties", () => {
      class MyClass {
        method() {}
      }
      const instance = new MyClass();
      expect(accessHas(instance, "method")).toBe(true);
    });
  });

  describe("sandboxedKeys", () => {
    // INVARIANT: accessKeys returns only own enumerable keys
    it("returns own enumerable keys", () => {
      const obj = { a: 1, b: 2, c: 3 };
      expect(accessKeys(obj)).toEqual(["a", "b", "c"]);
    });

    // INVARIANT: accessKeys never includes inherited keys
    it("never includes inherited keys", () => {
      class MyClass {
        method() {}
      }
      const instance = new MyClass();
      (instance as { own?: string }).own = "value";

      const keys = accessKeys(instance);
      expect(keys).toEqual(["own"]);
      expect(keys).not.toContain("method");
      expect(keys).not.toContain("toString");
    });

    // INVARIANT: accessKeys returns an empty array for null/undefined
    it("returns empty array for null/undefined", () => {
      expect(accessKeys(null)).toEqual([]);
      expect(accessKeys(undefined)).toEqual([]);
    });
  });

  // `accessSet` (the interop WRITE face) was deleted 2026-07-10 — a mutation
  // face violates total immutability and had zero production callers.
  // DEAD (atlas invariants, no longer testable — the API itself is gone):
  //   - accessSet sets own properties
  //   - accessSet shadows an inherited property by creating an own property instead
  //   - accessSet throws InteropAccessError for blocked property names
  //   - accessSet throws TypeError for null/undefined targets


  describe("markAsSandboxBoundary", () => {
    // INVARIANT: markInteropBoundary marks a class's prototype as a boundary
    it("marks a class as a boundary", () => {
      class TestClass {}
      markInteropBoundary(TestClass);
      expect(isInteropBoundary(TestClass.prototype)).toBe(true);
    });

    // INVARIANT: markInteropBoundary marks a plain object as a boundary
    it("marks an object as a boundary", () => {
      const obj = {};
      markInteropBoundary(obj);
      expect((obj as Record<symbol, unknown>)[INTEROP_BOUNDARY]).toBe(true);
    });
  });

  // INVARIANT: Object.prototype/Array.prototype/Function.prototype are boundaries;
  // null is treated as a boundary; a custom class prototype is not a boundary by default;
  // a class marked with INTEROP_BOUNDARY is recognized as a boundary
  describe("isSandboxBoundary", () => {
    it("returns true for Object.prototype", () => {
      expect(isInteropBoundary(Object.prototype)).toBe(true);
    });

    it("returns true for Array.prototype", () => {
      expect(isInteropBoundary(Array.prototype)).toBe(true);
    });

    it("returns true for Function.prototype", () => {
      expect(isInteropBoundary(Function.prototype)).toBe(true);
    });

    it("returns true for null", () => {
      expect(isInteropBoundary(null)).toBe(true);
    });

    it("returns false for custom class prototype", () => {
      class MyClass {}
      expect(isInteropBoundary(MyClass.prototype)).toBe(false);
    });

    it("returns true for marked class prototype", () => {
      class SecureClass {
        static [INTEROP_BOUNDARY] = true;
      }
      expect(isInteropBoundary(SecureClass.prototype)).toBe(true);
    });
  });

  describe("Array access", () => {
    // INVARIANT: index access and .length on arrays are allowed
    it("allows index access on arrays", () => {
      const arr = ["a", "b", "c"];
      expect(accessMember(arr, "0")).toBe("a");
      expect(accessMember(arr, "1")).toBe("b");
      expect(accessMember(arr, "length")).toBe(3);
    });

    // INVARIANT: Array.prototype methods (push/map/filter) are blocked
    it("blocks Array.prototype methods", () => {
      const arr = ["a", "b", "c"];
      expect(() => accessMember(arr, "push")).toThrow(InteropAccessError);
      expect(() => accessMember(arr, "map")).toThrow(InteropAccessError);
      expect(() => accessMember(arr, "filter")).toThrow(InteropAccessError);
    });
  });

  describe("Real-world attack vectors", () => {
    // INVARIANT: constructor.constructor (Function-constructor) escape is blocked
    it("blocks constructor.constructor (Function constructor) escape", () => {
      const obj = {};
      expect(() => accessMember(obj, "constructor")).toThrow(InteropAccessError);
    });

    // INVARIANT: __proto__ manipulation is blocked
    it("blocks __proto__ manipulation", () => {
      const obj = {};
      expect(() => accessMember(obj, "__proto__")).toThrow(InteropAccessError);
    });

    // INVARIANT: prototype property access on a function is blocked
    it("blocks prototype property access", () => {
      const fn = function () {};
      expect(() => accessMember(fn, "prototype")).toThrow(InteropAccessError);
    });
  });

  describe("Well-known Symbol blocking", () => {
    // INVARIANT: well-known symbols (toPrimitive/hasInstance/iterator/asyncIterator/species) are blocked from accessMember
    it("blocks Symbol.toPrimitive access", () => {
      const obj = { [Symbol.toPrimitive]: () => 42 };
      expect(() => accessMember(obj, Symbol.toPrimitive)).toThrow(InteropAccessError);
    });

    it("blocks Symbol.hasInstance access", () => {
      const obj = { [Symbol.hasInstance]: () => true };
      expect(() => accessMember(obj, Symbol.hasInstance)).toThrow(InteropAccessError);
    });

    it("blocks Symbol.iterator access", () => {
      const obj = { [Symbol.iterator]: function* () { yield 1; } };
      expect(() => accessMember(obj, Symbol.iterator)).toThrow(InteropAccessError);
    });

    it("blocks Symbol.asyncIterator access", () => {
      const obj = { [Symbol.asyncIterator]: async function* () { yield 1; } };
      expect(() => accessMember(obj, Symbol.asyncIterator)).toThrow(InteropAccessError);
    });

    it("blocks Symbol.species access", () => {
      const obj = { [Symbol.species]: Array };
      expect(() => accessMember(obj, Symbol.species)).toThrow(InteropAccessError);
    });

    // INVARIANT: non-well-known (user-created) symbols are allowed through accessMember
    it("allows non-well-known symbols (user symbols)", () => {
      const userSymbol = Symbol("user-data");
      const obj = { [userSymbol]: "safe value" };
      expect(accessMember(obj, userSymbol)).toBe("safe value");
    });

    // INVARIANT: accessHas returns false for blocked well-known symbols
    it("sandboxedHas returns false for blocked symbols", () => {
      const obj = { [Symbol.toPrimitive]: () => 42 };
      expect(accessHas(obj, Symbol.toPrimitive)).toBe(false);
    });

    // DEAD (atlas invariant, no longer testable — accessSet deleted 2026-07-10):
    //   accessSet blocks well-known symbols

  });

  // INVARIANT: WeakRef.prototype/FinalizationRegistry.prototype/SharedArrayBuffer.prototype are
  // boundaries; GeneratorFunction.prototype and AsyncGeneratorFunction.prototype are boundaries
  describe("Additional boundary prototypes", () => {
    it("blocks WeakRef.prototype methods", () => {
      expect(isInteropBoundary(WeakRef.prototype)).toBe(true);
    });

    it("blocks FinalizationRegistry.prototype methods", () => {
      expect(isInteropBoundary(FinalizationRegistry.prototype)).toBe(true);
    });

    it("blocks SharedArrayBuffer.prototype methods", () => {
      expect(isInteropBoundary(SharedArrayBuffer.prototype)).toBe(true);
    });

    it("blocks GeneratorFunction.prototype", () => {
      const genFn = function* () {};
      const genProto = Object.getPrototypeOf(genFn).prototype;
      expect(isInteropBoundary(genProto)).toBe(true);
    });

    it("blocks AsyncGeneratorFunction.prototype", () => {
      const asyncGenFn = async function* () {};
      const asyncGenProto = Object.getPrototypeOf(asyncGenFn).prototype;
      expect(isInteropBoundary(asyncGenProto)).toBe(true);
    });
  });

  describe("Cache invalidation", () => {
    // INVARIANT: markInteropBoundary invalidates the boundary cache for a plain-object prototype —
    // previously-accessible inherited methods become blocked immediately, without affecting own
    // properties (pins implementation, not behavior)
    it("markAsSandboxBoundary invalidates cache for plain objects", () => {
      const proto = { method() { return "test"; } };
      const child = Object.create(proto);
      child.ownProp = "own";

      // First access — proto is not a boundary, method is accessible
      expect(isInteropBoundary(proto)).toBe(false);
      expect(accessMember(child, "method")).toBeInstanceOf(Function);

      // Mark proto as boundary
      markInteropBoundary(proto);

      // Now proto should be a boundary — method should be blocked
      expect(isInteropBoundary(proto)).toBe(true);
      expect(() => accessMember(child, "method")).toThrow(InteropAccessError);

      // Own property still accessible
      expect(accessMember(child, "ownProp")).toBe("own");
    });
  });

  describe("isSandboxBoundary — global-constructor rule", () => {
    // INVARIANT: a global constructor's prototype not explicitly enumerated (TypeError.prototype)
    // is still flagged as a boundary via the globalThis[name]===ctor rule (pins implementation, not behavior)
    it("flags a global ctor's prototype that is NOT in the explicit list (TypeError)", () => {
      // TypeError is global, but TypeError.prototype is not enumerated in
      // BUILTIN_BOUNDARY_PROTOTYPES — the globalThis[name]===ctor rule covers it
      // (and every other global built-in we don't list, e.g. the Error subclasses).
      expect(isInteropBoundary(TypeError.prototype)).toBe(true);
    });

    // INVARIANT: a local (non-global) class prototype is not flagged; its own methods stay reachable
    it("does NOT flag a local (non-global) class prototype; its own method stays reachable", () => {
      class Widget {
        greet() {
          return "hi";
        }
      }
      expect(isInteropBoundary(Widget.prototype)).toBe(false);
      expect(accessMember(new Widget(), "greet")).toBeInstanceOf(Function);
    });

    // INVARIANT: an ad-hoc object used as a prototype is not falsely flagged as a boundary
    it("does NOT falsely flag an ad-hoc object used as a prototype (own data stays reachable)", () => {
      // It inherits `constructor` from Object — the own-constructor guard keeps it
      // OFF the boundary set, so a child's access to its own data is not blocked.
      const proto = { helper: 1 };
      expect(isInteropBoundary(proto)).toBe(false);
      expect(accessMember(Object.create(proto), "helper")).toBe(1);
    });

    // INVARIANT: boundary detection is identity-checked — spoofing constructor.name to "Object" does not fool it
    it("is identity-checked: spoofing constructor.name = 'Object' is not a boundary", () => {
      // ctor.name === "Object" but globalThis.Object !== this impostor → not flagged.
      const impostor = { constructor: function Object() {} };
      expect(isInteropBoundary(impostor)).toBe(false);
    });

    // INVARIANT: boundary detection reads the own "constructor" descriptor's .value rather than
    // invoking [[Get]], so a hostile accessor never fires and never fools the check (pins implementation, not behavior)
    it("never invokes a hostile own accessor `constructor` (descriptor read, not [[Get]])", () => {
      let fired = false;
      const proto = {};
      Object.defineProperty(proto, "constructor", {
        get() {
          fired = true;
          return Object; // tries to masquerade as the real Object
        },
        configurable: true,
      });
      // The boundary read uses the own DESCRIPTOR's .value (undefined for an
      // accessor), so it neither fires the getter nor is fooled into a boundary.
      expect(isInteropBoundary(proto)).toBe(false);
      expect(fired).toBe(false);
    });
  });
});
