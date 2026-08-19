# Scheme-for-Dummies: the constrained-decode tool-call rule catalog

**Status:** design / investigation. No code in this doc — it is the EXPLICIT, ENUMERATED inventory of every
"scheme for dummies" rule the arrival-sampler's tool-call gate already enforces (plus two `TO-ADD` rules from a
just-completed failure audit), classified, located, and prepared for (a) a registry, (b) per-rule
instrumentation, (c) possible per-model specialization.

All `file:line` citations are against `experimental/arrival/packages/arrival-sampler/src/` as of this writing. The code is
the source of truth; every existing rule below was read out of the gate, not approximated.

---

## 1. The concept

The sampler constrains a weak LLM so it *cannot* emit a malformed or unbound Scheme tool-call program — the
mask is applied at the logit, every step, not checked after the fact. On top of arrival's general structural +
Σ oracle the sampler runs a **tool-call sublanguage profile**: a forgiving dialect that captures the model's
**intent** (which function, which arguments, which array) and forgives the **materialization** (paren shape,
`'(…)` vs `(list …)`, a bare word vs a quoted string, a `` ```python `` fence vs `` ```scheme ``). The general
arrival reader is untouched; all of this lives only in the constrained gate.

Each accommodation or restriction is a discrete **rule**. They sort onto one axis. **FORGIVE** — accept or
canonicalize a natural-but-non-canonical emission the model reaches for, *where the intent is unambiguous*
(`'(…)` ≡ an array; bare `men` ≡ `"men"` at a string slot; a markdown fence steered to ` ```scheme `).
**ENFORCE** — mask a *meaningless or ambiguous* shape, *only where forgiving would mean guessing intent*
(unquote `,` / quasiquote `` ` `` in a tool call; `'` not followed by `(`; a non-symbol at the operator head).
Some rules are **HYBRID**: the same predicate forgives one shape and masks its over-reaching twin (element
force-quote forgives one bare word by quoting it but masks a multi-word split). The governing line is **"mask
only the meaningless"** — forgive where one intent is clear; enforce where the surface is genuinely undecidable
or guaranteed to mis-execute.

---

## 2. The rule catalog

