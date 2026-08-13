# Hermeticity audit — 2026-08-13

> **Status update (same day, final):** ALL findings are FIXED on main. Breaches
> B2/B3/B4 red-test-first (rulings below); Wave B placement shipped (B1 →
> `src/reactivity/`, P1 `run/path-algebra.ts`, P2 `run/penetration.ts`, P3 `is_promise`
> → value-guards, P4 reader parse, P5 typecheck → membrane/ + promises repoint, E4);
> Wave C declarations shipped (S5/S6 → `docs/strata.md` — the stratum registry this
> audit called for; S1/S2/S4/D1–D8/E1–E3/F7–F9/W11 as doc sentences, censuses, and the
> §AXES legal-region table; E1 also consolidated the six axis doors under
> `assertContractAxes`; E2 under `defOf`). E3 resolved as documented-exception
> (arrival-mcp consumes `testCallCtx` from the root barrel). S3 resolved as sanction
> comment (rerouting through `_lookupWithResolvers` is not behavior-identical — it
> would run resolver side effects). Rulings recorded as RULINGS.md **R10** (world flip — a
> rosetta impl returning an AValue crashes, `WorldFlipError`; `z.dynamic`'s return face is
> now `unknown`), **R11** (contract seal — frozen at instantiation, stampers re-mint under
> runtime whitelists; plus `assertSlotKinds` runtime twin in every factory), **R12**
> (prelude persistence — B4 resolved the OPPOSITE way from the disjointness-assert
> proposal below: prelude defines PERSIST per-run, preludeOnly names stay unresolvable,
> "invocation survives, reference does not", incl. mid-run require/extension). Law
> suites: `common/__tests__/{slot-kind-gate,rosetta-world-flip,contract-seal}.law.test.ts`,
> `env/__tests__/prelude-persistence.law.test.ts`.

