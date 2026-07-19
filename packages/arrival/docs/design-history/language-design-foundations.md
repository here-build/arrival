# Arrival-Scheme — Language Design Foundations

**The charter for arrival-scheme as a *language*, not just an interpreter.** It establishes
the single stance that governs every future syntax and semantics decision. Read it before
adding a reader macro, a literal, a dialect borrowing, or a serializer form.

Companions:
- [`../reference/r7rs-coverage.md`](../reference/r7rs-coverage.md) — the conformance matrix for the base.
- `sandbox-security-model.md` — the no-IO boundary (private monorepo docs).
- [`../../arrival-serializer/README.md`](../../arrival-serializer/README.md) — the printer (the other
  half of the round-trip).

---

## 1. Who writes this language

The **primary author is an LLM agent** (the MCP-first thesis): MCP discovery/action S-expression
queries, the inhuman scheme runner, `.prompt` units. The secondary author is a human writing
strict Scheme. The README already names the instinct — *"Scheme is the notation for compositional
thinking"* and *"features from other Lisp dialects were added as expression means"* (`(:key alist)`).
That instinct is correct; this document gives it a spine so it stops being ad hoc.

## 2. The thesis — intent over materialization, one layer down

This is the here.build grounding line applied to a programming language. **Take the materialization
— which dialect's exact syntax — away as a requirement; keep the intent — a list, a map, a filter.**

Sort every surface element into three strata:

1. **Intent** — "a sequence of these", "a map from these to those", "filter where p". Foregrounded.
2. **Platform model** — R7RS-small, re-presented as transparent **glass**. Exact, faithful,
   round-trips to identity. Never bent.
3. **Quirks** — dialect-surface mismatches (JSON `true`/`false`/`null`, EDN keywords). Recover
   them; never error on a recognizable intent. (Clojure `[]`-as-vector and `{:k v}`-as-dict went
   further than recovery: they are **blessed literals** since 2026-07-02 — see the §5 amendment —
   so the bracket surfaces are `(` … `)` lists, `[ … ]` vectors, and `{ … }` dict literals.)

An expert writing strict R7RS gets an **exoskeleton** (their Scheme, executed faithfully). An LLM
writing JSON-ish data gets a **zimmerframe** (held up, recovered, and taught the platform through a
transparent mapping). Hiding stratum 2 — making the base anything other than real R7RS — would be the
straightjacket.

## 3. The base — R7RS-small, sandboxed, no IO

- **Target = the R7RS-small subset.** Conformance tracked in `R7RS-COMPLIANCE.md`; gaps are bugs to
  close, not license to invent.
- **Sandboxed, no IO, ever.** No ports, filesystem, network, process, ambient `eval`, or host
  globals. The sandbox is a *permanent* property of the base, not a mode (`sandbox-security-model.md`).
- **Faithful.** Strict R7RS input evaluates exactly per spec and round-trips to identity. The base is
  never adjusted to accommodate forgiveness — forgiveness lives strictly above it (§4).

## 4. The load-bearing principle — forgiveness is a fallback *under* strict, never beside it

The ordering **is** the architecture:

1. Strict R7RS + any enabled SRFIs parse and evaluate **first**.
2. The forgiving layer fires **only** where step 1 errors or is undefined.

Forgiveness never *overrides* a defined meaning — it *catches the fall*.

The payoff: **non-conflict is structural, not audited.** You cannot conflict with a SRFI you defer
to. Every SRFI stays implementable; if one is enabled, it *wins*; the forgiving layer occupies only
unclaimed or erroring space. "Not conflicting with any potential SRFI" stops being a syntax-by-syntax
bet you can lose and becomes a property of the layering.

## 5. The reserved-zone rule — what may be *blessed* vs only *recovered*

R7RS-small §7.1.1 **reserves `[` `]` `{` `}` `|`** for future extensions. But *reserved ≠ free*: the
readable-Lisp family already builds on those characters. So the blessable zone is the narrower
**reserved AND uncontested-by-any-SRFI-you-might-want** — which in practice is the **`#`-family**
(`#(…)`, with room for `#hash(…)`-style words) plus strict R7RS itself.

> **Amendment (2026-07-02, implemented — supersedes the `{}`/`[]` rows below as originally
> written).** SRFI-deference lost to model gravity on exactly two delimiters: **`{:k v}` now reads
> as a dict literal** (≡ `(dict :k v …)`) and **`[a b c]` as a vector literal**, with SRFI-105
> curly-infix demoted to **opt-in** (`ParserOptions.curlyInfix`, default off — mutually exclusive
> on the delimiter). The evidence: the primary author is an LLM (§1), and models default to
> Clojure/JSON literals — one τ²-airline run produced five distinct wrong object encodings for a
> correctly-typed dict argument. Meeting the model's native literal IS the zimmerframe; refusing it
> was the straightjacket. Print-back stays asymmetric (`(dict …)` / `#(…)`) — the literals are an
> input surface, not the canonical stored form. Sugarcoat is unaffected: its lens reads `{a + b}`
> as infix in its own surface and lenses `{}` declarations to `(dict …)` on the way in. Full
> decision record (comma rules, key rules, the `key:` suffix flip):
> `docs/working-proposals/arrival-curly-vector-literals.md`.

