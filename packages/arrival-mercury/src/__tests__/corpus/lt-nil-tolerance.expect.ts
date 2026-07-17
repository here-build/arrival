import type { ExpectedOutcome } from "../../index.js";

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
export const expected: ExpectedOutcome = {
  divergent: {
    interpreter: { value: true },
    compiled: { value: false },
  },
};
