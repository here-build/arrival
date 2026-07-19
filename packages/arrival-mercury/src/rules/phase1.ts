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
 *    walker's own `truthTest`). (`not`/`filter` both obeyed this law from this table
 *    and now obey it from their own Contracts — see the relocation note below.)
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
 * Known deferred hazards (documented, INVESTIGATED this wave — R5b, the TS2367
 * widen sweep — but NOT landed; both would change committed emitted text, which
 * conflicts with the zero-golden-churn gate, so both are report-tracked for a
 * churn-accepting follow-up rather than fixed unilaterally here):
 *  - `null?`'s FACT-GATED clean form (now on its own Contract —
 *    foundations/arrival/arrival/src/env/r7rs/equality.ts) can still hit TS2367 under
 *    a TUPLE-typed proven argument (`.length` narrows to a numeric literal; `=== 0` is
 *    a no-overlap comparison); phase1-symbol-rules.md §2 prescribes a `Un("+", …)`
 *    widen. **Tried and REVERTED this wave**: `provesArray` (equality.ts) gates the
 *    clean branch on ANY proven list/pair/nonEmptyList fact, not specifically a
 *    tuple-narrowed one — the two aren't distinguished at the facts layer yet, so the
 *    branch is NOT dormant (a prior draft of this note claimed it was; disproven
 *    empirically) — `inhuman-gepa-full`'s two `null?` call sites already prove plain
 *    (non-tuple) list facts and hit this branch TODAY. Applying the widen unconditionally
 *    therefore changed ALREADY-CORRECT emitted text (`fails.length === 0` →
 *    `+fails.length === 0`, etc.), breaking `emitted-fixtures.test.ts`'s committed
 *    `inhuman-gepa-full.ts` golden — reverted rather than accepted. A safe fix needs
 *    the facts layer to distinguish "tuple-narrowed length" from "plain list length"
 *    FIRST (typefacts-extraction.md §4 item 2's tuple-typed list-constructor leaves,
 *    not yet delivered) so the widen can be scoped to only the case that needs it.
 *    `pair?`'s sibling rule needs no such fix regardless: its `>` is RELATIONAL, not
 *    `===`/`!==` — TS2367 only fires on the equality family (empirically confirmed:
 *    `xs.length > 0` never errors on a tuple-typed `xs`).
 *  - `and`/`or`/`not`'s Law-T truthiness guard (`X === false` / `X !== false`) hits
 *    TS2367 whenever `X`'s tsc-inferred type is a literal disjoint from `false` —
 *    empirically the CURRENT cause of `emitted-strict-gate.test.ts`'s documented
 *    "TS2367 (9 rows)": `and-three`, `and-zero-then-one`, `not-zero`,
 *    `or-first-truthy-wins`, `short-circuit-effect`, `short-circuit-or`,
 *    `truthy-empty-list`, `truthy-empty-string`, `truthy-zero-then` (verified via
 *    `strictDiagnostics` over every corpus row — 10 diagnostics across these 9 files,
 *    matching the header's count exactly). Unlike `null?`'s attempted fix, this class
 *    has no type-only widen available even in principle: the disjointness is
 *    inherent (a `number`/`string`/`unknown[]` literal is genuinely never `false`), so
 *    any fix changes the rendered comparison/declaration text for `and`/`or`/`if`
 *    (walker.ts's shared `truthTest`/`lowerAndOr`) and `not`'s guard — a foundational,
 *    pervasively-exercised path whose committed goldens (gate3's short-circuit-or,
 *    cross-pass-fixtures, several `fixtures/emitted/*.ts` rows) would all need
 *    re-basing. Not attempted, for the same golden-churn reason `null?`'s attempt was
 *    reverted for.
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
 *    byte-identical to the table's own (now-deleted) `filterRule` — but its TABLE ROW
 *    stayed for a full follow-up wave, evidence-forced: `scheme/srfi-1` was not part
 *    of the oracle's harvested ambient (`emitRegistryOf(session.ambient)` saw
 *    `scheme/lists`/`scheme/numeric`/`scheme/equality` — map/cons/apply/quotient/
 *    not/… all resolved from these Contracts — but ZERO rows for ANY srfi-1 symbol,
 *    probed directly). **Ambient gap now CLOSED** (`oracle/harness.ts`'s
 *    `greenfieldRegistryFor`): `scheme/srfi-1` can't simply join
 *    `session.ambient.capabilities` — its own `deps` order conflicts with
 *    `arrival/schema`'s (both always co-resident, both ordering `lists` vs
 *    `equality` oppositely; a real `AssembleLinearizationError`, confirmed directly,
 *    not a style question) — so harness.ts harvests it STATICALLY off the bare
 *    capability instead (`emitRegistryOf`'s bare-tree input mode, no C3 involved) and
 *    merges it under the real ambient's own harvest (ambient rows win on any name
 *    overlap). `withRules`' fallthrough to that merged harvest row is what resolves
 *    `filter` now — the same mechanism map/apply use, one layer earlier.
 *  - R2: the infer family's FIVE real Contract-backed symbols (`infer`, `infer/chat`,
 *    `infer/chat/system`, `infer/chat/user`, `infer/chat/assistant`) move onto their
 *    own Contracts in `@inhuman.tools/llm-plane-arrival-env`'s `src/infer.ts`
 *    (`arrivalInferCapability`) — the SAME `inferRule(verb)` factory this file used
 *    to hold, now named `inferEmitRule` there, byte-identical (`Call(ctx.runtime
 *    (verb), args)`). **Discovered, not assumed, and — unlike filter's (pre-fix)
 *    ambient gap — no gap to close at all:**
 *    `registry-harvest.test.ts`'s own pre-existing assertion (`capability:
 *    "arrival/infer"` on the harvested `infer` row) already proved `arrival/infer`
 *    IS part of the oracle's harvested ambient — `arrivalAgenticCapability` (rooted
 *    in `arrivalCapabilities()`, `@inhuman.tools/arrival-run/src/packs/index.ts`)
 *    deps on it, so `infer`/`infer/chat`/the three chat-message constructors resolve
 *    through the REAL harvest exactly like map/apply/cons do — no ambient gap, no
 *    held row. All five table rows are deleted (not just presence-only) —
 *    `withRules`' fallthrough to the harvested Contract row is what resolves them
 *    now.
 *  - `infer/scalar`/`infer/chat/scalar` STAY table-resident — but for a DIFFERENT
 *    reason than filter's ambient gap: they are not real capability vocabulary at
 *    all. They are the infer-scalar-fold peephole's synthetic dispatch heads (the
 *    distinguished call-head `(car (infer …))`/`(car (infer/chat …))` fuses onto —
 *    ../peepholes/infer.ts), so no `arrival/infer` symbol is named "infer/scalar";
 *    there is no Contract for either to move to, ever. Law C holds: the peepholes
 *    themselves (cross-node idioms) stay engine-side, unmoved by this relocation.
 */
import type { EmitCtx, EmitRule } from "@inhuman.tools/arrival/emit";

import type { Binding, R } from "../residual/types.js";
import { ArrayLit, Arrow, Bin, Call, Cond, Index, Lit, Member, Method, Ref } from "../residual/types.js";
import type { SymbolRuleTable } from "./overlay.js";

/** The rules-side twin of the walker's `ruleOf` narrowing seam: `EmitCtx.fresh` is
 *  typed `unknown` in arrival core (deliberately opaque — the residual algebra lives in
 *  THIS package, §4.5 layering), while the walker's real `ctxFor` supplies the namer's
 *  `Binding`. One helper, one cast, documented — no rule touches `fresh` directly.
 *  Kept for `carRule`'s `.ref` method (R5c's eta-expansion, below) — this table's only
 *  remaining local user now that `filterRule` is deleted (its Contract's own copy
 *  lives in srfi-1.ts; map/apply's copies live on lists.ts, alongside their
 *  relocated rules). */
const freshBinding = (ctx: EmitCtx<R>, hint: string): Binding => ctx.fresh(hint) as Binding;

/** Fixed-arity refusal (see the module header's arity note). Returns the args
 *  length-checked — the callers' `!` index assertions are made true here, once. */
function exactly(ctx: EmitCtx<R>, sym: string, args: readonly R[], n: number): readonly R[] {
  if (args.length !== n) ctx.door(`\`${sym}\` wants exactly ${n} argument${n === 1 ? "" : "s"}, got ${args.length}`);
  return args;
}

