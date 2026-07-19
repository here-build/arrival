# One-Number Rework — exact = safe-integer ratio of `number`s (v2.1, RATIO ruled)

**Status: EXECUTED ✓ — LANDED 2026-07-14.** Commits: `9b6ca55958` (bitwise doors, ahead of the atom) · `98fd0e2d88` (the representation atom, 69 files) · `ac1b2f4a50` (bfcl external) · registry cleanup (13 healed xfail rules retired). Executed by a 9-agent Sonnet fleet (scout ∥ W0 → core → 4 sweeps → triage → gate) + main-session review, which completed the 3 protected-file mints, adjudicated `(inexact->exact 0.5)` → exact `1/2` (correct under RATIO; this plan's earlier "error" row was a flat-era leftover — §6 note), and retired the triage agent's honestly-ledgered blocked-bug xfails. Final gates: build 0 errors · W0 28/28 · chibi corpora 775 pass / 153 xfail / 0 unexpected · downstream green. This document is retained as the design record.

**Ruling:** v2.1 — four audits folded; the §2.0 fork RESOLVED: RATIO with crash-on-overflow (V, 2026-07-14: "two-number ratio propagation is extremely promising — minimal change, observable, trackable, fair numeric tower behavior, numbers as ints, safely; we can crash properly if we're out of safe integer on each of ratio sides").
**Ruling:** V, 2026-07-13 — "all numbers should be safe integers … less is more; we're already doing the impossible." Constitution §7. Supersedes exact=bigint.
**Already executed ahead of this plan:** the **bitwise family is DOORED** (`9b6ca55958`, "here lieth the dragons") — bitwise-and/ior/xor/not, arithmetic-shift, `| & ~ >> <<`, bit-count; all four auditors independently recommended door-not-coerce; the JS-operators-truncate-to-32-bits workstream is gone from this plan.

---

## 0. Invariants (the ruling, restated)

1. Every scheme number's payload is a JS `number`. Exactness is a **box-class distinction** (`AExact` vs `AInexact`), never a payload type.
2. **The safe-operand invariant (load-bearing):** every `AExact` payload satisfies `Number.isSafeInteger` at all times — enforced at the *three ingress gates* (parser/`string->number`, membrane `fromJS`, op minting). Given safe operands, IEEE float arithmetic on integers is **exact** whenever the true result is in safe range, and a true result ≥ 2^53 can never round back *into* safe range (2^53 is representable; nearest-rounding lands ≥ it) — so a post-op `isSafeInteger` check is a **sound** exactness gate for `+ − ×` chains *within the closed algebra*. (This answers the auditors' BigInt-internal-ALU demand: their ulp-corruption traps all require an unsafe operand, which the invariant excludes. Belt added anyway: a DEBUG-mode assertion cross-checks exact-path results against BigInt arithmetic in dev/test builds — zero production cost, catches any gate leak.)
3. **Exact results whose components leave safe range THROW** — a proper, teaching error ("exact overflow: result exceeds safe-integer components — use inexact operands (`1.0`, `exact->inexact`) if approximation is acceptable"), never a silent coercion. R7RS §6.2.3 explicitly permits *reporting* the implementation restriction. Consequence: **exactness is a guarantee** — if exact arithmetic answered, the answer is exact; every exit from the exact domain is either an *authored* inexact operand (visible in source, ordinary contagion) or a thrown error. Host-number ingress stays the status-quo silent law (`fromJS(2^60)` → inexact — ambient host values are not authored exacts); a **source literal** too big for exact (`9007199254740993`, `#e`-prefixed over-safe) is a ParseError telling the author to write it inexact.
4. `bigint` is an opaque host value — not a scheme number (`number?` → `#f`); arithmetic on it doors with a convert-explicitly message.
5. Interpreter stays the faithful reference (`exact?`, `eqv?` distinction, `5.0` printing — all box-carried). Compiled-artifact doors are constitution §7's business, not this plan's.
6. Pinned behaviors: `(= 1 1.0)` `#t` · `(eqv? 1 1.0)` `#f` · `(equal? 1 1.0)` `#f` (Setoid dispatch **must stay ordered before** the `valueOf` fast path — structural-equal.ts:66-71; post-rework the payloads collide, only the ordering saves it) · `(eqv? 0.0 -0.0)` `#f` · `(eqv? +nan.0 +nan.0)` `#t` · exact `-0` is **unconstructible** (`isSafeInteger(-0)` is `true` — the constructor normalizes `v + 0`... i.e. `x === 0 ? 0 : x`).

## 1. Verified current state (Fable census, 2026-07-14)

- `AExact` = bigint **rational** (`num`/`denom`, AExact.ts:16-19): ~230 lines of gcd/normalize/cross-compare/arith/round-ties-even. `numbers.ts`: `bigintISqrt`, `schemeCompare` bigint arm, `parseNumber` (host-only). The `(+ (/ 1 3) 0)` decay = ops dropping `denom`.
- **Prod blast radius: contained.** 78 prod `new AExact(` sites / 20 files (numeric.ts 32, parsing.ts 9, scheme-zod 8, …); **~275 test sites are the mechanical bulk**. `.denom` 61 hits/10 files. All AExact importers inside the arrival packages **except two duck-typed externals**:
  - `arrival-serializer/serializer.ts:529-538` — `"num" in obj` duck-type → post-rework **silent fall-through**;
  - the BFCL eval scorer (private monorepo) — `v.denom === 1n` → post-rework **silent NaN in the scorer**.
- **Tape/cache risk is VACUOUS** (v1 risk 2 deleted): `canonicalJson` throws on bigint (run-cache.ts:111-148), `run-program.ts` records via `JSON.stringify` (would have thrown at record time), provenance hashing has a documented non-load-bearing `String()` fallback. **No persisted artifact can contain a bigint payload. W5 = rebuild-and-rerun, no migration, no version bump.**
- **Reader**: `1/3` parses (`parse_rational`, parsing.ts:107-117), `#e`/`#i` honored (:92-97), `#e1.5` → rational (:194-208); reader and `string->number` are **one code path** (strings.ts:428). ⚠ a token failing numeric regexes falls through to **ASymbol** (:410) — rational rejection must **throw ParseError**, never decline, or `1/3` silently becomes a symbol.
- `fromJS(5)` ingress is **already exact** at all three mints (boxing.ts:47-52, op-helpers.ts:341-352, values-repr.ts:141-147) — ⚖️3 answered: status quo, zero behavior change.
- **The exactness-bug family is wider than the sweep's cluster** — the loose-codec encode edge re-derives exactness from value shape (scheme-zod.ts:489, :512-517): `(exact? (floor 2.5))` → `#t`, `(exact? (quotient 7.0 2))` → `#t`, `(exact? (gcd 4.0 6))` → `#t`, `(exact? (abs -0.0))` → `#t` — all live today, all one root cause.
- `forceBigInt` rosetta option (rosetta.ts:50-73) has **no production setter** — vestigial; it's also the one bit keying the two-level wrapper-cache mode → deleting it simplifies the cache.
- min/max already do correct box-contagion (numeric.ts:452-470) — keep, don't route through naive minting.
- plexus/feistel confirmed decoupled (number-halves, no AExact/z.bigint imports).

## 2. Target design

### 2.0 THE FORK — RESOLVED: **RATIO with crash-on-overflow** (V, 2026-07-14)

`AExact = (num: number, denom: number)`, both safe-ints, gcd-normalized, `denom > 0`, exact `-0` unconstructible. Non-integral exact division constructs a rational (no event); any op whose result components exceed safe range **throws** (§0.3). Egress divides (`toJS(1/3)` = `0.333…` — projection∘borrow, the nil-as-array law). The comparison table below is retained for the record; FLAT survives only as the documented fallback if the guarded port fails in practice.

| | **FLAT** — `AExact = number` | **RATIO** — `AExact = (num, denom)` both safe-int numbers, gcd-normalized, `denom > 0` |
|---|---|---|
| `(/ 1 3)` | inexact `0.333…` | **exact `1/3`**; egress divides (JS face `0.333…` — projection∘borrow, same law as nil-as-array) |
| chibi §6.2 | large flip: rational rows, `(/ 3)`, numerator/denominator, round-on-`7/2`, rationalize → xfail ledger (realistic: **material fraction of §6.2**, hundreds of rows to triage — longcat) | most rational rows **stay green** within safe components |
| complexity | one field, no gcd | port existing rational code bigint→number + isSafeInteger gates on cross-multiplied intermediates (sound per §0.2 — products of safe ints check exactly) |
| coercion events | overflow + every non-integral `/` | component overflow only (unlike-denominator sums blow up denominators in ~10 terms → coerce+warn) |
| `quotient` family | unchanged | doors on `denom ≠ 1` (R7RS: integer args) |
| oracle | face-level fine | face-level fine (egress divides — interpreter face ≡ compiled face) |

Fable's findings sized flat; ratio adds the ALU port but *deletes* most of the chibi-triage and the `/`-semantics regression. **Lead rec: ratio** (buys back a big R7RS slice for a port of code that already exists); flat is the fallback if the guarded port turns ugly.

### 2.1 Core

- `AExact` payload per the fork; constructor invariant-checks (internal error if violated — ops must coerce *before* constructing) + `-0` normalization.
- **One mint choke-point** `mintNumeric(ctx, x, wantExact)` owning §0.3, with the warn taxonomy (§2.4). Temporary `AExact.fromBigint` adapter during the sweep, deleted at the end of the same commit series.
- Ops needing per-intermediate checks (all sound under §0.2): variadic `+/-/*` folds (check each step), `expt` (repeated-mult with per-step check), `lcm` (`a/g*b`, checked product), `exact-integer-sqrt` (float `Math.sqrt` + integer verify — `bigintISqrt` deletes). **`(/ x 0)` still errors** (exact division by exact zero — R7RS; the "plain JS division" framing does not repeal it; inexact `/ 0.0` → `Infinity` per IEEE, documented).
- `numerator`/`denominator`: **the inexact arm survives** (`(denominator 0.5)` → `2.0` is R7RS-required; `floatToRational` at numeric.ts:497-529 stays); only the exact arm simplifies (flat: `x`/`1`; ratio: the fields).
- `rationalize`: **keep** (Fable: with integer exact args, `simplestInRange` always contains x → exact-integer result; inexact arm already correct; just de-bigint it). Under ratio it keeps real behavior.
- `inexact->exact 0.5` → **error** (R7RS §6.2.6: result must be exact AND equal; coerce-warn would self-contradict). `inexact->exact` of NaN/Inf keeps throwing; of `-0.0` → exact `0` (chibi pins it).
- `schemeCompare`: exact/exact via number compare (payloads safe — no float hazard); the bigint cross-multiply arm deletes (its reason — >2^53 exacts — can no longer exist). Keep AExact/AInexact Setoid instanceof-gates AND the structural-equal dispatch order (§0.6).

### 2.2 The encode-edge exactness law (the real cluster fix)

The contagion bugs live at the **codec encode edge**, not in op bodies: `looseNumber`/`looseAnyNumber.encode` re-derive exactness from the VALUE (`isSafeInteger → AExact`). The law: **encode never invents exactness — `wantExact` is computed from the coerced operands' boxes by `nativeNumericOp`/`marshalCall` and threaded to the out-channel** (or the affected specs bypass loose codecs and mint directly). This single change fixes `(exact? (abs -0.0))`, `(exact? (floor 2.5))`, `(exact? (quotient 7.0 2))`, `(exact? (gcd 4.0 6))` — and `"1e2"` fixes at parse (`parse_float`'s exponent arm, parsing.ts:178-180, mints `wantExact=false` per §7.1.1). Transcendentals (`sqrt`-non-perfect, `sin`, `log`, …) are inexact-by-spec-class — they mint `wantExact=false` **silently** (no warn; they're already silently inexact today).

### 2.3 Codecs · membrane · host-bigint

- `z.exact` decodes/encodes `number`; `z.bigint` **retired** — every contract site flips (`string-length`, `char->integer`, srfi-13 ×2, `odd?`/`even?`/`gcd`/`lcm`/`quotient` specs; srfi-151's went with the doors). Type-layer twins flip too: `EXACT_GUARD` "bigint" strings (numeric.ts:1031-1038), schema-to-ts printer + its test, `numeric.test-d.ts`'s 6 face assertions.
- Membrane: `fromJS(bigint)` → **opaque host pass-through**. Named design decision (not a footnote): bigint is a primitive — can't WeakMap-wrap — so it rides the raw pass-through lane (the `Uint8Array` precedent, membrane.ts:204); `number?`/arithmetic door on it; printing shows `10n`-style host form. AWrap/AUnwrap rows (values/types.ts:146-181) rewritten; `forceBigInt` deleted (+ the wrapper-cache mode bit simplification). `toJS`(exact) → plain number always (the out-of-range bigint face can no longer trigger).
- **Host-API break, said loudly:** any host callback that received `bigint` (lengths, ids) now receives `number`; input-side `z.bigint` rosettas are enumerated in W1 and each gets a named disposition. A `bigint->number` conversion verb ships (safe-range-checked) so opaque host bigints have an explicit door into scheme numbers. DEVIATIONS entry: the wall is hard, no soft-migration release (repo-internal consumers only — census found zero external).
- JSON face invariant, documented: exact `1` and inexact `1.0` are indistinguishable in JSON output (both `1`) — box survives only in scheme space; this was already true for safe-range exacts today.

### 2.4 The warn channel — DISSOLVED by the crash ruling

There is nothing left to warn about: component overflow **throws** (loud, contextual, teaching — the error IS the observability); non-integral `/` constructs an exact rational (no event); transcendentals are inexact-by-spec-class (silent, as today); host-number ingress keeps its status-quo silent law. The auditors' noise/visibility concerns (cadence caps, agent-visible channel) are deleted with the channel — an error already reaches every transcript by construction. The only surviving message design is the **overflow error text** itself: it names the operation, the offending magnitude, and the escape hatch ("use inexact operands if approximation is acceptable") — errors-as-doors.

### 2.5 Printing / parsing

- `number->string`(exact) → integer string (radix support unchanged); the `num/denom` printer arm (numeric.ts:911, AExact.toString) — flat: deletes; ratio: stays for exact rationals.
- `string->number`: `"1e2"` → inexact; `"p/q"` — flat: `#f` **except when q divides p** (integral+safe → exact integer; keeps chibi `10/2`/`0/10`/`#e0/10` green — Fable's refinement); ratio: parses within safe components else `#f`. Reader twin: same, but **throws ParseError** on a rejected rational token (never falls through to symbol — §1's hazard).

## 3. Work packages (re-sliced per the unanimous audit demand)

- **W0 — red first.** All prior rows PLUS: **overflow-throws rows** (`(+ 9007199254740992 1)` → error, never a wrong exact and never a silent float; `(* 94906266 94906266)` component-overflow in a rational op → error), **ratio rows** (`(/ 1 3)` → exact, `(exact? (/ 1 3))` `#t`, `(+ 1/3 1/3 1/3)` → exact `1`, `(numerator (/ 6 4))` → `3`, `toJS`-face of `1/3` = `0.333…`), `(exact? (floor 2.5))` `#f`, `(exact? (quotient 7.0 2))` `#f`, `(exact? (gcd 4.0 6))` `#f`, `(equal? 1 1.0)` `#f`, `(eqv? 0.0 -0.0)` `#f`, exact `-0` unconstructible, `(/ 1 0)` errors, `(quotient (/ 3 2) 1)` errors (integer args), `(sort > '(1 1.0 2 2.0))` stable, transcendental-silence row, `(string->number "10/2")` → exact `5`, over-safe source literal → ParseError.
- **W1 — scouts, now thin** (census done by the audit): the input-side `z.bigint` rosetta enumeration + disposition table; chibi §6.2 verdict-flip pre-list with a **real count** (variant-dependent); confirm the warn channel's agent-visible surface.
- **W2 — THE REPRESENTATION ATOM (fused; the old W2+W3+serializer).** One commit series, green only at its end: AExact + `mintNumeric` + DEBUG bigint cross-check + numbers.ts + numeric.ts sweep + **scheme-zod codecs incl. the encode-edge law** + boxing/`coerceNumeric` + membrane bigint row + AWrap/AUnwrap + `forceBigInt` deletion + **arrival-serializer AExact arm** + **bfcl-eval-score numeric read** + type-layer bigint strings + `r7rs-numbers.test.ts` **whole-suite inversion** (it is 174 lines of regression guards FOR the old semantics) + chibi re-verdicts + membrane law tests. All four auditors: W2/W3 as separate green commits was fiction — the codecs decode the payloads.
- **W3 — printing/parsing** (§2.5) + reader-throw rule + repl battery.
- **W4 — downstream:** rebuild; llm-plane-arrival-chain, arrival-run, inhuman suites; BFCL example re-run. (No migration work — tapes vacuous.)
- **W5 — docs:** DEVIATIONS entries (no rationals-beyond-safe / flat: no rationals at all; safe-int exact ceiling; `inexact->exact` errors; host-bigint wall; JSON face), r7rs-completeness-audit numeric section, stale chibi registry reason-strings (isqrt), memory.

## 4. Non-goals

Compiled-world emission (constitution §7 owns it) · type-lens leaf redesign (all-number already; only the §2.3 bigint-string flips) · any bignum/rational-beyond-safe capability (host bigint + the conversion verb is the escape hatch) · bitwise (doored, `9b6ca55958`).

## 5. Risks (v2)

1. **Gate-leak on the safe-operand invariant** — one unguarded mint path = silent wrong exacts. Mitigation: single choke-point + DEBUG bigint cross-check in test builds + W0 ulp rows.
2. **The two duck-typed externals** (serializer, bfcl) — in the atom's sweep, not discoverable by type errors. Mitigation: named in W2's checklist; grep-gate in CI for `\.denom\b` outside AExact at the end of W2.
3. **Chibi §6.2 triage volume** (flat variant especially) — hundreds of rows; must land as named xfails, never silent skips. Mitigation: W1 pre-list with count; suite stays green-by-law.
4. **Warn-channel noise/visibility** — §2.4's cadence + surface requirements are part of W2's definition of done.
5. Setoid/valueOf ordering regression (§0.6) — one W0 row guards the only thing preventing `(equal? 1 1.0)` → `#t`.

## 6. ⚖️ Resolved (audit round) + remaining

Resolved: **flat vs ratio → RATIO with crash-on-overflow** (V 2026-07-14) · `inexact->exact 0.5` → **error** · `"1/3"` → under ratio, parses to the exact rational when components are safe, else `#f`/ParseError per §2.5 · ingress integral-safe → **exact** (status quo) · `rationalize` → **keep** (real behavior under ratio) · warn channel → **dissolved** (§2.4) · bitwise → **doored** (executed, `9b6ca55958`) · arbitrary-precision load-bearing consumers → none.
**No open decisions. Ready to execute: W0.**
