/**
 * Interop Member-Access Policy
 *
 * The read policy of the polyglot membrane (`membrane.readMember` wraps `accessMember`):
 * when Scheme reads a member of any value via `@` / `:key`, expose OWN DATA MEMBERS
 * only — never the implementation substrate's prototype machinery (`constructor`,
 * `__proto__`, built-in prototype methods, well-known symbols). This is arrival's
 * `InteropLibrary.readMember` contract, not a security fence around a guest: a foreign
 * object exposes its members, not its language's internals (Graal: JS can't reach
 * Java's `getClass()`). Arrival's own value-types opt in via `@arrival.private` so
 * `(@ a-string :__string__)` cannot reach their internals.
 *
 * "Boundary" here is the membrane sense — the prototype where the member walk STOPS —
 * not a sandbox. See docs/sandbox-security-model.md for the original design rationale.
 *
 * TWO CONCEPTS live here, deliberately co-located because the CHECKER reads both:
 * 1. THE READ POLICY — accessMember/accessHas/accessKeys + the boundary walk +
 *    blocklists. After the tagless member-access rework, its mouths are exactly TWO —
 *    the borrowed-value terms `AJSObject` and `AJSArray` (their own `get/has/keys` over
 *    `source`). The membrane's `readMember` face no longer calls the policy directly
 *    (it dispatches to the value's `arrival/tagless-final/get|has|keys` term), and
 *    member-walk (the dotted-path side-door) was deleted with V's dotted-path ruling.
 *    ENDGAME (noted, not executed): with only two callers, both borrowed-value classes,
 *    the policy could inline INTO those classes entirely — interop-access dissolving the
 *    way bridge.ts did. Held: the blocklist/boundary-walk is genuinely shared logic and
 *    a shared module is the honest home until a third pressure decides the cut.
 * 2. THE PRIVACY BRAND — INTEROP_BOUNDARY + markInteropBoundary/@arrival.private:
 *    the opt-in for HOST classes (arrival-chain re-exports it). Arrival's own value
 *    family no longer stamps per-class: the family rule inside `isInteropBoundary`
 *    (own `[CLASS]` brand on the constructor = boundary) covers every primitive.
 *
 * Lineage: GraalVM Truffle InteropLibrary (Würthinger et al. 2013/2017);
 * object-capability membrane (Miller, "Robust Composition", 2006).
 */

// Installs the global `Error.invariant`/`TypeError.invariant` assertion helper
// used throughout this module (side-effect import).
import "@here.build/error-invariant";

import { InteropAccessError } from "../errors.js";
// The arrival value-family brand (a plain string key, P7 taxonomy) — used by the
// family rule in `isInteropBoundary`: any class carrying an OWN `[CLASS]` static is
// an arrival value class, hence a boundary. well-known-symbols.ts is a constants
// leaf (zero imports), so this stays cycle-free.
import { CLASS } from "../well-known-symbols.js";

// ============================================================================
// Interop Boundary Marker
// ============================================================================

/**
 * Symbol used to mark classes/prototypes as interop boundaries.
 * Any prototype with this symbol (set to true) will block inherited property access.
 *
 * Usage:
 * ```typescript
 * class SecureAPI {
 *   static [INTEROP_BOUNDARY] = true;
 *   // Methods here won't be accessible via prototype chain from Scheme
 * }
 * ```
 */
// Module-local (NOT Symbol.for): a registry-global symbol is forgeable from
// sandbox via `Symbol.for("scheme:interop-boundary")`, letting hostile code stamp
// its own boundary markers or strip ours. A module-private Symbol is unreachable
// from outside this module's closure.
export const INTEROP_BOUNDARY = Symbol("scheme:interop-boundary");

// ============================================================================
// Interop Access Error
// ============================================================================

// InteropAccessError is defined in errors.ts (the single error home) and
// re-exported here: it is the error these access primitives THROW, so a consumer
// importing `accessMember` can import the error it catches from the same module
// (mirrors membrane.ts, the other thrower of this error).
export { InteropAccessError } from "../errors.js";

// ============================================================================
// Built-in Boundaries
// ============================================================================

/**
 * Built-in prototypes that are ALWAYS interop boundaries.
 * These are the standard JavaScript built-ins that Scheme code should never access.
 */
