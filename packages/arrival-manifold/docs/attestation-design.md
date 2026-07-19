# Attestation: branded `s/*` values and the uniform tool-boundary check

**Status: design (docs/attestation-design.md 0); implemented in bind.ts (buildManifoldEnv/rosettaDef) since 2026-07-05.**

The idea (V): make the `s/*` validator family produce *attested* values, and make every
manifold-bound tool argument *attestation-requiring* — uniformly, no per-function
declarations. A model cannot pass a bare model-authored value into a tool; it must wrap
it: `(s/number 37)` / `(s/string "Berlin")`. This is an explicit decision about *what the
value is*, not a type hint. Tool return values are machine-attested automatically, so
nested composition `(outer :x (inner ...))` stays free; plucked fields inherit; computed
values deliberately lose attestation and must be re-attested.

This is **provenance/taint-flow, not typing** — and the code confirms the frame is real:
arrival already carries taint (the provenance set) on every value, but with the *wrong
algebra* for attestation, which is exactly what decides the mechanism below.

---

## 1. Verified code facts

### F1 — Value boxing and identity: boxes are distinct per occurrence, sidecar-carriable

- `fromJs` (`foundations/arrival/arrival/src/values/primitives/boxing.ts:44-67`) always
  constructs `new AString(...)` / `new AExact(...)` / `new AInexact(...)` per crossing.
  **No small-number or string interning anywhere.** A `WeakSet<AValue>` can carry
  per-value attestation for scalars, pairs, vectors, dicts.
- `AJSObject.get` is **identity-stable per (wrapper, key)**: a module-private
  `WeakMap<AJSObject, Map<string, SchemeValue>>` entry cache
  (`values/primitives/AJSObject.ts:51`, hit at `:141-144`, stored at `:176-182`) —
  `(eq? (@ r :x) (@ r :x))` holds. Note the cache is deliberately encapsulated
  (unreachable from outside the module), which forecloses any manifold-side "register
  the plucked boxes from outside" scheme.
