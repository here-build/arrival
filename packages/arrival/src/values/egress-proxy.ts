/**
 * R9 lazy egress proxies — the container exit of the membrane.
 *
 * Design: RULINGS.md R9 + docs/working-proposals/arrival-egress-membrane-exit.md. A
 * native container (AVector / APair / ADict) exits as a lazy, observationally-plain-JS
 * proxy instead of an eager deep copy: elements materialize on first read, and a
 * tracker guarantees a stable identity per projection — where "projection" is now an
 * explicit law, not one global slot:
 *
 *   • BARE (serialization — `arrival/toJS()`, no options): identity = (box), forever.
 *     One module-level WeakMap, exactly the original R9 behavior. Elements
 *     materialize through their own `arrival/toJS` (a nested callable stringifies —
 *     that IS the serialization contract).
 *   • MEMBRANE (`arrival/toJSMembrane(exit)` — rosetta/exec crossings): identity =
 *     (box, mode, SCOPE). The cache lives on the exporting RegionScope
 *     (`RegionScope.egressProxies`), handed in via `MembraneExit.cache`, so a later
 *     invocation re-egressing the same box mints proxies bound to ITS scope instead
 *     of resurrecting wrappers pinned to a closed (or DETACHED) one. Elements
 *     materialize through `exit.element` — the full recursive membrane crossing.
 *   • GATED (tier-state egress): identity = (gate, box). A gate is snapshot-scoped
 *     (`tierGateFromSnapshot` mints a fresh closure per snapshot), so its proxies are
 *     too — same-gate re-egress is a cache hit, a new snapshot's gate mints a fresh
 *     proxy honestly reflecting current tiers. Never combined with a membrane exit
 *     today (tiering is bare-mode by design — payload serialization WANTS print
 *     strings); if both are supplied, the membrane cache wins and the gate still
 *     governs materialization.
 *
 * BORROWED carriers (AJSArray/AJSObject) are a FOURTH egress class that never routes
 * here: they egress source identity (`return this.source`) — that IS their membrane
 * contract, and adding a proxy or a membrane walk would break it.
 *
 * Mechanics (each locked in the design doc):
 * - The target is a REAL `[]` / `{}` doubling as the materialization cache: every trap
 *   answer is backed by an ordinary configurable+writable target property, so all Proxy
 *   invariants are trivially satisfiable, `Array.isArray(proxy)` is true for the array
 *   shape, and a second read is a plain property hit.
 * - The proxy registers in its cache slot BEFORE any trap can run (built, set,
 *   returned — traps only fire on reads after return), so a cyclic reach-back (a
 *   container that — via any depth — contains itself) resolves to the
 *   already-registered proxy structurally, with no recursion. (JSON.stringify on such
 *   a value then fails with the same TypeError a genuinely cyclic plain object
 *   produces — observationally plain JS, exactly.) The invariant holds PER SLOT.
 * - The write family (`set` / `deleteProperty` / `defineProperty` / `setPrototypeOf`)
 *   throws the same teaching door family as AJSObject's read-only membrane: the egressed
 *   value is a projection of an immutable Scheme value, not a mailbox back into it.
 * - Scalars are never routed here — they unwrap directly at their own `arrival/toJS`.
 * - Provenance reach-back (R9's "future bonus": deep non-primitive reads re-entering the
 *   boxed world with lineage intact) is deliberately NOT scaffolded in this iteration.
 *
 * Leaf module: imports only the AValue base (for tracker key types and the bare
 * materialization dispatch) and the interop error — never membrane/env/bridge/rosetta.
 * The membrane recursion reaches this file exclusively as the `MembraneExit` VALUE
 * built by rosetta's `egressAValue` (type-only import below), which is exactly why a
 * nested callable can get its real reverse-membrane host-fn projection without this
 * module ever importing `callableToHostFn`.
 */
import { AValue } from "./primitives/AValue.js";
import type { EgressMode, MembraneExit } from "./types.js";
import { InteropAccessError } from "../errors.js";

/** BARE-law tracker: same box → same proxy, forever. Deterministic (no options, no
 *  scope), so box-forever identity is coherent — the original R9 law, now scoped to
 *  the serialization projection only. */
const bareProxies = new WeakMap<AValue, object>();

