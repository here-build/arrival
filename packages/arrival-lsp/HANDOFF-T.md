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

## Remaining

### T-inject — sift tool types into `ArrShape` *(the next high-value piece)*
T narrows only `__arr` members (builtins). Sift's evidence tools (`memory/netscan`, `ip/*`, …) emit
as bare/undefined → unresolved → conservatively KEPT (no narrowing). To make the *forensic* mask
type-aware, sift must declare its tool signatures into the merged `ArrShape` (the "custom type
declarations to injected symbols" V described): `interface ArrShape { "memory/netscan"(): Connection[];
"ip/external-c2-candidate?"(ip: SchemeIP): SBool; … }`. Then `(ip/external-c2-candidate? ⟨cur⟩)`
masks to SchemeIP-producers and `(:Field ⟨cur⟩)`/`(@ Field ⟨cur⟩)` masks to the row's `keyof`. This
is the seam where the entity types (SchemeIP, the rows) become the constraint — sift-side, builds on
the prelude's leaf-merge contract. **The single biggest remaining lever for the forensic sampler.**

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
