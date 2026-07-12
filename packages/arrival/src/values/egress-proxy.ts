/**
 * R9 lazy egress proxies — the container exit of the membrane.
 *
 * Design: RULINGS.md R9. A native
 * container (AVector / APair / ADict) exits `toJS` as a lazy, observationally-plain-JS
 * proxy instead of an eager deep copy: elements materialize through their own
 * `arrival/toJS` on first read, and a WeakMap tracker guarantees the same box always
 * egresses as the same proxy (aliasing law — a tail/element shared by two containers is
 * ONE object on the JS side, reference-equality observable).
 *
 * Mechanics (each locked in the design doc):
 * - The target is a REAL `[]` / `{}` doubling as the materialization cache: every trap
 *   answer is backed by an ordinary configurable+writable target property, so all Proxy
 *   invariants are trivially satisfiable, `Array.isArray(proxy)` is true for the array
 *   shape, and a second read is a plain property hit.
 * - The proxy registers in the WeakMap BEFORE any element materializes, so a cyclic
 *   reach-back (a container that — via any depth — contains itself) resolves to the
 *   already-registered proxy structurally, with no recursion. (JSON.stringify on such a
 *   value then fails with the same TypeError a genuinely cyclic plain object produces —
 *   observationally plain JS, exactly.)
 * - The write family (`set` / `deleteProperty` / `defineProperty` / `setPrototypeOf`)
 *   throws the same teaching door family as AJSObject's read-only membrane: the egressed
 *   value is a projection of an immutable Scheme value, not a mailbox back into it.
 * - Scalars are never routed here — they unwrap directly at their own `arrival/toJS`.
 * - Provenance reach-back (R9's "future bonus": deep non-primitive reads re-entering the
 *   boxed world with lineage intact) is deliberately NOT scaffolded in this iteration.
 *
 * Leaf module: imports only the AValue base (for the tracker key type and the
 * materialization dispatch) and the interop error — never membrane/env/bridge.
 */
import { AValue } from "./primitives/AValue.js";
import type { ACallable } from "./primitives/ACallable.js";
import { is_callable_value } from "./value-guards.js";
import { InteropAccessError } from "../errors.js";

/** Singleton tracker: same box → same proxy, forever. Module-level, mirrors
 *  membrane.ts's `jsToWrapper` (the entry-side twin of this exit-side cache).
 *
 *  Deliberately a plain `WeakMap`, not `DefaultedWeakMap` (@here.build/collections),
 *  unlike `jsToWrapper`'s conversion: `jsToWrapper` dispatches its ONE factory purely
 *  off the key's own shape (`Array.isArray`), so binding it once at construction is
 *  exactly right. Here the "recipe" — `shape` and `reader` — is supplied PER CALL by
 *  `egressContainerProxy`'s three callers (AVector/APair/ADict's own `arrival/toJS`),
 *  not derivable from `box` alone without importing all three concrete container
 *  classes into this deliberately leaf module (see the file header: "imports only the
 *  AValue base... never membrane/env/bridge") — that coupling is exactly what the
 *  leaf-module boundary exists to avoid. A single bound factory can't accept a
 *  per-call reader, so the get-check-set idiom stays. (Ordering is NOT the blocker:
 *  `reader.keys()`/`.read()` never materialize elements during construction — see
 *  `EgressReader`'s doc — so a DefaultedWeakMap-style "set after the factory returns"
 *  would preserve the "register before any element materializes" invariant fine; the
 *  factory-arity mismatch is the actual reason this one stays manual.) */
const egressProxies = new WeakMap<AValue, object>();

/** Shallow read model a container hands to its proxy: `keys()` enumerates the own
 *  string keys (index strings for the array shape), `read(key)` returns the ELEMENT —
 *  usually a box, or a raw FFI-passthrough value (binary/Promise) that never boxed. */
export interface EgressReader {
  keys(): readonly string[];
  read(key: string): unknown;
}

/** Element exit: protocol dispatch — the element's class is the conversion authority;
 *  a raw FFI-passthrough element has no protocol and exits as itself.
 *
 *  A callable element is special-cased BEFORE the generic protocol dispatch: a
 *  callable's own `arrival/toJS` is fallback-display-only (a print string — see
 *  ACallable.ts), because the REAL reverse-membrane host-fn projection needs
 *  `callableToHostFn` (rosetta.ts), which this leaf module cannot import (would cycle
 *  through rosetta → scheme-zod at module-init). `wrapCallable`, supplied by whichever
 *  caller DOES have that machinery (schemeToJsImpl, via each container's `arrival/toJS`),
 *  closes the gap — the same projection a BARE callable argument already gets. Absent
 *  (e.g. a print path with no rosetta context), a nested callable falls back to the
 *  print string exactly as before — byte-identical for every caller that doesn't opt in. */
function materializeElement(element: unknown, wrapCallable?: (value: ACallable) => unknown): unknown {
  if (wrapCallable && is_callable_value(element)) return wrapCallable(element);
  return element instanceof AValue ? element["arrival/toJS"]() : element;
}

