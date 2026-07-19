# One-Number Rework — exact = safe-integer ratio of `number`s

Every scheme number's payload is a plain JS `number`. Exact numbers are ratios of two
safe integers; exact results that would leave safe range **throw**, never silently
coerce.

## 0. Invariants

1. Every scheme number's payload is a JS `number`. Exactness is a **box-class distinction** (`AExact` vs `AInexact`), never a payload type.
2. **The safe-operand invariant (load-bearing):** every `AExact` payload satisfies `Number.isSafeInteger` at all times — enforced at the *three ingress gates* (parser/`string->number`, membrane `fromJS`, op minting). Given safe operands, IEEE float arithmetic on integers is **exact** whenever the true result is in safe range, and a true result ≥ 2^53 can never round back *into* safe range (2^53 is representable; nearest-rounding lands ≥ it) — so a post-op `isSafeInteger` check is a **sound** exactness gate for `+ − ×` chains *within the closed algebra*. The classic float-ALU objection — a ulp-corrupted "exact" result — requires an unsafe operand, which the invariant excludes. Belt anyway: a DEBUG-mode assertion cross-checks exact-path results against BigInt arithmetic in dev/test builds — zero production cost, catches any gate leak.
3. **Exact results whose components leave safe range THROW** — a proper, teaching error ("exact overflow: result exceeds safe-integer components — use inexact operands (`1.0`, `exact->inexact`) if approximation is acceptable"), never a silent coercion. R7RS §6.2.3 explicitly permits *reporting* the implementation restriction. Consequence: **exactness is a guarantee** — if exact arithmetic answered, the answer is exact; every exit from the exact domain is either an *authored* inexact operand (visible in source, ordinary contagion) or a thrown error. Host-number ingress stays the silent law (`fromJS(2^60)` → inexact — ambient host values are not authored exacts); a **source literal** too big for exact (`9007199254740993`, `#e`-prefixed over-safe) is a ParseError telling the author to write it inexact.
4. `bigint` is an opaque host value — not a scheme number (`number?` → `#f`); arithmetic on it doors with a convert-explicitly message.
5. The interpreter is the faithful reference (`exact?`, `eqv?` distinction, `5.0` printing — all box-carried). Compiled-artifact numeric behavior is out of scope (§4).
6. Pinned behaviors: `(= 1 1.0)` `#t` · `(eqv? 1 1.0)` `#f` · `(equal? 1 1.0)` `#f` (Setoid dispatch **must stay ordered before** the `valueOf` fast path in `structural-equal.ts` — exact `1` and inexact `1.0` carry identical payloads; only the dispatch order keeps them distinct) · `(eqv? 0.0 -0.0)` `#f` · `(eqv? +nan.0 +nan.0)` `#t` · exact `-0` is **unconstructible** (`isSafeInteger(-0)` is `true`, so the constructor normalizes: `x === 0 ? 0 : x`).

## 1. Rejected representation: bigint rationals

The alternative — `AExact` backed by `bigint` `num`/`denom` — buys arbitrary precision
at the wrong price:

- **Two numeric kingdoms.** Every op, comparison, printer, and codec grows a bigint arm (~230 lines of gcd/normalize/cross-compare/round-ties-even, plus a bigint `isqrt`); the type layer and every numeric contract must present `bigint` faces to the host.
- **The range is unobservable anyway.** `bigint` is not JSON-serializable — canonical hashing and run recording throw on it, so no persisted artifact can carry an over-safe exact. The extra range exists only inside a single evaluation.
- **It fights the membrane.** `bigint` is a primitive — it cannot be WeakMap-wrapped — so forcing it into scheme numbers requires a dedicated wrapper-cache mode keyed by a `forceBigInt` bit that nothing in production sets.
- **It hides a real bug family.** With `bigint` as the exact face, codec encode edges re-derive exactness from value *shape* (`isSafeInteger → exact`), producing `(exact? (floor 2.5))` → `#t` and friends. The one-number design forces the fix (§2.2).

The governing rule: all scheme numbers are safe integers or ratios of safe integers.
Arbitrary precision is not a capability this interpreter sells — host `bigint` plus an
explicit conversion verb is the escape hatch (§2.3, §4).

