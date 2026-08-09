# arrival-sugarcoat — at-expressions (prose / text-mode interpolation) spec

**Status:** spec · **Date:** 2026-07-05 · **Rung:** sugarcoat (cognitive).
Companion to [`../extension-design-doctrine.md`](../extension-design-doctrine.md) (the governing
doctrine). Reader of record: `arrival/packages/arrival-sugarcoat/src/sugarcoat-read.ts`;
render of record: `sugarcoat-render.ts`. This spec adds **one** surface form and obeys every clause the
ideation doc froze — it does not relax any of them.

---

## 0. The pain, and the one move

Prose assembled with `string-append` is where sugarcoat is ugliest — two failures stacked:

1. **quote-escape hell** — a literal `"` inside a `"`-string forces `\"`.
2. **interpolation-as-fragmentation** — one sentence shredded into N alternating literal/value lines;
   the prose stops being readable *as prose*.

The move is the one the whole ideation doc converged on (§0, §2): **the category lives in a leading
marker, decided locally.** A single marker `@` opens a **text sub-reader** where the default is
*literal text* and `@` is the only escape back to code. This is not invented — it is
Racket/Scribble **at-expressions**, the Lisp-proven answer to "prose inside a homoiconic core," and it
is a *pure pre-macro reader transform* (§1) that lowers to an ordinary call the core already has.

```
@string-append{Pitch "@config/product" to @config/audience.
  This one is a @(field lead "role") whose pain is: @(field lead "pain").
  One sentence. Make it land.}
```

reads to **exactly** the hand-written form — no `\"`, prose intact:

```scheme
(string-append "Pitch \"" config/product "\" to " config/audience ".\n"
  "This one is a " (field lead "role") " whose pain is: " (field lead "pain")
  ".\nOne sentence. Make it land.")
```

---

## 1. Rung placement — why sugarcoat, not sweet

The ideation trimorphism litmus: **sweet** = notation for a model R7RS *already has* (glyphs for the
same mental model); **sugarcoat** = notation that *imports a reading model R7RS lacks* (pipeline,
anaphora). Text-with-holes imports the **prose-with-holes** reading model — R7RS has string
concatenation but not the *notation* for interleaving prose and code. So at-expressions sit on the
**sugarcoat** rung, beside `it` / trailing-lambda, connected by the **sweet ⟷ sugarcoat** (cognitive)
bifunctor. They lower to an existing scheme form (`string-append` / `format` / any head) — **zero new
core**, one new projection. This keeps the scheme ⟷ sweet half pure and opinion-free (§"Why three").

Add one row to the ideation's feature-home table:

| rung pair | feature |
|---|---|
| **sweet ⟷ sugarcoat** (cognitive) | dot-method pipelines · `it` / anaphora · trailing lambdas · **at-expressions (prose)** |

### 1.1 The JS tagged-template isomorphism — and where Lisp beats it

`@head{…}` **is** a tagged template: `head` is the tag, headless `@{…}` is the untagged literal
(flat string interpolation → a string). This is the exact mental model to import.

But JS tagged templates carry a *split* shape — `` tag`a ${x} b` `` → `tag(["a ", " b"], x)` — a
literal-strings array kept **separate** from the values, precisely because a JS function cannot tell a
literal from an interpolation. A Lisp can. We lower **flat**:

```
@html{<b>@name</b>}   →   (html "<b>" name "</b>")
```

and a tag that would need the literal/value distinction (`html` escaping, `sql` parameterization) can be
written as a **macro** — it sees which args are string-literals (provably safe) and which are
expressions (interpolated → escape/parameterize). Homoiconicity delivers injection-safety with **no
split-array protocol**; JS needs the split array precisely because its functions can't. One flat
lowering therefore serves *everything* while still erasing to the hand-written call — the stolen
construct pays a dividend its source language can't collect.

**Scope (2026-07-05):** the reader is general (any head), but we build only the two everyday heads —
`str` (the default) and `dedent`. `@html`/`@sql` are **not needed now** [V]; they remain expressible
later as macro-heads with zero reader change. So this spec ships `@{…}` and `@dedent{…}` only.

---

## 2. Lexical reconciliation — `@` is *not* an unused char

`@` is already spent three ways. The spec must not silently reinterpret existing forms (§1
backwards-compat clause). Ground truth (`sugarcoat-read.ts`, `sugarcoat-render.ts`, base `specials.ts`):

