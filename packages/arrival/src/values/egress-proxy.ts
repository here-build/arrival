/**
 * R9 lazy egress proxies — the container exit of the membrane.
 *
 * Design: docs/working-proposals/two-tier-exec-api.md §5 (RULINGS.md R9). A native
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
import { InteropAccessError } from "../interop-access.js";

/** Singleton tracker: same box → same proxy, forever. Module-level, mirrors
 *  membrane.ts's `jsToWrapper` (the entry-side twin of this exit-side cache). */
const egressProxies = new WeakMap<AValue, object>();

/** Shallow read model a container hands to its proxy: `keys()` enumerates the own
 *  string keys (index strings for the array shape), `read(key)` returns the ELEMENT —
 *  usually a box, or a raw FFI-passthrough value (binary/Promise) that never boxed. */
export interface EgressReader {
  keys(): readonly string[];
  read(key: string): unknown;
}

/** Element exit: protocol dispatch — the element's class is the conversion authority
 *  (P7); a raw FFI-passthrough element has no protocol and exits as itself. */
function materializeElement(element: unknown): unknown {
  return element instanceof AValue ? element["arrival/toJS"]() : element;
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
 */
export function egressContainerProxy(box: AValue, shape: "array" | "object", reader: EgressReader): object {
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
    target[key] = materializeElement(reader.read(key));
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
