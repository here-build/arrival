/**
 * Phase-1 SYMBOL RULES — the vertical slice's emit rules as `EmitRule<R>` values,
 * keyed by bound symbol name (constitution §4.3's worked rules made real; component
 * spec docs/working-proposals/arrival-mercury/phase1-symbol-rules.md, which the
 * constitution OVERRIDES on conflict — the reconciliations are noted per rule).
 *
 * PLACEMENT (interim by design — see ./overlay.ts's header): a compiler-side table
 * overlaid on the harvest via `withRules`, not Contract-carried rules yet.
 *
 * Laws in force:
 *  - Law W — every rule is sync-shaped: no `Await` minted, no asyncness seen. The
 *    ASYNC-IFY pass owns the await plane (`map`'s async callback → `Promise.all`,
 *    `infer`'s promise-typed edge → a local await).
 *  - Law A — fact-directed branches key on `ctx.argFacts` (argument facts), never on
 *    result types or parent nodes (cross-node idioms are Law-C engine peepholes).
 *  - Law F + the read register (constitution §1) — a fact-directed clean/conservative
 *    split, fact absence takes the conservative form in the run register; the read
 *    register short-circuits to the clean form (glass is never executed — mirrors the
 *    walker's own `truthTest`). (`not` obeyed this law from this table and now obeys
 *    it from its own Contract; `filter` obeys it from BOTH — its table row (below)
 *    AND its Contract are byte-identical copies — see the relocation note below for
 *    why filter is the one exception that keeps a table-resident rule.)
 *  - §7 one-number — was `+ - * /` are plain folds/operators over JS numbers; no
 *    exactness dispatch EXISTS: not a fact, not a shim, not a branch. (`=`/`quotient`/
 *    `modulo`/`+`/`-`/`*`/`/` all obeyed this law from this table; they now obey it
 *    from their own Contracts — see the relocation note below.)
 *  - §2.1 representation collapse + Law U — `car`/`cdr` are syntax over the array
 *    representation. `(car '())` is outside the compilation contract (the lens warns
 *    at compile time; the artifact stays clean — no guard, no shim, no mode). (`cons`
 *    obeyed the SAME representation-collapse law from this table; `null?`/`pair?`
 *    obeyed the Law-F fact-gated variant of it — total predicates over any value,
 *    defined behavior not UB, so their clean `.length` form is fact-gated and the
 *    shim is the unproven default, the fuzzer having proved the unconditional form
 *    wrong on strings; all three now obey these laws from their own Contracts — see
 *    the relocation note below.)
 *
 * Arity: fixed-arity rules refuse a mis-arity call site via `ctx.door` (a compile
 * diagnostic — totality: every form compiles or doors, never crashes the walker on an
 * `undefined` operand). This is stricter than the interpreter's evaluation-time arity
 * check, deliberately: a fixed-arity builtin called wrong is a static defect, exactly
 * the class a compiler front gate exists to catch.
 *
 * Known deferred hazards (documented, not landed — report-tracked for later waves):
 *  - `null?`/`pair?`'s FACT-GATED clean form (now on their own Contracts —
 *    foundations/arrival/arrival/src/env/r7rs/equality.ts) can still hit TS2367 under
 *    a TUPLE-typed proven argument (`.length` narrows to a numeric literal; `=== 0` is
 *    a no-overlap comparison); phase1-symbol-rules.md §2 prescribes a `Un("+", …)`
 *    widen. Rarer now (the clean form needs a proven list fact at all), lands with the
 *    widen sweep wherever the rule lives.
 *
 * RELOCATED (Phase-2 relocation drill, constitution §9), one package deal at a time:
 *  - Wave 1: `=`/`quotient`/`modulo` moved onto their own Contract's `emit` field —
 *    foundations/arrival/arrival/src/env/r7rs/numeric.ts carries
 *    `numEqEmitRule`/`quotientEmitRule`/`moduloEmitRule`.
 *  - Wave 2: `+`/`-`/`*`/`/` joined them on the SAME numeric.ts Contracts
 *    (`plusEmitRule`/`minusEmitRule`/`timesEmitRule`/`divideEmitRule`); `cons` moved
 *    onto its own Contract in foundations/arrival/arrival/src/env/r7rs/lists.ts
 *    (`consEmitRule`); `not`/`null?`/`pair?` moved onto their own Contracts in
 *    foundations/arrival/arrival/src/env/r7rs/equality.ts (`notEmitRule`/
 *    `nullQEmitRule`/`pairQEmitRule` — `null?`/`pair?`'s `narrows`/`refPolicy` moved
 *    WITH the rule, the full Law-N package deal).
 *  - Wave 3: `map`/`apply` joined `cons` on lists.ts's own Contracts
 *    (`mapEmitRule`/`applyEmitRule` — residual-lite grew `Arrow`/`Index` for these
 *    two, plus a `RuntimeRef` TYPE ARM with no constructor, for `apply`'s structural
 *    inspection of an already-lowered argument's own tag — see residual-lite.ts's own
 *    doc comment). No RULE-bearing table row remains for either — `withRules`'
 *    fallthrough to the harvested base row (capability `scheme/lists`, an
 *    always-ambient R7RS base pack) is what resolves them now. The bare `"+": {}`/
 *    `"*": {}` presence rows this note used to describe are ALSO deleted this wave:
 *    their sole reason for existing — keeping `applyRule`'s FOLD_OPS shortcut
 *    resolvable under this file's base-less test registry — left WITH `apply`'s rule;
 *    no vestigial row remains for either.
 *
 *    `filter` grew the SAME Contract-side `emit` field this wave —
 *    foundations/arrival/arrival/src/env/srfi/srfi-1.ts carries `filterEmitRule`,
 *    byte-identical to `filterRule` below — but its TABLE ROW STAYS, unlike every
 *    other symbol in this list. **Discovered, not assumed:** `scheme/srfi-1` (the
 *    capability filter's Contract lives on) is NOT part of the oracle's harvested
 *    ambient — `emitRegistryOf(session.ambient)` sees `scheme/lists`/`scheme/
 *    numeric`/`scheme/equality` (verified: map/cons/apply/quotient/not/… all resolve
 *    from these Wave-1/2/3 Contracts through the REAL harvest) but has ZERO rows for
 *    ANY srfi-1 symbol (filter, take, drop, iota, zip, every?, any?, … — probed
 *    directly). Deleting `filter`'s table row reproduced the SAME
 *    `unresolved-identifier` door `every`/`any` are already guarded against below, but
 *    WORSE for filter specifically: a bare presence row (their fix) would route
 *    filter through the rung-3 RuntimeRef shim, changing its compiled shape (this
 *    file's own golden — the clean `.filter(pred)`/guarded-arrow form — vs a shim
 *    call), which fails this wave's OWN zero-golden-churn gate
 *    (cross-pass-fixtures.test.ts's/emitted-fixtures.test.ts's/bug-cell-corpus
 *    .test.ts's `filter-truthy-zero`/`ai-winter-ebl-investigation`/
 *    `inhuman-gepa-full`/`mercury-fixture-gepa` rows, all verified red on a bare-row
 *    attempt, all verified green with the table rule retained). Fixing the ambient
 *    gap (making `buildArrivalSession` include `scheme/srfi-1`) lives in
 *    `@inhuman.tools/arrival-run`/this package's `oracle/harness.ts` — outside this
 *    relocation's boundary (and `oracle/harness.ts` is mid-edit by a concurrent lane
 *    as of this wave) — flagged for a follow-up wave, not fixed here. Once it lands,
 *    deleting this table row is the same one-line move every other Wave-3 symbol
 *    already made.
 *  All thirteen fully-relocated symbols (map/apply this wave; eleven from Waves 1-2)
 *  are byte-identical to the rules this file used to hold (verified: the oracle's
 *  bug-cell rows quotient-neg/modulo-neg/exact-vs-inexact-eq and the cross-pass/gate3
 *  goldens are unchanged; the rest have no dedicated bug-cell row of their own but are
 *  exercised pervasively across the existing corpus, also unchanged). `filter`'s
 *  table-resident rule (below) is likewise byte-identical to its new Contract twin —
 *  the two are proven equal by construction (one function, copied once, never
 *  re-derived) rather than merely "consistent."
 */
