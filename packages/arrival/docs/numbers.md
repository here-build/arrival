# Numbers — the one-number model

Arrival has one numeric representation, chosen so that no arithmetic result can silently be
wrong. This page states the model, the places it deliberately refuses to answer, and the
literal syntax. Every claim below is pinned by `src/__tests__/numeric-one-number.test.ts`
(the scheme-surface rows) or by the code named in each section.

## The representation

- **Exact numbers** are `AExact`: a gcd-normalized `(num, denom)` rational whose two
  components are plain JS `number`s that are `Number.isSafeInteger` at all times
  (`denom > 0`). An exact integer is just `denom = 1`. There are **no bigints** anywhere in
  the Scheme numeric tower.
- **Inexact numbers** are `AInexact`: an IEEE-754 double. Exactness is visible in the box
  (`1/3` versus `0.3333333333333333`) and collapses only on egress to plain JS, where an
  exact rational is divided (`toJS(1/3)` is the float `0.333…`).
- **Exactness is contagious in the usual way.** `(/ 1 3)` stays the exact rational `1/3`;
  `(+ 1/3 1/3 1/3)` is exactly `1`; any inexact operand makes the result inexact.
  `(= 1 1.0)` is `#t` (numeric equality crosses exactness), but `(eqv? 1 1.0)` and
  `(equal? 1 1.0)` are `#f` — the boxes differ.
- **Exact zero divisor errors.** `(/ 1 0)` is an error (R7RS), not infinity; `(/ 1.0 0)` is
  `+inf.0` and `(/ 0.0 0)` is `+nan.0`.
- **Exactness-preserving ops stay honest.** `floor`, `round`, `truncate`, `quotient`, `gcd`
  and `abs` of an inexact operand stay inexact (`(round 2.5)` is `2.0`); `sqrt` returns an
  exact result only for an exact perfect square (`(sqrt 16)` is `4`, `(sqrt 2)` is inexact).
  Transcendentals (`exp`, `log`, `sin`, `atan`, …) mint inexact silently — no warning, no
  error.

## Crash on overflow