- `withProvenance` **always mints a new instance** (`AValue.ts:74-83`, "AValues are
  immutable — provenance updates mint a new instance"); `AJSObject.withProvenance`
  additionally resets the entry cache (`AJSObject.ts:109-117`).

### F2 — Interning / singletons: four shared-box families, enumerated

| Type | Shared instance | Site | Attestation hazard |
|---|---|---|---|
| `ABool` | `schemeTrue` / `schemeFalse` | `ABool.ts:51-52`; reused by `fromJs` **only on the empty-provenance fast path** (`boxing.ts:56-57`) — a provenance-stamped boolean is a fresh `new ABool` | stamping the singleton = every `#t` in the program becomes attested |
| `ANil` | `nil` | `ANil.ts:127`; `jsToScheme` returns shared `nil` for `null` only when provenance is empty, else fresh `new ANil(ctx, provenance)` (`rosetta.ts:284-287`). **`AJSObject.get` returns shared `nil` for missing/blocked keys** (`AJSObject.ts:154,157`) | leak + "absent field is attested" nonsense |
| `AVoid` | `theVoid` | `AVoid.ts:63`; **returned shared even on provenanced paths** (`rosetta.ts:288-291`, `boxing.ts:72`) | leak |
| `ASymbol` | per-RunContext flyweight intern table | `ASymbol.ts:23-38`; the file's own invariant: a provenance stamp "mints a fresh uninterned copy via this sentinel" (`ASymbol.ts:12-15`) | keywords are shared within a run |

Identity guards: **no `=== schemeTrue` / `=== schemeFalse` / `=== theVoid` / `=== nil`
guard exists anywhere in `src/`** (grep over non-test sources: zero hits). Truthiness is
structural — `is_false` (`values/value-guards.ts:71`) checks instance shape, not
reference. So **fresh-boxing a boolean is safe**: `(s/boolean #t)` may return a fresh
`ABool` clone without breaking any evaluator behavior.

**Resolutions** (per family):
- `ABool`: `s/boolean` returns a **fresh clone** when handed a shared singleton
  (`v.withProvenance(v.provenance)` — always mints, `ABool.ts:38`), attests the clone.
  The program-wide singletons never enter the attestation set.
- `ANil` / `AVoid`: **exempt — never attestable.** The `attest()` entry point refuses
  them by identity check (cheap: `v === nil || v === theVoid || v instanceof AVoid`).
  The `s/*` validators already reject them (`typeof` tests fail on `null`/`undefined`).
  The auto-attest walk (§3) skips them; a plucked missing key is shared `nil` and stays
  unattested — correct: "absent" is not a value a tool should receive as attested.
- `ASymbol`: **exempt.** Keywords are call syntax (consumed by `collectKwargsObject`,
  never a payload), and no `s/symbol` exists. If one is ever needed, the interning
  invariant already prescribes the road: mint an uninterned copy (`ASymbol.ts:12-15`).
- `AExact` / `AString` / `AInexact` / containers: no sharing (F1) — no special handling.

### F3 — Stamp survival: reference semantics everywhere that matters

- **`let` / argument passing / list & vector element storage**: the evaluator binds and
  stores evaluated `AValue` boxes by reference; no re-boxing occurs on binding or
  variable reference. `car`/`vector-ref` return the **stored element box** (the
  deep-stamp war story in `rosetta.ts:255-263` exists precisely because `car` returns
  the stored box — pre-deep-stamp, `(car (infer …))` surfaced an element that had never
  been stamped).
- **The kwargs decode path preserves identity end-to-end**: `collectKwargsObject`
  (`common/symbols/_bake.ts:276-287`) folds `:key value` pairs into a plain record
  **valued by the raw scheme boxes**; the manifold's per-property codec is `z.value` =
  `z.custom<SchemeValue>()` — a no-transform identity schema
  (`common/scheme-zod.ts:65`). The box the model's expression produced **is** the box
  the manifold impl sees in `decoded[p.name]` (`arrival-manifold/src/bind.ts:123-128`).
- **The `s/*` validators are validating identities**: on pass they return `decoded`
  unchanged (`bind.ts:76-79`) — the attested box then flows by reference through `let`,
  args, and the next call's kwargs fold. (Wrinkle: they are *rosetta* symbols, so their
  return re-crosses `jsToScheme` in `bakeRosetta` step 4 — see §3, "the s/* mint".)
- **Membrane re-box sites** (where fresh boxes are minted carrying a parent's
  provenance): `AJSObject.get` boxes lazily via
  `jsToScheme(this.ctx, raw, {}, this.provenance)` (`AJSObject.ts:175`);
  `AJSArray` boxes elements the same way on materialization (`AJSArray.ts:94-100`);
  `bakeRosetta`'s return path deep-stamps via `jsToScheme(..., resultProvenance)`
  (`_bake.ts:551-560`). These three are the **inheritance sites**.

### F4 — Computation freshness: compute mints fresh boxes; the drop algebra is free

- Cluster builtins (`string-append`, `+`, comparisons, copies…) produce **fresh**
  results and stamp them via `withInputProvenance`
  (`values/op-helpers.ts:364-375`): the result is either a fresh construction, a
  `result.withProvenance(prov)` **clone** (`:369` — always a new instance, F1), or a
  fresh `fromJs` boxing of a raw scalar (`:372`). Numeric ops route through
  `coerceNumeric` (`op-helpers.ts:273-299`) — always `new AExact`/`new AInexact`.
  **An identity-keyed attestation therefore drops through computation automatically.**
- Provenance itself, however, **forwards** through computation (that is
  `withInputProvenance`'s whole purpose, and `unionProvenance`'s singleton-forwarding
  returns the *same set reference*, `AValue.ts:104-115`). `(+ (:a r) 1)` carries `r`'s
  provenance set — **indistinguishable from a pluck at the provenance level**. This is
  the decisive fact: *the existing provenance channel has union/forward algebra;
  attestation needs drop-on-compute algebra. They are different channels.*