// ─── §2.1 representation collapse: car / cdr (LOOSE emit contract) ───────────────────
// Compile target is the interpreter DEFAULT: loose mode (ExecOptions.strict defaults
// false). Loose car/cdr of empty → nil (`[]` on the array face); of a vector/array
// spine is first/rest (strictGate would PortabilityError — we never emit that path).
// R7RS-strict throws are intentionally NOT compiled.

const carRule: EmitRule<R> = {
  call: (args, ctx) => {
    const xs = exactly(ctx, "car", args, 1)[0]!;
    // loose nil-tolerance: empty → []; non-empty → [0] (never bare xs[0], which is undefined)
    return Cond(Bin("===", Member(xs, "length"), Lit(0)), ArrayLit([]), Index(xs, Lit(0)));
  },
  // Eta-`ref` for value position (`(map car xss)`): same loose residual as call.
  ref: (ctx) => {
    const callable = ctx.selfFacts?.callable;
    if (callable?.arity !== 1) return ctx.runtime("car"); // Law F: no proof ⇒ stage0 loose shim
    const x = freshBinding(ctx, "x");
    const innerCtx: EmitCtx<R> = { ...ctx, argFacts: [callable.paramFacts?.[0] ?? {}] };
    return Arrow([x], carRule.call([Ref(x)], innerCtx));
  },
};

