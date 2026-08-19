# Type-Reachability Gate — the oracle admits "what can lead to a valid T"

**Status:** IMPLEMENTED, 2026-06-22 (`scalar-enum-integration.test.ts` green; lens twin + fusion green). The
principled fix for the scalar-enum bug (LFM2 `route_type → #f`, `time_frame → (list six)`). Supersedes the
rejected *enum-strict* approach (which masked every `(` at an enum slot and **severed sequential-execution
piping** — `car`/`first`/`:field` are how you get a value of type `T` out of a computed source). The shipped
polarity is the **sound dual** of the first draft below — *mask the provably-array dead end, admit otherwise* —
because an uninstantiated generic head infers `unknown`, which a `ReturnType ⊆ T` admission test over-drops.

## The principle (V's, verbatim intent)

> The oracle masks a token **iff no typed completion reaches a valid value of the slot-type `T` through it**
> — a dead end. It admits everything on *some* path to a valid `T`. Nothing bounds the depth: the oracle
> *permits* the arbitrarily-deep pipe; the model collapses it to a literal because the literal is shorter.
> "What can lead to the right answer" is the whole spec.

This is the existing feasibility kernel with a second arm. `isCandidateLive` already does **structural**
reachability (does this token keep the program parseable + closeable — Σ-bound heads, balanced parens,
live closers). This adds **type** reachability (does this token keep a valid-`T` answer reachable).

## The predicate — the SOUND DUAL: *mask the provable dead end*, don't *admit the provable reach*

The naïve reading — "**admit** a head `h` iff `ReturnType<h> ⊆ T`" — is the WRONG polarity and would **cut the
pipe**. An uninstantiated generic head carries no argument at the moment it is typed: `car<T>(xs: List<T>): T`
with no `xs` infers `R = unknown`, and `unknown ⊆ T` is **false** for every concrete `T`. So a `⊆ T` admission
test **drops `car`** (and `first`, `cdr`-of-element, every element-returning op) and severs exactly the
`(car …)` / `(set-x (find-y …))` sequential-execution piping the gate exists to protect. The real value-typing
of a head's *result* is not knowable until its arguments are filled — which is the **argument-slot recursion's**
job, not the head gate's.

The gate therefore tests the **complement, which IS soundly decidable at the head with no argument**: is the
head **PROVABLY array-returning**? `ReturnType<typeof list>` = `List<T>` = `readonly T[]` — provably an array
*regardless of instantiation*. At a **scalar** slot an array result `T[] ⊄ T` can **never** fill the slot — a
dead end with no completion. So:

At a slot of declared scalar type `T`, a candidate is **MASKED** iff it is a provable dead end:

1. a **wrong-type literal** — a `#`-literal (`#t`/`#f`/`#\c`) or a number at a **string-typed** slot (a
   free-form `string` or a closed string-literal enum); the literal's type reaches no string value, OR
2. a **`(` opening — or a nested operator typing — a head `h` that is PROVABLY array-returning**
   (`[ReturnType<typeof h>] extends [readonly unknown[]]` is `true`: `list`/`vector`/`append`), OR
3. a **list-literal opener** (`'`/`[`) at a scalar slot (the existing list-structure arm).

Everything else is **ADMITTED** (the default — admit unless *provably* a dead end): a literal of type `T`
(enum member via Σ, a string at a string slot, a number at a number slot), a bare `(` (no head yet — it is the
shared prefix of *every* op, including the reachable element-returning ones), `(car`/`(first`/`:field` (their
return is the element `T` / the field value, on a path to a valid value), and any **unresolved** head (`null`).
The recursion handles each argument slot as its own typed slot. **A non-callable / value head is admitted too**
— the array test sits *inside* the function-arm of the conditional, so it never collapses a `never` return to a
spurious `true`.

> Why the dual is not just "safe" but *more correct*: a `⊆ T` test answers a question the head can't yet answer
> (what does it *return* here?) and gets `unknown`; the array test answers a question the head CAN answer (is it
> *structurally* a list constructor?) and gets a definite yes/no. The gate masks on the definite yes only.

## Type-contextuality — the load-bearing property

A symbol is **never globally banned**; its admission is decided per-slot by the wanted wire-type:

- `list` is **MASKED** at a scalar-`T` enum slot — it returns `T[] ⊄ T`, a dead end *here*.
- `list` is **ADMITTED** inside `(car █)` — that argument slot *wants* `T[]`, and `list` produces `T[]`.

Same symbol, opposite verdict, decided only by the port's type. The scalar-enum bug, restated: `list` was
admitted at a slot where `T[]` was never wanted. The fix is not "ban list" — it is "at a scalar slot, mask the
heads that PROVABLY return an array (a dead end here); admit the rest," and `list` sorts itself: provably-array
at the scalar slot (masked), and at `(car █)` the slot is `T[]` so the reachability arm does not fire at all
(admitted by the list-structure arm, which forces a list there).

## Mechanism (as implemented)