## 2. Design

### 2.0 Representation: RATIO with crash-on-overflow

`AExact = (num: number, denom: number)`, both safe integers, gcd-normalized,
`denom > 0`, exact `-0` unconstructible. Non-integral exact division constructs a
rational (no event); any op whose result components exceed safe range **throws**
(§0.3). Egress divides (`toJS(1/3)` = `0.333…` — projection∘borrow, the same law as
nil-as-array).

The rejected in-family alternative — **FLAT** (`AExact = number`, integers only):

| | **FLAT** — `AExact = number` | **RATIO** — `AExact = (num, denom)` |
|---|---|---|
| `(/ 1 3)` | inexact `0.333…` | **exact `1/3`**; egress divides (JS face `0.333…`) |
| R7RS §6.2 conformance | large flip: rational rows, `(/ 3)`, numerator/denominator, round-on-`7/2`, rationalize all become xfails — a material fraction of the corpus | most rational rows **stay green** within safe components |
| complexity | one field, no gcd | rational arithmetic over `number` + `isSafeInteger` gates on cross-multiplied intermediates (sound per §0.2 — products of safe ints check exactly) |
| exact-domain exits | overflow *plus every non-integral `/`* | component overflow only (unlike-denominator sums blow up denominators in ~10 terms → throw, §0.3) |
| `quotient` family | unchanged | doors on `denom ≠ 1` (R7RS: integer args) |

RATIO wins: it keeps most of R7RS §6.2 green and preserves `/`-semantics, for the cost
of porting rational arithmetic that is sound under the safe-operand invariant. FLAT
demotes every non-integral exact division to inexact — a semantic regression, not just
a conformance one.

### 2.1 Core

- The `AExact` constructor invariant-checks its components (an unsafe component at construction is an internal gate-leak bug, never a program-level event — ops must check *before* constructing) and normalizes `-0`.
- **One mint choke-point** — `mintNumeric(ctx, x, wantExact)` in `values/mint-numeric.ts` — owns the overflow-throws law (§0.3) via checked-arithmetic helpers (`checkedAdd`/`checkedSub`/`checkedMul`).
- Ops needing per-intermediate checks (all sound under §0.2): variadic `+/-/*` folds (check each step), `expt` (repeated-mult with per-step check), `lcm` (`a/g*b`, checked product), `exact-integer-sqrt` (float `Math.sqrt` + integer verify). **`(/ x 0)` errors** (exact division by exact zero — R7RS); inexact `/ 0.0` → `Infinity` per IEEE.
- `numerator`/`denominator`: the inexact arm is R7RS-required (`(denominator 0.5)` → `2.0`, via `floatToRational`); the exact arm reads the fields.
- `rationalize`: real behavior — with integer exact args the simplest-in-range search always contains x, giving an exact-integer result; the inexact arm is unchanged.
- `inexact->exact`: `0.5` → exact `1/2` (R7RS §6.2.6 — result must be exact AND equal, and RATIO represents it exactly). NaN/Inf throw; `-0.0` → exact `0`.
- `schemeCompare`: exact/exact compares by cross-multiplication of safe components; where an intermediate leaves safe range, the comparator degrades to a monotonic float compare — sound, because a comparator only needs to answer *order*, never reconstruct a value. The `AExact`/`AInexact` Setoid instanceof-gates and the structural-equal dispatch order (§0.6) are load-bearing.

### 2.2 The encode-edge exactness law

The exactness-contagion bug family lives at the **codec encode edge**, not in op
bodies: a loose codec that re-derives exactness from the VALUE (`isSafeInteger →
AExact`) invents exactness the operands never had. The law: **encode never invents
exactness — `wantExact` is computed from the coerced operands' boxes and threaded to
the out-channel** (or the affected specs bypass loose codecs and mint directly). This
single law is what makes `(exact? (abs -0.0))`, `(exact? (floor 2.5))`,
`(exact? (quotient 7.0 2))`, and `(exact? (gcd 4.0 6))` all answer `#f`; `"1e2"` is
handled at parse (the exponent arm mints `wantExact=false`, §2.5). Transcendentals
(`sqrt`-non-perfect, `sin`, `log`, …) are inexact-by-spec-class — they mint
`wantExact=false` silently.