const cdrRule: EmitRule<R> = {
  // loose: empty → [] via slice(1); non-empty → rest. Matches ANil/AJSArray loose.
  call: (args, ctx) => Method(exactly(ctx, "cdr", args, 1)[0]!, "slice", [Lit(1)]),
  ref: (ctx) => {
    const callable = ctx.selfFacts?.callable;
    if (callable?.arity !== 1) return ctx.runtime("cdr");
    const x = freshBinding(ctx, "x");
    const innerCtx: EmitCtx<R> = { ...ctx, argFacts: [callable.paramFacts?.[0] ?? {}] };
    return Arrow([x], cdrRule.call([Ref(x)], innerCtx));
  },
};

// ─── §2.1 representation collapse, compound family: cadr / caddr / cddr / … ───────────
// The SAME law as car/cdr above, extended to R7RS's full generative cxr family: a
// compound name is nothing but car/cdr applied in sequence, innermost (rightmost)
// letter first — arrival's own kernel derives the identical steps for the
// INTERPRETER (foundations/arrival/arrival/src/eval/Resolver.ts's `cxrUnfold`:
// `[...name.slice(1, -1)].reverse()`, "innermost (rightmost) letter applied
// first"). `cxrCall` below is that same derivation, read off the NAME, targeting
// the array representation instead of a runtime letter-walk — no guard, no shim,
// no register branch, exactly car/cdr's own "no mode" (§4.3).
//
// Folded, not nested: a run of pending cdrs collapses into one pending "drop
// count" that the NEXT car folds directly into an index — `.slice(k)[0]` is
// always `[k]` for an array, so the drop never renders its own `.slice()` unless
// the name ends on a cdr with no following car. `cadr` → `xs[1]` (not
// `xs.slice(1)[0]`), `caddr` → `xs[2]`, `cddr` → `xs.slice(2)`, and a genuine
// composition like `cadar` → `xs[0][1]` (car, then a pending single drop folds
// into the next car's index) — derived, never hand-typed per name.
//
// Bounded at depth 4 — R7RS's own generative ceiling (there is no `cadddr`-of-a-
// cdddr-style depth-5 name), the same bound gate1/measure.ts's local `CXR_RE =
// /^c[ad]{1,4}r$/` polices independently. car/cdr (depth 1) keep their own
// hand-written rules above — they predate this table and carry car's eta `.ref`
// (R5c); this table covers depths 2-4 only, enumerated from the {a,d} alphabet
// rather than hand-typed, so one compound name can never be present while its
// same-depth sibling is missing. No `.ref`/eta here (unlike car): nothing in the
// current oracle corpus uses a compound accessor as a bare HOF value — a future
// value-position use degrades to the ordinary rung-3 shim ladder like any other
// registry symbol without a `.ref`, and doors honestly (frame door) if no
// stage-0 export answers it, exactly like every other un-shimmed symbol.
function cxrCall(name: string, args: readonly R[], ctx: EmitCtx<R>): R {
  let cur = exactly(ctx, name, args, 1)[0]!;
  let pendingDrops = 0;
  for (const letter of [...name.slice(1, -1)].reverse()) {
    if (letter === "d") {
      pendingDrops += 1;
    } else {
      cur = Index(cur, Lit(pendingDrops));
      pendingDrops = 0;
    }
  }
  // A trailing run of cdrs with no following car (cddr, cdddr, …) has no index
  // to fold into — it renders as the plain slice.
  if (pendingDrops > 0) cur = Method(cur, "slice", [Lit(pendingDrops)]);
  return cur;
}

