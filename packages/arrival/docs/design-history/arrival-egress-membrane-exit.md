# Egress membrane exit — honest container crossing (supersedes the `wrapCallable` stopgap)

Status: REV 3 — post-triad (longcat / grok-4.5 / composer) + Fable final review
(APPROVE-WITH-CHANGES, all mandatory amendments folded; ledger in §9), 2026-07-12.
Supersedes commit `33ed0c2fcb`'s threading hack, which stays in as a stopgap until this
lands.

## 1. Problem

A scheme value crossing to JS has TWO distinct exits that the current code conflates:

1. **Serialization projection** — cache / log / HTTP / print-preview. `AValue.prototype
   ["arrival/toJS"]`'s own doc names exactly this ("Plain-JS representation for
   serialization (cache / log / HTTP)"). Under THIS contract a callable's `#<procedure
   name>` string is CORRECT — a log should stringify a closure.
2. **Membrane crossing** — rosetta arg/return marshalling, `exec`'s value exit
   (`membrane.ts#toJS`), MCP result values. Under THIS contract a callable must become
   its reverse-membrane host-fn wrapper (`callableToHostFn`, region-scoped re-entry),
   and every element projection must respect the caller's `RosettaOptions`.

Both rosetta (`schemeToJsImpl`) and `membrane.ts#toJS` already special-case a BARE
top-level callable (`is_callable_value` check before protocol dispatch — each site
carries a comment explaining the cycle constraint that forces the special-casing). But a
container egresses through the R9 lazy proxy (`values/egress-proxy.ts`), whose
`materializeElement` dispatches each element's own `arrival/toJS` — the SERIALIZATION
projection — losing the membrane semantics for everything nested:

- **Nested callable** → inert `#<procedure lambda>` string instead of a host fn.
  Observable: `(require/call "f.scm" "greet" (dict :f (lambda (x) x)))` sailed through
  `arrival-reflect`'s `isWireSafe` choke (a string is wire-safe; the documented
  WireUnsafeError never fired). Found via inhuman-mcp's failing wire-safe-choke test.
  (The choke lives in the `arrival-reflect` package's `src/wire-safe.ts`, in the
  private monorepo.)
- **Nested AExact under `forceBigInt`** → `schemeToJsImpl` handles `forceBigInt` BEFORE
  protocol dispatch, so it only ever applies to a bare top-level number. An AExact
  inside a dict materializes through bare `toJS` → safe-range number, option silently
  ignored. Same defect class, different value kind, proving the bug is "options don't
  reach nested elements", not "callables stringify".

## 2. Why the landed stopgap (`33ed0c2fcb`) is dishonest

It threads `wrapCallable?: (v: ACallable) => unknown` through `AValue["arrival/toJS"]`
→ each container → `egressContainerProxy` → `materializeElement`.

- **Protocol pollution.** `arrival/toJS` is the serialization protocol; the optional
  param is a membrane concern that ~every non-container subclass ignores. Fat interface.
- **Symptom, not defect.** Fixes the callable kind only; `forceBigInt` (and any future
  option) still lost for nested elements. The honest thing to thread is the RECURSION
  (`schemeToJsImpl(el, options)`) — the lazy twin of the eager raw-container branch
  rosetta already has (`value.map((r) => schemeToJsImpl(r, options))`).