| existing use | where | verdict |
|---|---|---|
| `,@` unquote-splice | tokenizer lexes `,@` as a comma-variant *before* `@` is seen alone (`sugarcoat-read.ts:222`) | **untouched** — `@` alone is never reached through `,` |
| bare symbol `@` = dynamic-accessor head `(@ obj key)` | emitted from `foo[key]` subscript (`:344`); rendered back **as `obj[key]`** (`sugarcoat-render.ts:507,560`) | **surface-free** — `@` never appears as a token in rendered sweet; it lives only in canonical scheme |
| `@foo` lexes as an ordinary symbol | word-run in `tokenize` | **the one enumerated break** (below) |

**Consequence:** on the *sugarcoat surface* `@` is free, because the accessor always materialises as
`[]`. The only real break is a user-authored **symbol beginning with `@` immediately followed by `{` or
`(`** (`@foo{…}` / `@foo(…)` tight). Today that reads as `symbol @foo` + sibling group; after this
spec it reads as an at-expression.

**Containment of the break** (honors §1 "add surface, never reinterpret existing forms"): in *code
context* `@` is the at-marker **only** in the tight forms `@word{`, `@{`, `@(`. A bare `@` or a
`@foo` **not** followed tight by `{`/`(` stays an ordinary symbol. So the reinterpreted set is exactly
`@<ident>{` and `@<ident>(` adjacencies — vanishingly rare (a symbol named `@foo` applied tight to a
curly/paren group). Enumerate it, ship a migration grep (`rg '@[A-Za-z][\w/!?*-]*[{(]'`), done.

---

## 3. Grammar (EBNF) — two contexts

`@` behaves differently in **code context** (ordinary sugarcoat) and **text context** (inside an
at-body). This asymmetry is Racket's and is the crux: outside you write `@cmd{…}`; inside prose you
write `@id` to interpolate.

### 3a. Code context

```ebnf
at-expr    ::= "@" head? "{" text "}"      (* headed or headless text command *)
             | "@" "(" datum ")"           (* rare in code; escape/graft *)
head       ::= word                        (* any symbol: string-append, format, html, sql, … *)
```

- `@head{ text }`  →  `(head <part>…)`
- `@{ text }`      →  `(str <part>…)`   — `str` is the existing coercing concatenator (§9.1)
- `<part>`s are the coalesced sequence produced by the text reader (§3b, §4).

### 3b. Text context (inside a `{…}` at-body)

```ebnf
text       ::= text-item*
text-item  ::= literal-run                 (* → one string literal; includes " ' . , : etc. verbatim *)
             | "@" head? "{" text "}"       (* → nested (head …) *)
             | "@" "(" datum ")"            (* → datum, spliced as a part *)
             | "@" interp-id               (* → the identifier, as a part (interpolation) *)
             | "{" text "}"                (* literal braces — balanced, kept verbatim as text *)
interp-id  ::= (IDENT_START | digit | "/")+ (* STOPS at "." '"' "{" "}" "@" "(" ")" whitespace *)
```

Rules that make it total and prose-safe:

- **`@` is the sole escape.** Everything else is literal text, **including `"`** (no `\"`) and
  newlines. That kills pain #1.
- **Braces balance as literal text.** An inner `{…}` with no preceding `@` is kept verbatim (braces
  included) — `@fmt{use {curly} literally}` → `(fmt "use {curly} literally")`. Text mode **suspends
  curly-infix entirely**; only `@` re-enters code. (Without this, `@fmt{price {x}}` would wrongly infix
  `{x}`.)
- **Interpolation boundary is restricted** (§9 fork, recommended default): bare `@id` reads a symbol of
  `IDENT_START`/digit/`/` and **stops at `.`** so prose periods stay literal
  (`@config/audience.` → `config/audience` + literal `.`). `/` is kept because sugarcoat already lexes
  `config/model` as one symbol. For anything richer (dotted access, a call, a method chain) use the
  explicit **`@(expr)`** graft — that is the escape hatch, and it is unambiguous.

---

## 4. Reading algorithm (text sub-reader)

Hook point: a new token/branch mirroring how `,@` is already a `quote`-token variant — in `tokenize`
(`sugarcoat-read.ts:~204`) and `classicDatum` (`:374`). Sketch:

