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
 *  - Law F + the read register (constitution §1) — where a rule has a fact-directed
 *    clean/conservative split (`not`, `filter`), fact absence takes the conservative
 *    form in the run register; the read register short-circuits to the clean form
 *    (glass is never executed — mirrors the walker's own `truthTest`).
 *  - §7 one-number — `+ - * / = quotient modulo` are plain folds/operators over JS
 *    numbers. No exactness dispatch EXISTS: not a fact, not a shim, not a branch.
 *  - §2.1 representation collapse + Law U — lists/pairs are arrays; `car`/`cdr`/
 *    `cons` are syntax over that representation. `(car '())` is outside the
 *    compilation contract (the lens warns at compile time; the artifact stays
 *    clean — no guard, no shim, no mode). `null?`/`pair?` are DIFFERENT: total
 *    predicates over any value (defined behavior, not UB), so their clean
 *    `.length` form is fact-gated and the shim is the unproven default (Law F —
 *    the fuzzer proved the unconditional form wrong on strings).
 *
 * Arity: fixed-arity rules refuse a mis-arity call site via `ctx.door` (a compile
 * diagnostic — totality: every form compiles or doors, never crashes the walker on an
 * `undefined` operand). This is stricter than the interpreter's evaluation-time arity
 * check, deliberately: a fixed-arity builtin called wrong is a static defect, exactly
 * the class a compiler front gate exists to catch.
 *
 * Known deferred hazards (documented, not landed — report-tracked for later waves):
 *  - `null?`/`pair?`'s FACT-GATED clean form can still hit TS2367 under a TUPLE-typed
 *    proven argument (`.length` narrows to a numeric literal; `=== 0` is a no-overlap
 *    comparison); phase1-symbol-rules.md §2 prescribes a `Un("+", …)` widen. Rarer now
 *    (the clean form needs a proven list fact at all), lands with the widen sweep.
 *  - `quotient` references the global `Math` via a minted binding (precedent: the
 *    walker's door throws reference global `Error` the same way). The walker's module
 *    JS frame pre-seeds "Error"/"Math"/"Promise" (landed with the FRAME wave), so a
 *    user binding cleaning to `Math` disambiguates instead of shadowing the global.
 */
import type { EmitCtx, EmitRule } from "@here.build/arrival/emit";

import type { Binding, BinOp, R } from "../residual/types.js";
import {
  ArrayLit,
  Arrow,
  Bin,
  Binding as mkBinding,
  Call,
  Index,
  Lit,
  Member,
  Method,
  Ref,
  Spread,
  Un,
} from "../residual/types.js";
import type { SymbolRuleTable } from "./overlay.js";

/**
 * The rules-side twin of the walker's `ruleOf` narrowing seam: `EmitCtx.fresh` is
 * typed `unknown` in arrival core (deliberately opaque — the residual algebra lives in
 * THIS package, §4.5 layering), while the walker's real `ctxFor` supplies the namer's
 * `Binding`. One helper, one cast, documented — no rule touches `fresh` directly.
 */
const freshBinding = (ctx: EmitCtx<R>, hint: string): Binding => ctx.fresh(hint) as Binding;

/** Fixed-arity refusal (see the module header's arity note). Returns the args
 *  length-checked — the callers' `!` index assertions are made true here, once. */
function exactly(ctx: EmitCtx<R>, sym: string, args: readonly R[], n: number): readonly R[] {
  if (args.length !== n) ctx.door(`\`${sym}\` wants exactly ${n} argument${n === 1 ? "" : "s"}, got ${args.length}`);
  return args;
}

// ─── §2.1 representation collapse: car / cdr / cons ───────────────────────────────────
// Constitution §4.3 verbatim: syntax over the array representation, not library
// symbols. No guard, no shim, no register branch (the component spec's guarded-branch
// draft predates the representation-collapse ruling and is superseded by §4.3).

const carRule: EmitRule<R> = {
  call: (args, ctx) => Index(exactly(ctx, "car", args, 1)[0]!, Lit(0)),
};

const cdrRule: EmitRule<R> = {
  call: (args, ctx) => Method(exactly(ctx, "cdr", args, 1)[0]!, "slice", [Lit(1)]),
};

const consRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [x, xs] = exactly(ctx, "cons", args, 2);
    return ArrayLit([x!, Spread(xs!)]);
  },
};

