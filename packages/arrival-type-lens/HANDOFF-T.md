# Layer T handoff — worklist (arrival agent → Claude)

The arrival agent built the **basic wiring** (Scheme→TS type-faithful emit + span lens +
LSP-mirror service + the prelude + the `arrival-sampler` Σ skeleton) and handed off the
**type-narrowed mask** to me. The `KNOWN GAP` / `v1:` / `degrade` annotations across these
packages are this worklist, not boundaries. This file consolidates them, sequenced.

## The re-prioritization (from tracing the empty-completions bug)

The sampler (`arrival-sampler`) **already masks the OPERATOR slot via Σ** — the bound-symbol
prefix set from the env. So the type lens's critical path is **NOT** the operator head-mapping
(that's IDE/hover polish); it's the **ARGUMENT slot**, where T decides which bound values/symbols
are type-valid for *this* parameter. Sequence accordingly.

## Done

- **L1 — balance incomplete prefixes** (`7c3bae958`). Cursor queries balance the mid-edit prefix
  so `emitTypes` parses it (was: unbalanced → empty module → `[]` completions). The plumbing now
  works end-to-end on incomplete input — the precondition for everything below.
- **T1+T2 — `getTypeValidCandidates` + `narrowByType`** (`435dc18e0`, `78be98619`). The
  type-narrowed mask, built NOT via completions (which are scope+sorted, not a hard filter) but via
  a **batched conditional-type probe**: sentinel-emit → AST find the enclosing call (callee +
  argIndex) → one `__ok<T>` tuple per candidate → checker-read `[true,false,…]` in one pass.
  `narrowByType(base, ls)` wraps a Σ scanner so `validSymbols()` = Σ∩T at an argument slot,
  memoized per slot (one TS round-trip per decode step). **Proven end-to-end through the sampler's
  real `isCandidateLive`:** at `(car ` (arg wants a List) Σ∩T masks `length`/`not`/`car` while Σ
  alone kept them. Conservative — drops only PROVEN-ill-typed; unresolved (locals, un-declared
  tools) kept. Sharpens automatically as sift injects tool types into `ArrShape`.
  - **The composition is: node-runner does `narrowByType(makeOracle(env), createSchemeLanguageService())`**
    → hand the result to the sampler. The sampler + browser path are unchanged (T is node-only).

## Done (cont.)

- **T-inject — sift tool types into `ArrShape`** (the single-source `type:` seam). The forensic
  mask is now type-aware end to end. The asymmetry that fell out of building it:
  - **Candidate side was already free.** `probeTypes` looks every candidate up as `typeof
    __arr[name]`, so declaration-merge injection alone makes an injected tool maskable.
  - **Slot side needed an emitter roster.** A non-builtin head lowered to a bare cleaned
    identifier (`any`) → no constraint. Fix: `emitTypes(scheme, { hostMembers })` lowers a head in
    the roster via `__arr["<name>"](…)` like a builtin (the third head case — host tools ARE
    ambient `__arr` members), so `Parameters<typeof head>` resolves. Runtime emit unaffected.
  - **The single source is the rosetta registry.** `defineRosetta(name, { fn, type })` carries the
    TS signature as an inert string (arrival-scheme has no TS); `Environment.__rosettaTypes__`
    records it; `assembleHostPrelude([...env.__rosettaTypes__], { preamble })` derives BOTH the
    `ArrShape` leaf (candidate side) and the `members` roster (slot side). One registration, no
    parallel `.d.ts` to drift — the builtin two-source split, collapsed for host tools.
  - **Sift coverage:** every tool in `tools/*` + the `defineEntity` factory + all entity specs now
    carry `type:`; `sift/src/discovery-types.ts` is the shared row/entity preamble. Proven:
    `sift/src/__smoke__/type-lens-coverage.test.ts` (SchemeIP / entity / List slots narrow, prelude
    compiles clean, every roster tool typed) + `src/__tests__/host-prelude.test.ts` (the seam).

## Remaining

## Supporting (lower priority)

- **T3 — operator head-mapping** (`language-service.test.ts` "KNOWN GAP", + the hover gap):
  `emitBuiltinCall` records only a whole-form span, so a cursor on a *complete* builtin head
  projects to `__arr`, not `.car`. Record a head-token span → the `.member` TS range. Flips the
  pinned test + fixes hover-on-operator. **Σ already covers this for the sampler** — it's IDE/LSP
  polish, do it after T1/T2. (Note: a *partial* operator `(fi` isn't a builtin → emits bare; if
  the sampler ever wants operator completion from the lens, partial heads need `__arr.<partial>`.)
- **T4 — prelude type richness** (`prelude/types.d.ts` `v1:` notes): no pair/improper-list brand;
  `@?` is an open boolean (accessor shape not narrowed). Tightening these sharpens what T checks.
- **T5 — desugar gaps** (`chain-view/desugar.ts`): `case` and `cond` `=>`/bare-test clauses throw
  ("not yet desugared") → those forms degrade to `unknown`. Add desugaring so they type.
- **T6 — incremental host** (`language-service.ts` `v1:`): recreate-per-source today; an
  incremental host that diffs the program text is the perf path once per-token masking lands.

## The acceptance shape

A scout query mid-generation: at each argument boundary, the sampler's mask = Σ ∩ (T-valid at this
slot). Concretely — `(ip/external-c2-candidate? ⟨cur⟩)` masks to symbols whose value is a `SchemeIP`;
`(:Field ⟨cur⟩)`/`(@ Field ⟨cur⟩ row)` masks the field to the row's `keyof`. When that holds, a
0.8B model cannot emit an ill-typed forensic query — the "autocomplete IS the constraint" endpoint.