- **One level deep only** (triad, grok-4.5 #5). A container INSIDE a container
  materializes via bare `toJS()` with no `wrapCallable` — a depth-2 lambda
  (`(dict :inner (dict :f (lambda …)))`) still stringifies under the stopgap. The
  stopgap's own test matrix (depth-1 only) reads green while the defect stands.
- **First-caller-wins staleness.** `egressProxies` is `WeakMap<AValue, object>` — same
  box → same proxy FOREVER (the R9 identity law). But proxy behavior now depends on the
  `wrapCallable` captured at FIRST egress. A dict that first crosses a bare path (print,
  kwargs `faceOf`, serializer) caches a bare proxy; a later rosetta crossing gets the
  print-string behavior back. The test passes because rosetta happens to egress first.
- **Contradiction made latent, not resolved.** "Same box → same proxy, forever" and
  "projection depends on options" are jointly unsatisfiable over ONE cache slot. Two
  calls differing in `forceBigInt` MUST observe different objects. The pre-stopgap code
  hid this by ignoring options for nested elements entirely (consistent, wrong); the
  stopgap makes it inconsistent AND wrong-for-later-callers.

## 3. Design

### 3.1 The two protocols (interface segregation)

- `["arrival/toJS"]()` — REVERTS to zero-arg. Serialization projection, semantics
  byte-identical to pre-stopgap HEAD. Callables stringify (§5.5 pins this as a LAW —
  it was an accident before). Every existing bare caller (`kwargs-rejection.ts#faceOf`,
  arrival-mcp `DiscoveryTool.ts#hostFace`, print paths, direct test calls) is untouched
  and correct. Non-container subclasses drop the stopgap's dead optional param from
  their overrides (bivariance would silently permit it — clean them all).
- `["arrival/toJSMembrane"]?(exit: MembraneExit)` — NEW optional protocol member,
  implemented ONLY by the three native containers (ADict / APair / AVector). Scalars
  and callables never declare it. Doc comment on the abstract member names the
  containers-only contract explicitly. (Triad note: a branded
  `interface MembraneEgress` + type guard is marginally more honest; the optional
  protocol member matches AValue's existing `withProvenanceDeep?`/tagless-final
  convention and is bivariance-checked on declared overrides — not a soundness trap.
  Staying with the codebase convention.)

```ts
/** The membrane's element exit, handed to a container's toJSMembrane. Lives in
 *  values/types.ts (leaf-safe); egress-proxy/rosetta/membrane import the TYPE
 *  (type-only — the leaf stays clean). */
export interface MembraneExit {
  /** Full recursive membrane crossing for one element, running under the PINNED
   *  exporting region scope (§4) — closes over withRegionScope(pinnedScope, () =>
   *  schemeToJsImpl(el, options)). Handles nested callables (schemeToJsImpl's own
   *  is_callable_value fast path → callableToHostFn, minting under the pinned scope),
   *  nested forceBigInt, nested containers (recursion re-enters toJSMembrane, same
   *  mode — the closure carries the same options, so the same modeKey falls out). */
  element(el: unknown): unknown;
  /** Branded cache-mode discriminator — see §3.3. Derived from options CONTENT;
   *  closure identity is irrelevant. */
  modeKey: EgressMode;
  /** The pinned scope's OWN membrane-proxy cache (`RegionScope.egressProxies` —
   *  §3.3's law: membrane proxy identity = (box, mode, SCOPE)). Handed in as a plain
   *  WeakMap so egress-proxy needs zero new imports. Without this, a (box, mode)-
   *  forever cache would resurrect wrappers pinned to a CLOSED scope for a later
   *  invocation (spurious escape doors), or serve DETACHED-pinned wrappers to a live
   *  rosetta crossing (discipline bypass by cache pollution) — Fable finding 1. */
  cache: WeakMap<AValue, Map<EgressMode, object>>;
}
```

### 3.2 Dispatch sites — ONE shared helper

One exported helper in `rosetta.ts` (both call sites already import from rosetta, so no
new cycle), used by `schemeToJsImpl`'s AValue branch AND `membrane.ts#toJS` — the two
copies of the dispatch must not exist to drift (triad: composer #19 + longcat #11):

```ts
/** Boxed-AValue membrane exit: containers cross via toJSMembrane (full recursive
 *  projection under the caller's options + pinned region scope), everything else
 *  via its serialization protocol. THE one place the two protocols meet. */
export function egressAValue(value: AValue, options: RosettaOptions): unknown {
  const membrane = value["arrival/toJSMembrane"];
  if (membrane === undefined) return value["arrival/toJS"]();
  const pinned = currentRegionScope() ?? DETACHED_SCOPE; // §4 — capture at EXIT BUILD
  return membrane.call(value, {
    element: (el: unknown) => withRegionScope(pinned, () => schemeToJsImpl(el, options)),
    modeKey: modeKeyOf(options),
    cache: pinned.egressProxies, // §3.3 — membrane proxies are SCOPE-owned
  });
}
```

`membrane.ts#toJS` calls `egressAValue(value, {})`. **This flips behavior on the
hottest exit path** (triad, longcat #8): `toJS(dictWithNestedLambda)` used to yield the
print string for the nested callable, now yields a host fn. Deliberate — exec's exit
already gives a bare top-level callable the host-fn face (`callableToHostFn(value, {})`
at membrane.ts:245), so nested now matches top-level. Fable-verified contained: the
sole production `membrane.toJS` importer is `eval/generator-exec.ts`; every exec
consumer already tolerates fn values because top-level callables cross as host fns
today; no `JSON.stringify`-of-exec-values path relies on nested print strings. The one
observable delta for ad-hoc logging: `JSON.stringify` OMITS fn-valued object keys /
nulls array slots where a `"#<procedure …>"` string appeared before. §5.1 pins the
flip; §6 keeps the consumer grep as the final sweep (expected: zero edits). The
`Values` multi-value arm recurses through `toJS` per element and needs no separate
edit — but §6 names it so the implementer confirms rather than assumes.

Everything else (`faceOf`, `hostFace`, prints, tests) keeps calling bare `toJS()` —
serialization, correct as-is. arrival-mcp's serializer WANTS strings on the wire;
`DiscoveryTool.ts:169-177`'s "mirrors membrane.toJS" comment becomes false under this
split and gets corrected in the same pass (§6).

### 3.3 Cache: the resolved identity law — bare = (box); membrane = (box, mode, SCOPE)

Two trackers, not one (Fable finding 1 — a (box, mode)-forever membrane cache is
unsound once exits pin scopes: it would resurrect wrappers pinned to a CLOSED scope for
a later invocation of the same crossing → spurious `RegionEscapeError` mid-legitimate
call; or, exec-first, pin DETACHED into the very slot rosetta's defaults share →
nested callables re-entering under `CONSTANT_CTX` with no escape discipline — the §2
first-caller-wins defect class reintroduced on the scope axis):

- **Bare mode** — module-level in `egress-proxy.ts`, exactly today's shape:
  `WeakMap<AValue, object>`. Bare projection is scope-free and option-free
  (deterministic serialization), so box-forever identity remains coherent. All
  existing R9 laws land here unchanged.
- **Membrane modes** — SCOPE-owned: `RegionScope` gains
  `readonly egressProxies: WeakMap<AValue, Map<EgressMode, object>>`, initialized in
  `openRegionScope` / `reconstructRegionScope` / the `DETACHED_SCOPE` singleton
  (mirroring `RegionScope.cache`, region-scope.ts:146 — same "never `===` across
  scopes" law its wrapper cache already documents). `egressAValue` hands
  `pinned.egressProxies` into the `MembraneExit`; egress-proxy consumes it as a plain
  WeakMap parameter, zero new imports. Scope-less paths (exec's simple tier,
  trace/display) all share the DETACHED singleton's map — same box-forever behavior
  they have today, one slot per mode.

**Mode is a closed, branded union — not a free string** (triad-confirmed ×3):

```ts
/** The egress projection modes. bare = serialization (no options, callables
 *  stringify). mem:0/mem:1 = membrane crossing, split by forceBigInt — the ONE
 *  RosettaOptions field that changes element projection (returnEither/argProvenance
 *  are wrapper-call concerns read only inside createRosettaWrapper, never by
 *  schemeToJsImpl or inbound jsToScheme — triad-verified, longcat #2 + grok-4.5 #3). */
export type EgressMode = "bare" | "mem:0" | "mem:1";
export const BARE_MODE: EgressMode = "bare";

/** Type-level exhaustiveness: a NEW RosettaOptions field makes _ModeKeyHandles `never`
 *  and this assignment a compile error, forcing the author to decide whether the field
 *  affects projection (⇒ new EgressMode member) or not (⇒ add it to the Exclude list).
 *  (A destructure or `satisfies RosettaOptions` does NOT do this — destructuring is
 *  never exhaustiveness-checked; Fable finding 3.) */
type _ModeKeyHandles = Exclude<keyof RosettaOptions,
  "forceBigInt" | "returnEither" | "argProvenance"> extends never ? true : never;
const _modeKeyExhaustive: _ModeKeyHandles = true;

function modeKeyOf(o: RosettaOptions): EgressMode {
  return o.forceBigInt ? "mem:1" : "mem:0";
}
```

Plus a regression test pinning `modeKeyOf` output per option combination (§5.8).

**Restated identity law**: bare projection is a function of (box) — same proxy forever,
as today. Membrane projection is a function of (box, mode, scope) — same proxy within
one exporting scope's lifetime; a re-egress under a NEW invocation mints proxies bound
to ITS scope. Cross-mode/cross-scope `===` was never a coherent expectation — no
in-repo consumer compares proxies across paths (triad-verified, grok-4.5 #7). Existing
crossing.law identity/aliasing/cycles tests run scope-less → the DETACHED singleton's
map → green unchanged; §5.3-5.4 add the cross-mode and cross-scope pins; the aliasing
law is restated as PER-(mode, scope) aliasing in the module header + R9 prose (§6 —
mandatory, or the next agent "fixes" the cache back to single-slot).

**Registration ordering** (triad, longcat #4): the per-mode proxy registers into the
inner Map BEFORE any trap can run — get-or-create inner map, `set(modeKey, proxy)`,
THEN return — preserving the register-before-materialize cycle invariant per slot.

**Region wrapper cache goes two-level too** (triad, grok-4.5 #2, sharpened by Fable
finding 4): `RegionScope.cache` today keys wrappers by callable alone — AND has two
factory families racing it (rosetta's untyped `callableToHostFn`, scheme-zod's typed
`z.procedure` decode; region-scope.ts:136-145 documents the first-wins hazard as the
reason to reject `DefaultedWeakMap` while keeping an idiom with the identical
collision). Nothing prevents one callable crossing both paths in one scope — and
`DETACHED_SCOPE.cache` is process-wide, so detached crossings collide for the process
lifetime. This plan makes the collision hot (nested callables multiply
`callableToHostFn` reachability), so fixing it here is the honest move: the cache
becomes `WeakMap<object, Map<WrapperKey, wrapper>>` where

```ts
/** NOT EgressMode: "typed" is scheme-zod's z.procedure family, not an egress mode,
 *  and "bare" never mints wrappers — the live domain is {"mem:0","mem:1","typed"}. */
type WrapperKey = EgressMode | "typed";
```

`callableToHostFn` keys by `modeKeyOf(options)`; scheme-zod's decode keys by
`"typed"`. Explicit non-goal: schema collision WITHIN "typed" (same callable, two
different `z.procedure` schemas) is pre-existing and stays.

### 3.4 `egressContainerProxy` signature

Positional-optional stacking (`gate?, wrapCallable?`) is rot; fold into one options
arg. The membrane pair travels as ONE object so materialize/mode cannot drift apart
(triad, composer #6 — the mismatch becomes unrepresentable):

```ts
export interface EgressOpts {
  gate?: TierGate;
  /** The membrane exit — presence switches materialization from bare serialization
   *  to exit.element, and the cache slot to exit.modeKey. Bare egress omits it. */
  membrane?: MembraneExit;
}
export function egressContainerProxy(box, shape, reader, opts?: EgressOpts): object;
```

`materializeElement(el, membrane?)`: `membrane ? membrane.element(el) : (el instanceof
AValue ? el["arrival/toJS"]() : el)`. **No `is_callable_value`, no ACallable import** —
the stopgap's leaf-purity damage reverts; the leaf gets PURER than pre-stopgap HEAD
(zero value-kind knowledge).

**Gated egress caches per (gate, box)** (composer #1 named the corruption; Fable
finding 5 killed the rev-2 throw-law that answered it): a gate is snapshot-scoped —
`tierGateFromSnapshot` mints a FRESH closure per snapshot over a per-moment tier view,
and tier state only moves toward stub, so re-serving a long-lived container after tier
movement is the feature's PURPOSE. Reference-identity stickiness would throw forever
on exactly that flow (latent today only because tiering has zero production wiring —
`tiering.ts` only exports the gate builder; the sole `egressContainerProxy`-with-gate
caller is its test — so the throw would ship dormant and detonate at first real
wiring). Presence-based stickiness is worse (silent stub-vs-real corruption — the
original finding). Resolution, same shape as the scope-owned membrane cache
(parameterized materialization cannot live in a parameter-blind identity slot): gated
egress caches in `WeakMap<TierGate, WeakMap<AValue, object>>` — same-gate re-egress is
a cache hit (unchanged), new-snapshot re-egress mints a fresh proxy honestly
reflecting current tiers. No sticky side-table, no throw. Law, one line: "a gate is
snapshot-scoped; its proxies are too." Ungated bare egress keeps the module-level
box-forever map. (Tiering stays bare-mode: provenance-store payload serialization
WANTS print strings for callables.)

Call sites to migrate (Fable-corrected — rev 2 listed two non-callers:
`tiering.ts` only imports the `TierGate` TYPE, and `dict-literal-shape.law.test.ts`'s
mention is a comment): containers ×3 (`AVector.ts:91`, `APair.ts:500`, `ADict.ts:247`)
+ `provenance/store/__tests__/tiering-egress-gate.test.ts:52/64/83/104` (positional
`gate` → `{ gate }`).

### 3.5 Containers

Each container: `toJS()` reverts to the pre-stopgap zero-arg body (bare mode);
`toJSMembrane(exit)` mirrors it with `{ membrane: exit }`.

**Pending-entry law, pinned** (triad-confirmed: longcat #6 resolves grok-4.5 #6 +
composer #9): native AVector/APair hold OWNED `SchemeValue` elements structurally —
`pending-entry.ts`'s settle machinery is used by ADict/AJSObject/AJSArray ONLY, so a
promise-valued element in a native vector/list cannot be a pending cell; a raw scheme
Promise there hits `schemeToJsImpl`'s FFI passthrough and egresses as the Promise, by
design. This invariant gets a one-line comment at `pending-entry.ts`'s header ("native
spine carriers never hold pending cells") so the ADict-only settle below reads as law,
not oversight.

ADict's pending-entry branch: bare `toJS` keeps today's settle continuation (`boxed
instanceof AValue ? boxed["arrival/toJS"]() : boxed`); `toJSMembrane` continues with
`exit.element(boxed)` instead — the promise settles into the SAME mode's projection,
under the pinned scope (`exit.element`'s `withRegionScope` is sync save/restore inside
the microtask continuation — correctly reinstalled at settle time). NOTE the benign
double-dispatch (Fable finding 10 — do NOT "fix" it): the outer `materializeElement`
also passes the pending PROMISE itself through `membrane.element`, where
`schemeToJsImpl`'s Promise FFI passthrough returns it unchanged — a no-op by
construction; the real projection happens in the `.then` continuation. §5.6 covers a
pending entry settling to a CALLABLE: membrane mode → function, bare mode → print
string.

### 3.6 AValue

Revert the abstract `arrival/toJS` to zero-arg. Declare the optional member:

```ts
/** OPTIONAL membrane-crossing protocol — implemented ONLY by the native containers
 *  (ADict/APair/AVector); a non-container subclass must never declare it (its
 *  presence IS the dispatch discriminator in rosetta's egressAValue). See
 *  values/types.ts#MembraneExit and egress-proxy.ts. Serialization callers never
 *  touch this. */
["arrival/toJSMembrane"]?(exit: MembraneExit): unknown;
```

`MembraneExit` + `EgressMode` live in `values/types.ts` (leaf-safe home; egress-proxy,
containers, rosetta, membrane all already import types from there).

### 3.7 Borrowed containers — explicitly OUT (triad-confirmed ×3)

`AJSArray`/`AJSObject` egress **source identity** (`return this.source`) — that IS
their membrane contract (borrowed = round-trips to the host's own object). They get NO
`toJSMembrane`; adding one would break source identity. The scheme side cannot inject
an ALambda into borrowed source (write doors); host-authored content returns to the
host as-authored; a hypothetical boxed AValue sitting in borrowed source leaks as a raw
box on egress — pre-existing, unchanged by this work, and `isWireSafe` rejects it at
the choke (class instance → proto ≠ Object.prototype). One sentence lands in
`egress-proxy.ts`'s header naming borrowed carriers as the fourth egress class with
source-identity law, so nobody "completes the set."

## 4. Region scope: PINNED at exit construction (was "documented, not fixed" — triad overruled)

`callableToHostFn` captures `currentRegionScope() ?? DETACHED_SCOPE` at MINT time. A
lazy proxy materializes elements at first READ — almost always after the exporting
`withRegionScope` window restored (it is sync save/restore around the marshalling
call). Unpinned, every nested callable would mint under `DETACHED_SCOPE` and re-enter
under `CONSTANT_CTX` — a region-discipline bypass CREATED by this feature (today's
nested print strings are inert, so no hole exists yet). Same failure family as the
`value-slot-callable-door` law.

Resolution (grok-4.5 #1 BLOCKER + composer #14; longcat's counter-argument — "build
time is detached as often as read time" — is factually wrong for the paths that matter:
rosetta builds the exit INSIDE the `withRegionScope(scope, …)` marshalling window,
where the exporting scope is live; first-read happens after restore): `egressAValue`
captures the ambient scope ONCE at exit construction and `element` re-enters it via
`withRegionScope(pinned, …)` around each materialization. Consequences:

- A nested callable's wrapper mints under the EXPORTING scope — identical semantics to
  a bare top-level callable crossing in the same rosetta call.
- Late invocation (host reads + calls the nested fn after the exporting invocation
  closed) hits the SAME escape discipline a bare exported callable does — the
  documented door, not silent CONSTANT_CTX. §5.7 pins this.
- Paths with no ambient scope at exit build (exec's simple-tier exit outside any region
  call) pin DETACHED_SCOPE — exactly today's behavior for their top-level callables;
  nothing regresses.

## 5. Test matrix (new laws in crossing.law.test.ts unless noted)

1. **Nested callable crosses as fn** — via `schemeToJs` AND via `membrane.toJS`
   (the behavior flip is deliberate; this is its pin): lambda inside dict/vector/list;
   element `typeof "function"`; invoking round-trips through re-entry.
2. **Depth ≥ 2** (stopgap lies green at depth 1): `(dict :inner (dict :f (lambda …)))`
   and dict→vector→lambda — innermost crosses as fn under membrane, as string under
   bare.
3. **Nested forceBigInt**: AExact inside dict; `schemeToJs(d, {forceBigInt: true})` →
   element is `bigint`. (Fails on HEAD + stopgap today.)
4. **Mode + scope isolation**: same dict — bare `toJS()` twice → same proxy;
   membrane `{}` twice UNDER ONE SCOPE → same proxy; bare vs membrane → different;
   `{forceBigInt:true}` vs `{}` → different. Aliasing law asserted PER (mode, scope)
   (shared child = one object within a slot, distinct across slots).
5. **Scope-owned membrane cache** (Fable finding 1's two laws): (a) re-egress of the
   same box under a SECOND invocation's scope yields SECOND-scope-bound nested
   wrappers — invoking during B works; A's earlier proxy's wrapper doors with the
   escape error; (b) `toJS`-egress (DETACHED) and rosetta-egress (live scope) of the
   same box are DISTINCT proxies with distinct re-entry discipline — exec-first cache
   pollution is impossible.
6. **Serialization pinned as law**: bare `toJS()` on a callable-bearing dict yields the
   `#<procedure …>` string.
7. **ADict pending entry settling to a callable**: membrane crossing → awaited element
   is a function; bare → the print string.
8. **Pinned-scope law**: nested lambda materialized DURING the exporting region call
   re-enters under the live scope; materialized/invoked AFTER the exporting invocation
   closed → the escape-discipline door (same as a bare exported callable), never a
   silent CONSTANT_CTX re-entry.
9. **`modeKeyOf` pin**: exact output per option combination (the closed-lattice
   regression guard).
10. **Gate-keyed egress**: same-gate re-egress → cache hit (same proxy); a fresh gate
    (new snapshot) → fresh proxy reflecting current tiers; ungated bare egress
    unaffected by either.
11. **Existing R9 laws unchanged**: identity / aliasing / cycles (single-mode,
    scope-less → DETACHED slot) green without edits.
12. **inhuman-mcp wire-safe choke** (existing test, no edits): stays green.
13. **Wrapper-cache two-level**: same callable crossing typed (`z.procedure`) and
    untyped (nested-in-dict) paths in ONE scope gets TWO wrappers — the typed one
    keeps its marshalling regardless of crossing order.

## 6. Execution order

1. `values/types.ts` — `MembraneExit` (with `cache`), `EgressMode`, `BARE_MODE`
   (type-only imports everywhere downstream — the leaf stays clean).
2. `egress-proxy.ts` — `EgressOpts{gate?, membrane?}`; bare box-forever WeakMap +
   membrane materialization through `membrane.cache` (register-before-return per
   slot); gated egress in `WeakMap<TierGate, WeakMap<AValue, object>>`; header
   REWRITTEN to the bare=(box) / membrane=(box, mode, scope) / gate=(gate, box) laws
   + borrowed-carriers-are-a-fourth-class note; stopgap imports (`is_callable_value`,
   ACallable) reverted.
3. Containers ×3 — revert `toJS` to zero-arg, add `toJSMembrane`; ADict pending branch
   (keep the benign promise double-dispatch, §3.5); `pending-entry.ts` header line
   (native spines never hold pending cells).
4. `AValue.ts` — revert abstract to zero-arg, add optional `toJSMembrane` member; sweep
   non-container subclasses for the stopgap's dead optional params (Fable-verified: the
   stopgap param exists ONLY on AValue + the 3 containers — expect zero other hits,
   keep the sweep anyway).
5. `region-scope.ts` — `RegionScope.egressProxies` (init in `openRegionScope`,
   `reconstructRegionScope`, `DETACHED_SCOPE`); wrapper cache →
   `WeakMap<object, Map<WrapperKey, wrapper>>`; update the cache doc comment (its
   DefaultedWeakMap-rejection story becomes the two-level-key story).
6. `rosetta.ts` — `modeKeyOf` + the `_modeKeyExhaustive` type guard (+ comment on
   `RosettaOptions` pointing at it), `egressAValue` with scope pinning + `cache:
   pinned.egressProxies`; `schemeToJsImpl` AValue branch → `egressAValue`;
   `callableToHostFn` keys the wrapper cache by `modeKeyOf(options)`.
7. `scheme-zod.ts` `z.procedure` decode — wrapper cache key `"typed"`.
8. `membrane.ts#toJS` — `egressAValue(value, {})`; confirm the `Values` multi-value arm
   (recurses per element — expected no-op, verify not assume); grep `membrane.toJS` /
   exec-exit consumers for print-string reliance on nested callables (Fable pre-swept:
   expect zero edits — sole production importer is `eval/generator-exec.ts`).
9. Migrate `tiering-egress-gate.test.ts:52/64/83/104` (positional gate → `{ gate }`).
   `tiering.ts` itself: type import only, nothing to migrate.
10. `arrival-mcp/DiscoveryTool.ts:169-177` — fix the now-false "mirrors membrane.toJS"
    comment (hostFace stays bare deliberately: wire wants strings).
11. New law tests (§5); rewrite R9 prose: `egress-proxy.ts:6-9, 36-37, 116-122`
    headers, `docs/RULINGS.md:72`, and `crossing.law.test.ts:684`'s
    stale `two-tier-exec-api.md §5` citation (not in-tree — fix or drop). Then:
    arrival full suite, arrival-mcp suite, inhuman-mcp suite, targeted consumer builds
    (studio/cli), full monorepo build.

## 7. Resolved questions (was "open" — triad adjudicated)

- **Q1 — `membrane.toJS` shares `modeKeyOf({})`**: YES (3/3). Keeps
  `toJS(v) === schemeToJs(v)` for default options. Caveat stated: identity is
  default-options-membrane only, not a general cross-options bifunctor identity.
- **Q2 — `returnEither`/`argProvenance` in the mode key**: NO (2/3 + code adjudication;
  composer's inclusion argument rested on a wrong mechanism — wrappers mint in the
  region cache, which container-proxy slots never reach). Neither field is read by
  `schemeToJsImpl` nor by inbound `jsToScheme`; nested wrappers are bit-identical
  across them. Mode = `forceBigInt` only; the `_modeKeyExhaustive` type guard + pin
  test guard the future.
- **Q3 — recursion cost**: acceptable (3/3). One extra dispatch per MATERIALIZED
  element; unread keys free; dominated by proxy-trap overhead.
- **Q4 — lazy region-scope divergence**: FIX, by pinning at exit construction (2/3;
  longcat's counter refuted on mechanism — see §4). "Documented, not fixed" was this
  proposal's original §4 and is retracted.

## 8. Non-goals (explicit)

- Borrowed-container membrane crossing (§3.7) — source identity IS the law.
- Eager membrane peel (drop R9 laziness on the membrane path — grok-4.5's alternative
  #14.1): rejected; laziness is load-bearing for large-structure exits (studio), and
  per-mode caching preserves it at every depth.
- Ambient-exit holder (ALS-style) instead of parameter threading: rejected; reintroduces
  the exact lazy-read-outside-extent lifetime bugs §4 exists to close.
- `pure` on `RosettaFunction` in the mode key: it is a provenance-mint flag on the
  INBOUND wrapper, not an egress projection option (composer #22, refuted-as-gap).

## 9. Triad ledger (adjudication record)

- **Confirmed ≥2 + adopted**: scope pinning (grok45 #1, composer #13/14); region cache
  mode-keying (grok45 #2, mechanism-verified); forceBigInt-only mode (grok45 #3,
  longcat #2/#5); branded/exhaustive modeKey (grok45 #4, composer #5/6, longcat #3);
  depth≥2 tests (grok45 #5, longcat's stopgap recursion note); pending-entry law pin
  (grok45 #6, composer #9/10, longcat #6); R9 doc rewrite (grok45 #7, composer #2/21);
  gate stickiness (composer #1, grok45 #8); AJS* exclusion (grok45 #10, composer #17,
  longcat #10, + HEAD ledger pre-check); shared dispatch helper (composer #19, longcat
  #11); membrane.toJS flip test + consumer grep (longcat #8, grok45 #11); Values arm
  named in execution order (composer #18, grok45 #11); DiscoveryTool comment (composer
  #20); tiering bare-semantics assert (longcat #12).
- **Refuted with evidence**: longcat #1's CONCLUSION ("wire-safe.ts doesn't exist" —
  the file exists and both other models quoted it by line) — but its LOCATION claim was
  right and the rev-2 refutation's path was stale: the package had relocated within the
  private monorepo in `413b161875` (Fable finding 7 corrected the
  record); longcat #9 ("don't pin scope" — exit construction happens INSIDE the live
  `withRegionScope` window on rosetta paths, so pinning strictly dominates first-read
  capture; Fable re-verified both crossing paths + confirmed no foreign-scope capture
  exists); composer #7 (include returnEither/argProvenance — mechanism wrong, see Q2;
  Fable re-verified the read sites).
- **Acknowledged, kept as-is**: optional protocol member over branded interface
  (grok45 #9 + longcat #7: codebase-consistent, bivariance-checked, not a landmine —
  the containers-only contract lives in the doc comment).

### Fable final-review round (APPROVE-WITH-CHANGES — all folded into rev 3)

- **Finding 1 (design)**: (box, mode)-forever membrane cache unsound under pinned
  scopes — closed-scope wrapper resurrection + DETACHED pollution of the shared
  default slot. → membrane proxies are SCOPE-owned (`RegionScope.egressProxies`),
  law bare=(box) / membrane=(box, mode, scope); §3.3, §5.5.
- **Finding 3 (design)**: rev-2's "exhaustive destructure" compile guard was inert
  (destructuring is never exhaustiveness-checked; `satisfies` tautological). → the
  `Exclude<keyof …>`-based `_modeKeyExhaustive` type guard; §3.3.
- **Finding 4 (design)**: typed/untyped wrapper collision on `scope.cache` is real,
  pre-existing, made hot by this plan; inner key is `WrapperKey = EgressMode |
  "typed"` (live domain excludes "bare" — it never mints wrappers); scheme-zod
  migrates in the same pass; within-"typed" schema collision = explicit non-goal;
  §3.3, §5.13, §6.7.
- **Finding 5 (design)**: rev-2's identity-sticky gate THROW would brick tiering's
  intended re-serve-after-tier-movement flow (gates are fresh closures per snapshot;
  tiering has zero production wiring today, so the throw would ship dormant). → gated
  egress caches per (gate, box); "a gate is snapshot-scoped; its proxies are too";
  §3.4, §5.10. Also corrected: rev-2's claim that tiering.ts calls
  `egressContainerProxy` was wrong (type import only; the test is the sole caller).
- **Findings 2/6 (verification)**: 3-slot lattice confirmed (no latent bare-vs-mem:0
  divergence beyond callables + pending settle); membrane.toJS flip contained (sole
  production importer `eval/generator-exec.ts`; zero consumer edits expected; the
  JSON.stringify-omits-fn-keys delta documented in §3.2).
- **Findings 7-10 (docs)**: wire-safe path correction; migration list pruned to real
  call sites; R9 prose targets named (`RULINGS.md:72`, egress-proxy headers, the stale
  `two-tier-exec-api.md` citation at `crossing.law.test.ts:684`); ADict pending
  double-dispatch no-op noted so the executor doesn't "fix" it.