// ─── Law T: not ────────────────────────────────────────────────────────────────────────
// Constitution §5.2: `!c` when the operand is provably boolean, `c === false` otherwise
// (exact Scheme truthiness — only `#f` is false; `0`/`""` are truthy). `not` stays an
// ordinary registry symbol (§3.2) — the NForm grammar recognizes it structurally.

const notRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [c] = exactly(ctx, "not", args, 1);
    return ctx.config.register === "read" || ctx.argFacts[0]?.boolean === true
      ? Un("!", c!)
      : Bin("===", c!, Lit(false));
  },
};

// ─── null? / pair? — FACT-GATED .length reads, Law-N self-witnessed ──────────────────
// Both are TOTAL predicates over ANY value — which is exactly why the bare `.length`
// read was wrong-code, not a deferred hazard: a JS string carries `.length` too, so
// `(null? "")` compiled to `true` where the interpreter says `#f`. The fuzzer found
// it on its first run (narrows-{null,pair}-string-collision corpus rows). Law F
// applied properly: the clean `.length` form emits only when argFacts PROVE the
// array representation; anything unproven rides the stage-0 shim, whose
// Array.isArray test is the honest total semantics.

const provesArray = (f: { list?: true; pair?: true; nonEmptyList?: true } | undefined): boolean =>
  f?.list === true || f?.pair === true || f?.nonEmptyList === true;

const nullQRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [xs] = exactly(ctx, "null?", args, 1);
    return provesArray(ctx.argFacts[0])
      ? Bin("===", Member(xs!, "length"), Lit(0))
      : Call(ctx.runtime("null?"), [xs!]);
  },
};

const pairQRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [xs] = exactly(ctx, "pair?", args, 1);
    return provesArray(ctx.argFacts[0])
      ? Bin(">", Member(xs!, "length"), Lit(0))
      : Call(ctx.runtime("pair?"), [xs!]);
  },
};

// ─── §7 one-number: + - * / — plain left folds, zero ctx reads ───────────────────────
// The platform's arithmetic IS the semantics; no exactness dispatch exists for any
// branch to key on. Left folds print flat (`a + b + c`) because same-precedence
// left-nesting needs no parens — the renderer's parenthesizer is structural.

const foldBin = (op: BinOp, args: readonly R[]): R => args.reduce((acc, a) => Bin(op, acc, a));

const plusRule: EmitRule<R> = {
  // (+) → 0 (the additive identity); (+ x) → x itself — no operator node emitted.
  call: (args) => (args.length === 0 ? Lit(0) : foldBin("+", args)),
};

const timesRule: EmitRule<R> = {
  call: (args) => (args.length === 0 ? Lit(1) : foldBin("*", args)),
};

const minusRule: EmitRule<R> = {
  // R7RS `-` wants ≥ 1 argument; unary is negation.
  call: (args, ctx) =>
    args.length === 0
      ? ctx.door("`-` wants at least 1 argument")
      : args.length === 1
        ? Un("-", args[0]!)
        : foldBin("-", args),
};

const divideRule: EmitRule<R> = {
  // `/` is plain JS division (§7 — the interpreter's exact-rational richness is
  // interpreter-plane; the artifact divides). Unary is the R7RS reciprocal: (/ x) → 1 / x.
  call: (args, ctx) =>
    args.length === 0
      ? ctx.door("`/` wants at least 1 argument")
      : args.length === 1
        ? Bin("/", Lit(1), args[0]!)
        : foldBin("/", args),
};

// ─── = — chained ===, natively correct under §7 ───────────────────────────────────────
// `(= 1 1.0)` → `1 === 1.0` → true = Scheme's #t (Appendix B: "natively correct").
// Not a Law-N predicate (a value comparison narrows no type) — no `narrows` field.