**The original SRFI survey (kept for the reasoning trail):**
- `{ … }` is **curly-infix** (`{a + b}` → `(+ a b)`) under SRFI-105, and SRFI-110 sweet-expressions
  build on it — so `{}` was treated as claimed by the readability SRFIs until the amendment above.
- `e[ … ]` (a bracket immediately after a datum) is **neoteric bracket-apply** (`x[a]` →
  `($bracket-apply$ x a)`). Standalone `[ … ]` is left *undefined* by SRFI-105/110 and was dropped
  by R7RS-small — it spent 2026-06 as a hard parse error before the amendment blessed it as a
  vector literal.
- The readable family defines **no** dict/map/hash/record literal. The only reader-*literal* dict
  precedent in the Lisp world is **Racket's `#hash(…)`** — i.e. the `#`-family.

| Disposition | Meaning | Examples |
|---|---|---|
| **BLESS** | Claim as canonical input surface. Strict R7RS forms, **`#`-family** literals, and the two amended literals. | `(list …)`, `#( … )`, `{:k v …}` dict, `[ … ]` vector |
| **RECOVER-ONLY** | Never claim; fire as fallback (§4); yield to any enabling SRFI. The LLM/JSON idiom lives here. | `true`/`false`/`null` (in data position) |
| **NEVER STEAL** | Claimed syntax — repurposing it breaks the principle. | `&` (identifier char; R6RS condition prefix), `,` (`unquote`), redefining the core `#(`/`#u8(`/`#;`/`#\|` |

This decides the recurring `&(…)`-vs-`[…]`-vs-`{…}` question on principle, not taste. `&` is claimed
(identifier) → forbidden outright. `{}`/`[]` are blessed **input literals** whose canonical stored
forms remain `(dict …)` / `#(…)`. The `#`-family stays the zone for any future *self-round-tripping*
literal — exactly where the lone dict-literal precedent (`#hash(…)`) already sits.

## 6. One data model, many surfaces

There is **one** shared data model under Scheme, Clojure, EDN, and JSON: sequence, map, keyword,
string, number, boolean, nil. Only the surface differs. So we never "choose a dialect." The reader is
a **dialect-tolerant front-end to one R7RS datum model**: every recognized surface lowers to the
canonical R7RS datum.

The Rosetta table (README) already fixes this model at the *value* boundary (`[1,2,3] ↔ (list 1 2 3)`,
`{x:10} ↔ alist`, `true/false ↔ #t/#f`, `null ↔ nil`). This charter extends the same mapping from "JS
values" to "any-dialect *surface syntax*."

**The faithfulness boundary is the datum.** `read(forgiving-surface) ≡ read(strict-equivalent)` as
data, with zero residue, and strict input is identity. This is the reader's half of a bifunctor:
surface → datum → surface round-trips over the *blessed* set.

## 7. SRFI policy

- Any SRFI must remain implementable; the forgiving default never precludes one.
- When a SRFI is enabled, its reading is **sovereign** over the forgiving default (the §4 ordering).
- Forgiveness is enumerated and humble; SRFIs are first-class and win every collision.

## 8. Conservatism and the bounded registry

- **Conservative recovery.** Fire only on genuine error/undefined; **never reinterpret a *valid*
  form.** The blind spot is deliberate: a bare symbol like `true` in operator position evaluates
  per strict R7RS and is *never* second-guessed into the boolean recovery, even if `#t` was meant.
  Faithful-where-valid beats clever-and-surprising. The instant recovery starts second-guessing
  valid code, the exoskeleton becomes the straightjacket. (The same logic drove `[]`'s path: first
  removed outright rather than recovered — an unambiguous parse error over a silent
  reinterpretation — then, per the §5 amendment, *blessed* as a vector literal: a blessed form is
  just as unambiguous as a removed one.)
- **Enumerated registry.** "As forgiving as we can" still means a *named* set of recovered idioms,
  each with its lowering and its conflict note — not open-ended guessing. Same discipline as the
  studio `--ir-*` / `--studio-*` superset registry: bounded, enumerated, compile-erased.

## 9. Serializer corollary — the printer must speak the blessed surface

The reader and printer round-trip over the **blessed canonical set**, so the printer
(`arrival-serializer`) is bound by the same rule:

- It emits strict R7RS or blessed-superset forms — **never bespoke sigils**.
- Its plain-object output `&( … )` was **non-conformant** (`&` is claimed syntax the reader can
  never safely round-trip). **Migrated to `(dict :k v …)` 2026-06-09** — arrival's existing dict form:
  a plain `( … )` combination, so blessed-zone and non-conflicting with *every* SRFI. **All three paths
  now speak it:** the serializer **emits** `(dict …)` (the `&` branch deleted); a **runtime**
  `global_env` builtin **evaluates** it (companion to the `(:key d)` accessor — it reads
  `KEYWORD_ACCESSOR_FIELD` off the keyword accessor, so `(:k (dict :k v))` round-trips); and
  arrival-chain-view **transpiles** it both ways to `{ }` / Python `{}`. Typed entities keep their
  `(TypeName …)` form. (A true-hash *datum*, if ever wanted, is Racket's `#`-family `#hash((k . v) …)`
  — but `(dict …)` is the canonical surface.)