const BUILTIN_BOUNDARY_PROTOTYPES: Set<object | null> = new Set([
  Object.prototype,
  Array.prototype,
  Function.prototype,
  String.prototype,
  Number.prototype,
  Boolean.prototype,
  Symbol.prototype,
  RegExp.prototype,
  Date.prototype,
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
  WeakRef.prototype,
  FinalizationRegistry.prototype,
  Promise.prototype,
  Error.prototype,
  // TypedArrays
  Int8Array.prototype,
  Uint8Array.prototype,
  Uint8ClampedArray.prototype,
  Int16Array.prototype,
  Uint16Array.prototype,
  Int32Array.prototype,
  Uint32Array.prototype,
  Float32Array.prototype,
  Float64Array.prototype,
  BigInt64Array.prototype,
  BigUint64Array.prototype,
  ArrayBuffer.prototype,
  // SharedArrayBuffer exists only in crossOriginIsolated scopes (plain
  // browser workers hide it entirely) — police it where it can exist.
  ...(typeof SharedArrayBuffer === "undefined" ? [] : [SharedArrayBuffer.prototype]),
  DataView.prototype,
  // Generator/AsyncGenerator function prototypes
  Object.getPrototypeOf(function* () {}).prototype, // GeneratorFunction.prototype
  Object.getPrototypeOf(async function* () {}).prototype, // AsyncGeneratorFunction.prototype
]);

/**
 * Known dangerous property names that should always be blocked,
 * regardless of where they're defined.
 */
const BLOCKED_PROPERTY_NAMES: Set<string> = new Set([
  // Prototype manipulation
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  // Constructor access (can create new objects outside the membrane)
  "constructor",
  // Prototype access
  "prototype",
]);

/**
 * Well-known Symbols that should be blocked from sandbox access.
 * These symbols trigger JS runtime behaviors (type coercion, iteration,
 * instance checks) that could execute arbitrary code or leak internal state.
 */
const BLOCKED_WELL_KNOWN_SYMBOLS: Set<symbol> = new Set([
  Symbol.toPrimitive,
  Symbol.hasInstance,
  Symbol.species,
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.toStringTag,
  Symbol.unscopables,
  Symbol.isConcatSpreadable,
]);

// ============================================================================
// Boundary Cache
// ============================================================================

/**
 * Cache for prototype boundary status.
 * WeakMap ensures we don't prevent GC of prototypes.
 */
const boundaryCache = new WeakMap<object, boolean>();

/**
 * A prototype whose OWN `constructor` is a global (`globalThis[ctor.name] ===
 * ctor`) is a built-in's prototype, hence a boundary — generalizes the explicit
 * BUILTIN_BOUNDARY_PROTOTYPES list so every global (Date, RegExp, Map, the Error
 * subclasses, …) doesn't need enumerating. Identity-checked, not name-checked: a
 * hostile `constructor.name = "Object"` still fails, since `globalThis["Object"]`
 * is the real Object, not the impostor.
 *
 * OWN-constructor is the discriminator: built-in and class prototypes have an
 * own `constructor` (`X.prototype.constructor === X`); an ad-hoc object used as
 * a prototype doesn't — it inherits `Object`, and without this guard would be
 * falsely flagged as a boundary, blocking its own data.
 */
function isGlobalConstructorPrototype(proto: object): boolean {
  // Read via the OWN descriptor: enforces the own-requirement (an ad-hoc
  // prototype inherits `Object` → no own descriptor → undefined) and hardens
  // the read — a hostile own *accessor* `constructor` is never invoked.
  const ctor = Reflect.getOwnPropertyDescriptor(proto, "constructor")?.value;
  if (typeof ctor !== "function" || typeof ctor.name !== "string" || ctor.name.length === 0) return false;
  // Identity, not name: a spoofed `constructor.name` still fails — `globalThis[name]`
  // is the real global, not the impostor.
  return (globalThis as Record<string, unknown>)[ctor.name] === ctor;
}

/**
 * Check if a prototype is a interop boundary.
 * Results are cached for performance.
 */
