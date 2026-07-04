# Bracket bindings — a named, compile-erased superset of the let-family

> Reference artifact for the `@here.build/arrival` Scheme interpreter. Companion to the
> V-approved requirements (`docs/working-proposals/arrival-bracket-bindings-requirements.md`,
> R1–R8) and the executable spec (`spec/corpus/bracket-bindings-read.jsonl`,
> `spec/corpus/bracket-bindings-eval.jsonl`). Supersedes the bracket-let **door**
> (`5259a9398a`) for well-formed cases; the door survives for malformed ones.

Arrival's let-family binding forms **consume a vector datum** in their bindings slot — the
Clojure move. `(let [a 1 b 2] …)` and `(let* ([a 1] [b 2]) …)` become legal and mean exactly
what their fully-parenthesized images mean. This is a **form-contract-level widening only**:
the reader does not change, and nothing about `[…]` as a datum changes anywhere else.

## Registry entry — where this sits in the superset ledger

This is a **named superset** in the sense of the studio grounding line: a bounded, explicitly
enumerated departure from the literal surface of the parent dialects that is fidelity to their
*logic*. It qualifies against the four gates:

- **(a) zero non-spec residue.** Consumption is a pure syntactic rewrite performed inside the
  special form's own evaluation. `(let [a 1 b 2] …)` evaluates byte-identically to
  `(let ((a 1) (b 2)) …)`. No new runtime object, no flag, no trace difference (R3). There is
  nothing to lower or strip because there is no emitted artifact residue — the vector datum is
  read normally and interpreted by the form; it never survives into a downstream value.
- **(b) completes the platform's own grain.** The reader already mints `[…]` as a first-class
  vector datum in every position (the `{…}`/`[…]` collection-literal extension). The let-family
  was the one place that vector datum was inertly rejected. Accepting it removes an arithmetic-
  free asymmetry: every major Scheme-adjacent dialect a model is trained on (Racket, Clojure)
  writes bindings with brackets; Arrival read them but the forms refused them.
- **(c) bounded / wrong-state-impossible.** ONLY the six enumerated forms' bindings slots (R5).
  Every malformed shape doors with a teaching error (R4). No context-sensitive lexing exists to
  make a shape mean two things.
- **(d) explicitly enumerated.** The six forms and their per-form arities are listed below; the
  exclusions (`do` whole-list, destructuring, non-binding positions) are named.

The **faithfulness boundary is the reader's totality**: `[…]` is a vector datum *everywhere*,
including inside a `quote` or a macro's input. The widening lives entirely in the *form
contract*, never in the grammar.

## R1 — Reader invariance (totality)

The reader is **unchanged**. `[…]` always produces a vector datum — an `AVector` with
`evalElements === true` — in every position. No context-sensitive lexing; no binding-position
special case. Homoiconicity holds: `quote` and macros see a plain vector datum.

- `[a 1]` reads as a vector of a symbol and a number.
- `(quote (let [a 1] a))` reads to a list whose **second element is a vector** `[a 1]`, not a
  binding — quoting a let form yields inert data, and the binding slot is just a vector datum.
- `#(a 1)` (`evalElements === false`, the R7RS constant vector) is a **distinct node** from
  `[a 1]` and is never consumed as bindings (R5).

Corpus: `bracket-bindings-read.jsonl` (9 `y_` read-level entries — these pass against the
current tree unchanged, since reader behavior is invariant).

## R2 — Consumption contract (enumerated forms ONLY)

The bindings SLOT of `let`, `let*`, `letrec`, `letrec*`, named `let`, and `do` additionally
accepts a vector, with these equivalences:

| Form | R2a whole-list (Clojure) | R2b per-element (Racket) | name-slot | value/step arity |
|---|---|---|---|---|
| `let` | `[s₁ v₁ s₂ v₂ …]` ≡ `((s₁ v₁)(s₂ v₂)…)` | `[s v]` ≡ `(s v)` | symbol | 2 |
| `let*` | same | `[s v]` ≡ `(s v)` | symbol | 2 |
| `letrec` | same | `[s v]` ≡ `(s v)` | symbol | 2 |
| `letrec*` | same | `[s v]` ≡ `(s v)` | symbol | 2 |
| named `let` | `[s₁ v₁ …]` ≡ `((s₁ v₁)…)` | `[s v]` ≡ `(s v)` | symbol | 2 |
| `do` | **NOT accepted** (R2a exclusion — door) | `[s v step]` ≡ `(s v step)`; `[s v]` ≡ `(s v)` | symbol | 2–3 |

- **R2a whole-list** (Clojure surface): the bindings slot *is* an `evalElements` vector
  `[s₁ v₁ s₂ v₂ …]`. Requires an **even** element count and a **symbol** at every binding-name
  (even) position. `do` does **not** accept the whole-list form — its 3-element steps make
  pairwise grouping ambiguous, so `(do [i 0 (+ i 1)] …)` doors and points at the per-element
  form.
- **R2b per-element** (Racket surface): the bindings slot is a **list** whose elements may each
  be an `evalElements` vector. `[s v]` ≡ `(s v)`; for `do` also `[s v step]` ≡ `(s v step)`.
  Element length must be exactly 2 (2–3 for `do`) with a symbol first.
- **R2c mixing:** within one bindings list, paren pairs and bracket vectors may mix freely —
  `(let ([a 1] (b 2)) …)` is legal (Racket allows it), each element judged independently.

Corpus: `bracket-bindings-eval.jsonl` `y_` consumption entries (whole-list, per-element,
named-let recursion, `do` stepping, mixing, shadowing, closures, `letrec` mutual recursion, and
the direct paren-image equivalence pin). These pass only after the consumption commit
(`feat(arrival): bracket bindings`) lands.