- **Lens query — `getHeadReturnsArray(scheme, head)`** (the ReturnType twin of `getSlotIsArray`, in BOTH
  `service-core.ts` and `tsgo/type-lens.ts`, kept in sync by the fusion tests): `[ReturnType<typeof head>]
  extends [readonly unknown[]] ? true : false`, with the array test folded *inside* the function-arm so a
  non-callable head resolves `false` (admit) instead of collapsing a `never` return to `true`. `true` = mask
  (provably array), `false`/`null` = admit. Slot-independent. A second probe — **`getSlotIsStringTyped`** —
  separates a string/enum scalar slot (`[__E] extends [string]`, mask non-string literals) from a number/
  boolean one (which `getSlotAcceptsBareWord===false` alone cannot, since a number slot also returns `false`).
- **The async scanner stamp — `OracleState.arrayReturningHeads`** (`typed-scanner-async.ts`): in a SCALAR
  context the scanner computes the provably-array-returning subset of the slot's Σ (one `getHeadReturnsArray`
  per head, cached per `(slot, head)`; the per-slot set warmed in `prefill`). Stamped at TWO sites: a scalar
  **value slot** (`slotIsArray===false`) and a **nested operator** whose **enclosing** slot is scalar (found
  via `enclosingSlotPrefix` + the enclosing slot's `getSlotIsArray`). `slotIsStringTyped` is stamped alongside.
- **The gate (reachability arm of `violatesValueStructure`):** keyed off `arrayReturningHeads`, it masks the
  head-prefix iff it is a live prefix of an array-returning head AND **not** a live prefix of any *other*
  (reachable, non-array) bound symbol — i.e. it can ONLY complete to an array op. This makes a bare `(` (empty
  head — prefixes everything, so it has a non-array completion) and `(car`/`(first` ADMITTED, and `(list` /
  `list`-at-the-nested-operator MASKED. Two firing sites by `state.position`: **argument** (the GLUED
  `(get_route (list` — head parsed after the candidate's `(`) and **operator** (the INCREMENTAL `(get_route (`
  committed, then `list` — head = the candidate's leading atom). The string-typed arm masks `#`/number scalar
  literals when `slotIsStringTyped===true`. The recursion needs no special handling — each argument slot is
  just another typed slot (e.g. `(car █)` wants `T[]`, so it is an array slot where `arrayReturningHeads` is
  NOT stamped and `(list` is admitted).
- **The decode-loop slot-state** (`lazy-processor.ts`, `decode-strategy.ts`, `llama-cpp-generate.ts`):
  re-analyzes at the `prefix + " "` boundary for the **operator-transition** (`midToken && position ===
  "operator"`) as well as the argument-transition, so the scalar stamp reaches the gate when one token closes
  the head and opens the first value.

The depth bound is still none: the gate permits arbitrary nesting; the model collapses it to a literal.

## Acceptance — the red/green pair IS the fix definition (DONE — all green in `scalar-enum-integration.test.ts`)

A fix is correct iff **both** halves pass. Red alone is satisfiable by enum-strict (the pipe-cutter); green
is what proves reachability. **A change that passes red but fails green is the cheap cut in disguise.**

**RED — wrong masked** (`scalar-enum-integration.test.ts` Parts A/B/C, now green):
- `#f` masked at a string-enum slot (Hole A — via `slotIsStringTyped`).
- `(list …` masked at a scalar-enum slot (Hole B — via `arrayReturningHeads`), while the **bare `(` is
  ADMITTED** (the shared prefix of the reachable `(car …)` pipe — the one assert flipped from the old
  enum-strict draft).
- the operator→argument transition re-analyzes the boundary so the scalar stamp reaches the gate (Hole C),
  AND the nested-operator head is narrowed by return-reachability (the incremental `(get_route (` then `list`).

**GREEN — right NOT masked (the pipe survives)** (added — the discriminator enum-strict fails):
- `(car …` / `(first …` / `:field` **admitted** at the enum slot — their return is the element `T` / a field
  value, NOT a provable array.
- `(list` **admitted** inside `(car █)` — that argument slot wants `T[]` (an array slot, no reachability
  stamp).
- a bare enum member (`fastest`) admitted — the literal path; a bare `(` admitted — the pipe's shared prefix.
- (regression guard) at a `T[]` array slot, `(list` still admitted and a scalar literal still masked
  (the existing structure-gate behaviour is unchanged — the new arm only *adds* masks at SCALAR slots,
  never removes a legitimate one).
- the **real lazy mask path** is driven (adversarial: the array head is rank-0 → vetoed; the element head
  rank-0 → admitted) per `feedback-sampler-test-adversarial-distribution`.

## Non-goals / by-design

- **No depth bound** on the pipe. The oracle permits arbitrary nesting; the model chooses flatness.
- **No global symbol bans.** Every verdict is per-slot-type.
- **No new model field.** This is an analysis-layer gate over existing `OracleState` + lens stamps; it adds
  no CRDT commitment.

## Invariants (must hold)

1. **Byte-identical on untyped slots.** Where the lens returns no type (the degrade path), the gate is
   Σ-only exactly as today. The new arm only engages when a slot-type is present.
2. **No legitimate producer removed.** The arm is purely additive to the admitted set relative to a *correct*
   total gate — it closes holes (masks dead ends), it never masks a live `T`-producer.
3. **Structural reachability unchanged.** The existing parse/close/Σ arm is untouched; this composes with it
   (a token must pass *both* arms).
