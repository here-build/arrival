# AHalfBaked existence review — VERDICT: KILL (dissolve into R2/C3 struct-fact wires)

*DAG node D2, ruling R4 ([RULINGS.md](../RULINGS.md)). Evidence gathered 2026-07-09
against the arrival package @ post-A3 (f52d2db4b1). Doc-only; removal was a
follow-up execution task.*

> **Status: EXECUTED.** AHalfBaked dissolved 2026-07-09 (`90272a0b99`) — the carrier,
> its producer wiring, and its test files (`half-baked`, `speculative-eval`,
> `deferred-value-egress`) are gone. Present-tense descriptions below record the
> pre-dissolution state this review judged.

## What it is

`AHalfBaked` (src/values/primitives/AHalfBaked.ts) is a still-resolving value carrier for
Tier-2 speculative evaluation: `filter`/`map` over promise-bearing fans may emit a lazy
carrier whose per-slot cardinality records form a narrowing interval; `length` reads the
interval as a number-domain view; the five numeric comparisons `decide()` a branch the
instant the interval is decisive, with slots still pending. Design lineage is real and
recent (Traub lenient evaluation; the speculative-evaluation promise-functor
design, 2026-06-05, private monorepo docs).

## Q1 — What does it save today? Who calls it?

**Nothing, and nobody.** Full reachability walk:

- The entire feature is gated on `ExecOptions.speculate → RunContext.speculate`,
  default **false**. Producers (lists.ts mapImpl/filter/zip arms), the consumer
  (numeric.ts `speculativeCompare`), and the evaluator force-choke
  (evaluator.ts:3120) are all behind the flag.
- `speculate: true` appears in exactly **three test files** and nowhere else:
  `speculative-eval.test.ts`, `deferred-value-egress.test.ts`,
  `membrane/crossing.law.test.ts` (the egress block).
- Zero hits for `speculate`/`HalfBaked` across the private monorepo's downstream packages (arrival-run,
  arrival-chain, arrival-effects, …), **arrival-mcp**, **arrival-scheme**, and the
  inhuman consumers. No benchmark exercises it (`__benchmarks__/` contains only the
  exec-seam benchmark).
- So the measurable work saved in any production run is **zero by construction**: with
  the flag off, no carrier can exist.

**And the feature is incomplete inside its own happy path.** The egress block's third
`it.fails` documents that a forced carrier's elements carry `CONSTANT_CTX` instead of the
producing run's ctx — "confirmed even after a manual `.force()`, the ctx plumbing itself
doesn't carry the producing run through." This is not a dormant-but-done optimization;
it's an unfinished one.

**Meanwhile the boundary tax is real and recurring.** Three shipped bug classes in one
week trace to carriers crossing boundaries that didn't know them:
1. `isSchemeValue` omitted AHalfBaked → `Environment.set` re-wrapped LIVE carriers as
   `AJSObject`, corrupting speculation (fixed 3b9fad2d0c, but the bug class is the point);
2. force-on-egress gap — three `it.fails` rows, ledger id "live AHalfBaked escapes exec
   under speculate";
3. the `arrival/toJS` `{__halfBaked__}` marker — the P9 violation R4 kills either way.

Every membrane/egress/env boundary must forever answer "what if a live carrier arrives?"
for a value that cannot occur in production.

## Q2 — KILL branch: what dies, what simplifies

Removal sequence (each step green; ~700 net lines out):

1. **Tier-2 consumption**: numeric.ts `speculativeCompare`/`decide` path + `SPECULATE`
   marks on comparison ops; lists.ts interval-read arm in `lengthImpl` and the
   `runCtx?.speculate &&` producer arms in mapImpl/filter/zip. The eager path already
   exists as the fallback in every case — deletion is arm-removal, not rewrite.
2. **Dispatch plumbing**: evaluator.ts force-choke block (≈3111–3125), the
   `SpeculationAware` marker type, `SPECULATE` in well-known-symbols.ts, and its
   preservation hops in capability.ts/_bake.ts/native.ts (**keep `.fanout`** — separate
   concern sharing the shape).
3. **Run state**: `speculate` leaves ExecOptions, EvalContext, RunContext,
   makeRunContext.
4. **The class**: AHalfBaked.ts + `is_half_baked` call sites + the SchemeValue union
   member. D1 lattice simplification: the `SchemeCarrier` stratum exists FOR HalfBaked —
   it collapses, `Datum = Carrier` (D1 already prices both branches at one-line diffs).
5. **Tests**: half-baked.test.ts + speculative-eval.test.ts deleted (the equivalence
   floor becomes vacuous — both sides are now the same code path); crossing.law
   "egress of deferred carriers" block deleted; ledger row retires with a
   the suite-consolidation manifest's survivor row (private monorepo docs) noting the gap became *unreachable, not fixed*;
   lists-contract-precision's length row inverts into a precision WIN (`length` output
   narrows `z.value` → `z.schemeNumber` — its comment says z.value exists only because
   of the HalfBaked return).
6. **Record**: the 2026-06-05 design doc stays as archaeology; the wireframe proposal
   (execution-plan-wireframe.md) gains AHalfBaked's motivating program —
   `(if (>= (length (filter pred items)) 2) …)` deciding early — as an acceptance
   criterion for struct-fact wires, so the CAPABILITY survives as a requirement while
   the mechanism dies.

## Q3 — KEEP branch: the MaybePromise seam (why it loses)

R4's KEEP shape: `arrival/toJS` on a carrier returns a `MaybePromise` resolving when the
value bakes. Post-A3 this is structurally cornered:

- R1/R9 (landed, f52d2db4b1) make container egress **synchronous lazy proxies** whose
  `get` traps call `toJS` on element boxes. Proxy traps are synchronous — a live carrier
  inside an egressing container would need an **async trap**, which does not exist. The
  only escapes are (a) egress-await: exec awaits full settlement before returning —
  which erases the optimization at exactly the boundary anyone observes, or (b) a
  pending-Promise leaf inside an otherwise-plain structure — breaking the
  plain-JS-observable law (JSON, deep-equal) the crossing suite just started enforcing.
- So KEEP degenerates to "intra-run speculation only, forced at every egress" — an
  optimization nothing consumes, kept at the price of every boundary staying
  carrier-aware, plus finishing the ctx-plumbing work Q1 shows was never completed.

## Q4 — VERDICT: KILL

Deciding evidence, in order of weight:
1. **Zero production reachability** — flag set only by the feature's own tests; no
   consumer package references it. The optimization optimizes nothing.
2. **Supersession by ruled work**: R2's structural facts exist explicitly to make
   `(< (length (sort …)) 5)` decidable without materializing data (RULINGS names
   shortcut evaluation as the goal), and C3's wireframe carries **struct-fact wires** —
   the cardinality interval, generalized and static. AHalfBaked is a hand-built runtime
   approximation of the struct-fact wire, and meets the same fate C3 assigns the trace
   prune machinery: dissolve into the principled version.
3. **Structural contradiction with landed R1/R9** — synchronous lazy-proxy egress cannot
   host an async leaf (Q3); KEEP requires either breaking a law suite or neutering the
   feature.
4. **The boundary tax is paid in real bugs** (three classes in one week) for a value that
   cannot occur outside tests.

P15 note: this is a *dissolution with a survivor*, not a capability retreat — the
motivating program moves into the wireframe's acceptance criteria, and if async-fan
workloads (LLM predicates over MCP fans) later demand runtime early-collapse, the
wireframe's mux nodes are the designed home for it.
