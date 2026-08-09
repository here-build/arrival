# Egress membrane exit — honest container crossing

How a boxed scheme value exits to JS: the two-protocol split (serialization vs
membrane crossing), the `MembraneExit` interface, and the cache-identity laws.
Code: `values/types.ts` (`MembraneExit`, `EgressMode`, `WrapperKey`),
`values/egress-proxy.ts` (the lazy container exit), `rosetta.ts#egressAValue`
(the one dispatch site), `values/primitives/region-scope.ts` (the scope-owned
caches). The laws are pinned in `__tests__/membrane/crossing.law.test.ts` and
summarized in RULINGS.md R9.

## The problem: one exit, two contracts

A scheme value crossing to JS has TWO distinct exits:

1. **Serialization projection** — cache / log / HTTP / print-preview.
   `AValue.prototype["arrival/toJS"]` is exactly this contract, and under it a
   callable's `#<procedure name>` string is CORRECT — a log should stringify a
   closure.
2. **Membrane crossing** — rosetta arg/return marshalling, exec's value exit
   (`membrane.ts#toJS`), MCP result values. Under this contract a callable must
   become its reverse-membrane host-fn wrapper (`callableToHostFn`,
   region-scoped re-entry), and every element projection must respect the
   caller's `RosettaOptions`.

Conflating them corrupts everything NESTED. Both rosetta (`schemeToJsImpl`) and
`membrane.ts#toJS` special-case a bare top-level callable (`is_callable_value`
before protocol dispatch — a cycle constraint forces the special-casing at each
site). But a container egresses through the R9 lazy proxy
(`values/egress-proxy.ts`), and if element materialization dispatches each
element's own `arrival/toJS` — the serialization projection — the membrane
semantics are lost one level down: a lambda inside a dict crosses as an inert
`#<procedure lambda>` string instead of a host fn. Worse, the failure is
silent — a string is wire-safe, so a downstream wire-safety choke that
documents a loud rejection for callables never fires. The same defect class
swallows any projection-affecting option handled before protocol dispatch: it
applies to the bare top-level value and is silently ignored for nested
elements. The defect is "options and membrane semantics don't reach nested
elements", not "callables stringify".

### Why a threaded parameter cannot fix it

The tempting patch — thread a `wrapCallable?: (v: ACallable) => unknown`
parameter through `arrival/toJS` → each container → the egress proxy → element
materialization — fails structurally, not incidentally:

- **Protocol pollution.** `arrival/toJS` is the serialization protocol; the
  optional param is a membrane concern that every non-container subclass
  ignores. Fat interface.
- **Symptom, not defect.** It fixes the callable kind only; every other
  projection-affecting option is still lost for nested elements. The honest
  thing to thread is the RECURSION — `schemeToJsImpl(el, options)` — the lazy
  twin of the eager raw-container branch rosetta already has.
- **One level deep.** A container INSIDE a container materializes via bare
  `toJS()` with no parameter — a depth-2 lambda still stringifies while a
  depth-1 test matrix reads green.
- **First-caller-wins staleness.** The proxy cache is box-forever
  (`WeakMap<AValue, object>` — the R9 identity law), so proxy behavior would
  depend on the parameter captured at FIRST egress. A dict that first crosses
  a bare path (print, serializer) caches a bare proxy; a later membrane
  crossing gets serialization behavior back.
- **The contradiction, named.** "Same box → same proxy, forever" and
  "projection depends on options" are jointly unsatisfiable over ONE cache
  slot. Two crossings differing in options MUST observe different objects.
  Ignoring options for nested elements is consistent-but-wrong; a threaded
  parameter over a single slot is inconsistent AND wrong-for-later-callers.

The resolution is interface segregation plus a projection-aware cache: two
protocols, and identity slots keyed by everything the projection depends on.

## The two protocols

- **`["arrival/toJS"]()`** — zero-arg serialization projection. **Callables
  stringify — that is a law, not an accident.** Every serialization caller
  (kwargs `faceOf`, MCP host faces, print paths) calls it bare and is correct
  as-is: the wire wants strings.