One row per discrete masking/forgiving decision. `kind` is FORGIVE / ENFORCE / HYBRID. Location is `file:line`
(the predicate's home) or `TO-ADD`. The activation predicate is the exact condition under which the rule fires
(masks, or — for a forgive rule — *admits something Σ/structure would otherwise mask*).

| ID | name | kind | one-line statement | location | activation predicate |
|----|------|------|--------------------|----------|----------------------|
| `R-UNQUOTE-QUASI` | unquote/quasiquote veto | ENFORCE | `,` `,@` `` ` `` are meaningless outside a quasiquote a tool call never opens | `structural-gates.ts:115` | a `,` or `` ` `` appears in `next` outside a string |
| `R-POST-QUOTE-PAREN` | post-quote forcing | ENFORCE | a `'` is legal only as `'(`; the char immediately after `'` must be `(` | `structural-gates.ts:119-122` | `next` contains `'` followed (outside a string) by a defined non-`(` char |
| `R-QUOTE-LIST-ARRAY` | quote-list as array | FORGIVE | admit `'(…)` as a first-class array materializer (not just `(list …)`) | `structural-gates.ts:119-122` (the *non*-mask of `'(`) + scorer canonicalization | `'(` opens at a value slot — admitted where naive Σ would want `(list` |
| `R-PHANTOM-LIST` | phantom-list veto | ENFORCE | the bare symbol `list` as the FIRST datum of a `'(`-opened quote-list is masked | `structural-gates.ts:70-96`, `:124-125` | `next` opens `'(` whose first datum atom is exactly `list` |
| `R-ALT-PAREN-ADMIT` | alt-paren admission | FORGIVE | `[ ]` stays unmasked at the grammar layer (forward-compat for the `[a b]`→vector revamp) | `structural-gates.ts:35-41,113` (a documented *non*-mask) | `[` at a value slot — not vetoed by the grammar (the foundation Parser/`feasible` still rejects it today) |
| `R-HEAD-IS-SYMBOL` | operator-head-is-symbol | ENFORCE | every non-quoted application head must be a NAMED SYMBOL, not `(`/`'`/a literal | `structural-gates.ts:98` seam (**TO-ADD**) | parent application frame `elems === 0` (head slot) and the opener is a non-symbol |
| `R-ATOM-STAYS-OPEN` | atom-stays-open (anti-misfire) | FORGIVE | a mid-atom continuation is never re-classified as a fresh value opener | `greedyDescend.ts:161-168` (**TO-ADD** — fix the existing re-base) | prefix is mid-atom in the SAME arg slot and the candidate continues that atom |
| `R-ARRAY-REJECTS-SCALAR` | array-slot rejects scalar literal | ENFORCE | at an ARRAY slot, a scalar literal (`"…"`/number/`#…`) is masked → forces a list materializer | `structural-gates.ts:175` | fresh arg value, `slotIsArray === true`, opener ∈ `{ " , 0-9 , # }` |
| `R-SCALAR-REJECTS-LIST` | scalar-slot rejects list literal | ENFORCE | at a SCALAR/stringy slot, a list literal (`'(…)`/`[…]`) is masked | `structural-gates.ts:176` | fresh arg value, scalar slot (`slotIsArray===false` or `slotIsStringy===true`), opener ∈ `{ ' , [ }` |
| `R-STRINGSLOT-REJECTS-NONSTRING` | string slot rejects #/number literal | ENFORCE | at a string-typed slot, a `#`-literal or number is masked (only a quoted string / enum / call belongs) | `structural-gates.ts:183-184` | fresh arg value, `slotIsStringTyped===true`, opener ∈ `{ # , 0-9 }` |
| `R-REACHABILITY-ARRAY-HEAD` | type-reachability array-head | ENFORCE | at a scalar context, mask a `(head` that can ONLY complete to an array-returning op (`(list`/`(vector`/`(append`) | `structural-gates.ts:150-158`, `:202-236` | `arrayReturningHeads` stamped; head-prefix is a live prefix of ONLY array heads (bare `(`, `(car`, `(first` admitted) |
| `R-ELEM-FORCE-QUOTE` | array-element force-quote | HYBRID | at a string array element, mask a bare-word / nested-list start to force `"…"` (single word forgiven by quoting, multi-word split masked) | `structural-gates.ts:258-276` | `elementIsStringy===true`, value-START, opener ∉ `{ " ( 0-9 # ) ] } }` |
| `R-BARE-WORD-STRING` | scalar bare-word-is-string | FORGIVE | at a free-form string ARGUMENT slot, a bare word is admitted (≡ the quoted string) past Σ | `mask-compiler.ts:147` | mid-atom argument, `slotIsStringy===true` — admit even though the atom is an UNBOUND symbol |
| `R-LITERAL-ARG-EXEMPT` | literal-arg Σ exemption | FORGIVE | numbers / `#`-literals (incl. partial `-`, `.5`) bypass the Σ bound-symbol gate at an ARGUMENT | `mask-compiler.ts:136` + `scheme-atoms.ts:38-45` | mid-atom argument, `isLiteralValue(frag)` true |
| `R-LITERAL-NOT-OPERATOR` | literal-not-callable at head | ENFORCE | a number / `#`-literal at OPERATOR position is NOT exempt → `(1 …)` / `(#t …)` ungeneratable | `mask-compiler.ts:134-136` (exemption gated to `position==="argument"`) | mid-atom operator, atom is a literal — falls through to the callable-prefix check and dies |
| `R-KEYWORD-ACCESSOR` | `:`-keyword accessor admit | FORGIVE | a `:`-prefixed atom (member-read accessor) is callable-like — admitted at operator OR argument | `mask-compiler.ts:132` | mid-atom op/arg, `frag.startsWith(":")` |
| `R-ELEM-ENUM-NARROW` | quote-surface enum narrowing | ENFORCE | inside `'(…)` / `(list …)`, a string-literal-enum element is narrowed to its members (Σ can't reach inside the quote) | `mask-compiler.ts:123-126` | non-application surface, `elementEnum` non-empty, mid-atom — keep only enum-member prefixes |
| `R-EOS-CLOSEABLE` | EOS only when closeable | ENFORCE | the end-of-sequence token is admitted only when the program is balanced/closeable | `mask-compiler.ts:290-291` | `analyze(prefix).closeable === true` admits EOS; else masked |
| `R-FENCE-STEER` | markdown-fence steer | FORGIVE | accept the model's ` ```python `/` ```js ` instinct, normalize to ` ```scheme\n ` then decode Scheme inside | `decode/fence-preamble.ts:69-110` | first content token detokenizes to a leading backtick (after ≤`maxWs` whitespace tokens) |
| `R-KWARGS-ARITY` | kwargs required-positional arity | ENFORCE | exactly `requiredCount` positionals forced first, then `:kw value` pairs; over-budget bare positional masked | `profile-gates.ts:177-195` | profile present (no `requiredKeywords`); `positionalCount` vs `requiredCount` boundary |
| `R-KWARGS-KEY-NARROW` | optional-keyword narrowing | ENFORCE | an in-progress `:kw` must prefix some `optionalKeywords` member | `profile-gates.ts:183-186` | profile present; in-progress keyword fragment matches no optional keyword |
| `R-POSKEYED-ORDER` | positional-keyed required order | ENFORCE | every arg a `:kw value` pair; required keywords forced in declaration order, no bare positional | `profile-gates.ts:392-427` | `requiredKeywords` present; out-of-order / bare-positional / `:`-led-operator / early-close |

**Total: 22 rules.** FORGIVE: 7 (`R-QUOTE-LIST-ARRAY`, `R-ALT-PAREN-ADMIT`, `R-ATOM-STAYS-OPEN`,
`R-BARE-WORD-STRING`, `R-LITERAL-ARG-EXEMPT`, `R-KEYWORD-ACCESSOR`, `R-FENCE-STEER`). ENFORCE: 14
(`R-UNQUOTE-QUASI`, `R-POST-QUOTE-PAREN`, `R-PHANTOM-LIST`, `R-HEAD-IS-SYMBOL`, `R-ARRAY-REJECTS-SCALAR`,
`R-SCALAR-REJECTS-LIST`, `R-STRINGSLOT-REJECTS-NONSTRING`, `R-REACHABILITY-ARRAY-HEAD`, `R-LITERAL-NOT-OPERATOR`,
`R-ELEM-ENUM-NARROW`, `R-EOS-CLOSEABLE`, `R-KWARGS-ARITY`, `R-KWARGS-KEY-NARROW`, `R-POSKEYED-ORDER`). HYBRID: 1
(`R-ELEM-FORCE-QUOTE`).

> Notes on scope. `R-ALT-PAREN-ADMIT` is a *documented non-mask* (a deliberate forgiveness that the foundation
> Parser/`feasible` currently neutralizes) — counted because it is an explicit gate decision. `R-EOS-CLOSEABLE`
> is arrival's base structural guarantee, surfaced here because it is the one closeability rule the catalog must
> name for the instrumentation. The three profile rules (`R-KWARGS-*`, `R-POSKEYED-ORDER`) are opt-in per-call
> shapes, inert without a `ToolCallProfile`.

---

## 3. Per-rule detail

### R-UNQUOTE-QUASI — unquote/quasiquote veto (ENFORCE)
**Statement.** `,` / `,@` / `` ` `` are meaningful only inside a quasiquote, which a tool call never opens, so
they are always malformed in the sublanguage.
**Rationale (ENFORCE).** No intent to forgive — a model copying Python `f(3, 11)` emits a comma; admitting it
would let through a form that can only mis-parse. Mask the meaningless.
**Location / predicate.** `structural-gates.ts:115` — `if (c === "," || c === "\`") return true;` inside the
string-aware char scan of `violatesToolCallGrammar`.
**Fires on.** `(f 3, 11)` (the literal Python-comma corruption).
**Per-model.** GLOBAL. No model legitimately needs unquote in a tool call; forgiving helps none.
**Activation signal.** classify hit on `R-UNQUOTE-QUASI` at the step whose candidate carries the `,`/`` ` ``.

### R-POST-QUOTE-PAREN — post-quote forcing (ENFORCE)
**Statement.** After a `'`, the only legal next char is `(` — `'` is well-formed here ONLY as `'(` (a quoted
list).
**Rationale (ENFORCE).** `''`, `'atom`, `'5`, `'"…"`, `' x` are all undecidable/meaningless materializers — a
quoted scalar or dangling quote has no array intent. Masking the non-`(` successor (a pure prefix function, no
lookahead) leaves exactly one quote shape alive.
**Location / predicate.** `structural-gates.ts:119-122` — for a `'` at `i`, mask iff `next[i+1]` is defined and
≠ `(`. A trailing `'` is admitted (the *next* step forces `(`).
**Fires on.** `'5`, `'foo`, `''`.
**Per-model.** GLOBAL — it is the structural guard that makes `R-QUOTE-LIST-ARRAY` safe to admit at all.
**Activation signal.** classify hit on `R-POST-QUOTE-PAREN`.

### R-QUOTE-LIST-ARRAY — quote-list as array (FORGIVE)
**Statement.** `'(…)` is admitted as a first-class array materializer, not forced to `(list …)`.
**Rationale (FORGIVE).** Models natively emit `'(…)` for an array arg far more often than `(list …)`; the
intent (an array) is unambiguous, and the downstream scorer canonicalizes `'(…)` / `[…]` / `(list …)` /
`(array …)` identically. Forgive where one intent is clear.
**Location / predicate.** The *non-mask* of `'(` in `violatesToolCallGrammar` (`structural-gates.ts:119-122`
admits `'(`), paired with scorer canonicalization. Visible as the complement of `R-POST-QUOTE-PAREN`.
**Fires on (admits).** `(fn '("a" "b"))` where naive Σ would mask the `'` and force `(list …)`.
**Per-model.** GLOBAL forgiveness — but its *necessity* is per-model (a model that never emits `'(` doesn't
exercise it). A candidate to LOG per-model to learn which models actually reach for it.
**Activation signal.** an admitted candidate whose value-opener is `'(` at an array slot — logged as a forgive
event (no mask, but the rule was decisive).

### R-PHANTOM-LIST — phantom-list veto (ENFORCE)
**Statement.** The bare symbol `list` standing as the FIRST datum of a `'(`-opened quote-list is masked.
**Rationale (ENFORCE).** The model conflates the two array surfaces and emits `'(list "a" "b")`, whose first
ELEMENT the scorer reads as the literal symbol `list` — meaningless (no array's first element is the word
`list`). Mask only the exact `list` atom in the first-datum slot; `(list …)` (no quote), `list` as a later
element, and `list-ref`/`list->vector` stay legal.
**Location / predicate.** `quoteListFirstDatumIsBareList` (`structural-gates.ts:70-96`), called at
`:124-125`. Exact-string match on the first-datum atom run after `'(` does the mid-atom-vs-complete split for
free.
**Fires on.** `'(list "a" "b")`.
**Per-model.** GLOBAL — it disambiguates a surface confusion, not a model preference.
**Activation signal.** classify hit on `R-PHANTOM-LIST`.

### R-ALT-PAREN-ADMIT — alt-paren admission (FORGIVE)
**Statement.** `[ ]` is left unmasked at the grammar layer (forward-compat for the stashed `[a b]`→SchemeVector
revamp).
**Rationale (FORGIVE).** A documented decision to *not* veto brackets in the grammar tightening. Today the
foundation Parser rejects `[` with a hard ParseError so `feasible` masks it anyway — so this forgiveness is
currently inert downstream. Counted because it is an explicit gate stance.
**Location / predicate.** `structural-gates.ts:35-41` (the doc), `:113` (the explicit non-veto). No active mask.
**Fires on.** `[a b]` — admitted by the grammar, neutralized by `feasible`.
**Per-model.** GLOBAL (and inert) until the Parser revamp lands.
**Activation signal.** N/A while inert; once live, an admitted `[` value-opener.

### R-HEAD-IS-SYMBOL — operator-head-is-symbol (ENFORCE) — **TO-ADD**
**Statement.** Every non-quoted application starts with a NAMED SYMBOL, not another expression. Forbid a `(`,
`'`, or a literal at the operator/head slot. Generalizes to `('foo …)`, `((lambda …))`, `(123 …)`, and fixes
the parallel-collapse `((call)(call))`.
**Rationale (ENFORCE).** A non-symbol head can only mis-execute (an application whose operator is itself an
application/literal). The intent — call a named function — is unambiguous, so masking the non-symbol opener at
the head slot guesses nothing. This is the structural generalization of the existing `R-LITERAL-NOT-OPERATOR`
(which already kills `(1 …)`/`(#t …)` via Σ) to ALL non-symbol openers (`(` and `'` too).
**Location / predicate.** `structural-gates.ts:98` seam (the `violatesToolCallGrammar` head). Mechanism: veto a
non-symbol opener when the parent application frame's element count is 0 (the head slot). The parent-frame
`elems === 0` distinction is the operator-vs-argument discriminator: at `elems===0` the next datum is the head;
at `elems>0` a nested `(` is a legal argument call.
**Fires on.** `((get_x))`, `('foo 1)`, `(123 x)`.
**Per-model.** **STRONG per-model candidate.** Audit evidence: Arch-1.5B *collapsed* into `((call)(call))`
parallel-emission without this rule (the rule rescues it); Arch-3B *benefited* from the grammar regularization
(cleaner heads) but did not collapse without it. A smaller model may need this enforced where a larger model's
distribution already avoids the shape — exactly the kind of "helps one, neutral-to-another" the instrumentation
must measure.
**Activation signal.** at a step whose parent frame `elems===0`, the candidate's value-opener is a non-symbol
(`(` / `'` / a digit / `#`) — classify hit on `R-HEAD-IS-SYMBOL`.

### R-ATOM-STAYS-OPEN — atom-stays-open / anti-misfire (FORGIVE) — **TO-ADD**
**Statement.** An atom already in progress stays open — never re-classify a mid-atom continuation as a fresh
value opener.
**Rationale (FORGIVE / anti-misfire).** This is the rule whose *violation* is "BUG 2". The `slotState` re-base
at `greedyDescend.ts:161-168` analyzes `prefix + " "` (force-closing the atom) whenever the prefix is mid-atom
at an argument/operator — needed at a value-OPEN boundary, but WRONG when the candidate merely *continues* the
current number/atom. The force-close makes the digit/structure arms
(`R-ARRAY-REJECTS-SCALAR`/`R-STRINGSLOT-REJECTS-NONSTRING`) fire on the CONTINUATION of a number (`(fn 1` then
`945` → masks `945` as a "fresh scalar literal at an array slot") instead of only at a real fresh opener.
Forgiving means: when the candidate keeps typing the same atom, keep the *true* cursor's slot state, do not
re-base to the next-boundary slot.
**Location / predicate.** `greedyDescend.ts:161-168` — the `prefixState.midToken && (position argument |
operator) ? analyze(prefix + " ") : prefixState` re-base. The fix: only re-base when the candidate OPENS a new
value (the atom actually closes), not when it continues the in-progress atom.
**Fires on (the misfire it prevents).** `(fn 1` + candidate `945` — must stay a continuation of `1945`, not be
re-read as a fresh `9…` literal at the next slot.
**Per-model.** GLOBAL — it is a correctness fix in the harness, not a model-shaped forgiveness. (Its *misfire
rate* is worth logging per-model because tokenizers that split numbers differently hit it at different rates.)
**Activation signal.** the anti-misfire would log when the re-base is SUPPRESSED because the candidate is a
mid-atom continuation (i.e. the would-be misfire was avoided).

### R-ARRAY-REJECTS-SCALAR — array-slot rejects scalar literal (ENFORCE)
**Statement.** At an ARRAY slot, a scalar literal (`"…"` / number / `#…`) is masked, forcing a list
materializer.
**Rationale (ENFORCE).** A scalar literal at an array slot is provably type-wrong; masking it fixes the night's
under-listing sink. AMBIGUOUS openers (`(` a call, a bare symbol a reference) are NEVER gated — precise, not
strict, so `(set-x (find-y …))` survives.
**Location / predicate.** `structural-gates.ts:175` — `slotIsArray===true` and value-opener ∈ `{ " , 0-9 , # }`.
Gated to a fresh arg value (`!midToken`, `position==="argument"`, `formKind==="application"`).
**Fires on.** `(fn 5)` where the slot is `number[]`.
**Per-model.** GLOBAL (type-derived, model-independent).
**Activation signal.** classify hit on `R-ARRAY-REJECTS-SCALAR`.

### R-SCALAR-REJECTS-LIST — scalar-slot rejects list literal (ENFORCE)
**Statement.** At a SCALAR or stringy slot, a list literal (`'(…)` / `[…]`) is masked.
**Rationale (ENFORCE).** A list value at a scalar slot is the literal kind of over-listing; with the bare-word
exemption (`R-BARE-WORD-STRING`) admitting the natural form, the `'(` escape hatch is removed so the model has
no list fallback at a scalar string.
**Location / predicate.** `structural-gates.ts:176` — scalar slot (`slotIsArray===false` OR
`slotIsStringy===true`) and value-opener ∈ `{ ' , [ }`.
**Fires on.** `(fn '("a"))` where the slot is a scalar `string`.
**Per-model.** GLOBAL (type-derived).
**Activation signal.** classify hit on `R-SCALAR-REJECTS-LIST`.

### R-STRINGSLOT-REJECTS-NONSTRING — string slot rejects #/number literal (ENFORCE)
**Statement.** At a string-typed slot (free-form `string` or a closed string-literal enum), a `#`-literal or a
number is masked — only a quoted string, a bound enum member via Σ, or a `T`-producing call belongs.
**Rationale (ENFORCE).** A `#t`/`#f`/number reaches no string value (the literal twin of the reachability arm).
Kills the live `route_type → #f` corruption. The `"` opener and enum members (via Σ) stay legal.
**Location / predicate.** `structural-gates.ts:183-184` — `slotIsStringTyped===true` and opener ∈ `{ # , 0-9 }`.
**Fires on.** `(fn #f)` where the slot is `"a"|"b"`.
**Per-model.** GLOBAL (type-derived).
**Activation signal.** classify hit on `R-STRINGSLOT-REJECTS-NONSTRING`.

### R-REACHABILITY-ARRAY-HEAD — type-reachability array-head (ENFORCE)
**Statement.** At a scalar context, mask a `(head` that can ONLY complete to an array-returning op — its `T[]`
result can never fill the scalar slot.
**Rationale (ENFORCE).** The sound polarity is the dual of `ReturnType ⊆ T`: mask iff the head can ONLY become
array-returning. A bare `(` (empty head, prefixes everything) and `(car`/`(first` (element returns) stay
ADMITTED, preserving the sequential-execution pipe; only `(list`/`(vector`/`(append` die. Fires at OPERATOR
position too (the incremental `(get_route (list`).
**Location / predicate.** `violatesReachability` (`structural-gates.ts:202-236`), entered from
`violatesValueStructure` at `:150-158`. `arrayReturningHeads` stamped (scalar context); head-prefix is a live
prefix of array heads AND not a live prefix of any reachable non-array bound symbol.
**Fires on.** `(get_route (list …))` where `get_route`'s arg-0 is scalar.
**Per-model.** GLOBAL (type-derived), but only some models emit the glued `(head (list` corruption — worth
logging which.
**Activation signal.** classify hit on `R-REACHABILITY-ARRAY-HEAD` (distinguish from the literal arm by the
firing site: `arrayReturningHeads !== undefined`).

### R-ELEM-FORCE-QUOTE — array-element force-quote (HYBRID)
**Statement.** At a string array element, a bare-word or nested-list START is masked to FORCE the quoted string
`"…"`; the quoted form `"`, a computed `(` call, and a closer `)`/`]`/`}` are admitted.
**Rationale (HYBRID).** FORGIVE a single bare word by quoting it upfront (`vegan` ≡ `"vegan"` via the scorer's
symbol→literal lowering); ENFORCE against a multi-word split (`open hole` whitespace-splits at the scorer into
two elements — there is no fixing it after the first word, so the quote must be forced before the first word
lands). The inverse of `R-BARE-WORD-STRING`: a bare word is ADMITTED at a scalar string slot, MASKED at an
array element.
**Location / predicate.** `violatesElementStructure` (`structural-gates.ts:258-276`). `elementIsStringy===true`,
value-START, opener ∉ `{ " ( 0-9 # ) ] } }` → mask (bare word / `'` / `[`).
**Fires on.** `(list open …)` (mask `open`, force `"open"`); `(list '(…))` (mask the nested wrap).
**Per-model.** Candidate per-model — a model that reliably quotes array strings never needs it; one that emits
bare multi-word elements depends on it. Log per-model to learn the split.
**Activation signal.** classify hit on `R-ELEM-FORCE-QUOTE`; sub-tag the bare-word case vs the nested-list case
(different opener classes) to separate the FORGIVE half from the ENFORCE half in the stats.

### R-BARE-WORD-STRING — scalar bare-word-is-string (FORGIVE)
**Statement.** At a free-form string ARGUMENT slot, a bare word is admitted past Σ — `(fn men)` ≡ `(fn "men")`.
**Rationale (FORGIVE).** The model's rank-0 bare value-word (`men`, `classical`) is RIGHT; the membrane/scorer
lowers it to the string. Without the exemption Σ masks it (unbound symbol) and the model falls back to the
`'(…)` list corruption. Strictly type-gated: number slots, operator position, and the no-type grammar path all
keep the bare word Σ-masked.
**Location / predicate.** `mask-compiler.ts:147` — in `passesSigmaOnState`, `position==="argument" &&
slotIsStringy===true` returns true (admit) before the bound-symbol check.
**Fires on (admits).** `(filter_diet men)` where the diet arg is `string`.
**Per-model.** **STRONG per-model candidate.** Forgiving an unbound symbol is exactly the kind of accommodation
that helps a model whose rank-0 is the bare word but could *hurt* a model that uses bare words as genuine
references — the instrumentation is meant to find whether any model regresses under it.
**Activation signal.** an admitted mid-atom argument that is an UNBOUND symbol (not a Σ prefix) at a stringy
slot — logged as a forgive event (the rule overrode a would-be Σ mask).

### R-LITERAL-ARG-EXEMPT — literal-arg Σ exemption (FORGIVE)
**Statement.** Numbers and `#`-literals (including a partial leading `-`/`+`/`.`) bypass the Σ bound-symbol gate
at an ARGUMENT slot.
**Rationale (FORGIVE).** Σ never binds literals, so as an argument a value is fair; the PARTIAL case is
load-bearing for decode (a tokenizer splits `-11` into `-` + `11`, so the lone `-` must read as the start of a
negative number, not the unbound subtraction symbol — otherwise the gate eats the minus on every negative arg).
**Location / predicate.** `mask-compiler.ts:136` — `position==="argument" && isLiteralValue(frag)` returns true.
`isLiteralValue` at `scheme-atoms.ts:38-45` (sign?/dot?/digit, a bare sign/dot in progress, or `#…`).
**Fires on (admits).** `(fn -11)` mid-split as `(fn -` + `11`.
**Per-model.** GLOBAL — a universal Scheme fact, not a forgiveness of a model quirk. (Its partial-number
exemption rate varies by tokenizer, worth logging.)
**Activation signal.** an admitted mid-atom argument whose `frag` satisfies `isLiteralValue` but is not a Σ
prefix.

### R-LITERAL-NOT-OPERATOR — literal-not-callable at head (ENFORCE)
**Statement.** A number / `#`-literal at OPERATOR position is NOT exempt → `(1 …)` / `(#t …)` is ungeneratable.
**Rationale (ENFORCE).** A value is not callable; `(1 …)` is a guaranteed apply-error. The exemption is
position-gated to arguments precisely so the head falls through to the callable-prefix check and dies. Kills the
`(1)` root-collapse. (R-HEAD-IS-SYMBOL generalizes this to `(` and `'` openers too.)
**Location / predicate.** `mask-compiler.ts:134-136` — the literal exemption is guarded by
`position==="argument"`; at operator position a literal `frag` reaches `isLiveSymbolPrefix(frag, valid)` and
fails.
**Fires on.** `(1 2 3)`, `(#t x)`.
**Per-model.** GLOBAL.
**Activation signal.** a masked mid-atom OPERATOR whose `frag` is a literal.

### R-KEYWORD-ACCESSOR — `:`-keyword accessor admit (FORGIVE)
**Statement.** A `:`-prefixed atom (a member-read accessor, callable-like) is admitted at operator OR argument
position.
**Rationale (FORGIVE).** `:keyword` accessors are a legitimate member-read form; admitting them past the
callable-prefix check lets the model use the accessor surface. Narrow, structural.
**Location / predicate.** `mask-compiler.ts:132` — `frag.startsWith(":")` returns true in `passesSigmaOnState`.
**Fires on (admits).** `(:field obj)`.
**Per-model.** GLOBAL.
**Activation signal.** an admitted mid-atom op/arg whose `frag` starts with `:`.

### R-ELEM-ENUM-NARROW — quote-surface enum narrowing (ENFORCE)
**Statement.** Inside `'(…)` / `(list …)`, a string-literal-enum element is narrowed to its members — the Σ∩T
array analog reaching inside the quote that the outer-slot query cannot.
**Rationale (ENFORCE).** On the quote surface Σ degrades (no base bound-symbol set), so a closed enum element
would be unconstrained; this enforces the member set directly so a non-member is masked on the quote surface
too. Surface-symmetric with the force-quote gate.
**Location / predicate.** `mask-compiler.ts:123-126` — non-application surface, `elementEnum` non-empty,
`frag !== ""` → keep only `isLiveSymbolPrefix(frag, elementEnum)`.
**Fires on.** `'(red gren)` where the element enum is `"red"|"green"` (masks `gren`).
**Per-model.** GLOBAL (type-derived).
**Activation signal.** classify hit (sigma reason) on `R-ELEM-ENUM-NARROW`.

### R-EOS-CLOSEABLE — EOS only when closeable (ENFORCE)
**Statement.** The end-of-sequence token is admitted only when the program is balanced/closeable.
**Rationale (ENFORCE).** A truncated, unbalanced program must be ungeneratable — the whole point of the
constraint. Not a tool-call-specific forgiveness but the closeability rule the catalog names for the stats.
**Location / predicate.** `mask-compiler.ts:290-291` (`compileMask`); the same `closeable` gate threads the
decode loop (`greedyDescend.ts:169,382`).
**Fires on.** masking EOS at `(fn "a"` (unbalanced); admitting it at `(fn "a")`.
**Per-model.** GLOBAL.
**Activation signal.** an EOS candidate masked because `closeable===false` (a premature-end attempt).

### R-FENCE-STEER — markdown-fence steer (FORGIVE)
**Statement.** Accept the model's ` ```python ` / ` ```js ` instinct and normalize it to ` ```scheme\n `, then
run the Scheme-constrained decode inside the fence.
**Rationale (FORGIVE).** On hard entries a model commits to a markdown fence; masking the fence suppresses the
SYMPTOM, not the model's PLAN, and force-feeds rank-39 garbage. Accepting and steering the fence keeps the
model's distribution coherent. The fence lives only in the KV (not the Scheme oracle prefix); it is unwrapped
downstream.
**Location / predicate.** `maybeOpenFence` (`decode/fence-preamble.ts:69-110`) — first content token (after
≤`maxLeadingWhitespace` whitespace tokens) detokenizes to a leading backtick → force-emit `FENCE_OPENER`
(`:34`). Round-trip-guarded; declines on a tokenizer artifact.
**Fires on.** a model that opens with `` ```python\n ``.
**Per-model.** **STRONG per-model candidate.** Audit evidence: only SOME models open with a fence at all (rnj-1
emits `\n\n` then the fence at step 1; easy-entry models snap straight to `(`). The steer is pure benefit for
fence-emitting models and a no-op (byte-identical fall-through) for the rest — so whether to ARM it is a
per-model decision, and the per-model fence-rate is exactly what the stats should surface.
**Activation signal.** `fenceUsed===true` (a fence was opened and the canonical opener force-emitted) — a
distinct preamble event, logged once per decode.

### R-KWARGS-ARITY — kwargs required-positional arity (ENFORCE)
**Statement.** Exactly `requiredCount` positionals are forced first, then `:keyword value` pairs; a bare
positional past the budget (or a premature close before it) is masked.
**Rationale (ENFORCE).** Turns the optional-argument decision into a structural one — the model CANNOT mis-fill
an optional positional slot. Opt-in (profile present), byte-unchanged without a profile.
**Location / predicate.** `violatesKwargsProfile` (`profile-gates.ts:177-195`) via `violatesProfile` (`:432`),
called from `mask-compiler.ts:193`/`:234`. Keyed on `positionalCount` vs `requiredCount` + `closedCall`.
**Fires on.** `(predict_house_price 2500 5 1990)` past arity, or `(calc_area 10 :unit …)` short of arity.
**Per-model.** GLOBAL within a profiled call (schema-derived, not model-shaped).
**Activation signal.** classify hit on `R-KWARGS-ARITY` (sub-tag over-budget-positional vs premature-close).

### R-KWARGS-KEY-NARROW — optional-keyword narrowing (ENFORCE)
**Statement.** An in-progress `:keyword` must prefix some `optionalKeywords` member.
**Rationale (ENFORCE).** Narrows the optional keyword to the schema's set so a hallucinated keyword is
ungeneratable.
**Location / predicate.** `profile-gates.ts:183-186`.
**Fires on.** `(fn a :bogus …)` where `bogus` prefixes no optional keyword.
**Per-model.** GLOBAL within a profiled call.
**Activation signal.** classify hit on `R-KWARGS-KEY-NARROW`.

### R-POSKEYED-ORDER — positional-keyed required order (ENFORCE)
**Statement.** Every argument is a `:keyword value` pair; the required keywords are forced in declaration order,
no bare positional, and the call closes only once every required keyword is placed; a `:`-led operator is
masked.
**Rationale (ENFORCE).** The positional-keyed shape — exactly the required keywords, in order, each with a
value, then optional keywords. Each required keyword's value slot then has exactly one feasible symbol (its
keyword), force-emittable.
**Location / predicate.** `violatesPositionalKeyedProfile` (`profile-gates.ts:392-427`) via `violatesProfile`
(`:432`). `requiredKeywords` present; checks `operatorFirstChar===":"`, bare positional, keyword order,
early-close.
**Fires on.** `(:distance …)` (`:`-led operator), `(fn :date … :location …)` out of order.
**Per-model.** GLOBAL within a profiled call.
**Activation signal.** classify hit on `R-POSKEYED-ORDER` (sub-tag: bad-operator / bare-positional / out-of-order
/ early-close).

---

## 4. Instrumentation design (for the stats — NOT implemented)

Goal: after a sweep, answer **"rule R fired in X% of FAILING decodes vs Y% of SUCCESSFUL decodes, for model
M."** Per-`(rule, model, entry, step, outcome)` activation events, aggregated into per-model × per-rule tables
split by pass/fail.

### 4.1 Where the signal already is

The gate already produces, per step, the exact classification the rules need — it just doesn't *name the rule*.
Two existing seams carry it:

- **The per-step explain tap** — `ctx.onExplain` in `greedyDescend.ts:359-380`, feeding
  `buildStepExplain` (`step-explain.ts:132`). It already classifies every top-K id via `classifyCandidate`
  (`mask-compiler.ts:170`) into `alsoValid` / `noGo` (`structural`/`sigma`), and — under `omittedTopN` (the
  `--log-omitted` carrier, `step-explain.ts:146-174`) — records the high-prob MASKED tokens (`ExplainOmitted`,
  `:38-47`). This is the over-masking view: a dropped token the model *wanted*.
- **The "generation log"** — the per-decode `StepExplain[]` stream the sweep captures (the same stream
  `probe.ts:46-48` collects with `explainOmittedTopN: 12`). One stream per BFCL entry, alongside the entry's
  pass/fail verdict from the reference runner.

What's missing is **rule attribution**: `classifyCandidate` returns only `"structural"` / `"sigma"` — it does
not say *which* of the 14 ENFORCE rules masked the candidate, nor does any path record the 7 FORGIVE rules
firing (a forgive is invisible today — it shows up only as a candidate that *wasn't* masked).

### 4.2 The proposed hook: a `RuleTrace`

Thread a single optional `onRuleFire?(event: RuleFireEvent)` callback alongside `onExplain`, populated inside
`classifyCandidate` / `classifyCandidateSession` (the one shared seam — `mask-compiler.ts:170,213`) and the
two out-of-band forgive sites (`passesSigmaOnState` for `R-BARE-WORD-STRING`/`R-LITERAL-ARG-EXEMPT`/
`R-KEYWORD-ACCESSOR`, and `maybeOpenFence` for `R-FENCE-STEER`). Event shape:

```
RuleFireEvent {
  ruleId:   "R-PHANTOM-LIST" | … ;     // stable catalog ID
  kind:     "enforce" | "forgive";     // the catalog axis
  decision: "masked" | "admitted";     // enforce→masked; forgive→admitted (the decisive override)
  model:    string;                    // M — the roster model id
  entry:    string;                    // the BFCL entry id (the decode unit)
  step:     number;                    // the decode step index
  rank:     number;                    // the candidate's rank in the prob-desc top-K (0 = argmax)
  prob:     number;                    // the model's probability for the candidate (over-masking weight)
  candidate: string;                   // the detokenized candidate chunk (for spot audit)
}
```

A rule's "fire" is recorded once per (step, candidate) where the rule was DECISIVE — i.e. the first rule in the
`classifyCandidate` order that returned a verdict. (`classifyCandidate` short-circuits, so the decisive rule is
unambiguous; FORGIVE rules in `passesSigmaOnState` are decisive when they return `true`/admit *before* the
bound-symbol check.) To keep the existing fast path byte-identical, `onRuleFire` is undefined by default and
every site guards on it — the zero-overhead-when-off contract `omittedTopN` already follows
(`step-explain.ts:106-114`).

### 4.3 Aggregation

For each `(ruleId, model)` accumulate, split by the entry's pass/fail outcome:

- `firedFailing` / `totalFailing` — count of FAILING decodes in which the rule fired at least once / all failing
  decodes for M. `X% = firedFailing / totalFailing`.
- `firedPassing` / `totalPassing` — the same over SUCCESSFUL decodes. `Y% = firedPassing / totalPassing`.
- `overMaskWeight` — sum of `prob` for ENFORCE fires where `rank <= reachRank` (the dropped token sat at or
  above the eventually-picked token — the over-masking signal `step-explain.ts:37` already defines).

The output table is `rule × model → { X%, Y%, overMaskWeight, n }`. A rule with **high X, low Y** is *masking
on the path to failure* (suspicious — either the rule is wrong for M, or it fires precisely where M is already
lost). A FORGIVE rule with **high Y, low X** is *carrying successful decodes* (it earns its keep for M). A rule
with **X ≈ Y ≈ 0** for a model is inert for that model (never exercised — a candidate to drop from M's active
set).

### 4.4 Tie-in to the existing log

No new logging transport: the sweep already writes the `StepExplain[]` per entry. Carry the `RuleFireEvent[]`
on the same per-entry record (one array, appended as rules fire during the decode), keyed by the entry id the
reference runner already stamps pass/fail on. The aggregation in 4.3 is a post-pass join over
`{ entry → (ruleEvents, outcome, model) }`.

---

## 5. The per-model question (the open design question)

The instrumentation in §4 exists to answer: **which rules should become per-model rather than global?** Global
forgiveness is the default (a rule that helps every model stays global); a rule becomes a per-model knob only
when the audit shows it *helps some models and hurts others* — the "different models need different forgiveness"
hypothesis. The strongest candidates, with audit evidence:

1. **`R-HEAD-IS-SYMBOL` (TO-ADD, ENFORCE).** **Strongest.** Arch-1.5B *collapsed* into `((call)(call))`
   parallel-emission without it (the rule rescues the small model); Arch-3B *benefited from the grammar
   regularization* but did not collapse. A rule that is load-bearing for a 1.5B model and merely tidying for a
   3B is the canonical per-model split — enforce it for models whose distribution reaches for non-symbol heads,
   leave it inert for models that never do. The X-high/Y-low vs X-low/Y-low table for this rule across the
   roster is the direct test.

2. **`R-FENCE-STEER` (FORGIVE).** Only some models open with a markdown fence at all (rnj-1 does at step 1;
   easy-entry models snap straight to `(`). The steer is pure benefit for fence-emitters and a byte-identical
   no-op otherwise — so ARMING it is already a per-model decision in spirit. The per-model fence-rate (`fenceUsed`
   frequency) tells us for which models the preamble is worth running.

3. **`R-BARE-WORD-STRING` (FORGIVE).** Admitting an *unbound symbol* as a string value is the riskiest
   forgiveness — it helps a model whose rank-0 at a string slot is the bare word (`men`, `classical`) but could
   regress a model that uses bare words as genuine references. Its high-Y/low-X profile per model is exactly
   what decides whether to keep it global or gate it to models that demonstrably benefit.

Secondary watch-list (log, but weaker priors for per-model split): `R-ELEM-FORCE-QUOTE` (depends on whether a
model reliably quotes array strings) and `R-QUOTE-LIST-ARRAY` (depends on whether a model reaches for `'(…)` vs
`(list …)` — a materialization-preference difference, not a correctness one).