const numEqRule: EmitRule<R> = {
  call: (args) => {
    // R7RS: a 0/1-ary comparison is vacuously true. (Degenerate — a lowered operand
    // residual is discarded here; sound for the pure slice corpus, and the shape is
    // the component spec's own chainCompare verbatim.)
    if (args.length < 2) return Lit(true);
    if (args.length === 2) return Bin("===", args[0]!, args[1]!);
    // n-ary: a === b && b === c — middle operands appear twice; §2.2 licenses pure
    // double-evaluation (a perf note, not a correctness bug; temps are effect-discipline).
    let chain = Bin("===", args[0]!, args[1]!);
    for (let i = 2; i < args.length; i++) chain = Bin("&&", chain, Bin("===", args[i - 1]!, args[i]!));
    return chain;
  },
};

// ─── quotient / modulo — Appendix B operator-identity residuals ───────────────────────
// Fixed per-symbol algorithms, never type-directed: truncating division and the
// sign-correct (sign-of-divisor) modulo. JS's `%` is a REMAINDER (sign-of-dividend);
// `((a % n) + n) % n` is the one correct modulo algorithm over it.

const quotientRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [a, b] = exactly(ctx, "quotient", args, 2);
    // Global `Math` via a minted binding — the walker's `Error` door-throw precedent
    // (see the module header's seeding note).
    return Method(Ref(mkBinding("Math")), "trunc", [Bin("/", a!, b!)]);
  },
};

const moduloRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [a, n] = exactly(ctx, "modulo", args, 2);
    return Bin("%", Bin("+", Bin("%", a!, n!), n!), n!);
  },
};

// ─── map — the arity bridge, sync-shaped ALWAYS (Law W) ───────────────────────────────
// Constitution §4.3 verbatim: single-list rides `Array.prototype.map`; multi-list is
// the index-zip arrow (drives off lists[0]'s length — today's emitter behavior,
// inherited deliberately; the length-mismatch question is phase1-symbol-rules.md Open
// Q 4, not resolved here). If `f` is async, ASYNC-IFY sees `Promise<B>[]` meeting a
// `B[]`-consumer and rewrites to `await Promise.all(...)` at the consuming edge — not
// this rule's concern (it recognizes the `.map` shape structurally, post-emission).

const mapRule: EmitRule<R> = {
  call: (args, ctx) => {
    if (args.length < 2) ctx.door(`\`map\` wants a function and at least one list, got ${args.length} argument${args.length === 1 ? "" : "s"}`);
    const [f, ...lists] = args;
    if (lists.length === 1) return Method(lists[0]!, "map", [f!]);
    const el = freshBinding(ctx, "item");
    const idx = freshBinding(ctx, "i");
    const rest = lists.slice(1).map((l) => Index(l, Ref(idx)));
    return Method(lists[0]!, "map", [Arrow([el, idx], Call(f!, [Ref(el), ...rest]))]);
  },
};

// ─── filter — Law T on the predicate's VERDICT ────────────────────────────────────────
// `Array.prototype.filter` keeps by JS truthiness, which drops Scheme-truthy `0`/`""`;
// Scheme's filter keeps everything except `#f`. So the conservative form wraps the
// predicate in the Law-T guard `(x) => f(x) !== false`; a provably-boolean predicate
// (or the read register) passes `f` bare. This RECONCILES the component spec's §6
// (bare `.filter(pred)` unconditionally — pre-reconciliation) against constitution
// Law T, per the wave plan; single-list only (filter's own Contract, unlike map).

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

// ─── apply — the reduce/arity bridge (constitution §6's preserved-knowledge row) ──────
// `(apply + xs)` → a reduce with the correct identity. Recognition is STRUCTURAL over
// the already-lowered operator residual (`+` in value position lowers to
// `RuntimeRef("+")` via its shim refPolicy before this rule runs) — the same
// residual-plane recognition ASYNC-IFY uses on `.map`'s method name; Law A forbids
// peeking at SYNTAX or result types, not at the lowered value in hand.
//
// Generic `(apply f a b xs)` → `f(a, b, ...xs)` — SPREAD, not `f.apply(null, xs)`
// (the mission's pick-one): spread is the idiomatic modern form (§1 human-grade (b)),
// carries no `this`-binding noise, and composes with leading fixed args without an
// argument-array concat.