```
readAtBody():
  parts = []; buf = ""
  loop:
    c = next()
    '}' at depth 0        -> flush buf; return parts
    '{'                   -> buf += balancedBraces()          ; literal, kept verbatim
    '@':
        peek '('          -> flush buf; parts.push(readDatum())        ; @(expr)
        peek head?'{'     -> flush buf; parts.push(readAtExpr())       ; nested @cmd{…}
        else              -> flush buf; parts.push(readInterpId())     ; @id
    otherwise             -> buf += c                          ; literal (", newline, . all literal)
  flush(): if buf != "" { parts.push(stringLit(buf)); buf = "" }
```

- **Coalescing is mandatory and load-bearing** — consecutive literal characters become **one** string
  literal. This is what makes the read output identical to the hand-written `string-append` (§5).
- **The body is verbatim — the reader does *not* trim.** Whitespace, indentation, and newlines are
  preserved exactly as written. Auto-dedenting in the reader would be an *editorial opinion* silently
  mutating the literal text (forbidden — the reader stays opinion-free; §1). The body is delimited by
  explicit `{…}`, so §3's "suspend indentation inside brackets" applies and there is **no
  significant-whitespace fragility** (§5.4 tax not paid) — but that means source indentation *lands in
  the string literal* unless you strip it explicitly.
- **`@dedent{…}` is the opt-in prettifier — a sugarcoat-rung head that *dissolves*, like `=>`→`lambda`.**
  To write source-indented prose that comes out clean, wrap it: `@dedent{…}`. `dedent` is bound **only
  in the sugarcoat env extension** (not base sweet/scheme) — same shelf as `=>` and `str`. It strips
  the common minimal leading-whitespace prefix from the **literal** parts (interpolated value parts
  untouched — JS `dedent` semantics). Crucially, on lowering sugarcoat → scheme it **dissolves to
  `(str <dedented-parts>…)`** — the canonical scheme rung never contains `dedent`, only `str`. So both
  `@{…}` and `@dedent{…}` bottom out at `(str …)`; the two differ only in whether the reader strips
  source indentation on the way down. (Source indentation is therefore *cosmetic* — normalized away,
  not stored; see the fixed-point note in §5.)

---

## 5. Erasure / round-trip — the moat (§5.3), **not** optional

The ideation doc forbids read-only surface: *"`surface → core → surface = id` for every form, or the
form doesn't ship."* So at-expressions are a **canonizer-registry row** (a Rendel–Ostermann invertible
syntax description), not a one-way reader hack.

Canonical scheme carries only two string-assembly heads — **`str`** (default, coercing) and
**`string-append`** (strings-only). `dedent` is **not** a canonical head; it is a *render-form choice*
for a multi-line `(str …)` (it dissolved on the way down, §4). The registry row:

```ts
{
  reads: atExpr => (head === 'dedent' ? (str, dedent(coalesce(parts)))   // @dedent{…} → (str <dedented>)
                                      : (head,  coalesce(parts))),        // @{…}→(str …), @head{…}→(head …)
  emit:  (head, args) =>
           !available(head, args) ? null :
           head === 'str' ? (multiline(args) ? atDedent(args) : atBrace(args))  // (str …) → @dedent{}/@{}
                          : atHead(head, args),                                  // (string-append …) → @string-append{}
  // law:  reads(emit(c)) === c
}
```

**`emit` availability (round-trip-sound):** a call `(head arg…)` is at-exp-representable **iff `head` ∈
{`str`, `string-append`} *and* no two args are adjacent string literals.** The second clause is the
soundness gate: the reader *always* coalesces adjacent literals, so `(str "a" "b")` is **not**
representable (`@{ab}` reads back to `(str "ab")` ≠ original). Such forms emit classic. Both spellings
live in one e-class ⇒ the per-row law holds for whichever `emit` picks; the choice is **preference**
(egg-style extraction), not correctness.

**Preference:** available `(str …)` renders as at-exp when any literal contains prose (space/`"`/newline)
— single-line → `@{…}`, multi-line → `@dedent{…}`. Bare `(str x y)` (no prose literals) stays classic.