## R3 — Equivalence law (zero residue)

Consumption is a **syntactic rewrite**. A form using bracket bindings evaluates
**byte-identically** to its parenthesized image: same values, same errors elsewhere, same tail
behavior, same provenance/trace shape. No new runtime object, no flag, no observable difference
downstream. The corpus pins this directly:

```scheme
(equal? (let ([a 1] [b 2]) (+ a b))
        (let ((a 1) (b 2)) (+ a b)))   ; ⇒ #t
```

## R4 — Validation doors (malformed keeps teaching)

Violations throw door-grade errors (stable `Error:`-compatible first line; fact + why + action).
The stable machine-checkable classes are the two **surviving** codes from the original door
(`5259a9398a`), whose *meanings* are now narrowed to genuine malformations (well-formed shapes
no longer reach them):

| Code | Fires when |
|---|---|
| `E-LET-BRACKET-BINDINGS-LIST` | whole-list vector is malformed for this form: **odd element count**; or the **whole-list form on `do`** (R2a exclusion — door points at the per-element form) |
| `E-LET-BRACKET-BINDING` | a per-element vector is malformed: **wrong length** (≠2; ≠2–3 for `do`); or a **non-symbol in the binding-name slot** |

Special-cased text: when the non-symbol name is itself a **vector** (Clojure destructuring), the
door reads *"destructuring is not supported — bind the whole value to one name, then read parts
with accessors"*.

The **existing generic invariant** (`let: invalid binding`, etc.) remains for shapes outside all
contracts — a bare symbol binding `(let ((a 1) b) …)`, a `(define …)` misused as a `do` clause,
and so on. Those are `APair`/symbol shapes, never `evalElements` vectors, so they fall straight
through to the unchanged path and are **not** in the bracket-binding door family.

Corpus: `bracket-bindings-eval.jsonl` `n_` entries (odd arity, wrong per-element length,
destructuring name slot, `do` whole-list exclusion).

> **Door-code provenance note.** R4 in the requirements specifies door-grade *behaviour* (a
> teaching error with fact/why/action) but does not pin machine codes. This spec adopts the two
> already-committed codes on the "the door survives" reading — the malformed cases keep dooring,
> so they keep their classes. If the consumption commit re-codes them, that is an entry-side code
> update to these `n_` cases, not a contract change; it is the one dimension of this spec not
> fixed by the requirements text.

## R5 — Scope bound (named future explicitly excluded)

The widening covers **only the six enumerated forms' bindings slots**. Explicitly **not**:

- `cond` / `case` / `when` clause positions — a **future, separate decision**.
- lambda formals, head position, or **any data position**.
- `#(…)` constant vectors (`evalElements === false`) — **never** consumed; they keep today's
  behavior.

Positive corollaries the corpus pins (these hold on the current tree already, and must keep
holding — they are reader/data invariants, not consumption behavior):

- a bracket literal as a **binding init value** is data: `(let ((a [1 2 3])) (vector-length a))` ⇒ `3`.
- a bracket literal in the **body** is data: `(let ((a 1)) (vector-length [a a a]))` ⇒ `3`.
- a **quoted** let form's binding slot is a plain vector datum:
  `(vector-ref (car (cdr (quote (let [a 1] a)))) 0)` ⇒ symbol `a`.

## R6 — Non-intersection justification (the union is a function)

The reason no context-dependent meaning is introduced: **each surface has exactly one legal
reading among the parent dialects**, and Arrival's chosen meaning equals that unique reading.
There is no shape whose Scheme meaning and Clojure/Racket meaning both exist and disagree.

| Surface | Scheme (R7RS) | Racket | Clojure | Arrival meaning |
|---|---|---|---|---|
| `(let ((s v)) …)` | ✅ legal — binding `(s v)` | ✅ same | ✗ (Clojure has no paren-pair let) | Scheme, **untouched** |
| `(let ([s v]) …)` | ✗ malformed — reads `(let (s v) …)` where `s` is not a binding list | ✅ legal — binding `[s v]` | ✗ (needs whole-list) | **= Racket** (R2b), and Racket's semantics equals the paren rewrite |
| `(let [s v …] …)` | ✗ malformed — reads `(let (s v …) …)`, a list of non-lists | ✗ (Racket needs per-pair) | ✅ legal — pairwise bindings | **= Clojure** (R2a), the pairwise rewrite |

Each row's only ✅ column is the meaning Arrival adopts. Where R7RS would call a shape malformed,
Arrival gives it the single well-defined dialect meaning instead of a door — and that meaning is,
by R3, byte-identical to a form R7RS *does* accept. The union of the three readings is therefore
a **function**: one input shape → one meaning, everywhere, with no branch on surrounding context.

## R7/R8 — Executable spec & gates

- Read-level entries (`bracket-bindings-read.jsonl`, 9× `y_`) assert R1 and pass against the
  current tree — reader behavior is invariant.
- Eval-level entries (`bracket-bindings-eval.jsonl`) assert R2/R3 consumption (`y_`), the R4
  doors (`n_`), and the R5 data-position invariants (`y_`). The consumption `y_` cases go green
  only after the `feat(arrival): bracket bindings` commit lands; the door `n_` and R5 `y_` cases
  hold on the current tree already.
- Gate: arrival `pnpm test` (plain parallel; baseline 2370) + `tsc --noEmit`; authoritative
  `turbo build --filter=@here.build/arrival` at the next dist rebuild. The bracket-let door tests
  (`let-bracket-binding-door.test.ts`) are rewritten by the consumption commit: well-formed cases
  flip from door-assertions to equivalence assertions; malformed cases keep door assertions with
  updated texts.