### 2.3 Codecs · membrane · host-bigint

- `z.exact` decodes/encodes plain `number`; every core numeric contract's JS face is `number`. A compatibility `bigint` codec remains for consumers that still declare it (it doors on non-integral exacts and safe-range-checks on encode) — new code uses `integer`.
- Membrane: `fromJS(bigint)` → **opaque host pass-through**. Named design decision, not a footnote: `bigint` is a primitive — it cannot be WeakMap-wrapped — so it rides the raw pass-through lane (the `Uint8Array` precedent); `number?` answers `#f` on it, arithmetic doors on it, printing shows the `10n`-style host form. `toJS`(exact) → plain `number` always (with safe-int components, an out-of-range bigint face cannot arise).
- **The host-API wall, said loudly:** host callbacks receive `number`, never `bigint` (lengths, ids included). A `bigint->number` conversion verb (safe-range-checked) is the explicit door from an opaque host bigint into scheme numbers.
- JSON face invariant: exact `1` and inexact `1.0` are indistinguishable in JSON output (both `1`) — the box survives only in scheme space.

### 2.4 No warn channel

There is nothing to warn about: component overflow **throws** (loud, contextual,
teaching — the error IS the observability, and it reaches every transcript by
construction); non-integral `/` constructs an exact rational (no event);
transcendentals are inexact-by-spec-class (silent); host-number ingress is silently
inexact for non-safe values. The only message design is the **overflow error text**:
it names the operation, the offending magnitude, and the escape hatch ("use inexact
operands if approximation is acceptable") — errors as doors.

### 2.5 Printing / parsing

- `number->string`(exact) → integer string, or `num/denom` for exact rationals (radix support unchanged).
- `string->number`: `"1e2"` → inexact; `"p/q"` parses to an exact rational when both components are safe, else `#f`.
- Reader twin (`string->number` and the reader share one numeric path in `utils/parsing.ts`): same rules, but a rejected rational token **throws ParseError** — it must never decline, because a token failing the numeric regexes falls through to symbol, and `1/3` silently becoming a symbol is worse than any error. An over-safe source literal is likewise a ParseError (§0.3).

## 3. Pinned behavior rows

- **Overflow throws:** `(+ 9007199254740992 1)` → error — never a wrong exact, never a silent float; `(* 94906266 94906266)` component-overflow inside a rational op → error; a variadic fold (`(* 94906266 94906266 94906266)`) catches overflow at whichever step first leaves safe range.
- **Ratio semantics:** `(/ 1 3)` → exact; `(exact? (/ 1 3))` `#t`; `(+ 1/3 1/3 1/3)` → exact `1`; `(numerator (/ 6 4))` → `3`; `toJS`-face of `1/3` = `0.333…`.
- **Encode-edge law (§2.2):** `(exact? (floor 2.5))` `#f` · `(exact? (quotient 7.0 2))` `#f` · `(exact? (gcd 4.0 6))` `#f` · transcendental results are silently inexact.
- **Box identity (§0.6):** `(equal? 1 1.0)` `#f` · `(eqv? 0.0 -0.0)` `#f` · exact `-0` unconstructible · `(sort > '(1 1.0 2 2.0))` stable.
- **Doors:** `(/ 1 0)` errors · `(quotient (/ 3 2) 1)` errors (integer args).
- **Parsing (§2.5):** `(string->number "10/2")` → exact `5` · over-safe source literal → ParseError.

## 4. Non-goals

- Compiled-world numeric emission (the interpreter is the faithful reference, §0.5).
- Any bignum / rational-beyond-safe capability — host `bigint` plus the `bigint->number` verb is the escape hatch.
- **The bitwise family is doored, not coerced:** JS bitwise operators truncate to 32 bits while exacts range to 2^53 — silent corruption above 2^31; here lieth the dragons. `bitwise-and`/`ior`/`xor`/`not`, `arithmetic-shift`, `bit-count` (and SRFI-151) raise a teaching error instead of returning truncated results.