const cxrEmitRule = (name: string): EmitRule<R> => ({
  call: (args, ctx) => cxrCall(name, args, ctx),
});

/** Every depth-2..4 name over the {a,d} alphabet — R7RS's full compound cxr family
 *  (4 + 8 + 16 = 28 names), generated from the alphabet rather than hand-typed so
 *  the row set can never miss a sibling. */
function compoundCxrNames(): readonly string[] {
  const names: string[] = [];
  for (let depth = 2; depth <= 4; depth++) {
    for (let bits = 0; bits < 2 ** depth; bits++) {
      let middle = "";
      for (let bit = depth - 1; bit >= 0; bit--) middle += (bits >> bit) & 1 ? "d" : "a";
      names.push(`c${middle}r`);
    }
  }
  return names;
}

const compoundCxrRules: SymbolRuleTable = Object.fromEntries(compoundCxrNames().map((name) => [name, { emit: cxrEmitRule(name) }]));

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

// ─── filter — RELOCATED (see the module header's relocation note, Wave 3; its
// ambient gap closed in oracle/harness.ts's `greenfieldRegistryFor`). Its Law-T
// predicate-verdict guard (`Array.prototype.filter` keeps by JS truthiness, which
// drops Scheme-truthy `0`/`""`, so the conservative form wraps the predicate in the
// guard `(x) => f(x) !== false`; a provably-boolean predicate or the read register
// passes `f` bare) now lives on its own Contract's `emit` field in
// foundations/arrival/arrival/src/env/srfi/srfi-1.ts (`filterEmitRule`). No rule
// body or table row remains here.