**Premise (V's ruling):** arrival is layers of hermetic primitives stacked one by one. Walls must be
declaration-shaped and crisp — contours may be big or small, the only thing they are not allowed to
be is **vague**. This audit checks every wall against that rubric.

**Method:** six parallel read-only auditors, one per wall-set, each doing mechanical verification
(import greps, holder inventories, doc-claim cross-checks — no trusting comments). Verdicts:
**CRISP** (contour declared and true), **VAGUE** (contour exists in code but its declaration is
missing, stale, or false), **BREACHED** (a value crosses a wall the architecture forbids).

**Headline:** the deliberately built walls hold. Three breaches, one false invariant, and the
vagueness concentrates in exactly two structural absences — **no stratum map document exists**, and
**the interpreter knot is emergent rather than declared**. Almost every local finding is a symptom
of one of those two.

---

## 1. Observed topology (measured from imports, not docs)

```
errors.ts (leaf, type-only)          well-known-symbols (0 imports)
        ───────────── THE KNOT (one SCC, ~8 buckets) ─────────────
        values ⇄ eval ⇄ membrane ⇄ run ⇄ common/symbols
               ⇄ common/scheme-zod ⇄ env ⇄ provenance
        ───────────────────────────────────────────────────────────
reader*  symbol  emit  static-validation*  oracle  type-layer
loader  capabilities  utils*  lsp-/host-/reflect-internals  index.ts
```

Everything above the knot is one-directional (`*` = has upward leak edges, see findings). The knot
is real and arguably **by design** — tagless-final means value classes implement both interpreters,
so `values` must see `eval`/`membrane`. It is held together today by *local* cycle notes (ACallable
header, CallCtx header, scheme-zod type-only note) but **no document declares the SCC as one named
contour**. Big is fine; emergent is not.

Within the knot the practiced value-edge direction for the run stratum is:
`run/` (base) ← `membrane`/`common/symbols` ← `eval` ← `env` — with one file violating it (B1).

---

## 2. Verdict summary

| Wall | Verdict | Finding |
|---|---|---|
| Membrane crossing totality (toJS/jsToScheme) | CRISP | — |
| Region-scope confinement | CRISP | container gap comment-only (D2) |
| Interop sealing | CRISP | — |
| Bake↔runtime membrane split | CRISP | — |
| Values carry no run-state | CRISP | verified — no regrowth |
| eval→env direction (readers/writer-door/root) | CRISP | — |
| Frame birth + storage write chokepoint | CRISP mech. | perimeter statements stale (S2, S3) |
| Bootstrap vs mid-run assembly | CRISP | PreludeBindTarget dual semantics (E5) |
| Capability↔run state | CRISP | — |
| Provenance package boundary (5 subpaths) | CRISP | criterion shelved in file headers (D5) |
| errors.ts leaf + ErrorClass taxonomy | CRISP | — |
| MobX/plexus wall, export map, disposal | CRISP | — |
| Path-producer placement (I9 pattern) | CRISP | **the model wall — copy this shape** |
| §3 "one reader" claim | **VAGUE** | doc false; code is clean 2-reader (D1) |
| Dynamic-extent holder roster | **VAGUE** | 5 real holders, 3 declared (S1) |
| Keyed-residency statics ("fourth home") | **VAGUE** | pattern used 5×, undeclared (S4) |
| Axis-product legal region | **VAGUE** | 6 doors, 5 sites, no map (E1) |
| Channel algebra vs channel module | **VAGUE** | P1, P2 |
| Stratum map | **VAGUE** | does not exist (S5) |
| Interpreter knot | **VAGUE** | undeclared contour (S6) |
| run→eval in reaction-envelope | **BREACHED** | B1 |
| Contour/crossing brand runtime twin | **BREACHED** | B2 |
| Post-bake stamp channels | **BREACHED** | B3 |
| preludeOnly/main disjointness | **FALSE INVARIANT** | B4 |

---

## 3. Breaches

**B1 — `run/reaction-envelope.ts` value-imports `eval/generator-exec`** (reaction-envelope.ts:46).
Found independently by two auditors. `run/` is the base stratum every layer imports; this one file
sits *above* eval (it composes whole `exec` runs, fresh caches, hub scheduling — a host-tier
orchestrator misfiled in the leaf). Also the edge closing the bucket-level cycle with
`generator-exec → run/reactive-atoms`.
*Fix:* `git mv` to a new tier above eval (e.g. `src/reactivity/` or `src/host/`); `run/` keeps bus +
atoms + algebra; host-internals barrel path updates. Nothing else moves.

**B2 — Contour/crossing brand bans have no runtime twin; the preamble claims one**
(_bake.ts:20 vs :219–314). `ContourOnly`/`CrossingOnly` exist only in type positions; an `as any`
caller can bake `native` with `z.dynamic` slots or `rosetta` with `z.schemeValue`, and nothing
catches it — precisely the hole `assertNoResourcePathProducers` closes for the path axis. Runtime
detection is trivially available (`z.lookupName`, `cacheGateSlots`).
*Fix:* `assertSlotKinds(name, kind, inSchema, outSchema)` in `_bake`, called by every factory —
copying the I9 pattern exactly. Red-test-first.

**B3 — `withContractFields` / `withCallbackRoles` stamp sealed contracts after all gates ran**
(_bake.ts:827–833, :819–823). `Object.assign` with only a type-level `Pick` restriction: an untyped
caller can stamp `queries`/`cacheClass`/`provenance` post-bake. Inert for dispatch, but
harvest/catalog/static readers treat contract fields as truth — introspection lies.
*Fix:* runtime key whitelist (4 keys) + roles-vocabulary check. Red-test-first.

**B4 — False invariant: "main map + preludeOnly are disjoint by construction"**
(assemble-run.ts:129–130). Routing is per-*definition*: cap A's `preludeOnly x` + cap B's plain `x`
lands `x` in both maps, and overlay order silently makes the assembly-only value shadow the runtime
one inside every prelude. Undefined collision semantics presented as impossible.
*Fix:* assert disjointness at end of `buildFresh` with a teaching error naming both capabilities
(or rule shadowing in, explicitly) + one law test. Red-test-first.

---

## 4. Structural vagues (the two roots + convergent patterns)

**S5 — No stratum map exists anywhere.** docs/README.md maps docs↔dirs; no document states intended
dependency order. Every other verdict in this audit had to be judged against *measured* topology
because there is no declared one. *Fix:* one §STRATA section (execution.md §0 or `docs/strata.md`):
bottom-up bucket list, the declared knot, the rule for new directories ("may depend on the knot,
never join it"). Make it the wall registry this audit becomes the seed of.

**S6 — The interpreter knot is emergent.** 8 buckets, all mutual at value level, held by scattered
local cycle notes. *Fix:* name it once in §STRATA ("two-interpreter core", closed member list).

**S4 — The unnamed fourth home.** execution.md §1 HERMETIC names three homes for state; a fourth
pattern — module-level WeakMap/WeakSet keyed by a run-scoped object, lifetime = the key's — is used
5×: `inFlight` (run-cache.ts:142), `retiredRuns`/`lastRunByBus` (reactive-atoms.ts:118,120),
`lifecycles` (run-lifecycle.ts:31), `vocabularyByRunCtx` (assemble-run.ts:85). Found independently
by two auditors. *Fix:* add home #4 ("keyed residency") to §1 and cite it from all sites.

**S1 — Dynamic-extent holder roster under-declared.** §HERMETIC enumerates three (handler stack,
call-site, region scope); reality adds `globalThis.__arrivalRunResolver` (evaluator.ts:273) and
provenance-hooks `_coordinate`/`_sink` (:45–46). Two sub-hazards:
- `__arrivalRunResolver` save/restore is synchronous around a possibly-async apply
  (evaluator.ts:2688–2703) — a consumer past an `await` reads a stale/foreign resolver. Whether
  trampoline discipline makes this unreachable is exactly what's undeclared. *Fix:* declare the
  sync-extent guarantee + why async consumers cannot exist, or add a guard door.
- `_coordinate`/`_sink` are per-recording-run state in a depth-varying holder — two concurrently
  recording runs would interleave sinks. *Fix:* declare "at most one recording run per isolate," or
  key by runCtx.

**S2 — Stale perimeter censuses** (three instances of one failure class: the enumeration that
*defines* a perimeter no longer matches code, though every actual member is legitimate):
- AmbientRuntime writer census misses 5 writer families (γ ingress, mid-run prelude overlay,
  gensym hoist, chain-frame seeding). *Fix:* restate as families.
- bindValue declared "NOT barrel-exported" while host-internals exports it (:134, own
  justification). *Fix:* name the single sanctioned re-export in the preamble.
- `values/op-helpers.ts` header claims "imports only value-type classes" while value-importing
  run/CallCtx + membrane. *Fix:* rewrite header to the true contour.

**S3 — `__env__` wall is convention-fenced.** Public mutable field; discipline holds (grep: zero
violations) but two raw readers exist outside the class — vocabulary.ts (stated reason) and
`oracle/env.ts:83` (no sanction, bypasses the `RawCrossingError` door). *Fix (smallest):* sanction
or reroute the oracle read; enumerate raw readers next to the writer census. Symbol-keying the
store is the structural fix — optional, bigger.

---

## 5. Enforcement/consolidation vagues

**E1 — Six pairwise axis doors, five sites, no legal-region map.** sink⇒void, transparent⇒void,
fan⇒lambda (`assertProvenanceRoleShape`), view⇒serializable (`assertCacheClassShape`),
queries⇒serializable (`assertResourcePathContractShape`), sink∧queries + effects-only-return
(**inline anonymous ifs in rosetta.ts:178–193** — the two newest doors, not named gates beside
their siblings). *Fix:* one `assertContractAxes(...)` aggregator in `_bake` called by every
factory + a legal-region table (roles × axes, each cell legal/door + error class) in
environments.md §AXES — which still says the axes "never mix" (predates all six doors).

**E2 — Four independent `_zod.def` reach-ins, one drift pin.** Only `resolveCore` pins "zod 4.3.6";
`topLevelSchemas`, `cacheGateSlots`, positional-rejection each break independently on a zod bump.
*Fix:* one `defOf(schema)` exported from scheme-zod under the single pin.

**E3 — Export-tier rule unstated.** `makeCallCtx`/`testCallCtx` (dispatch machinery, "THE ONE
construction site") sit on the public stable tier while siblings sit on host-internals. *Fix:*
state the per-symbol tier rule in the index header; demote unless a public consumer exists.

**E4 — run-cache totality comment names one gate where two now carry it** (run-cache.ts:282 —
`assertCacheClassShape` + `assertResourcePathContractShape` since path-Q view-elevation). *Fix:*
one comment naming both.

**E5 — `PreludeBindTarget`: one interface, two semantics.** Bootstrap `.set` persists; mid-run
`.set` dies at `require()` return. kernel.ts documents it; the interface type doesn't. *Fix:*
"persistence is CALLER-DEFINED" in the jsdoc, or two named types.

**E6 — `coerceNumeric(value, ctx = CONSTANT_CTX)`** (op-helpers.ts:267) is exactly the defaulted-ctx
shape §CALLCTX brands a latent hazard, undeclared as sanctioned. *Fix:* one header sentence or drop
the default.

---

## 6. Placement vagues (git-mv-shaped)

**P1 — `resource-paths.ts` conflates shared vocabulary with a channel.** Every sibling channel
value-imports its pure algebra (overlap, serialize, path type) while the file is also the
resourcePaths *channel* (journal, door, CQS apply). *Fix:* split `run/path-algebra.ts` from the
channel, or declare the dual role in header + §CHANNELS.

**P2 — `penetrateThroughCache` composes four channels but lives in `run-cache.ts`** (named for
one). Chokepoint discipline holds (sole caller = rosetta). *Fix:* move to `run/penetration.ts` or
declare in-place.

**P3 — `is_promise` stranded in eval/.** Six value modules runtime-import it FROM eval, and
`eval/guards.ts` drags Macro/Syntax/TF_EXPAND transitively into the value kernel + a values⇄eval
runtime cycle — manufacturing the only values→eval entanglement. *Fix:* move to
`value-guards.ts`; `eval/guards` re-exports.

**P4 — `reader/extract-defines.ts:20` imports `parse` from generator-exec** which delegates
straight back to reader/parse — a gratuitous upward edge making reader non-leaf. *Fix:* one line.

**P5 — `utils/` imports upward** (promises→eval, typecheck→membrane ×2). *Fix:* relocate two files
or rule utils leaf-only.

**P6 — `env/macros/macros.ts:85` performs an evaluator-family hygiene write** from an env pack
file. Sanctioned family, wrong stratum for the machinery. *Fix:* tag comment; relocation optional.

**P7 — `CallCtx.ts:8` type-imports membrane** — tolerable, but no rule says type-only upward
imports are sanctioned. *Fix:* state it once in §HERMETIC, or move `InvocationLike` to a leaf.

**P8 — `reader/specials.ts:8` → CONSTANT_CTX** semantically fine; nothing declares
CONSTANT_CTX as the universally-importable ctx leaf. *Fix:* one sentence in RunContext.ts header —
converts N ad-hoc edges into one declared affordance.

---

## 7. Doc-lag vagues (one-sentence batch)

**D1** — execution.md §3 "One reader… no other site consults them" is contradicted by §8/§13 of
the same doc *and* by code (found independently twice). Rewrite to enumerate the sanctioned
readers: rosetta chokepoint (per-penetration) + eval loop (per-form guard, unit clock, liveness
note). **D2** — the `z.list(z.dynamic)` shallow container gap is named only in code comments; add
one sentence to membrane.md §REGION. **D3** — scheme-zod (845-line crossing member of the knot)
has no module charter. **D4** — membrane.ts:22 → env/AmbientRuntime value import unmentioned in
its charter. **D5** — the provenance-wall criterion lives only in file headers; PROVENANCE.md
never names the package or the wall — add one §WALL paragraph ("the five subpaths are the only
door"); optional: rename core `uneval.ts` → `wire-emission.ts` to dissolve the name collision.
**D6** — eval ⇄ static-validation mutual, declaration not found. **D7** — "syntax by class,
semantics by term" (the two-channel values-execution surface) is stated only in a guards comment;
add to PRINCIPLES. **D8** — `HubPublicBus.observe` silent no-op absent from every design-doc layer
table (second audit to flag it).

---

## 8. Crisp walls to copy (the pattern)

When crisping the above, copy these shapes — each is a wall that passes the rubric completely:

- **Path-producer placement (I9):** type-level field placement + runtime twin in every factory +
  by-construction for tagless + both ends cross-named + law-tested. B2/E1 should copy this exactly.
- **env ⇄ provenance mutual:** both directions carry charters — the model for a *declared* big
  exception (findings P1–P8 should copy the charter style).
- **errors.ts:** declared leaf, closed commented union, single home, deprecated fallback.
- **Interop sealing:** one primitive, one owner, one enforcement site.

---

## 9. Suggested crisping order (pending V's rulings)

1. **Wave A — enforcement, red-test-first:** B2 (`assertSlotKinds`), B3 (stamp whitelists),
   B4 (disjointness assert + law), E1 aggregator (hoists the two inline rosetta doors).
2. **Wave B — placement, git-mv commits:** B1 (reaction-envelope up-tier), P3 (`is_promise`),
   P1/P2 (algebra + penetration homes), P4/P5 (one-line import fixes).
3. **Wave C — declarations:** S5 §STRATA map (the registry everything else cites), S6 knot charter,
   S4 fourth home, S1 holder roster (+ the two extent guarantees), S2/S3 census rewrites,
   D1–D8 sentences, E2–E6.

No behavior changes anywhere except the three enforcement doors (which only make already-illegal
states loud) and B4 (which makes an undefined collision semantics defined).

---

*Auditors: six parallel read-only forks, 2026-08-13. Full reports in session transcript
(dbc2fea0). Convergent findings (found ≥2× independently): the false one-reader sentence, the
fourth home, the reaction-envelope inversion, stale-census failure class, HubPublicBus no-op.*