export function isInteropBoundary(proto: object | null): boolean {
  // null = end of chain, always a boundary.
  if (proto === null) return true;

  const cached = boundaryCache.get(proto);
  if (cached !== undefined) return cached;

  if (BUILTIN_BOUNDARY_PROTOTYPES.has(proto)) {
    boundaryCache.set(proto, true);
    return true;
  }

  // A global constructor's prototype is a boundary — generalizes the explicit
  // list above so any global built-in (incl. unenumerated ones, like the Error
  // subclasses) stops the inheritance walk without being listed.
  if (isGlobalConstructorPrototype(proto)) {
    boundaryCache.set(proto, true);
    return true;
  }

  // ARRIVAL FAMILY RULE: a prototype whose OWN-descriptor constructor carries an
  // OWN `[CLASS]` brand ("arrival/class", the P7 string-key taxonomy) is an arrival
  // value class — always a boundary. Replaces the per-class
  // `static [INTEROP_BOUNDARY] = true` stamp every primitive used to carry (each
  // subclass needed its own stamp because this check is hasOwnProperty-based); one
  // rule here covers the whole family, and the primitives lose the import entirely.
  // Forgery direction is harmless: a borrowed class self-stamping `[CLASS]` only
  // SEALS itself — the same privacy `@arrival.private` grants deliberately. (The F1
  // forgery-guard concern — data keys masquerading as protocol on VALUES — doesn't
  // apply: this reads a constructor during a privacy walk, and the failure mode is
  // more privacy, not less.)
  {
    const ctor = Reflect.getOwnPropertyDescriptor(proto, "constructor")?.value;
    if (
      typeof ctor === "function" &&
      Object.prototype.hasOwnProperty.call(ctor, CLASS)
    ) {
      boundaryCache.set(proto, true);
      return true;
    }
  }

  // Explicit marker on the prototype itself. hasOwnProperty, not `in` — don't
  // inherit boundary status from a parent prototype.
  if (
    Object.prototype.hasOwnProperty.call(proto, INTEROP_BOUNDARY) &&
    (proto as Record<symbol, unknown>)[INTEROP_BOUNDARY] === true
  ) {
    boundaryCache.set(proto, true);
    return true;
  }

  // Class-level marker via `static [INTEROP_BOUNDARY] = true`. Read via the OWN
  // descriptor so a hostile accessor `constructor` is never invoked.
  const ctor = Reflect.getOwnPropertyDescriptor(proto, "constructor")?.value;
  if (ctor && typeof ctor === "function") {
    if (
      Object.prototype.hasOwnProperty.call(ctor, INTEROP_BOUNDARY) &&
      (ctor as unknown as Record<symbol, unknown>)[INTEROP_BOUNDARY] === true
    ) {
      boundaryCache.set(proto, true);
      return true;
    }
  }

  boundaryCache.set(proto, false);
  return false;
}

/**
 * Mark a class or object as a interop boundary.
 * This prevents Scheme code from accessing inherited properties through it.
 */
export function markInteropBoundary(target: object | Function): void {
  (target as unknown as Record<symbol, unknown>)[INTEROP_BOUNDARY] = true;
  // Invalidate cache — for classes, clear prototype; for plain objects, clear the object itself
  if (typeof target === "function" && target.prototype) {
    boundaryCache.delete(target.prototype);
  } else {
    boundaryCache.delete(target);
  }
}

/**
 * `@arrival.private` — declaratively seal a host class as an interop boundary, so
 * Scheme can't reach its prototype members (`(:field x)`/`(@ x :field)` → nil).
 * Wraps {@link markInteropBoundary}, which uses the MODULE-PRIVATE boundary symbol
 * — the only correct one. Never brand with `Symbol.for("scheme:interop-boundary")`:
 * that registry-global symbol is different from the one the boundary check reads,
 * and is forgeable from scheme code — it silently fails to seal anything.
 *
 * Usable as a TC39/legacy class decorator or a plain call:
 *
 *   @arrival.private class Ip { #bytes; get bytes() { … } }   // decorator
 *   arrival.private(Ip)                                        // equivalent call
 */
export function markInteropPrivate<T extends Function>(target: T, _context?: unknown): T {
  markInteropBoundary(target);
  return target;
}

/** The `arrival` namespace surface for the decorator ergonomic — `@arrival.private`. */
export const arrival = { private: markInteropPrivate };

// ============================================================================
// Sentinel Value
// ============================================================================

/**
 * Sentinel value indicating a property was not found.
 * This is distinct from `undefined` (which could be a valid property value).
 */
