/**
 * The bug-cell corpus protocol (oracle-harness.md §4.3) — ONE row per sibling
 * `<name>.scm`: the hand-reasoned expectation that lets the tier-1 oracle
 * catch an INTERPRETER regression (pure differential testing is blind to "both
 * sides agree on the same wrong answer").
 *
 * Row shapes (exactly one per row — the sweep in bug-cell-corpus.test.ts
 * enforces it):
 *   - `value`      — both sides produce this value (oracleEqual)
 *   - `errorClass` — both sides throw this class
 *   - `divergent`  — divergence-by-design (exact overflow, representation
 *                      collapse): each side is checked against its own half;
 *                      `interpreter ≡ compiled` is never checked, and the row
 *                      must KEEP diverging (a converged row is stale — promote
 *                      it to a plain `value` row).
 *
 * Adding a case is "drop one .scm + one row here" — bug-cell-corpus.test.ts's
 * drift guard fails loud on a row without a .scm or a .scm without a row.
 * The `.scm` files stay files: determinism, cross-pass, and emitted-fixtures
 * share them verbatim (constitution's "one corpus, two owners").
 */
import type { ExpectedOutcome } from "../../index.js";

export interface CorpusExpectation {
  /** The sibling `corpus/<name>.scm` this row expects on. */
  readonly name: string;
  readonly expected: ExpectedOutcome;
}