import type { EmitCtx, EmitRule } from "@here.build/arrival/emit";

import type { Binding, R } from "../residual/types.js";
import { Arrow, Bin, Call, Index, Lit, Method, Ref } from "../residual/types.js";
import type { SymbolRuleTable } from "./overlay.js";

/** The rules-side twin of the walker's `ruleOf` narrowing seam: `EmitCtx.fresh` is
 *  typed `unknown` in arrival core (deliberately opaque — the residual algebra lives in
 *  THIS package, §4.5 layering), while the walker's real `ctxFor` supplies the namer's
 *  `Binding`. One helper, one cast, documented — no rule touches `fresh` directly.
 *  Kept ONLY for `filterRule` below (map/apply's own copies of this helper now live on
 *  lists.ts, alongside their relocated rules). */
const freshBinding = (ctx: EmitCtx<R>, hint: string): Binding => ctx.fresh(hint) as Binding;

/** Fixed-arity refusal (see the module header's arity note). Returns the args
 *  length-checked — the callers' `!` index assertions are made true here, once. */
function exactly(ctx: EmitCtx<R>, sym: string, args: readonly R[], n: number): readonly R[] {
  if (args.length !== n) ctx.door(`\`${sym}\` wants exactly ${n} argument${n === 1 ? "" : "s"}, got ${args.length}`);
  return args;
}