- **`["arrival/toJSMembrane"]?(exit: MembraneExit)`** — optional protocol
  member on `AValue`, implemented ONLY by the three native containers
  (ADict / APair / AVector). Scalars and callables never declare it — **its
  presence IS the dispatch discriminator.** An optional protocol member
  (rather than a branded sub-interface + type guard) matches AValue's existing
  optional-member convention (`withProvenanceDeep?`) and is bivariance-checked
  on declared overrides — not a soundness trap.

### The `MembraneExit` contract

Defined in `values/types.ts` — the leaf-safe home; egress-proxy, containers,
rosetta, and membrane all import the TYPE from there, so the container leaf
keeps zero value-kind knowledge and zero new imports:

```ts
/** The membrane's element exit, handed to a container's `arrival/toJSMembrane`.
 *  Built exclusively by rosetta.ts's `egressAValue`; egress-proxy consumes it. */
export interface MembraneExit {
  /** Full recursive membrane crossing for one element, running under the PINNED
   *  exporting region scope — closes over `withRegionScope(pinned, () =>
   *  schemeToJsImpl(el, options))`. Handles nested callables (schemeToJsImpl's
   *  own is_callable_value fast path → callableToHostFn, minting under the
   *  pinned scope) and nested containers (the recursion re-enters toJSMembrane
   *  with the same options, so the same modeKey falls out). */
  element(el: unknown): unknown;
  /** Branded cache-mode discriminator — derived from options CONTENT by
   *  rosetta's `modeKeyOf`; closure identity is irrelevant. Never `"bare"` in
   *  practice (bare egress carries no MembraneExit at all). */
  modeKey: EgressMode;
  /** The pinned scope's OWN membrane-proxy cache (`RegionScope.egressProxies` —
   *  the law: membrane proxy identity = (box, mode, SCOPE)). Handed in as a
   *  plain WeakMap so egress-proxy needs zero new imports. */
  cache: WeakMap<AValue, Map<EgressMode, object>>;
}
```

## One dispatch site

`rosetta.ts#egressAValue` is THE one place the two protocols meet, shared by
`schemeToJsImpl`'s AValue branch AND `membrane.ts#toJS` — two copies of the
dispatch must not exist, because they would drift:

```ts
export function egressAValue(value: AValue, options: RosettaOptions): unknown {
  const membrane = value["arrival/toJSMembrane"];
  if (membrane === undefined) return value["arrival/toJS"]();
  const pinned = currentRegionScope() ?? DETACHED_SCOPE; // captured at EXIT BUILD
  return membrane.call(value, {
    element: (el: unknown) => withRegionScope(pinned, () => schemeToJsImpl(el, options)),
    modeKey: modeKeyOf(options),
    cache: pinned.egressProxies, // membrane proxies are SCOPE-owned
  });
}
```

`membrane.ts#toJS` calls `egressAValue(value, {})`, sharing rosetta's
default-mode slots, so `toJS(v) === schemeToJs(v)` holds for default options
(a default-options identity only — not a general cross-options law) and a
NESTED callable gets the same host-fn face exec's exit already gives a bare
top-level one. The observable consequence for ad-hoc logging:
`JSON.stringify` of an exec result omits fn-valued object keys / nulls array
slots where a `"#<procedure …>"` string would appear under serialization.

Everything else (`faceOf`, MCP host faces, prints, tests) keeps calling bare
`toJS()` — serialization, correct as-is.

## Cache-identity laws

**Bare = (box). Membrane = (box, mode, SCOPE). Gated = (gate, box).**

The governing principle: *parameterized materialization cannot live in a
parameter-blind identity slot.* Each projection caches under a key covering
everything the projection depends on — nothing less (staleness), nothing more
(spurious identity churn).

- **Bare** — module-level `WeakMap<AValue, object>` in `egress-proxy.ts`, the
  original R9 shape. Bare projection is scope-free and option-free
  (deterministic serialization), so box-forever identity is coherent. All
  original R9 laws (identity, aliasing, cycles) hold here unchanged.
