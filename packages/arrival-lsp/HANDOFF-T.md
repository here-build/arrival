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

## The critical path (toward a type-narrowed sampler mask)

### T1 — argument-slot cursor precision *(the real blocker)*
The trailing-arg cursor collapses onto the operator's TS start: `(car |`@5 → `__arr⟨CUR⟩.car`,
not inside the call's args. The one case that "worked" (`(filter |`) was an accident — the cursor
landed *mid-member-name* `__arr.fi⟨CUR⟩lter`, firing member completion. **Fix:** position the
completion cursor in the real argument slot. Cleanest is a **completion sentinel**: insert a marker
atom at the cursor in the (balanced) scheme, emit, find the marker in the TS, query there — it lands
inside `__arr.car(⟨marker⟩)` with the parameter's contextual type. Lives in `language-service.ts`
(query path) ± a span hook in `types-emit.ts`.

### T2 — the hard type-mask (the design decision)
`getCompletionsAtPosition` returns **everything in scope, type-*sorted*** (via `sortText`), not a
hard type filter — so it's not yet a mask. Two ways to a hard narrow:
  - **(a) contextual-type + `produces`** — read the expected type at the arg slot (TS contextual
    type / a quick-info-style probe), intersect the Σ candidate set by "does this symbol's return
    type satisfy it." Matches the `expectedType()`/`produces()` contract in `oracle-contract.ts`.
  - **(b) per-candidate diagnostic** — for each Σ candidate, emit it in the slot and check
    assignability (no error). Exact, but N type-checks per cursor (N = Σ size after structural).
  Pick (a) for the per-token mask (cheap, one query); keep (b) as the segment-level verifier.
  **This is the piece that makes the sampler type-aware** — wire the result into
  `arrival-sampler`'s mask so it's Σ∩T, not just Σ.

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