/** GATED-law tracker: a gate is snapshot-scoped; its proxies are too. Same-gate
 *  re-egress hits; a fresh snapshot's fresh gate closure gets a fresh inner map. */
const gatedProxies = new WeakMap<TierGate, WeakMap<AValue, object>>();

/** Shallow read model a container hands to its proxy: `keys()` enumerates the own
 *  string keys (index strings for the array shape), `read(key)` returns the ELEMENT —
 *  usually a box, or a raw FFI-passthrough value (binary/Promise) that never boxed. */
export interface EgressReader {
  keys(): readonly string[];
  read(key: string): unknown;
}

/** Element exit. Membrane egress routes through `exit.element` — the full recursive
 *  crossing (options + pinned scope + nested-callable wrapping live in rosetta's
 *  closure, never here). Bare egress dispatches the element's own serialization
 *  protocol; a raw FFI-passthrough element has no protocol and exits as itself. */
function materializeElement(element: unknown, membrane?: MembraneExit): unknown {
  if (membrane !== undefined) return membrane.element(element);
  return element instanceof AValue ? element["arrival/toJS"]() : element;
}

/**
 * The payload-tiering tier-state gate seam. This module stays a LEAF (file header
 * above) so this interface is deliberately ABSTRACT — no `PayloadTier`/
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

/** `egressContainerProxy`'s options — one object, so the membrane pair
 *  (materializer + mode + scope-owned cache) travels as a unit and cannot drift
 *  apart at a call site. */
export interface EgressOpts {
  /** Tier-state gate consulted BEFORE `reader.read(key)` on first materialization of
   *  each key. Omitting it is byte-stable pass-through. */
  gate?: TierGate;
  /** The membrane exit — presence switches materialization from bare serialization
   *  to `exit.element`, and the cache to the exit's scope-owned (box, mode) slots.
   *  Bare egress omits it. */
  membrane?: MembraneExit;
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

/** One cache slot under whichever identity law governs this egress — a get/set pair
 *  the build below stays agnostic to. */
interface ProxySlot {
  get(): object | undefined;
  set(proxy: object): void;
}

function membraneSlot(cache: WeakMap<AValue, Map<EgressMode, object>>, box: AValue, mode: EgressMode): ProxySlot {
  return {
    get: () => cache.get(box)?.get(mode),
    set: (proxy) => {
      let byMode = cache.get(box);
      if (byMode === undefined) {
        byMode = new Map();
        cache.set(box, byMode);
      }
      byMode.set(mode, proxy);
    },
  };
}

function boxSlot(cache: WeakMap<AValue, object>, box: AValue): ProxySlot {
  return {
    get: () => cache.get(box),
    set: (proxy) => cache.set(box, proxy),
  };
}

function gatedSlot(gate: TierGate, box: AValue): ProxySlot {
  let byBox = gatedProxies.get(gate);
  if (byBox === undefined) {
    byBox = new WeakMap();
    gatedProxies.set(gate, byBox);
  }
  return boxSlot(byBox, box);
}

/**
 * Build (or return the already-built) lazy egress proxy for `box`, under the identity
 * law its options select (file header): membrane ⇒ (box, mode, scope) via
 * `opts.membrane.cache`; gated ⇒ (gate, box); bare ⇒ (box) forever.
 *
 * Identity is guaranteed HERE, at the single chokepoint every container's
 * `arrival/toJS` / `arrival/toJSMembrane` calls — membrane.toJS needs no separate
 * pre-check because protocol dispatch lands in the right slot either way.
 */
export function egressContainerProxy(
  box: AValue,
  shape: "array" | "object",
  reader: EgressReader,
  opts?: EgressOpts,
): object {
  const membrane = opts?.membrane;
  const gate = opts?.gate;
  const slot =
    membrane !== undefined
      ? membraneSlot(membrane.cache, box, membrane.modeKey)
      : gate !== undefined
        ? gatedSlot(gate, box)
        : boxSlot(bareProxies, box);

  const cached = slot.get();
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
        ? materializeElement(reader.read(key), membrane)
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

  // Register BEFORE returning — traps only fire on reads after return, so a cyclic
  // reach-back during a later materialization finds this slot already occupied
  // (the register-before-materialize invariant, per slot).
  slot.set(proxy);
  return proxy;
}