- Identity fast-paths that pass an input box through unchanged (would *preserve*
  attestation): `fromJs` same-instance short-circuit (`boxing.ts:32-33`), `jsToScheme`
  same-provenance short-circuit (`rosetta.ts:300-301`) — both are membrane
  pass-throughs of the *same value*, i.e. desired preservation, not laundering.
  Control flow (`if`/`cond`/`let`/`begin`) returns the chosen sub-expression's box
  unchanged — a **select**, and select preserving attestation is intended (the value
  *is* one of the attested values). Implementation audit item: select-like builtins
  that may return an input box directly (`max`/`min` style) — acceptable if they do
  (they select), but enumerate during implementation.

### F5 — The boundary site: one choke point, per-argument names, even the right `s/<kind>` hint

- `bakeRosetta`'s kwargs arm decodes the folded object (`_bake.ts:512-518`) and hands
  the manifold impl `decoded` — scheme boxes, pre-`schemeToJs`. The manifold's own
  wrapper loop (`bind.ts:123-128`) iterates `signature.params` and touches each
  supplied box **before** unwrapping: this is the ONE uniform check site, entirely
  inside arrival-manifold.
- Error naming: the loop has `p.name`; and `KwargParam.schema` carries the tool's raw
  JSON-Schema property (`tool-signature.ts:30-34`), so the message can suggest the
  *specific* wrapper: `type: "integer"` → `(s/integer …)`, etc.
- Tool returns: manifold tools are **source** rosettas (not `pure`), so `bakeRosetta`
  mints `pointProvenance(inv.id)` and deep-stamps the whole return via `jsToScheme`
  (`_bake.ts:534-560`). The auto-attestation walk rides this exact site.

---

## 2. Mechanism: core attestation registry (WeakSet) + three stamp sites

**Rejected: pure manifold-side `WeakSet` sidecar (zero core change).** It carries `s/*`
stamps fine, but pluck-inheritance is unreachable: plucked boxes are minted *inside*
`AJSObject.get` / `AJSArray` / the `bakeRosetta` return walk, all core-internal, and the
entry cache is deliberately encapsulated (F1). A same-set-reference pre-boxing trick
(exploiting `rosetta.ts:300-301`'s fast path to make plucks return manifold-registered
boxes) exists but couples to membrane internals — noted as a spike option, not the design.

**Rejected: riding the provenance set.** Wrong algebra (F4): provenance forwards through
computation; attestation must drop. Also rejected: a new constructor field on `AValue` —
`withProvenance` clones serve both the compute path (must drop) and the deep-stamp path
(must set), so a field would need per-call-site clone semantics; a registry keyed by the
box expresses "drop unless explicitly carried" natively.

**Chosen:** a tiny core module — `foundations/arrival/arrival/src/values/attestation.ts`:

```ts
const attested = new WeakSet<AValue>();
export function attest<V extends AValue>(v: V): V;   // refuses nil/theVoid/interned ASymbol/ABool singletons (no-op)
export function isAttested(v: unknown): boolean;      // false for non-AValue
```

Stamp sites (all additive, each mirrors an existing provenance touch):

1. **Auto-attest tool returns** — `jsToScheme` gains `RosettaOptions.attest?: boolean`,
   threaded through its recursion; every value it constructs (and every same-identity
   fast-path return) is `attest()`ed. `bakeRosetta` step 4 passes `attest: true` iff the
   invocation minted a provenance point (`_bake.ts:541` — i.e. source rosettas under a
   live run). Container spines and leaves get attested in the same one-pass walk that
   deep-stamps provenance today — so `car`/`vector-ref` on tool results return
   already-attested stored boxes (F3).
2. **Pluck inheritance** — `AJSObject.get` (`AJSObject.ts:175`) and `AJSArray`'s element
   materialization (`AJSArray.ts:99`) pass `attest: isAttested(this)` into their
   `jsToScheme` call. Inheritance is literal: an entry is attested iff its container is.
   The per-(wrapper, key) cache (F1) keeps it stable.
