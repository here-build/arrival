/**
 * LEGIBILITY gate tests (constitution §3.5's third invention). As of E1a
 * (engine plan §2 E1a), destructure/singularize dissolved into ../naming/
 * (census.ts's use-shape analysis + allocate.ts's naming policy) — `walk()`
 * itself now produces the destructured/singularized shape, so this file's
 * "composed pass" tests exercise `compile()` (== `walk()`) directly for
 * those two behaviors. Their own gate tests live in `naming.test.ts`. Leg 3
 * (pure-region CSE) DISSOLVED at E2 (engine plan §2 E2, second half) into
 * `../naming/shared-bindings.ts`'s `sharedBindingsOf` (the decision view) +
 * `materializeSharedBindings` (the mechanical commit) — a real post-walk
 * pass still, unaffected by E1a, just no longer independently callable as
 * `pureRegionCse`/`legibility()`; every golden below is UNCHANGED bytes,
 * only the call shape moved (`materializeSharedBindings(sharedBindingsOf(u,
 * registry))` replaces `pureRegionCse(u, registry)` / `legibility(u,
 * {registry})`). A former final `describe` ran the REAL wiring against the
 * actual harvested `infer` capability; it depended on the oracle package and
 * was removed to keep this a pure compiler unit test.
 */
import { describe, expect, it } from "vitest";

import type { EmitRule } from "@inhuman.tools/arrival/emit";

import {
  classify,
  desugar,
  materializeSharedBindings,
  parseSexprs,
  phase1Rules,
  sharedBindingsOf,
  walk,
} from "../index.js";
import type { EmitRegistry, EmitRegistryRow } from "../index.js";
import { render } from "../residual/render.js";
import {
  Arrow,
  Bin,
  Call,
  Index,
  Lit,
  Method,
  Ref,
  type Binding,
  type CompilationUnit,
  type R,
} from "../residual/types.js";

/** `pureRegionCse`'s replacement call shape (module header): the decision,
 *  then its mechanical commit — over the SAME registry the dissolved pass
 *  read `cacheClass`/`provenance` off. */
const sharedBindings = (u: CompilationUnit, registry: EmitRegistry): CompilationUnit =>
  materializeSharedBindings(sharedBindingsOf(u, registry));

// ── a hand-rolled registry (same convention as walker.test.ts/async-ify.test.ts) ──

const row = (symbol: string, over: Partial<EmitRegistryRow> = {}): EmitRegistryRow => ({
  symbol,
  capability: "«test»",
  kind: "rosetta",
  refPolicy: "shim",
  ...over,
});
const registryOf = (...rows: EmitRegistryRow[]): EmitRegistry => {
  const m = new Map(rows.map((r) => [r.symbol, r]));
  return { lookup: (n) => m.get(n), names: new Set(m.keys()) };
};

// `+`'s real Contract now lives on foundations/arrival/arrival/src/env/r7rs/
// numeric.ts (Phase-2 relocation, Wave 2) — this package cannot deep-import arrival
// core's internal env/r7rs files (only its declared public subpaths), and spinning up
// a real harvest session just for this fast, hand-rolled registry
// would defeat the whole convention this file documents. A byte-verified LOCAL mirror
// of numeric.ts's own `plusEmitRule` (see that file, and its own
// numeric-emit.test.ts proof) — 2-ary only, which is all this suite ever constructs.
const plusEmitRuleMirror: EmitRule<R> = {
  call: (args) => (args.length === 0 ? Lit(0) : args.reduce((acc, a) => Bin("+", acc, a))),
};

// `map`'s real Contract now lives on foundations/arrival/arrival/src/env/r7rs/
// lists.ts (Phase-2 relocation, Wave 3) — same deep-import restriction as `+`'s
// mirror above. A byte-verified LOCAL mirror of lists.ts's own `mapEmitRule` (see
// that file, and its own lists-emit.test.ts proof).
const mapEmitRuleMirror: EmitRule<R> = {
  call: (args, ctx) => {
    if (args.length < 2) ctx.door(`\`map\` wants a function and at least one list, got ${args.length} argument${args.length === 1 ? "" : "s"}`);
    const [f, ...lists] = args;
    if (lists.length === 1) return Method(lists[0]!, "map", [f!]);
    const el = ctx.fresh("item") as Binding;
    const idx = ctx.fresh("i") as Binding;
    const rest = lists.slice(1).map((l) => Index(l, Ref(idx)));
    return Method(lists[0]!, "map", [Arrow([el, idx], Call(f!, [Ref(el), ...rest]))]);
  },
};

