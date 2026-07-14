/**
 * PREDICATE_CONSUMERS — oracle-harness.md §4.4's hand-maintained, small, closed table:
 * witness (a narrows-flagged predicate) → the registered symbols whose call the
 * witness's narrowing licenses trusting. NOT derivable from the registry today —
 * registry-emit.md's own Open Question 3 leaves predicate-vs-consumer scope
 * unresolved and no `licenses` field exists yet (oracle-harness.md OQ2) — so this
 * grows only by hand, and only when a new guarded-residual consumer registers.
 *
 * Law N (constitution §5.2; oracle-harness.md §4.4/§6, unconditional per
 * `arrival-ts-transpiler-design.md:336`): a harvested narrows-flagged row with ZERO
 * entries here is a HARD RED — no "no consumer yet" carve-out.
 * `narrows-fuzz.test.ts` enforces this every run over the LIVE harvested set, so a
 * future narrows-flagged row landing without a table entry fails CI immediately,
 * not "eventually."
 *
 * A consumer must be a symbol the WALKER can actually resolve on the compiled side
 * (a rule, a harvested Contract, or a stage-0 shim) — an arbitrary scheme identifier
 * with no registry row doors as `unresolved-identifier` (walker.ts's ladder), which
 * would make the fuzz row test the door path, not the narrowing claim.
 *
 * Current entries:
 *  - "pair?" → ["car", "cdr"] — oracle-harness.md's own worked example verbatim
 *    (§4.4): the guarded-residual family. (Today's `phase1Rules` ship car/cdr
 *    UNCONDITIONALLY — the representation-collapse ruling, `rules/phase1.ts`'s
 *    module header, "no guard, no shim, no mode" — rather than fact-gated on a
 *    pair?-proof. The oracle claim this row tests does not depend on which shape
 *    the residual takes: "whichever residual fired, does it compute the same value
 *    as the interpreter" holds, or fails, independent of that implementation
 *    choice — and per `narrows-fuzz.test.ts`'s header, it does fail, just not for
 *    the reason the original guarded-residual framing anticipated.)
 *  - "null?" → ["pair?"] — the "length-safe ops" consumer: `pair?` is itself a
 *    TOTAL, never-throwing `.length` read (exactly like `null?`), so it is both a
 *    resolvable registry symbol (satisfying the walker's dispatch — an
 *    unregistered consumer would door instead of testing anything) and a
 *    meaningful cross-check of `null?`'s witness at the exact values `null?`
 *    proves: "this value is empty" should make `pair?` of the SAME value the
 *    complementary `#f` on both sides.
 */
export const PREDICATE_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  "null?": ["pair?"],
  "pair?": ["car", "cdr"],
};