- The `:keyword` it already prints is *correct*, and is proof the codebase is one honest step from
  EDN-as-canonical already.

## 10. Registry v0 — the initial enumerated set

| Surface | Lowers to | Disposition | Notes |
|---|---|---|---|
| `[ … ]` | `(vector …)`-shaped literal, elements evaluated | **BLESS** (amended 2026-07-02) | Vector literal, Clojure-congruent; prints back as `#(…)` (asymmetric — input surface, not stored form). (The sugarcoat `[n]`/`[:k]` subscript is a separate authoring-surface accessor, not this form.) |
| `{ … }` | `(dict :k v …)` | **BLESS** (amended 2026-07-02) | Dict literal by default; SRFI-105 curly-infix only under opt-in `ParserOptions.curlyInfix` (mutually exclusive on the delimiter). Prints back as `(dict …)`. Key rules + comma rules in `docs/working-proposals/arrival-curly-vector-literals.md`. |
| `(dict :k v …)` | dict / object | **canonical** | Arrival's existing dict form — plain `( … )`, blessed-zone, round-trips via the `dict` constructor + `(:key …)` accessor, transpiles to `{ }`/Python `{}`. **The serializer emits this** (replacing `&(…)`). |
| `#hash( … )` | hash | **BLESS** (optional) | The lone `#`-family dict-literal precedent (Racket); the only *blessable* dict literal. Use only if a true-hash datum is wanted — otherwise `(dict …)` is canonical. |
| `:kw` | keyword | already | Arrival prints it; EDN/Clojure-idiomatic. |
| `true` / `false` / `null` | `#t` / `#f` / `nil` | **RECOVER** | Only in data position; the symbols stay valid identifiers under strict. |
| `,` inside a `{}` / `[]` / `(dict …)` literal | position-scoped separator | **RECOVER** | At most one comma absorbed per element boundary at the positions JSON-writers emit them; elsewhere `,` stays `unquote` (quasiquote templates over the literals survive). Full rules in `arrival-curly-vector-literals.md`. **Never** at top level — that would steal `unquote`. |
| `&( … )` | — | **NEVER** | `&` is claimed (identifier / R6RS condition). |

**Rejected — parity-dispatched `{}` maps.** It is tempting that simple curly-infix is *odd*-length
(`{a + b}`) while key-value pairs are *even* (`{:a 1 :b 2}`), so one could imagine "even `{}` = map."
**Don't.** It dispatches a literal's meaning by *counting its elements* — the §8
clever-and-surprising trap by textbook. Note the §5 amendment is NOT this trap: it resolves the
delimiter by a *mode switch* (`curlyInfix` off → dict, on → infix; mutually exclusive, never
content-inspected), not by parity. The rejection stands: within either mode, a `{}`'s meaning never
depends on what's inside it.

**On the canonical map — `(dict :k v …)`.** Arrival already had the answer, and it beats every
alternative weighed here (alist, `&(…)`, `#hash`): **`(dict :k v …)`** is a plain `( … )` combination,
paired with the `(:key d)` accessor. So it is homoiconic, **blessed-zone**, and non-conflicting with
*every* SRFI — curly-infix, sweet, all of them — because it is nothing but an identifier in head
position; it round-trips via the `dict` constructor; and arrival-chain-view transpiles it both ways
to `{ }` / Python `{}`. The runtime representation (object / alist / hash) is `dict`'s internal detail, invisible
at the surface — which dissolves the alist-vs-`#hash` question entirely. Since the §5 amendment,
`{:a 1}` is a blessed *input* spelling of the same form — `(dict …)` remains the canonical stored
form both print back to. *For the record:* Racket's `#hash((k . v) …)` stays the `#`-family literal,
reserved for a *true-hash datum*; an alist is nobody's map idiom.

## 11. Non-goals (the bound)

- Not R7RS-large; not a macro system beyond `syntax-rules`; no IO, ever (sandbox).
- The forgiveness is a **bounded, enumerated tolerance** for shared-idiom *surfaces* — not an
  open-ended "parse any language" and not NLP-of-syntax.

## 12. The design test — every future syntax/semantics call passes all four

1. Does strict R7RS + an enabled SRFI already define this? → if yes, be faithful; forgiveness stays out.
2. Which zone? **Claimed** (`&`, `,`, core `#(`) → never steal. **Blessed-by-amendment** (`{}` dict /
   `[]` vector, §5) → theirs; any further meaning needs a new amendment with model-gravity evidence
   of the same weight. **`#`-family or strict R7RS** → blessable.
3. Does it lower to a canonical R7RS datum with **zero residue**, round-tripping over the blessed set? →
   if no, it is not blessable.
4. Is it enumerated in the registry (§10) with its conflict note, and does it yield to any enabling
   SRFI? → if no, it is not in.

A rule derived from R7RS + the reserved-zone + the fallback ordering self-corrects in every unseen
case. Taste drifts; this does not.