Exact arithmetic on safe operands is exact. The moment a numerator or denominator — or any
cross-multiplied intermediate a rational operation needs — would leave the safe-integer
range, the operation **throws** an `ExactOverflowError` ("exact overflow in exact +: … use
inexact operands (1.0, exact->inexact) if approximation is acceptable"). It never widens to a
bigint and never rounds to a float:

```scheme
(+ 9007199254740991 1)   ; error: exact overflow
(* 94906266 94906266)    ; error: exact overflow
(expt 2 62)              ; error: exact overflow
(exact 1e300)            ; error: exact overflow in inexact->exact
```

Forming a non-integral rational such as `1/3` is ordinary and never an overflow event; only an
overflowing _component_ is. All exact minting routes through one checked choke point
(`src/values/mint-numeric.ts`), whose `checkedMul`/`checkedAdd`/`checkedSub` pre-check each
intermediate, because a silently overflowed float product can round to something that looks
safe afterwards.

An exact integer **literal** beyond the safe range is a read-time `ParseError`
(`9007199254740993`), and `string->number` of such text answers `#f`. To approximate, write the
literal inexact (`9007199254740993.0` or `#i9007199254740993`).

At the membrane the same rule holds from the host side: a raw JS `bigint` is not a Scheme
number and doors with `NoLensError` (see `membrane.md`).

## The tower subset

Arrival implements the **real** part of the R7RS numeric tower (R7RS 6.2 allows omitting
complex numbers):

- Integers, exact rationals and doubles, with the R7RS predicates (`number?`, `real?`,
  `rational?`, `integer?`, `exact?`, `inexact?`, `exact-integer?`, `nan?`, `infinite?`,
  `finite?`), `exact`/`inexact` and `exact->inexact`/`inexact->exact`, `numerator`/
  `denominator`, `floor/`, `floor-quotient`, `truncate-remainder` and kin, `exact-integer-sqrt`, `rationalize`,
  `square`, `expt` (negative exact exponents give exact rationals: `(expt 2 -1)` is `1/2`).
- `rational?` is `#f` for infinities and NaN. `(exact +inf.0)` and `(exact +nan.0)` error.
  `(exact 0.1)` is `1/10` — a float converts through its shortest decimal string, not its
  binary expansion (which would overflow).
- **Complex numbers are doored.** `make-rectangular`, `make-polar`, `real-part`, `imag-part`,
  `magnitude`, `angle`, complex literals (`3+4i`, even `3+0i`), and `sqrt` of a negative
  number raise a teaching error ("complex numbers are not supported in arrival"). The
  reader rejects a complex literal; `string->number` answers `#f` for one.
- **Bitwise operations are doored in full** — `bitwise-and`/`-ior`/`-xor`/`-not`,
  `arithmetic-shift`, the polyglot aliases (`|`, `&`, `~`, `>>`, `<<`) and SRFI-151's
  `bit-count`. JavaScript's bitwise operators coerce their operands to 32 bits, so any
  result on a value wider than 2^31 would be silent corruption — exactly the wrong-value
  class this model exists to abolish — and correct wide bitwise needs the arbitrary-precision
  ALU the representation gave up. The doors teach; they do not guess. (Rationale lives at the
  top of `src/env/srfi/srfi-151.ts`; the five core verbs are doored in
  `src/env/r7rs/numeric.ts`.) If demand ever lands, the honest implementation is split-limb
  arithmetic over safe integers, never the JS operators.

## NaN and negative zero

- `+nan.0`, `+inf.0`, `-inf.0` are shared inexact singletons, boxed like any other inexact.
- `(= +nan.0 +nan.0)` is `#f` (IEEE), but `(eqv? +nan.0 +nan.0)` is `#t` — `eqv?` compares
  with `Object.is`, so NaN is reflexive under it.
- Inexact zero keeps its sign: `(eqv? 0.0 -0.0)` is `#f` while `(= 0.0 -0.0)` is `#t`, and
  `(/ 1 -0.0)` is `-inf.0`. The printed form does not show the sign (`-0.0` prints `0.0`).
- **Exact negative zero does not exist.** `(* -1 0)` is the exact `0`.
- Sorting a list mixing equal-valued exact and inexact numbers (`(sort '(1 1.0 2 2.0) >)`) is
  well defined.

## Literal syntax and `string->number`

The reader and `string->number` share one parser (`src/reader/parsing.ts`), so a literal in
source and the same text handed to `string->number` agree on exactness and value.

| Text                    | Meaning                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `42`, `-7`              | exact integer                                                         |
| `1/3`, `10/2`           | exact rational, reduced (`10/2` is `5`); `1/0` is not a number (`#f`) |
| `1.5`, `1.0`            | inexact (a decimal point makes it inexact)                            |
| `1e2`                   | inexact `100.0` — an exponent never mints an exact                    |
| `#xff`, `#b101`, `#o17` | radix prefixes; `(string->number "ff" 16)` takes the radix instead    |
| `#e1.5`, `#e1e2`        | force exact: `3/2`, `100` (a decimal converts via its decimal string) |
| `#i3/4`                 | force inexact: `0.75`                                                 |
| `+inf.0`, `-inf.0`      | infinities (radix-independent; accepted by `string->number` too)      |
| `+nan.0`                | NaN                                                                   |

`string->number` returns `#f` for text that is not a number (`"abc"`, `""`, complex text,
or an out-of-safe-range exact integer) and sheds surrounding whitespace. A literal in source
that is a number-shaped but unrepresentable token (an over-safe exact integer, a complex
literal) is a `ParseError`/door rather than a quiet fallback to a symbol, so a mistyped number
can never become an unbound identifier.

## Where each rule lives

| Rule                             | Code                                                                      |
| -------------------------------- | ------------------------------------------------------------------------- |
| Representation, exact arithmetic | `src/values/primitives/AExact.ts`, `AInexact.ts`, `src/values/numbers.ts` |
| Overflow door, checked helpers   | `src/values/mint-numeric.ts`                                              |
| Literal parsing                  | `src/reader/parsing.ts`                                                   |
| `string->number`, numeric verbs  | `src/env/r7rs/strings.ts`, `src/env/r7rs/numeric.ts`                      |
| Bitwise doors                    | `src/env/r7rs/numeric.ts`, `src/env/srfi/srfi-151.ts`                     |
| Host `bigint` door               | `membrane.md` (INBOUND)                                                   |
| Behavior rows                    | `src/__tests__/numeric-one-number.test.ts`                                |