// ─── §2.1 representation collapse: car / cdr ──────────────────────────────────────────
// Constitution §4.3 verbatim: syntax over the array representation, not library
// symbols. No guard, no shim, no register branch (the component spec's guarded-branch
// draft predates the representation-collapse ruling and is superseded by §4.3).

const carRule: EmitRule<R> = {
  call: (args, ctx) => Index(exactly(ctx, "car", args, 1)[0]!, Lit(0)),
};

const cdrRule: EmitRule<R> = {
  call: (args, ctx) => Method(exactly(ctx, "cdr", args, 1)[0]!, "slice", [Lit(1)]),
};

// ─── cons / not / null? / pair? / + / - / * / / — RELOCATED (see the module header's
// relocation note, Wave 2). `cons`'s ArrayLit/Spread constructor, `not`'s Law-T guard,
// `null?`/`pair?`'s fact-gated `.length` reads (narrows + refPolicy moved WITH them),
// and the four arithmetic folds now live on their own Contract's `emit` field —
// foundations/arrival/arrival/src/env/r7rs/lists.ts (`consEmitRule`),
// foundations/arrival/arrival/src/env/r7rs/equality.ts (`notEmitRule`/
// `nullQEmitRule`/`pairQEmitRule`), and foundations/arrival/arrival/src/env/r7rs/
// numeric.ts (`plusEmitRule`/`minusEmitRule`/`timesEmitRule`/`divideEmitRule`). No
// rule body or table row remains here.

// ─── = / quotient / modulo — RELOCATED (see the module header's relocation note, Wave
// 1). These three rules (chained === for `=`; the Math.trunc/divisor-sign residuals
// for quotient/modulo — Appendix B's operator-identity algorithms) now live on their
// own Contract's `emit` field in foundations/arrival/arrival/src/env/r7rs/numeric.ts.
// No rule body or table row remains here.

// ─── map / apply — RELOCATED (see the module header's relocation note, Wave 3).
// map's arity-bridge (single-list `.map`/multi-list index-zip arrow) and apply's
// reduce/arity bridge (the `+`/`*` fold recognition, structural over an
// already-lowered `RuntimeRef` argument) now live on their own Contract's `emit`
// field in foundations/arrival/arrival/src/env/r7rs/lists.ts (`mapEmitRule`/
// `applyEmitRule`). No rule body or table row remains here.

// ─── filter — Law T on the predicate's VERDICT ────────────────────────────────────────
// `Array.prototype.filter` keeps by JS truthiness, which drops Scheme-truthy `0`/`""`;
// Scheme's filter keeps everything except `#f`. So the conservative form wraps the
// predicate in the Law-T guard `(x) => f(x) !== false`; a provably-boolean predicate
// (or the read register) passes `f` bare. This RECONCILES the component spec's §6
// (bare `.filter(pred)` unconditionally — pre-reconciliation) against constitution
// Law T, per the wave plan; single-list only (filter's own Contract, unlike map).
//
// TABLE-RESIDENT BY NECESSITY, not by choice (see the module header's relocation
// note): this rule ALSO lives on filter's own Contract
// (foundations/arrival/arrival/src/env/srfi/srfi-1.ts's `filterEmitRule`,
// byte-identical), but `scheme/srfi-1` is not part of the oracle's harvested ambient,
// so only THIS copy is reachable through the real compile pipeline today.

const filterRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [pred, xs] = exactly(ctx, "filter", args, 2);
    if (ctx.config.register === "read" || ctx.argFacts[0]?.boolean === true) {
      return Method(xs!, "filter", [pred!]);
    }
    const x = freshBinding(ctx, "x");
    return Method(xs!, "filter", [Arrow([x], Bin("!==", Call(pred!, [Ref(x)]), Lit(false)))]);
  },
};