- **Membrane** — SCOPE-owned:
  `RegionScope.egressProxies: WeakMap<AValue, Map<EgressMode, object>>`,
  initialized in `openRegionScope` / `reconstructRegionScope` / the
  `DETACHED_SCOPE` singleton, and handed into the `MembraneExit`. A
  (box, mode)-forever cache is unsound once exits pin scopes: it would either
  resurrect wrappers pinned to a CLOSED scope for a later invocation of the
  same crossing (spurious region-escape errors mid-legitimate call), or —
  crossings ordered the other way — pin DETACHED wrappers into the very slot a
  live rosetta crossing shares (escape-discipline bypass by cache pollution).
  That is the first-caller-wins defect reintroduced on the scope axis, which
  is why the cache lives on the scope. Scope-less paths (exec's simple tier,
  trace/display) share the DETACHED singleton's map — box-forever per mode,
  matching their top-level-callable behavior.
- **Gated** (tier-state egress) —
  `WeakMap<TierGate, WeakMap<AValue, object>>`. **A gate is snapshot-scoped;
  its proxies are too.** A gate is a fresh closure per snapshot over a
  per-moment tier view, and tier state only moves toward stub — re-serving a
  long-lived container after tier movement is the feature's purpose. Same-gate
  re-egress is a cache hit; a new snapshot's gate mints a fresh proxy honestly
  reflecting current tiers. Reference-identity stickiness (throw on gate
  change) would break exactly the intended flow; presence-based stickiness is
  worse — silent stub-vs-real corruption. Tiering itself stays bare-mode:
  payload serialization WANTS print strings for callables.

**Aliasing is PER (mode, scope):** a shared child is one object within a slot,
distinct across slots. Cross-mode / cross-scope `===` was never a coherent
expectation — no consumer compares proxies across paths, and once projection
depends on options and scope, a single identity across them is impossible by
construction.

**Registration ordering:** the per-mode proxy registers into its inner map
BEFORE any trap can run (get-or-create inner map, set, then return) —
preserving the register-before-materialize cycle invariant per slot.

## The mode key: a closed, branded union

```ts
export type EgressMode = "bare" | "mem";
```

Mode is derived from options CONTENT by `modeKeyOf(options)`, never from
closure identity. Every membrane crossing resolves to the single `"mem"` mode:
no live `RosettaOptions` field changes element projection —
`returnEither` / `argProvenance` are wrapper-call concerns read only inside
`createRosettaWrapper`, never by `schemeToJsImpl` or inbound `jsToScheme`, so
nested projections are bit-identical across them and keying on them would only
fragment the cache. The machinery survives the collapse to one live mode
because classification must be FORCED, not remembered: a type-level
exhaustiveness guard makes adding a `RosettaOptions` field a compile error
until the author classifies it — projection-affecting ⇒ new `EgressMode`
member; wrapper-call-only ⇒ the exclusion list.

```ts
/** A destructure or `satisfies RosettaOptions` does NOT do this —
 *  destructuring is never exhaustiveness-checked. */
type _ModeKeyHandles = Exclude<keyof RosettaOptions,
  "returnEither" | "argProvenance"> extends never ? true : never;
const _modeKeyExhaustive: _ModeKeyHandles = true;
```

### The region wrapper cache is two-level too

The same parameter-blind-slot hazard exists one layer down. Two factory
families mint host-fn wrappers into `RegionScope.cache`: rosetta's untyped
`callableToHostFn` and scheme-zod's typed `z.procedure` decode. Nothing
prevents one callable from crossing both paths in one scope — and
`DETACHED_SCOPE.cache` is process-wide, so detached collisions last the
process lifetime. Nested callables multiply `callableToHostFn` reachability,
making the collision hot. So the cache keys by (callable, `WrapperKey`):

```ts
/** NOT EgressMode: "typed" is scheme-zod's z.procedure family, not an egress
 *  mode, and "bare" never mints wrappers — the live domain is {"mem","typed"}. */
export type WrapperKey = EgressMode | "typed";
```

`callableToHostFn` keys by `modeKeyOf(options)`; scheme-zod's decode keys by
`"typed"` — the typed wrapper keeps its marshalling regardless of crossing
order. Explicit non-goal: schema collision WITHIN `"typed"` (same callable,
two different `z.procedure` schemas) stays out of scope.

## Region scope: pinned at exit construction