const FOLD_OPS: Readonly<Record<string, { readonly op: BinOp; readonly identity: number }>> = {
  "+": { op: "+", identity: 0 },
  "*": { op: "*", identity: 1 },
};

const applyRule: EmitRule<R> = {
  call: (args, ctx) => {
    if (args.length < 2) ctx.door("`apply` wants a function and a trailing argument list");
    const f = args[0]!;
    const last = args[args.length - 1]!;
    if (args.length === 2 && f.t === "RuntimeRef") {
      const fold = FOLD_OPS[f.symbol];
      if (fold !== undefined) {
        const acc = freshBinding(ctx, "acc");
        const item = freshBinding(ctx, "item");
        return Method(last, "reduce", [Arrow([acc, item], Bin(fold.op, Ref(acc), Ref(item))), Lit(fold.identity)]);
      }
    }
    return Call(f, [...args.slice(1, -1), Spread(last)]);
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
// structural rules (car/cdr/null?/pair?) — declarative this wave (the walker degrades
// eta to shim until instantiated-signature facts land), `shim` (the default) for the
// variadics and HOFs. `narrows` self-witnesses (`null?`/`pair?` ARE their own runtime
// proof — phase1-symbol-rules.md Open Q 3, inherited): the witness names the
// REGISTERED symbol, never the stage-0 shim export.

export const phase1Rules: SymbolRuleTable = {
  car: { emit: carRule, refPolicy: "eta" },
  cdr: { emit: cdrRule, refPolicy: "eta" },
  cons: { emit: consRule },
  not: { emit: notRule },
  "null?": { emit: nullQRule, narrows: { witness: "null?" }, refPolicy: "eta" },
  "pair?": { emit: pairQRule, narrows: { witness: "pair?" }, refPolicy: "eta" },
  "+": { emit: plusRule },
  "-": { emit: minusRule },
  "*": { emit: timesRule },
  "/": { emit: divideRule },
  "=": { emit: numEqRule },
  quotient: { emit: quotientRule },
  modulo: { emit: moduloRule },
  map: { emit: mapRule },
  filter: { emit: filterRule },
  apply: { emit: applyRule },
  // SRFI-1 every/any — REGISTRY PRESENCE ONLY (no emit rule; wave-C wiring fix). They
  // are preamble/scope symbols the contract harvest cannot see (the 221-name harvest
  // lacks them), so without these rows the walker's §4.2 ladder doors them
  // `unresolved-identifier` while their stage-0 shims (the value-returning SRFI forms
  // + STAGE0 manifest rows) sit unreachable. A table-only row rides rung 3
  // (RuntimeRef shim) → FRAME → stage0 — the same path member/assoc take through
  // their harvested rows. Replace with harvested Contracts when the SRFI-1 pack lands
  // registry-side (the Phase-2 package-deal discipline).
  every: {},
  any: {},
  infer: { emit: inferRule("infer") },
  "infer/chat": { emit: inferRule("infer/chat") },
  "infer/chat/system": { emit: inferRule("infer/chat/system") },
  "infer/chat/user": { emit: inferRule("infer/chat/user") },
  "infer/chat/assistant": { emit: inferRule("infer/chat/assistant") },
};

/**
 * ASYNC-IFY's seed set for programs compiled under these rules (`AsyncIfyOptions.
 * asyncSeeds`): the `RuntimeRef` symbols whose runtime target returns a promise.
 * Only the two INFERRING verbs — `infer/chat/{system,user,assistant}` construct
 * message values synchronously and must NOT seed (a constructor seed would wrap
 * every message list in a needless `Promise.all`). Colocated with the rules table
 * because this file is where the infer family's verbs are enumerated; the runtime-
 * shim registration owns the set once stage-1 shims land (async-await-plane.md).
 */
export const inferAsyncSeeds: ReadonlySet<string> = new Set(["infer", "infer/chat"]);