// ─── infer family — ONE sync-shaped call surface, framework axis deferred ────────────
// Sync-shaped `Call(RuntimeRef(verb), args)` — Law W: no Await minted; ASYNC-IFY reads
// the runtime shim's real declared type and awaits the promise-typed edge. The walker
// has ALREADY collapsed kwargs into one trailing options ObjectLit before any rule
// runs, so `args` carries the options object as-is — the rule adds nothing.
//
// TODO(config.framework): the per-framework residuals (vercel `generateText`/
// langchain `models.*.invoke`, phase1-symbol-rules.md §8's config-branched builders)
// do NOT land in this wave — the stage-0 runtime shim owns the framework axis: one
// `infer` export whose body dispatches, so the emitted call surface is framework-
// stable. When the §8 builders land, this rule grows the `ctx.config.framework`
// branch and the shim dissolves; the call-shape goldens pin today's surface.

const inferRule = (verb: string): EmitRule<R> => ({
  call: (args, ctx) => Call(ctx.runtime(verb), args),
});

// ─── the table ────────────────────────────────────────────────────────────────────────
// refPolicy annotations mirror phase1-symbol-rules.md §0: `eta` for the fixed-arity
// structural rules (car/cdr) — declarative this wave (the walker degrades eta to shim
// until instantiated-signature facts land), `shim` (the default) for the variadics and
// HOFs.

export const phase1Rules: SymbolRuleTable = {
  car: { emit: carRule, refPolicy: "eta" },
  cdr: { emit: cdrRule, refPolicy: "eta" },
  // cons / not / null? / pair? / - / / / = / quotient / modulo / map / apply —
  // RELOCATED onto their own Contracts (module header's relocation note); no table
  // row remains for any of them. The bare "+"/"*" presence rows this comment used to
  // describe (needed only so `applyRule`'s FOLD_OPS structural recognition could
  // resolve a value-position "+"/"*" to `RuntimeRef` under this file's base-less test
  // overlay) are ALSO gone: `apply`'s own relocation (Wave 3) took that need with it —
  // no table-resident rule is left to exercise it, so no vestigial row remains either.
  filter: { emit: filterRule },
  // filter STAYS (see the module header's relocation note in full): its Contract
  // ALSO carries `filterEmitRule` (srfi-1.ts), but `scheme/srfi-1` is invisible to
  // the oracle's harvest, so the table row above is the only reachable copy today.
  //
  // SRFI-1 every/any — REGISTRY PRESENCE ONLY (no emit rule; wave-C wiring fix). They
  // are preamble/scope symbols the contract harvest cannot see (the 221-name harvest
  // lacks them), so without these rows the walker's §4.2 ladder doors them
  // `unresolved-identifier` while their stage-0 shims (the value-returning SRFI forms
  // + STAGE0 manifest rows) sit unreachable. A table-only row rides rung 3
  // (RuntimeRef shim) → FRAME → stage0 — the same path member/assoc take through
  // their harvested rows. Replace with harvested Contracts when the SRFI-1 pack lands
  // registry-side (the Phase-2 package-deal discipline) — filter's OWN Contract
  // already landed this wave; only the ambient-visibility gap blocks the same move.
  every: {},
  any: {},
  infer: { emit: inferRule("infer") },
  "infer/chat": { emit: inferRule("infer/chat") },
  "infer/chat/system": { emit: inferRule("infer/chat/system") },
  "infer/chat/user": { emit: inferRule("infer/chat/user") },
  "infer/chat/assistant": { emit: inferRule("infer/chat/assistant") },
  // The infer-scalar-fold peephole's targets (../peepholes/infer.ts): the SAME
  // sync-shaped `inferRule` factory, under the distinguished head the peephole
  // rewrites `(car (infer …))` / `(car (infer/chat …))` onto. No new Residual
  // shape, no walker change — the peephole's whole integration cost is this row
  // plus the matching `inferAsyncSeeds` entry below.
  "infer/scalar": { emit: inferRule("infer/scalar") },
  "infer/chat/scalar": { emit: inferRule("infer/chat/scalar") },
};

/**
 * ASYNC-IFY's seed set for programs compiled under these rules (`AsyncIfyOptions.
 * asyncSeeds`): the `RuntimeRef` symbols whose runtime target returns a promise.
 * `infer/scalar` / `infer/chat/scalar` are the SAME underlying inference call as
 * `infer` / `infer/chat` (the peephole only changes whether the one-element list
 * wrapper survives to the runtime call, never the asyncness) — both fold-targets
 * seed exactly like their un-folded counterparts. `infer/chat/{system,user,
 * assistant}` construct message values synchronously and must NOT seed (a
 * constructor seed would wrap every message list in a needless `Promise.all`).
 * Colocated with the rules table because this file is where the infer family's
 * verbs are enumerated; the runtime-shim registration owns the set once stage-1
 * shims land (async-await-plane.md).
 */
export const inferAsyncSeeds: ReadonlySet<string> = new Set(["infer", "infer/chat", "infer/scalar", "infer/chat/scalar"]);