`callableToHostFn` captures `currentRegionScope() ?? DETACHED_SCOPE` at MINT
time, and a lazy proxy materializes elements at first READ — almost always
after the exporting `withRegionScope` window has restored (it is sync
save/restore around the marshalling call). Unpinned, every nested callable
would mint under `DETACHED_SCOPE` and re-enter under `CONSTANT_CTX` — a
region-discipline bypass this feature would CREATE (inert print strings leave
no hole to bypass). Same failure family as the `value-slot-callable-door` law.

So `egressAValue` captures the ambient scope ONCE at exit construction — which
on both rosetta crossings happens INSIDE the live `withRegionScope` marshalling
window — and `element` re-enters it via `withRegionScope(pinned, …)` around
each materialization. Consequences:

- A nested callable's wrapper mints under the EXPORTING scope — identical
  semantics to a bare top-level callable crossing in the same call.
- Late invocation (host reads and calls the nested fn after the exporting
  invocation closed) hits the SAME escape discipline a bare exported callable
  does — the documented door, never a silent `CONSTANT_CTX` re-entry.
- Paths with no ambient scope at exit build pin `DETACHED_SCOPE` — exactly the
  behavior their top-level callables already have; nothing regresses.

Capture-at-first-read is strictly worse: exit construction happens inside the
live window on the crossings that matter; first read happens after restore. An
ambient-exit holder (ALS-style) instead of parameter threading is rejected for
the same reason — it reintroduces the lazy-read-outside-extent lifetime bugs
pinning exists to close.

## Containers

Each native container implements `toJS()` (bare projection) and
`toJSMembrane(exit)` mirroring it with the membrane exit. Element
materialization in the proxy is
`membrane ? membrane.element(el) : (el instanceof AValue ? el["arrival/toJS"]() : el)` —
no `is_callable_value`, no ACallable import; the leaf has zero value-kind
knowledge.

**Pending entries** (ADict only): **native spine carriers never hold pending
cells** — AVector/APair own their `SchemeValue` elements structurally, the
settle machinery belongs to ADict/AJSObject/AJSArray, and a raw scheme Promise
in a native vector/list egresses through the FFI passthrough AS the Promise,
by design (the law is pinned at `pending-entry.ts`'s header). ADict's bare
`toJS` settles a pending entry with the serialization continuation; its
`toJSMembrane` settles with `exit.element(boxed)` — the promise resolves into
the SAME mode's projection under the pinned scope (`element`'s
`withRegionScope` is sync save/restore, correctly reinstalled inside the
microtask continuation). One benign double-dispatch is deliberate — do not
"fix" it: the outer materialization also passes the pending PROMISE itself
through `membrane.element`, where the Promise FFI passthrough returns it
unchanged — a no-op by construction; the real projection happens in the settle
continuation. A pending entry settling to a callable yields a function under
membrane crossing and the print string under bare.

**Borrowed containers are the fourth egress class — and they are OUT.**
`AJSArray` / `AJSObject` egress **source identity** (`return this.source`);
that IS their membrane contract — borrowed round-trips to the host's own
object. They get NO `toJSMembrane`; adding one would break source identity.
The scheme side cannot inject an ALambda into borrowed source (write doors);
host-authored content returns to the host as-authored; a hypothetical boxed
AValue inside borrowed source leaks as a raw box on egress — a pre-existing
edge, rejected at the wire-safety choke (class instance → prototype ≠
`Object.prototype`). The source-identity law is named in `egress-proxy.ts`'s
header so nobody "completes the set."

## Rejected alternatives

- **Threading a callable-wrapper parameter through the serialization
  protocol** — the structural failure analysis above (protocol pollution,
  depth-1 only, first-caller-wins cache staleness, the one-slot
  contradiction).
- **Eager membrane peel** (drop R9 laziness on the membrane path) — laziness
  is load-bearing for large-structure exits; per-mode caching preserves it at
  every depth.
- **Ambient-exit holder instead of parameter threading** — reintroduces the
  lazy-read-outside-extent lifetime bugs scope pinning closes.
- **`pure` on `RosettaFunction` in the mode key** — it is a provenance-mint
  flag on the INBOUND wrapper, not an egress projection option.
- **Branded `MembraneEgress` sub-interface + type guard** instead of the
  optional protocol member — marginally more explicit, but the optional
  member matches the codebase's existing protocol convention and is
  bivariance-checked; the containers-only contract lives in the member's doc
  comment.