// car/cdr ride the REAL Phase-1 rules (phase1.ts) so the residual shapes this suite
// destructures/singularizes/dedupes against are exactly what the gate-authoritative
// pipeline itself produces — never a hand-approximated stand-in. `+`/`map` ride
// byte-verified LOCAL MIRRORS instead (see each's own comment, just above its
// definition) — both relocated onto arrival-core Contracts this package cannot
// deep-import.
const testRegistry = registryOf(
  row("car", { emit: phase1Rules.car!.emit }),
  row("cdr", { emit: phase1Rules.cdr!.emit }),
  row("+", { emit: plusEmitRuleMirror }),
  row("map", { emit: mapEmitRuleMirror }),
  row("combine"), // bare shim — a value-position callback with no interesting rule
  row("list"), // bare shim — a plain, already-singular collection constructor
  row("g", { cacheClass: "pure" }), // a generic pure symbol, no emit rule (rung-3 shim)
  row("sinkop", { cacheClass: "pure", provenance: "sink" }), // sinks never dedup, even if (defensively) also "pure"
  row("infer", { cacheClass: "pure" }), // mirrors the real infer Contract's declared cacheClass
  row("plainop"), // present in the registry, but no cacheClass declared at all
);

const cf = (src: string) => classify(desugar(parseSexprs(src)));
const compile = (src: string): CompilationUnit => walk(cf(src), { registry: testRegistry, register: "run" });
const emit = (src: string, pass: (u: CompilationUnit) => CompilationUnit): string => render(pass(compile(src)));

// ── implicit destruction + element-name singularization ──────────────────────────
//
// Both dissolved into ../naming/ this wave (engine plan §2 E1a) — `compile()` (==
// `walk()`) now produces the destructured/singularized shape directly; there is no
// longer an independently-callable `destructureParams`/`singularizeHofParams` pass to
// unit-test in isolation. These golden shapes are re-pinned here (unchanged bytes —
// see naming.test.ts for the census/allocation-level unit coverage of the underlying
// analysis) so this file keeps its role as the constitution §3.5 worked-example gate.

describe("implicit destruction — now decided inside walk() (engine plan §2 E1a)", () => {
  it("THE constitution example: a param used only through car/cdr-composed positional access destructures to [first, second]", () => {
    // The constitution spells the second access `(cadr pair)`; this test keeps the
    // semantically-identical `(car (cdr pair))` spelling it always used (`cadr` is
    // now ALSO a registered symbol — rules/phase1.ts's `compoundCxrRules` — but this
    // file builds its own minimal `testRegistry`, not the real phase1Rules table, so
    // it never resolves compound cxr names regardless) — naming/census.ts's
    // `cdrOffsetOf` resolves either spelling to the same tuple position (see its own
    // header).
    expect(render(compile(`(define (f pair) (+ (car pair) (car (cdr pair))))`))).toBe(
      `function f([first, second]) {\n    return first + second;\n}\n`,
    );
  });

  it("control: a parameter used WHOLE anywhere disqualifies the whole parameter — no partial destructure", () => {
    expect(render(compile(`(define (f pair) (+ (car pair) (g pair)))`))).toBe(
      `function f(pair) {\n    return pair[0] + g(pair);\n}\n`,
    );
  });

  it("a param destructures the same way whether it is a top-level FnDecl or a bare/internal Arrow", () => {
    // Top-level `(define (f params…) body)` compiles straight to FnDecl (never an
    // Arrow) — a param-carrying shape distinct from the lambda case above, and one
    // materialize.ts must handle explicitly (FnDecl.params/.body get the SAME
    // treatment, not just Arrow.params/.body). This exercises the Arrow (bare-lambda)
    // side.
    // `(list 1 2)` folds to a literal array chunk (E2 ingestion fold, engine
    // plan §2 E2) — unrelated to the destructure decision this test pins.
    expect(render(compile(`((lambda (pair) (+ (car pair) (car (cdr pair)))) (list 1 2))`))).toBe(
      `(([first, second]) => first + second)([1, 2]);\n`,
    );
  });
});

describe("element-name singularization — now decided inside walk() (engine plan §2 E1a)", () => {
  it("multi-list map's fresh __item param renames to the receiver's singular ('examples' → 'example')", () => {
    // Single-list map forwards its callback verbatim (no fresh param ever minted —
    // see the control below); the multi-list zip is THIS wave's only path that
    // mints a generic callback param (`ctx.fresh("item")`, `mapEmitRule` in
    // foundations/arrival/arrival/src/env/r7rs/lists.ts) — exactly what
    // naming/census.ts's singularize gate improves. The index param (`i`) is left
    // alone: it has no natural name to derive from the collection.
    expect(render(compile(`(define (f examples others) (map combine examples others))`))).toBe(
      `function f(examples, others) {\n    return examples.map((example, __i) => combine(example, others[__i]));\n}\n`,
    );
  });

  it("control: a user-authored lambda param is never renamed (mapRule forwards a single-list callback as-is)", () => {
    const src = `(define (f examples) (map (lambda (x) x) examples))`;
    expect(render(compile(src))).toBe(`function f(examples) {\n    return examples.map(x => x);\n}\n`);
  });

  it("control: a receiver shape with no derivable name (e.g. a Cond, not a Ref/Call/Index/Member) leaves the generic param alone", () => {
    expect(render(compile(`(define (f c xs ys others) (map combine (if c xs ys) others))`))).toBe(
      `function f(c, xs, ys, others) {\n    return (c !== false ? xs : ys).map((__item, __i) => combine(__item, others[__i]));\n}\n`,
    );
  });
});