// Module-local (NOT Symbol.for): the sentinel must be unforgeable. In the global
// registry, sandbox code could mint the same symbol and inject it as a "real"
// property value to spoof the NOT_FOUND signal.
export const NOT_FOUND = Symbol("scheme:not-found");

type AccessResult<T> = T | typeof NOT_FOUND;

// ============================================================================
// Core Access Functions
// ============================================================================

/**
 * Check if a property name is unconditionally blocked.
 */
function isBlockedPropertyName(key: string | symbol): boolean {
  if (typeof key === "symbol") return BLOCKED_WELL_KNOWN_SYMBOLS.has(key);
  return BLOCKED_PROPERTY_NAMES.has(key);
}

/**
 * Member access — the core interop-read primitive.
 *
 * Access rules:
 * 1. Blocked property names (constructor, __proto__, etc.) always throw
 * 2. Own properties are always accessible
 * 3. Missing properties return NOT_FOUND
 * 4. Inherited properties are checked against interop boundaries
 *    - If found before hitting a boundary: accessible
 *    - If boundary is hit first: throws InteropAccessError
 *
 * @param data - The object to access
 * @param key - The property key
 * @returns The property value, or NOT_FOUND if not present
 * @throws InteropAccessError if access would cross a boundary
 */
export function accessMember(data: unknown, key: string | symbol): AccessResult<unknown> {
  if (data === null || data === undefined) {
    return NOT_FOUND;
  }

  const keyStr = typeof key === "symbol" ? key : String(key);

  if (isBlockedPropertyName(keyStr)) {
    throw new InteropAccessError(
      `Cannot access '${String(keyStr)}' - blocked for security`,
      keyStr,
      "blocked-property",
    );
  }

  // Box primitives to check properties.
  const obj = Object(data);

  // Fast path: own property.
  if (Object.prototype.hasOwnProperty.call(obj, keyStr)) {
    return Reflect.get(obj, keyStr);
  }

  if (!Reflect.has(obj, keyStr)) {
    return NOT_FOUND;
  }

  // Property is inherited — trace the prototype chain to find it.
  let proto = Reflect.getPrototypeOf(obj);

  while (proto !== null) {
    // Hit an interop boundary before finding the property?
    if (isInteropBoundary(proto)) {
      throw new InteropAccessError(
        `Cannot access inherited property '${String(keyStr)}' - ` +
          `blocked at interop boundary (${proto.constructor?.name || "Object"})`,
        keyStr,
        proto.constructor?.name || "Object",
      );
    }

    if (Object.prototype.hasOwnProperty.call(proto, keyStr)) {
      return Reflect.get(obj, keyStr);
    }

    proto = Reflect.getPrototypeOf(proto);
  }

  // Shouldn't reach here (we checked `in` above), but be safe.
  return NOT_FOUND;
}

/**
 * Interop member existence check.
 * Only returns true for:
 * - Own properties
 * - Inherited properties from non-boundary prototypes
 *
 * Returns false (not throws) for blocked properties.
 */
export function accessHas(data: unknown, key: string | symbol): boolean {
  if (data === null || data === undefined) {
    return false;
  }

  const keyStr = typeof key === "symbol" ? key : String(key);

  // Blocked properties don't "exist" from the interop perspective.
  if (isBlockedPropertyName(keyStr)) {
    return false;
  }

  const obj = Object(data);

  if (Object.prototype.hasOwnProperty.call(obj, keyStr)) {
    return true;
  }

  if (!Reflect.has(obj, keyStr)) {
    return false;
  }

  // Property is inherited — check if it's accessible.
  let proto = Reflect.getPrototypeOf(obj);

  while (proto !== null) {
    // Hit boundary? Property doesn't "exist" from the interop perspective.
    if (isInteropBoundary(proto)) {
      return false;
    }

    if (Object.prototype.hasOwnProperty.call(proto, keyStr)) {
      return true;
    }

    proto = Reflect.getPrototypeOf(proto);
  }

  return false;
}

/**
 * Interop member (own-key) enumeration.
 * Only returns own enumerable keys, never inherited ones.
 */
export function accessKeys(data: unknown): string[] {
  if (data === null || data === undefined) {
    return [];
  }

  return Object.keys(Object(data));
}