/**
 * The payload-tiering tier-state gate seam. This module stays a LEAF (file header
 * above: "never membrane/env/bridge") so this interface is deliberately ABSTRACT — no `PayloadTier`/
 * `EvidenceTier` import from `provenance/store`. The concrete implementation
 * (`provenance/store/tiering.ts`'s `tierGateFromSnapshot`) closes over its own tier
 * state and hands back a value shaped like this.
 *
 * Proxy traps (`get`/`getOwnPropertyDescriptor` below) are SYNCHRONOUS by spec, so a
 * gate can only consult an ALREADY-RESOLVED view of tier state — never awaits.
 */
export interface TierGate {
  /** `true`: tier state allows the real read through to `reader.read(key)` — this is
   *  the ONLY path taken when a gate is omitted entirely, or every backing payload is
   *  still ring-resident (byte-stable pass-through, no behavior change from the
   *  ungated shape). `false`: the key's payload has degraded (evicted to `stub`) —
   *  `stubbedValue(key)` substitutes instead, and `reader.read(key)` is never called. */
  allows(key: string): boolean;
  /** The degraded stand-in for a gated-off key. Never re-enters `reader.read` or
   *  `materializeElement` — placed directly on the target, exactly like the existing
   *  "raw FFI-passthrough" case (this file's header, mechanics bullet 4). */
  stubbedValue(key: string): unknown;
}

function writeDoor(kind: "assign" | "mutate", key: string | symbol | undefined): never {
  const verb =
    kind === "assign"
      ? "Cannot assign to an egressed container — writes are banned in the pure-dataflow sandbox"
      : "Cannot restructure an egressed container — mutations are banned in the pure-dataflow sandbox";
  throw new InteropAccessError(
    `${verb}; the value that crossed toJS is a read-only projection of an immutable Scheme value. Build the changed value on the Scheme side and egress that.`,
    typeof key === "symbol" ? key : String(key ?? "<prototype>"),
    "write-banned",
  );
}

/**
 * Build (or return the already-built) lazy egress proxy for `box`.
 *
 * Identity is guaranteed HERE, at the single chokepoint every container's
 * `arrival/toJS` calls — membrane.toJS needs no separate pre-check because protocol
 * dispatch lands in this cache either way.
 *
 * `gate` (optional, additive): a tier-state gate consulted BEFORE
 * `reader.read(key)` on first materialization of each key. Omitting it (every
 * ungated call site) is EXACTLY the old behavior — `ensure` below takes the
 * `gate === undefined` branch unconditionally, so this is byte-stable for every
 * caller that doesn't opt in. The gate does not replace or duplicate the lazy-
 * materialization seam itself (`reader`/`ensure`/the WeakMap identity cache) — it
 * sits in front of it, deciding per key whether the existing seam runs at all.
 *
 * `wrapCallable` (optional, additive): forwarded to `materializeElement` — see its own
 * doc for why a nested callable element needs it to get the real reverse-membrane
 * projection instead of a print string. Omitting it is byte-stable (today's behavior).
 */
export function egressContainerProxy(
  box: AValue,
  shape: "array" | "object",
  reader: EgressReader,
  gate?: TierGate,
  wrapCallable?: (value: ACallable) => unknown,
): object {
  const cached = egressProxies.get(box);
  if (cached) return cached;

  const names = reader.keys();
  const nameSet = new Set<string>(names);
  const target: Record<PropertyKey, unknown> = shape === "array" ? [] : Object.create(Object.prototype);
  if (Array.isArray(target)) target.length = names.length; // length preset — reads never materialize the spine

  /** Materialize one element onto the target (the cache) if it's ours and not yet there. */
  const ensure = (key: PropertyKey): void => {
    if (typeof key !== "string" || !nameSet.has(key)) return;
    if (Object.prototype.hasOwnProperty.call(target, key)) return;
    target[key] =
      gate === undefined || gate.allows(key)
        ? materializeElement(reader.read(key), wrapCallable)
        : gate.stubbedValue(key);
  };

  const proxy = new Proxy(target, {
    get(t, key, receiver) {
      ensure(key);
      return Reflect.get(t, key, receiver);
    },
    has(t, key) {
      return (typeof key === "string" && nameSet.has(key)) || Reflect.has(t, key);
    },
    ownKeys(t) {
      // Canonical key list: every element key (materialized or not), then whatever else
      // genuinely lives on the target ("length" for the array shape). Reporting a not-yet-
      // materialized key is legal (the target is extensible); gOPD below backs it on demand.
      const extras = Reflect.ownKeys(t).filter((k) => typeof k !== "string" || !nameSet.has(k));
      return [...names, ...extras];
    },
    getOwnPropertyDescriptor(t, key) {
      ensure(key);
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
    set(_t, key) {
      writeDoor("assign", key);
    },
    deleteProperty(_t, key) {
      writeDoor("mutate", key);
    },
    defineProperty(_t, key) {
      writeDoor("mutate", key);
    },
    setPrototypeOf() {
      writeDoor("mutate", undefined);
    },
  });

  egressProxies.set(box, proxy);
  return proxy;
}