// ── leg 3: pure-region CSE (dissolved into a decision view + materializer, E2) ────

describe("sharedBindingsOf/materializeSharedBindings — pure-region common-subexpression elimination (constitution §3.5/§2.3)", () => {
  it("two identical pure calls dedupe to one Const, hoisted before the first use", () => {
    expect(emit(`(define (f x) (+ (g x) (g x)))`, (u) => sharedBindings(u, testRegistry))).toBe(
      `function f(x) {\n    const __g = g(x);\n    return __g + __g;\n}\n`,
    );
  });

  it("a sink-provenance call is NEVER deduped — even carrying cacheClass \"pure\" (the defensive veto)", () => {
    const src = `(define (f x) (+ (sinkop x) (sinkop x)))`;
    expect(emit(src, (u) => sharedBindings(u, testRegistry))).toBe(emit(src, (u) => u)); // unchanged
  });

  it("an infer pair dedupes — infer is cacheClass \"pure\" (constitution §2.3)", () => {
    expect(emit(`(define (f x) (+ (infer x) (infer x)))`, (u) => sharedBindings(u, testRegistry))).toBe(
      `function f(x) {\n    const __infer = infer(x);\n    return __infer + __infer;\n}\n`,
    );
  });

  it("a single occurrence never hoists (≥2 sites required)", () => {
    const src = `(define (f x) (g x))`;
    expect(emit(src, (u) => sharedBindings(u, testRegistry))).toBe(emit(src, (u) => u));
  });

  it("a registered symbol with no cacheClass declared at all is never eligible", () => {
    const src = `(define (f x) (+ (plainop x) (plainop x)))`;
    expect(emit(src, (u) => sharedBindings(u, testRegistry))).toBe(emit(src, (u) => u));
  });

  it("sharedBindingsOf's OWN decision is empty for a program with nothing to share (the identity fast-path)", () => {
    const view = sharedBindingsOf(compile(`(define (f x) (g x))`), testRegistry);
    expect(view.groups).toEqual([]);
    expect(materializeSharedBindings(view)).toBe(view.unit); // same reference — no rewrite performed
  });
});

// ── the composed pass (now: walk()'s own destructure/singularize + CSE view/materializer) ──

describe("legibility — the composed pass (walk()'s destructure/singularize + shared bindings)", () => {
  it("destructure alone can collapse a doubly-nested car composition sharing one root into a single slot", () => {
    // `(car (car pairs))` occurring twice: `cdrOffsetOf` does not recognize a
    // NESTED Index as a cdr-composition (only Ref-direct or Method("slice",…)
    // chains — naming/census.ts's own header), so only the INNER `(car pairs)` at
    // each occurrence qualifies (both at position 0) — `pairs` destructures to a
    // single `[head]` slot, and the (still-present) outer `head[0]` reads are
    // NOT further reachable by CSE (shared-bindings.ts's header: Call-only scope,
    // Index chains are out of this wave's scope) — a real, verified, non-obvious
    // interaction, not a hand-guessed no-op. `compile()` already produces the
    // destructured shape; the shared-bindings materializer is a no-op on top of
    // it here (no duplicate Call nodes survive the destructure).
    const src = `(define (f pairs) (+ (car (car pairs)) (car (car pairs))))`;
    const out = render(sharedBindings(compile(src), testRegistry));
    expect(out).toBe(`function f([head]) {\n    return head[0] + head[0];\n}\n`);
  });

  it("destructure + singularize compose: a destructured param is left alone by singularize (no double-rename)", () => {
    const src = `(define (f examples) (map (lambda (pair) (+ (car pair) (car (cdr pair)))) examples))`;
    const out = render(sharedBindings(compile(src), testRegistry));
    // The map here is single-list (mapEmitRule forwards the lambda as-is — no fresh
    // param minted), so singularize has nothing to touch; destructure still fires
    // on the callback's own `pair` parameter (naming/census.ts's destructure
    // precedence over singularize — see its `registerParams`).
    expect(out).toBe(
      `function f(examples) {\n    return examples.map(([first, second]) => first + second);\n}\n`,
    );
  });
});

// (The real-wiring / oracle-session describe lived here; it depended on the
// oracle package and was removed to keep this a pure compiler unit test — the
// destructure/singularize/CSE claims above cover the behavior.)