export const CORPUS_EXPECTATIONS: readonly CorpusExpectation[] = [
  /**
   * Non-evaluation probe: if the untaken second operand is ever evaluated, BOTH
   * sides throw and this value row fails loudly. `error` is the immutability-legal
   * side-effect probe (`set!` doors; `(car '())` is Law-U-tolerant and proves nothing).
   */
  {
    name: "and-false-short-circuits",
    expected: { value: false },
  },

  /**
   * 3-ary `and` — the right-nested ternary chain must thread values through
   * every rung: first `#f` operand or the LAST value (2), never a JS `&&` fold.
   */
  {
    name: "and-three",
    expected: { value: 2 },
  },

  /**
   * `and` is value-position divergent under a raw `&&` lowering: Scheme `(and 0 1)`
   * returns the last operand `1` (0 is truthy); JS `(0 && 1)` returns `0`.
   */
  {
    name: "and-zero-then-one",
    expected: { value: 1 },
  },

  /**
   * SRFI `any` returns the first truthy predicate RESULT (the witness, 2).
   * Mercury has no `any` emitter yet — unbound in the artifact. Phase-1
   * residual.
   */
  {
    name: "any-witness",
    expected: { value: 2 },
  },

  /** The classic transpose idiom: `(apply map list '((1 2) (3 4)))` → `((1 3) (2 4))`. */
  {
    name: "apply-map-transpose",
    expected: {
      value: [
        [1, 3],
        [2, 4],
      ],
    },
  },

  /** `apply` over the variadic `+`: a plain reduce/fold — `6` (Appendix B: representation-collapsed). */
  {
    name: "apply-plus",
    expected: { value: 6 },
  },

  /**
   * The alist idiom end to end: CONSTRUCT via `(list (cons 'field v) …)`, then
   * READ via the `:field` keyword accessor (the 2026-07-17 alist-lowering ruling,
   * `keyword-accessor-alist-*` rows) — the two halves landed separately and had
   * never been proven together through actual compilation, since the unconditional
   * spread crashed construction before the accessor ever saw a `cons`-built alist.
   * `e` is `[["guilty", true]]`; both sides walk to the entry whose key is
   * `"guilty"` and return its value, `#t` / `true`.
   */
  {
    name: "cons-alist-round-trip",
    expected: { value: true },
  },

  /**
   * `cons` with a PROVEN list tail (a quoted list — `quoteFacts` derives `list`/
   * `nonEmptyList` structurally, no query needed): the spread golden, unchanged by
   * the tail-shape fact gate. Regression guard — `consEmitRule`'s three-way branch
   * must keep emitting `[x, ...xs]` for this shape, never fall back to the runtime
   * shim.
   */
  {
    name: "cons-list-tail",
    expected: { value: [1, 2, 3] },
  },

  /**
   * `cons` with a PROVEN scalar tail — the alist-entry idiom (`list`/real alists'
   * `(cons 'field v)`) that unconditional-spread crashed on: a scalar cdr is not
   * iterable, so `[x, ...xs]` threw "42 is not iterable" at construction. The tail
   * fact gate proves `numeric` here (a literal), so the residual is the clean
   * 2-element pair `[x, xs]` — no spread, no runtime call. `guilty` is a symbol —
   * its JS/membrane face is its interned name, `"guilty"` (§2.1).
   */
  {
    name: "cons-scalar-tail",
    expected: { value: ["guilty", 42] },
  },

  /**
   * `cons` with a PROVEN string tail: unconditional spread silently char-exploded
   * a string (`[1, ..."ab"]` → `[1, "a", "b"]`) instead of throwing — the quieter
   * half of the same defect the scalar-tail row catches loudly. The tail fact gate
   * proves `stringy` here (a literal), so the residual keeps the string whole as
   * the second slot: `[1, "ab"]`.
   */
  {
    name: "cons-string-tail",
    expected: { value: [1, "ab"] },
  },

  /**
   * `cons` with an UNKNOWN tail: `num-or-list`'s two `if` branches return a number
   * on one arm and a list on the other, so its inferred return type is a genuine
   * union neither `provesArray` nor `provesScalar` can claim (a union claims a fact
   * only when EVERY constituent does). Neither the spread nor the bare-pair form is
   * safe here — the tail really could be either shape at runtime — so the residual
   * rides the `cons` stage-0 shim, which decides with a real `Array.isArray` check.
   * `flag` is `#t`, so `num-or-list` returns the scalar arm (`7`): `["key", 7]`.
   */
  {
    name: "cons-unknown-tail",
    expected: { value: ["key", 7] },
  },

  /**
   * The compound cxr family over real lists (rules/phase1.ts's `compoundCxrRules`
   * — the representation-collapse law extended past car/cdr): `cadr`/`caddr`
   * fold to a plain index (`xs[1]`/`xs[2]`), `cddr` to a slice (`xs.slice(2)`),
   * and `cadar` — a genuine multi-level COMPOSITION, not just a run of one
   * letter — folds to the nested `xs[0][1]` chain the derivation is built to
   * produce (car of (10 20 30), then cdr, then car → the second element of the
   * first sublist).
   */
  {
    name: "cxr-compound-accessors",
    expected: {
      value: [2, 3, [3, 4, 5], 20],
    },
  },

  /**
   * RATIO ruling (constitution §7): the interpreter holds exact 1/3 internally
   * but egresses divided (`AExact["arrival/toJS"]` → `num/denom`); the compiled
   * side is plain JS division. Same double on the same V8 — agreement by
   * construction, exact float equality (no epsilon).
   */
  {
    name: "divide-int-inexact",
    expected: { value: 0.3333333333333333 },
  },

  /**
   * Divergence-by-design (representation collapse, constitution §2.1 + the
   * stage-0 header's catalogued consequence): `eq?` is IDENTITY, and
   * boxed-string identity is unobservable post-collapse. The interpreter's
   * strings are boxed — a freshly-appended string is a distinct object from the
   * literal, so `(eq? "ab" (string-append "a" "b"))` → `#f`. The compiled
   * world's strings are JS primitives — the stage-0 `eqP` (`Object.is`) sees two
   * equal primitives → `#t`. No later phase changes this: the collapse IS the
   * representation law; per-side assertions, permanently. (`equal?` agrees on
   * both sides — the eq-vs-equal-string-equal twin stays a plain value row.)
   */
  {
    name: "eq-vs-equal-string-eq",
    expected: {
      divergent: {
        interpreter: { value: false },
        compiled: { value: true },
      },
    },
  },

  /** `equal?` is structural: same characters ⇒ `#t`. Documents identity-vs-structure against the `eq?` twin. */
  {
    name: "eq-vs-equal-string-equal",
    expected: { value: true },
  },

  /**
   * `equal?` is structural, recursively — two freshly-built nested lists are
   * `#t`. A `===` lowering reference-compares two distinct arrays → `false`.
   */
  {
    name: "equal-nested-list",
    expected: { value: true },
  },

  /**
   * Both operands prove `numeric` — for a primitive, scheme `equal?` IS `===`
   * (§7's one-number law), so this lowers to the bare JS `5 === 5`.
   */
  {
    name: "equal-primitive-proven",
    expected: { value: true },
  },

  /**
   * THE ASYMMETRIC-GATE ROW: only ONE side (`5`) proves primitive (`numeric`);
   * the other is a freshly-built compound list — NOT proven primitive, and
   * `equalQEmitRule`'s gate is deliberately `||`, not `&&`. A primitive can
   * never `equal?`-match a compound (a type mismatch in `structuralEqual`), and
   * `===` between a number and an object is always `false` too — so `===`
   * agrees with `equal?` here even though only one side is proven. `(equal? 5
   * (list 1 2))` → `#f` either way; the emitted-fixture snapshot (not this
   * value check alone) is what confirms `===` — not the shim — was actually
   * emitted.
   */
  {
    name: "equal-primitive-vs-compound",
    expected: { value: false },
  },

  /**
   * `every` with a genuinely boolean predicate — verdict-only shape where the
   * guarded `.every` agrees with SRFI every (last predicate result = #t).
   */
  {
    name: "every-boolean-pred",
    expected: { value: true },
  },

  /**
   * SRFI `every` is value-RETURNING: last predicate result (2), not a boolean.
   * Compiled `.every` folds to `true` — Phase-1 residual territory (the
   * value-shape half; the predicate-boundary half is already fixed).
   */
  {
    name: "every-last-value",
    expected: { value: 2 },
  },

  /**
   * Divergence-by-design (RATIO ruling, constitution §7 / Appendix B): an exact
   * product whose components leave safe-integer range THROWS the teaching error
   * on the interpreter (`ExactOverflowError` — exactness is a guarantee) while
   * the identical compiled expression floats on silently. Per-side assertions;
   * `interpreter ≡ compiled` is never checked for this row.
   *
   * 94906266² = 9007199326062756 > 2⁵³−1; the compiled value is the exact JS
   * float product (verified: `94906266 * 94906266` on V8).
   */
  {
    name: "exact-overflow-mul",
    expected: {
      divergent: {
        interpreter: { errorClass: "exact-overflow" },
        compiled: { value: 9007199326062756 },
      },
    },
  },

  /** Numeric `=` compares value, not exactness: `(= 1 1.0)` is `#t` — native `1 === 1.0` agrees (Appendix B: natively correct). */
  {
    name: "exact-vs-inexact-eq",
    expected: { value: true },
  },

  /**
   * Law T at the PREDICATE boundary — the review-found live divergence:
   * `.filter(f)` consumes results with JS ToBoolean, silently dropping a
   * Scheme-truthy `0` return. The emitter now guards `(…) !== false`.
   */
  {
    name: "filter-truthy-zero",
    expected: { value: [0, 1] },
  },

  /** Both operands numeric literals — `>` lowers to the bare JS `9 > 4`. */
  {
    name: "gt-proven-numeric",
    expected: { value: true },
  },

  /**
   * `num-or-list`'s union leaves `>`'s first operand UNPROVEN — rides the
   * runtime shim. `flag` is `#t` → `7`: `(> 7 4)` → `#t`.
   */
  {
    name: "gt-unproven-shim",
    expected: { value: true },
  },

  /** Both operands numeric literals — `>=` lowers to the bare JS `6 >= 6`. */
  {
    name: "gte-proven-numeric",
    expected: { value: true },
  },

  /**
   * `num-or-list`'s union leaves `>=`'s first operand UNPROVEN — rides the
   * runtime shim. `flag` is `#t` → `7`: `(>= 7 8)` → `#f`.
   */
  {
    name: "gte-unproven-shim",
    expected: { value: false },
  },

  /**
   * One-armed `if` with a false test: R7RS unspecified; both worlds land JS
   * `undefined` (interpreter void egress / compiled literal `undefined`).
   */
  {
    name: "if-missing-else",
    expected: { value: undefined },
  },

  /**
   * Alist-lowering ruling (2026-07-17): `(:key e)` over an `e` PROVEN array-backed
   * (a quoted dotted-pair alist — `list`/`pair`/`nonEmptyList` TypeFacts) reads
   * Object.entries-shaped: find the `[k, v]` entry whose key matches, take its
   * value — never `e["guilty"]` (silently `undefined` on a real array). `guilty`'s
   * entry sits behind an unrelated `other` entry, so this also pins that `.find`
   * locates the right pair rather than reading whichever comes first.
   */
  {
    name: "keyword-accessor-alist-hit",
    expected: { value: 42 },
  },

  /**
   * Alist-lowering ruling (2026-07-17), the miss half: `(:missing e)` over an alist
   * with no `missing` entry. The interpreter's own accessor
   * (`AKeywordSymbol.apply` → `APair#get`,
   * foundations/arrival/arrival/src/values/primitives/APair.ts) falls through the
   * whole chain and returns `nil` — the membrane's JS face for `nil` is the empty
   * array `[]`, NOT `undefined`. The compiled `.find(...)` naturally yields
   * `undefined` on a miss (`Array.prototype.find` itself); the emit rule coerces
   * it to `[]` to agree — pinned here so that coercion can never regress silently.
   */
  {
    name: "keyword-accessor-alist-miss",
    expected: { value: [] },
  },

  /**
   * Alist-lowering ruling (2026-07-17), the nested case: the accessor sits inside
   * an `if`'s condition, not in tail position — the SAME shape the provenance
   * campaign's own adversarial corpus mints pervasively
   * (`probe-adversarial.test.ts` row 1: `(if (:guilty e) "GUILTY" "INNOCENT")` over
   * the one-key alist idiom). Pins that the `.find(...)` lowering composes
   * correctly under Law T's truthiness test, not only when the accessor is the
   * whole program's trailing expression.
   */
  {
    name: "keyword-accessor-alist-nested",
    expected: { value: "GUILTY" },
  },

  /**
   * Regression guard (alist-lowering ruling, 2026-07-17): a native `dict` accessor
   * must keep narrowing to `e["guilty"]` — the recommended shape (engine-walker.md
   * §5) — never fall into the alist `.find` branch a Dict target never proves. A
   * Dict carries no `list`/`pair`/`nonEmptyList` TypeFacts (typefacts/facts.ts's own
   * doc: a plain dict object is a type the closed vocabulary has nothing to say
   * about), so the accessor's fact gate must decline it exactly as before.
   */
  {
    name: "keyword-accessor-dict",
    expected: { value: 42 },
  },

  /**
   * `(list 1 2 3)` is array-backed and provably so (`list: true`) — `length`
   * lowers to the bare JS `.length` member read.
   */
  {
    name: "length-proven-array",
    expected: { value: 3 },
  },

  /**
   * `list-or-string`'s union (`List<number> | string`) fails `provesArray` (a
   * string is not array/pair/nonEmptyList-shaped) — UNPROVEN, rides the runtime
   * `length` shim, which dispatches uniformly over list/vector/string carriers.
   * `flag` is `#t` → the 3-element list: `(length '(1 2 3))` → `3`.
   */
  {
    name: "length-unproven-shim",
    expected: { value: 3 },
  },

  /**
   * `(list 10 20 30)` is array-backed and provably so — `list-ref` lowers to
   * the bare JS index read `xs[1]`.
   */
  {
    name: "list-ref-proven-array",
    expected: { value: 20 },
  },

  /**
   * `num-or-list`'s union (`number | List<number>`) leaves `list-ref`'s first
   * operand UNPROVEN — rides the runtime spine-walk shim. `flag` is `#f` → the
   * list: `(list-ref '(10 20 30) 1)` → `20`.
   */
  {
    name: "list-ref-unproven-shim",
    expected: { value: 20 },
  },

  /**
   * Divergence-by-design, DISCOVERED while building this row (not introduced by
   * this lane's fact-gate — see below) — same class as `eq-vs-equal-string-eq`'s
   * catalogued representation-collapse divergence (stage0.ts's own header).
   *
   * The fact gate itself works exactly as intended here: `int-or-nil`'s union
   * (`number | Nil`) fails `numeric`'s ∀-over-union-constituents claim (nil
   * shares no TypeFlags with NumberLike), so `<`'s first operand is UNPROVEN and
   * the call correctly stays OFF the native path — confirmed structurally via
   * `fixtures/emitted/lt-nil-tolerance.ts`, which shows the bare shim call
   * `lt(intOrNil(false), -5)`, never an inlined `<`.
   *
   * But `ctx.runtime("<")` resolves, in the COMPILED world, to stage0.ts's own
   * `lt = (a: number, b: number): boolean => a < b` — a bare numeric comparison
   * with NO nil-tolerance of its own (unlike the arrival-core INTERPRETER's
   * `looseCompare(wrapOrd(...))`, whose nil-as-bottom rule, op-helpers.ts's
   * `nilOrderCompare`, makes `(< '() -5)` → `#t` unconditionally — nil sorts
   * before every value). Nil compiles to `[]` (§2.1's representation collapse),
   * so the compiled side evaluates `[] < -5`, which JS's Abstract Relational
   * Comparison coerces to `Number([]) < -5` = `0 < -5` = `#f` — disagreeing with
   * the interpreter's `#t`.
   *
   * This is a PRE-EXISTING gap in stage0.ts's numeric-comparison shims
   * (`lt`/`gt`/`lte`/`ge`/`zeroP` are ALL bare `(a: number, ...) => ...`, never
   * nil-aware) — orthogonal to and unchanged by this lane's `emit` rules: before
   * this lane, `<` carried NO Contract.emit at all, so EVERY call (proven or
   * not) already routed through this same bare `lt`. Flagged here as a real,
   * hand-verified finding rather than silently fixed: `stage0.ts` is mercury's
   * runtime-emitter library, outside this lane's boundary (native-leaf-lowering
   * owns arrival-core's Contract.emit rules, not mercury's runtime module) —
   * upgrading stage0's comparison shims to full nil-tolerance is a separate,
   * larger decision (it touches every unproven `< <= > >= zero?` call site, not
   * just this one), reported to V rather than made unilaterally here.
   */
  {
    name: "lt-nil-tolerance",
    expected: {
      divergent: {
        interpreter: { value: true },
        compiled: { value: false },
      },
    },
  },

  /**
   * Both operands are numeric literals — `numeric: true` on both, so `<` lowers
   * to the bare JS `3 < 5` (the native-leaf-lowering fact-gate's happy path).
   */
  {
    name: "lt-proven-numeric",
    expected: { value: true },
  },

  /**
   * `num-or-list`'s two `if` branches return a number on one arm and a list on
   * the other (the same union idiom as `cons-unknown-tail.scm`) — a genuine
   * union neither arm alone claims `numeric` for (a union claims a fact only
   * when EVERY constituent does), so `<`'s first operand is UNPROVEN. The
   * residual rides the `looseCompare(wrapOrd(...))` runtime shim, never a bare
   * JS `<`. `flag` is `#t`, so `num-or-list` returns the scalar arm (`7`):
   * `(< 7 10)` → `#t`.
   */
  {
    name: "lt-unproven-shim",
    expected: { value: true },
  },

  /** Both operands numeric literals — `<=` lowers to the bare JS `5 <= 5`. */
  {
    name: "lte-proven-numeric",
    expected: { value: true },
  },

  /**
   * `num-or-list`'s union (`number | List<number>`) leaves `<=`'s first operand
   * UNPROVEN — rides the runtime shim. `flag` is `#t` → `7`: `(<= 7 7)` → `#t`.
   */
  {
    name: "lte-unproven-shim",
    expected: { value: true },
  },

  /**
   * `max-by` — argmax by key function (not Contract-backed anywhere; the
   * interpreter binds it via a scheme-string preamble, `arrival-run`'s
   * `BUILTIN_PREAMBLE` — see rules/phase1.ts's `"max-by"` row and
   * runtime/stage0.ts's `maxBy`). First case: plain argmax, no tie. Second case
   * PINS the tie behavior: two entries share the max key (5); the reference
   * (`(reduce (lambda (x best) (if (> (f x) (f best)) x best)) (car xs) (cdr
   * xs))`, a strict `>` fold seeded on the first element) never lets a later
   * tie displace an earlier max, so the FIRST entry carrying the max wins —
   * `[5, "first"]`, not `[5, "second"]`.
   */
  {
    name: "max-by-tie-break",
    expected: {
      value: [9, [5, "first"]],
    },
  },

  /**
   * Operator-identity cell (Appendix B): `member` returns the sublist from the
   * match (`(2 3)` → `[2, 3]`), `assoc` the matching entry (`(2 "b")` → `[2, "b"]`).
   * String alist values (not symbols) keep the row face-free.
   */
  {
    name: "member-assoc",
    expected: {
      value: [
        [2, 3],
        [2, "b"],
      ],
    },
  },

  /** Inexact contagion: exact 1 + inexact 2.5 = inexact 3.5 — a plain unconditional JS fold agrees (constitution §7). */
  {
    name: "mixed-exactness-add",
    expected: { value: 3.5 },
  },

  /**
   * Operator-identity cell (Appendix B): Scheme `modulo` follows the divisor's
   * sign — `(modulo -7 3)` is `2`. JS `%` is a remainder (`-7 % 3` → `-1`).
   * The one correct algorithm: `((a % n) + n) % n`.
   */
  {
    name: "modulo-neg",
    expected: { value: 2 },
  },

  /** Multi-list `map` — the index-zip bridge: `(map + '(1 2) '(10 20))` → `(11 22)`. */
  {
    name: "multi-list-map",
    expected: { value: [11, 22] },
  },

  /**
   * Runtime-sentinel cell (Appendix B): interpreter `eqv?` is `Object.is`-shaped —
   * `(eqv? NaN NaN)` is `#t` (interpreter-verified, all three NaN spellings).
   * A `===` lowering yields `false` (`NaN === NaN`).
   */
  {
    name: "nan-eqv",
    expected: { value: true },
  },

  /**
   * Fuzzer-found (first run, 2026-07-14) and FIXED the same day: null?'s clean
   * `.length` form is now fact-gated (Law F) — an unproven argument rides the
   * stage-0 Array.isArray shim, so a string (which also carries .length) answers
   * #f exactly like the interpreter. Kept as the permanent deterministic
   * regression row for the representation-collision class.
   */
  {
    name: "narrows-null-string-collision",
    expected: { value: false },
  },

  /**
   * Fuzzer-found (first run, 2026-07-14) and FIXED the same day: pair?'s clean
   * `.length` form is now fact-gated (Law F) — an unproven argument rides the
   * stage-0 Array.isArray shim, so a string (which also carries .length) answers
   * #f exactly like the interpreter. Kept as the permanent deterministic
   * regression row for the representation-collision class.
   */
  {
    name: "narrows-pair-string-collision",
    expected: { value: false },
  },

  /**
   * Runtime-sentinel twin of `nan-eqv`: `(eqv? -0.0 0.0)` is `#f` under the
   * interpreter's `Object.is` semantics (verified; `(eqv? -0.0 -0.0)` is `#t`).
   * A `===` lowering yields `true` (`-0 === 0`).
   */
  {
    name: "neg-zero-eqv",
    expected: { value: false },
  },

  /** `(not 0)` is `#f` — 0 is truthy. A raw `!0` lowering yields `true`. */
  {
    name: "not-zero",
    expected: { value: false },
  },

  /**
   * The await-sniff regression row: a string literal containing "await" must
   * NOT trigger the async IIFE wrap (`containsAwaitToken` strips literals).
   * Pre-fix this emitted `await` inside a sync arrow — a SyntaxError at load.
   */
  {
    name: "or-await-literal",
    expected: { value: 0 },
  },

  /**
   * `or` returns its first Scheme-truthy operand: `0` wins. A raw `||` lowering
   * returns `999` (JS falsiness of 0) — the value-position half of the Law T cell.
   */
  {
    name: "or-first-truthy-wins",
    expected: { value: 0 },
  },

  /**
   * Value-returning `or` INSIDE a define — the review-mandated shape the
   * trailing-expression corpus could not see: top-level `await` is legal in
   * `.mts`, so a wrongly async-wrapped `or` only detonates inside a sync
   * function body.
   */
  {
    name: "or-in-define",
    expected: { value: 0 },
  },

  /**
   * 3-ary `or` — nested IIFE temps; first non-`#f` operand wins.
   */
  {
    name: "or-three",
    expected: { value: 7 },
  },

  /** `quotient` truncates toward zero: `(quotient -7 3)` is `-2` (`Math.trunc(-7/3)` agrees). */
  {
    name: "quotient-neg",
    expected: { value: -2 },
  },

  /**
   * Positive control for the short-circuit probe: when the branch IS taken, the
   * R7RS `(error …)` raise must surface on both sides as `user-error` — guarding
   * against a probe that silently no-ops. Interpreter face: an `ArrivalError`
   * whose `cause` is the `R7RSError` (message "does-run").
   */
  {
    name: "short-circuit-control",
    expected: { errorClass: "user-error" },
  },

  /**
   * Resolved by ELIMINATION, not by a static prohibited-dynamics door
   * (gate3-human-grade-rulings.md R-G6; OQ8a's own follow-up, oracle-harness.md).
   * `set!` still classifies to `Door("prohibited-dynamics/set!")` unconditionally
   * (constitution §2.2 — doors are syntactic, not reachability-gated) — but `or`'s
   * FIRST operand here is the literal `#t`, so static prevaluation
   * (`../../prevalue/index.ts`) folds the whole `or` to that value and drops the
   * `(begin (set! n 999) 'x)` branch WHOLE, Door included, before the walker ever
   * lowers it. The compiled artifact ends up with no `set!` and nothing to door on;
   * the interpreter already never evaluated that branch either (lazy `or`). Both
   * sides agree on `n`'s untouched value, `0` — a prior draft considered re-ruling
   * this row to `{ value: 0 }` without fixing the mechanism ("papering," V's own
   * word for it, gate3-human-grade-rulings.md); this greens the honest way, by
   * making the dead branch structurally unreachable.
   */
  {
    name: "short-circuit-effect",
    expected: { value: 0 },
  },

  /**
   * The non-evaluation row: `or` takes its first truthy operand without touching
   * the second. Evaluation of the untaken branch ⇒ both sides throw ⇒ this value
   * row fails loudly. Pairs with `short-circuit-control` (the positive control
   * proving the probe actually fires when the branch IS taken). String operand
   * (not a symbol) keeps the row face-free.
   */
  {
    name: "short-circuit-or",
    expected: { value: "a" },
  },

  /**
   * SURPRISE, verified against the interpreter rather than assumed: bare `some`
   * is NOT SRFI-1's value-returning `any` — srfi-1.ts aliases it to `any?`
   * (`some: symbol.alias\`any?\``), the HONEST boolean quantifier. This row is
   * the discriminating case: the predicate returns a truthy NON-`#t` witness
   * (`2`) for the first list. A value-returning `some` would answer `2`; the
   * real (boolean) `some` answers `#t`/`true`. The second list has no odd
   * element, so `#f`/`false`. See rules/phase1.ts's `some` table row and
   * runtime/stage0.ts's `some` shim for the mirrored implementation.
   */
  {
    name: "some-boolean-alias",
    expected: {
      value: [true, false],
    },
  },

  /**
   * Symbol egress — ⚖️ RULED 2026-07-14: a quoted symbol's JS face is the PLAIN
   * interned name (constitution §2.1, "symbol → interned name"). The interpreter's
   * former apostrophe prefix ("'hello") died with the ruling (ASymbol arrival/toJS);
   * both worlds now agree by construction. Promoted from KNOWN_RED the same day.
   */
  {
    name: "symbol-face",
    expected: { value: "hello" },
  },

  /**
   * '() is Scheme-truthy (only #f is false) — and nil-as-array means the
   * compiled condition is a (truthy) empty array. Both worlds take the then-arm.
   */
  {
    name: "truthy-empty-list",
    expected: { value: "a" },
  },

  /** Law T: `""` is Scheme-truthy (only `#f` is false) — JS falsiness of `""` must not leak. */
  {
    name: "truthy-empty-string",
    expected: { value: "a" },
  },

  /** Regression guard for the one genuinely false value: `#f` takes the else arm. */
  {
    name: "truthy-false",
    expected: { value: "b" },
  },

  /**
   * Law T seed cell: `0` is Scheme-truthy — only `#f` is false. A JS-truthiness
   * ternary (`0 ? … : …`) picks the wrong arm. String arms keep the row
   * face-free: symbol egress is its own cell (`symbol-face`), never mixed into a
   * truthiness row.
   */
  {
    name: "truthy-zero-then",
    expected: { value: "a" },
  },

  /**
   * `(- 5 5)` is a numeric arithmetic expression — `numeric: true` — so `zero?`
   * lowers to the bare JS `5 - 5 === 0`.
   */
  {
    name: "zero-proven-numeric",
    expected: { value: true },
  },

  /**
   * `num-or-list`'s union leaves `zero?`'s operand UNPROVEN — rides the runtime
   * shim (`nativeNumericOp("zero?", ...)`, which coerces + doors on a
   * non-number). `flag` is `#t` → `0`: `(zero? 0)` → `#t`.
   */
  {
    name: "zero-unproven-shim",
    expected: { value: true },
  },
];