**The dedent fixed-point (honest moat statement).** `dedent` dissolves, so source indentation is
*discarded*, not stored — `@dedent{␣␣a\n␣␣b}` → `(str "a\nb")` → `@dedent{a\nb}` is **not** byte-identical
on the first pass. This is not a §5.3 violation: indentation is *layout*, owned by the pretty-printer
(ideation's Wadler offload), not by the semantic lens. The invariant that holds is **idempotence after
one normalization**: `render∘read` reaches a fixed point in one pass (`render(read(render(read(s)))) =
render(read(s))`), exactly like every code formatter. The *tree* `(str "a\nb")` round-trips to itself
with strict identity; only the cosmetic re-indent is normalized.

Worked round-trip:

```
surface  @{a @x b}                     (single line)
  reads  (str "a " x " b")
  emit   @{a @x b}                     ✓  surface→core→surface = id (strict)

surface  @dedent{␣␣a @x\n␣␣b}          (multi-line, indented)
  reads  (str "a " x "\nb")            dedent dissolved, indent stripped
  emit   @dedent{a @x\nb}              ✓  id up to one normalization pass (fixed point)

core     (str "a" "b")                 (adjacent literals)
  emit   str "a" "b"                   ✓  not representable → classic; core→surface→core = id
```

---

## 6. Quote / quasiquote interaction (§5.1 — mandatory before ship)

At-expressions are a **pure pre-macro reader transform** producing a datum, so quote semantics wrap the
*already-read* datum — quote-invariant by construction (Rhombus's load-bearing property):

- `` `@head{a@xb}`` reads to `(head "a" x "b")` **first**, then the leading marker wraps it →
  `'(head "a" x "b")` / `` `(head "a" x "b") ``. Same core inside and outside quote.
- Inside a quoted at-body, `@x` still reads as the *symbol* `x` (a part); `quote` inerts it like any
  datum. No evaluation leaks at read time — evaluation is entirely downstream, on the lowered call.
- **`@`-interpolation and `,@`-splice never meet:** `,@` is lexed off the `,` before `@`-alone is
  reachable; an at-body is not a quasiquote context. If you want splicing *of* an at-expression, it is
  `` `,@(…@head{…}…) `` — ordinary, because the at-expr is just a datum by the time `,@` sees it.

---

## 7. Disambiguation & the §2 edit-stability gate

The tight-`{` decision is made by the **one char before the head-adjacency** — the marker, never the
interior:

| preceding context | `{` opens | lowers to |
|---|---|---|
| bare (ws / operator / bol) | curly-infix | `{a + b}` → `(+ a b)` |
| `.op` tight (method-dot) | trailing lambda | `.map{it + 5}` → `(map (lambda (it) (+ it 5)) recv)` |
| `word` tight (plain, no `.`/`@`) | siblings (non-neoteric) | `f{a+b}` → `f` and `(+ a b)` |
| **`@`** tight | **text body** | `@f{a+b}` → `(f "a+b")` |

Two sigils (`.`, `@`) make a following tight `{` special; each in its own fixed way. **Run the §2
gate** (ideation §7 Q6, recommended acceptance criterion): *does any single-token **interior** edit
silently flip the category?*

- Edit inside a curly-infix body → stays curly-infix. ✓
- Edit inside an at-body → stays text (the body is uninterpreted prose; there is no interior parity to
  flip). ✓
- The only category change is **adding/removing the `@` marker itself** — which is *exterior* and
  *visible*, exactly the doctrine ("type in the delimiter"). That is the marker doing its job, not a
  silent interior flip.

**Gate: passed.** At-expressions are strictly *more* edit-stable than curly-infix, because the body
carries no grammar at all.

---

## 8. Before / after (V's example)

```
;; before — string-append fragmentation + \" hell
car
  infer config/model
    string-append "Pitch \""
      config/product
      "\" to "
      config/audience
      ".\n"
      "This one is a "
      (field lead "role")
      " whose pain is: "
      (field lead "pain")
      ".\n"
      "One sentence. Make it land."

;; after — one prose block, no escaping. @dedent strips the source indentation.
car
  infer config/model
    @dedent{Pitch "@config/product" to @config/audience.
      This one is a @(field lead "role") whose pain is: @(field lead "pain").
      One sentence. Make it land.}
```

The `\"`, the `.\n`-fragments, and the 12-way split all dissolve; the sentence reads as a sentence.
`@(field lead "role")` uses the graft form because it is a call (not a bare id). `@dedent` is the head
because the prose is source-indented under `infer` — the body is verbatim, so `dedent` is what erases
the leading whitespace. It **dissolves** on lowering (§4) — the canonical scheme rung holds a plain
`str`, no `dedent`:
`(str "Pitch \"" config/product "\" to " config/audience ".\nThis one is a " (field lead "role") …)`.
Rendering that multi-line `(str …)` back picks `@dedent{…}` by line-count (§5). A single-line block
would round-trip through `@{…}` instead.

---

## 9. Open forks (for V — decisions, not defaults)

1. ~~**Default head for headless `@{…}`?**~~ — **RESOLVED 2026-07-05: the existing `str`** [V].
   The designed door already exists — Clojure's `str` at `arrival/src/env/polyglot.ts:167`:
   `(define (str . args) (apply string-append (map (lambda (x) (if (string? x) x (repr x))) args)))`.
   That *is* "string-append with auto-conversion" (strings pass through, else `repr`), and wrapping
   `string-append` inherits provenance-collapse for free. So `@{…}` → `(str <part>…)`; **no new symbol
   minted** (a `string-interpolate` alias would be redundant delta). `@string-append{…}` stays the
   strings-only explicit variant; `@dedent{…}` the source-indent-stripping one.
2. **Interpolation boundary.** Restricted-id (stop at `.`, prose-friendly; recommended) vs
   Racket-inclusive (`@foo.bar` reads the dotted datum). Restricted keeps prose periods literal and
   pushes richness to `@(expr)`. Confirm restricted.
3. ~~**Text-head registry: general vs locked?**~~ — **RESOLVED 2026-07-05: general reader, two heads
   shipped** [V]. The reader is head-agnostic (generic, per §1). But we **build only `str` + `dedent`**;
   `@html`/`@sql` are not needed now and add zero reader surface when they arrive later as macro-heads
   (§1.1). Emit registry: `str` (↔ `@{}`/`@dedent{}`) and `string-append` (↔ `@string-append{}`).
4. **Emit preference threshold.** Exactly when does render *prefer* at-exp over classic? Proposed:
   available ∧ some literal contains prose (space/`"`/newline). Pure aesthetics — round-trip holds
   either way — but it sets what the editor projects back at the human.

Everything else is settled by the ideation doctrine: rung = sugarcoat, round-trip = mandatory
(§5), quote-invariant = §6, edit-stability = §7 passed, `@` reconciliation = §2.

---

## 10. Implementation checklist

Three surfaces, in dependency order. The lens and the editor are **not optional** — the ideation moat
(§5.3) makes the render half mandatory, and an editor that can't lex text-mode would mis-highlight
every at-body.

1. **Reader** — `arrival-sugarcoat/src/sugarcoat-read.ts`.
   - `tokenize` (~`:204`): recognise `@` as a non-terminating tight prefix in the three code-context
     openers `@word{` / `@{` / `@(`; leave bare `@`/`@foo` as symbols (§2).
   - `classicDatum` (`:374`): dispatch the at-expr; implement `readAtBody` (§4) with mandatory literal
     coalescing. Text mode suspends curly-infix (§3b).
   - Restricted `interp-id` boundary (stop at `.`); `@(…)` graft; balanced literal braces.

2. **Bifunctor lens / render** — `arrival-sugarcoat/src/sugarcoat-render.ts` + the canonizer registry.
   - Add the at-expression **Rule** (§5): `reads` (already the reader) + `emit`.
   - `emit` availability predicate: registered text-head ∧ **no two adjacent string-literal args**
     (the round-trip soundness gate — without it `(string-append "a" "b")` mis-round-trips).
   - Emit preference (§9.4). Per-row law `reads(emit(c)) === c` gets a unit test that runs the corpus
     both ways (mirror the DV2 bifunctor-coherence tests).

3. **Heads.**
   - `str` — **already bound** (`polyglot.ts:167`, sugarcoat env); the `@{…}` default head. Reuse.
   - `dedent` — **NOT a runtime binding** (decided 2026-07-06 [V] — confirmed no consumers outside the
     lens). Pure reader/render form: dissolves to `(str <dedented>)` at read (§4), exactly like
     `=>`→`lambda`. Canonical scheme never holds it. Special-cased in the reader (`tryReadAtExpr`) and
     the multi-line renderer (`renderAtDedentBlock`) — that is its entire existence.
   - No `html`/`sql` — out of scope (§9.3).

4. **CodeMirror plugin** — the `arrival-codemirror` package (ejected per memory
   `project-arrival-codemirror-eject-2026-06-10`).
   - Lex `@head{…}` as a text region: literal spans as string, `@id` / `@(…)` / nested `@head{…}` as
     code, balanced `{}` inside text. Distinct face for the text body vs the `@`-escapes.
   - Bracket-matching must treat at-body `{}` as text-delimiters (not curly-infix) so auto-close and
     match-highlight behave. Ghost-completion/LSP: complete the *head* in code context; inside a body,
     complete only inside `@(…)`/`@id`.