3. **The `s/*` mint** — each validator, on pass, returns `attest(freshIfSingleton(decoded))`.
   Because validators are themselves source rosettas whose return re-crosses
   `bakeRosetta` step 4, the simplest correct cut is: mark the `s/*` defs `pure: true`
   (they *are* transforms — forwarding input provenance is also more honest than minting
   a fresh origin for a passthrough) **and** let stamp-site 1's flag be
   `attest: true` for them explicitly, or attest in the impl and rely on the
   same-provenance identity fast path (`rosetta.ts:300-301`) returning the very box the
   impl attested. Decide at implementation; the test `s-wrap-passes` pins the behavior,
   not the route.

Enforcement stays wholly in the manifold (`bind.ts` `rosettaDef` impl loop):

```ts
for (const p of signature.params) {
  if (p.name in decoded) {
    if (mode === "required" && !isAttested(decoded[p.name])) throw attestationError(qualifiedName, p);
    args[p.name] = schemeToJs(decoded[p.name]);
  }
}
```

Scope guard: the check applies to **manifold tool bindings only** — the `s/*` family and
the `slug/tool` rosettas this package binds. Core arrival symbols (`string-append`, `+`,
`map`…) are computation, not tools; they never check.

## 3. Flow algebra

| Expression shape | Carrier event | Verdict at tool boundary |
|---|---|---|
| literal `37`, `"x"`, `#t`, `'(1 2)`, `{...}` | reader/eval-minted box, never attested | **rejected** |
| `(s/number 37)` | validator attests (identity return, `bind.ts:76-79`) | passes |
| `(inner ...)` nested in an outer call | return walk attests every node (site 1) | passes |
| `(:k r)` / `(@ r :k)` / `(@ r "k")` | `AJSObject.get` inherits (site 2) | passes iff `r` attested |
| `(car r)` / `(vector-ref r i)` / `(list-ref r i)` | stored box, attested by return walk | passes iff produced by a tool |
| `(let ((x A)) … x)`, lambda args | reference passing (F3) | preserves A's verdict |
| `(if c A B)`, `(and …)`, `(or …)` | select — returns an operand's box | preserves the selected operand's verdict |
| `(+ (:a r) 1)`, `(string-append …)`, any compute | fresh box (F4), not attested | **rejected** — model re-attests |
| `(s/number (+ (:a r) 1))` | re-attestation (deliberate laundering) | passes |
| `(map f r)` and other HOF products | fresh containers per element op | **rejected** unless re-attested (honest: a transform is a computation) |
| missing key → `nil`; `#void` | exempt singletons (§F2) | rejected (and `s/*` reject them too) |

`s/object` / `s/array` (not yet built; the four scalar validators landed in `bind.ts`):
**shallow semantics** — the wrapper attests the container box only; element attestation
is whatever each element carries. Site-2 inheritance then makes plucks *from an attested
container* attested, which composes correctly: `(s/object {…})` over a model-authored
dict makes the dict passable as a whole AND its plucked fields passable — one decision
covers the aggregate, matching the "explicit decision on what the value is" intent.
(A dict mixing tool-derived and model-authored fields is a container the model *built* —
computing — so requiring one explicit `s/object` on it is the intended friction.)

## 4. Config knob

`attestation: "off" | "available" | "required"` — threaded exactly like `evalTimeoutMs`
(`config.ts:28` schema optional field → `ManifoldConfig` (`config.ts:42`) →
`buildManifoldEnv` / `manifold-tool`). Default **`"available"`**.