// ─── infer/scalar / infer/chat/scalar — RELOCATED (R2), except these two ─────────────
// The infer family's FIVE real Contract-backed symbols (`infer`, `infer/chat`,
// `infer/chat/system`, `infer/chat/user`, `infer/chat/assistant`) moved onto their own
// Contract's `emit` field — `@inhuman.tools/llm-plane-arrival-env`'s `src/infer.ts`
// (`arrivalInferCapability`), carrying `inferEmitRule("infer")` etc., byte-identical to
// this file's own (now-deleted) `inferRule` factory. See the module header's relocation
// note for the full account, including WHY that move was safe outright (no ambient gap
// — `arrival/infer` IS part of the oracle's harvested ambient, discovered via
// registry-harvest.test.ts's own pre-existing assertion, unlike filter's srfi-1 case).
//
// `infer/scalar`/`infer/chat/scalar` are NOT part of that move (Law C — cross-node
// idioms are never symbol rules; the infer-scalar-fold + cache-key-elide PEEPHOLES that
// mint/consume these two heads stay engine-side, ../peepholes/infer.ts, untouched by
// this relocation). They are the scalar-fold peephole's own synthetic dispatch heads —
// the distinguished call-head `(car (infer …))`/`(car (infer/chat …))` fuses onto — not
// real capability vocabulary: no `arrival/infer` symbol is named "infer/scalar", so
// there is no Contract for either to ever move to. `inferRule` stays here, retained
// SOLELY for these two rows (the SAME sync-shaped shape as its five relocated former
// table-mates: `Call(RuntimeRef(verb), args)` — Law W: no Await minted; ASYNC-IFY reads
// the runtime shim's real declared type and awaits the promise-typed edge. The walker
// has ALREADY collapsed kwargs into one trailing options ObjectLit before any rule
// runs, so `args` carries the options object as-is — the rule adds nothing).

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
  // The compound cxr family (cadr, caddr, cddr, … depth 2-4) — see the
  // `compoundCxrRules` section above for the derivation; spread here rather than
  // hand-listed so the table can never drift from the generated name set.
  ...compoundCxrRules,
  // cons / not / null? / pair? / - / / / = / quotient / modulo / map / apply / filter
  // — RELOCATED onto their own Contracts (module header's relocation note); no table
  // row remains for any of them. The bare "+"/"*" presence rows this comment used to
  // describe (needed only so `applyRule`'s FOLD_OPS structural recognition could
  // resolve a value-position "+"/"*" to `RuntimeRef` under this file's base-less test
  // overlay) are ALSO gone: `apply`'s own relocation (Wave 3) took that need with it —
  // no table-resident rule is left to exercise it, so no vestigial row remains either.
  //
  // SRFI-1 every/any — REGISTRY PRESENCE ONLY (no emit rule; wave-C wiring fix), STILL
  // table-resident (unlike filter, above): now that oracle/harness.ts's
  // `greenfieldRegistryFor` merges srfi-1's static harvest into the compiled registry
  // (the same fix that closed filter's ambient gap), `every`/`any` DO resolve a real
  // row from their own Contract too (kind "define", a real `.type` — srfi-1.ts declares
  // no `.emit` for either, only filter's). These bare rows are therefore functionally
  // redundant now (`withRules`' merge only reads `entry.emit`/`.narrows`/`.refPolicy`
  // off this table — all three absent here — so an entry of `{}` changes nothing the
  // base row doesn't already supply; verified: the walker's fallback ladder branches on
  // `row.kind === "door"` only, never "native" vs "define"). Left in place — retiring
  // them is a separate, ungated cleanup, not this gap's fix.
  every: {},
  any: {},
  // some — UNLIKE every/any above, this row is NOT functionally redundant: grepped,
  // the interpreter defines `some` as `symbol.alias\`any?\`` (srfi-1.ts) — a byte-
  // identical rebinding, never its own baked entity — and the harvest's
  // `isBakedEntityLike` (registry/harvest.ts) explicitly SKIPS `kind === "alias"`
  // defs ("alias never binds directly … none of them can carry `.emit`"), so `some`
  // never gets a row from the ambient harvest at all. This presence row is the
  // ONLY thing that makes it resolvable — same tier as every/any (no `.emit`, falls
  // to the rung-3 named-import shim, `some` in runtime/stage0.ts).
  //
  // Behavior note (verified against srfi-1.ts, not assumed from the name): bare
  // `some` is NOT SRFI-1's value-returning `any` — it aliases `any?`, the HONEST
  // boolean quantifier (#t iff SOME element-tuple's predicate result is
  // scheme-truthy; plain #t/#f, never the witness). `every`'s bare form stays
  // genuinely value-returning (LAST result) — the two are asymmetric by design,
  // not one shape copied onto both names. stage0.ts's `some` mirrors the
  // boolean shape; `any` (already exported there) stays the value-returning
  // witness-finder untouched.
  some: {},
  // max-by — NOT Contract-backed at all (unlike every/any/some, which are at least
  // DECLARED in srfi-1.ts): grepped, confirmed absent from every
  // foundations/arrival/arrival/src/env/**/*.ts. The interpreter binds it by
  // injecting a scheme-level `(define (max-by f xs) …)` STRING into every session's
  // prelude (arrival-run/src/run-program.ts's `BUILTIN_PREAMBLE`, flagged there as a
  // standing TODO to migrate into a real core pack) — no Contract, so no ambient row
  // is possible until that migration lands. This presence row is therefore the
  // entire fix: falls to the rung-3 shim (`maxBy` in runtime/stage0.ts), same tier
  // as `max` itself (`max_`). Ties: the interpreter's own body (`reduce` seeded on
  // `(car xs)`, strict `>`) lets the FIRST (leftmost) element attaining the max
  // stand — `maxBy`'s shim mirrors that fold exactly, not `>=`.
  "max-by": {},
  // infer / infer/chat / infer/chat/system / infer/chat/user / infer/chat/assistant —
  // RELOCATED (R2, module header's relocation note); no table row remains for any of
  // them — `withRules`' fallthrough to the harvested Contract row
  // (`@inhuman.tools/llm-plane-arrival-env`'s `arrivalInferCapability`) resolves them
  // now.
  //
  // The infer-scalar-fold peephole's targets (../peepholes/infer.ts) — NOT relocated,
  // and never will be (see the section comment above `inferRule`, just above): the SAME
  // sync-shaped `inferRule` factory, under the distinguished head the peephole rewrites
  // `(car (infer …))` / `(car (infer/chat …))` onto. No new Residual shape, no walker
  // change — the peephole's whole integration cost is this row plus the matching
  // `inferAsyncSeeds` entry below.
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