- `"off"` — `s/*` bind as plain validators (today's behavior); no stamping, no checks.
- `"available"` — full stamping (sites 1-3) live; boundary check runs but only *counts*
  (a per-call `unattested: [":amount"]` note in the observation / a warn) — the
  measurement mode for model-compliance friction before flipping the default.
- `"required"` — boundary rejects unattested args with the frozen error below.

## 5. Frozen error shape

```
Error: tool argument :amount requires an explicit type assertion — wrap it: (s/number 37)
```

Construction: `tool argument :<param> requires an explicit type assertion — wrap it:
(s/<kind> <preview>)` where `<kind>` derives from `KwargParam.schema.type`
(`tool-signature.ts:30-34`; `integer`→`s/integer`, `number`→`s/number`,
`string`→`s/string`, `boolean`→`s/boolean`, `object`→`s/object`, `array`→`s/array`,
absent→`s/string` as the safest default) and `<preview>` is the argument's own value via
the existing `previewOf` (`bind.ts:49-52`, 60-char cap). Model-recoverable in one turn:
names the arg, shows the exact wrap, echoes the value. Consistent with the `s/*` family's
existing door voice ("expected a number, got string: …").

## 6. T-layer future note

Under the typed constrained-decode rework (Σ∩T), tool-arg slots become
`Attested<number>` branded slots: the only expressions inhabiting the type are `s/*`
applications and tool-call results — the wrap becomes **structurally forced by the
sampler's mask**, and the runtime check degrades to a belt-and-braces assert that never
fires. The runtime design here is the semantics; the T-layer makes wrong states
unrepresentable at generation time. (The same brand also gives the harvest printer an
honest signature: `s/number : number → Attested<number>`.)

## 7. Honest cost note

- **Tokens**: `(s/number …)` ≈ 4-6 extra tokens per wrapped literal; a typical 2-3
  literal-arg call pays ~10-20 extra tokens. Tool-chaining pays ~zero (auto-attest).
  The catalog preamble must teach the convention once (~60-80 tokens).
- **Friction**: models will forget the wrap on first contact; the error is single-turn
  recoverable but each miss costs a round trip. Expect measurable first-call failure
  rates on smaller models (the AppWorld prose-for-number cohort this family targets) —
  which is exactly what `"available"` mode exists to measure before `"required"` ships.
- **Perf**: WeakSet add/has on membrane paths — O(1), no GC pinning (weak), negligible
  against the existing per-crossing allocation.

## 8. Test plan (manifold `__tests__/attestation.test.ts`, plus one core suite for the walk)

1. **literal-rejected** — `(tool :amount 37)` → error names `:amount`, suggests `s/number`.
2. **s-wrap-passes** — `(tool :amount (s/number 37))` → invoke receives `37`.
3. **tool-result-passes** — `(outer :x (inner :a (s/number 1)))` free composition.
4. **pluck-inherits** — `(:price r)`, `(@ r :price)`, `(@ r "price")`, `(car r)`,
   `(vector-ref r 0)` all pass when `r` is a tool result; nested `(:a (:b r))` too.
5. **computed-relaundered** — `(+ (:a r) 1)` rejected; `(s/number (+ (:a r) 1))` passes;
   `(string-append (:name r) "!")` rejected.
6. **binding-preserves** — `(let ((x (s/number 5))) (tool :a x))` passes; lambda-arg
   passing too; `(if c (s/number 1) (s/number 2))` passes (select preserves).
7. **singleton edges** — `(s/boolean #t)` passes AND an unrelated bare `#t` in the same
   program remains rejected (no program-wide leak); missing-key `nil` and `#void`
   never attested; a second run context sees nothing.
8. **shallow s/object** — attested dict passes whole; its plucked field passes; a fresh
   dict built from attested parts is rejected until wrapped.
9. **config knob** — `off`: no rejection, no counting; `available`: passes but reports;
   `required`: rejects. Omitted-optional args are never checked.
10. **core walk suite** — return-walk attests spine+leaves of pair/vector/dict/scalar
    returns; `AJSArray` materialization inherits; cache stability (`eq?` + attested twice).

## 9. Effort: **M**

Core: `attestation.ts` (~40 lines) + `attest` flag threading through `jsToScheme`'s
recursion + two one-line inheritance hooks (`AJSObject.get`, `AJSArray`) + the
`bakeRosetta` step-4 flag — all additive, but they touch the membrane hot path while
concurrent agent work (schemevalue/membrane drift, env-capability migration) is in
flight: coordinate, and gate on the BUILD not typecheck (per
`feedback-arrival-build-authoritative-not-typecheck`). Manifold: validator attest +
boundary loop + knob + error + tests, all in files this package already owns. Not S
because of the core-coordination surface; not L because every site is named above and
none is a redesign.
