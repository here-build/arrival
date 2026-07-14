/**
 * LEGIBILITY gate tests (constitution §3.5's third invention; ../legibility/).
 * Fast unit-style tests run the walker directly against a hand-rolled registry
 * (same convention as async-ify.test.ts/walker.test.ts — real Phase-1 rules are
 * extracted from `phase1Rules` where a golden needs their exact residual shape,
 * e.g. car/cdr/map). The final `describe` runs the REAL wiring
 * (`compileGreenfield`, one shared `OracleSession` per the oracle-harness's §4.1
 * reuse contract) to verify the pre-ASYNC-IFY placement against the actual
 * harvested `infer` capability, oracle-agreement included.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";

import type { EmitRegistry, EmitRegistryRow } from "../registry/index.js";
import { render } from "../residual/render.js";
import type { CompilationUnit } from "../residual/types.js";
import { phase1Rules } from "../rules/index.js";
import { walk } from "../walker/index.js";
import { classify } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { compileGreenfield, openOracleSession, runOracle, type OracleSession } from "../oracle/harness.js";
import { destructureParams } from "../legibility/destructure.js";
import { singularizeHofParams } from "../legibility/singularize.js";
import { pureRegionCse } from "../legibility/cse.js";
import { legibility } from "../legibility/legibility.js";

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

// car/cdr/map ride the REAL Phase-1 rules (phase1.ts) so the residual shapes this
// suite destructures/singularizes/dedupes against are exactly what the gate-
// authoritative pipeline itself produces — never a hand-approximated stand-in.
const testRegistry = registryOf(
  row("car", { emit: phase1Rules.car!.emit }),
  row("cdr", { emit: phase1Rules.cdr!.emit }),
  row("+", { emit: phase1Rules["+"]!.emit }),
  row("map", { emit: phase1Rules.map!.emit }),
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

// ── leg 1: implicit destruction ───────────────────────────────────────────────────

describe("destructureParams — implicit destruction (constitution §3.5)", () => {
  it("THE constitution example: a param used only through car/cdr-composed positional access destructures to [first, second]", () => {
    // The constitution spells the second access `(cadr pair)`; `cadr` is not yet a
    // registered symbol in this slice (registry/harvest.ts's own comment — the
    // generative cxr composition rung is future work), so this exercises the
    // semantically-identical `(car (cdr pair))` spelling that THIS slice's
    // registered rules actually produce — destructure.ts's `cdrOffsetOf` resolves
    // either spelling to the same tuple position (see its own header).
    expect(emit(`(define (f pair) (+ (car pair) (car (cdr pair))))`, destructureParams)).toBe(
      `function f([first, second]) {\n    return first + second;\n}\n`,
    );
  });

  it("control: a parameter used WHOLE anywhere disqualifies the whole parameter — no partial destructure", () => {
    const src = `(define (f pair) (+ (car pair) (g pair)))`;
    expect(emit(src, destructureParams)).toBe(emit(src, (u) => u)); // byte-identical to no-op
  });

  it("a param destructures the same way whether it is a top-level FnDecl or a bare/internal Arrow", () => {
    // Top-level `(define (f params…) body)` compiles straight to FnDecl (never an
    // Arrow) — a param-carrying shape distinct from the lambda case above, and one
    // this leg must handle explicitly (FnDecl.params/.body get the SAME treatment,
    // not just Arrow.params/.body). This exercises the Arrow (bare-lambda) side.
    expect(emit(`((lambda (pair) (+ (car pair) (car (cdr pair)))) (list 1 2))`, destructureParams)).toBe(
      `(([first, second]) => first + second)(list(1, 2));\n`,
    );
  });
});

// ── leg 2: element-name singularization ───────────────────────────────────────────

describe("singularizeHofParams — element-name singularization (constitution §3.5)", () => {
  it("multi-list map's fresh __item param renames to the receiver's singular ('examples' → 'example')", () => {
    // Single-list map forwards its callback verbatim (no fresh param ever minted —
    // see the control below); the multi-list zip is THIS wave's only path that
    // mints a generic callback param (`freshBinding(ctx, "item")`, mapRule in
    // phase1.ts) — exactly what this leg improves. The index param (`__i`) is left
    // alone: it has no natural name to derive from the collection.
    expect(emit(`(define (f examples others) (map combine examples others))`, singularizeHofParams)).toBe(
      `function f(examples, others) {\n    return examples.map((example, __i) => combine(example, others[__i]));\n}\n`,
    );
  });

  it("control: a user-authored lambda param is never renamed (mapRule forwards a single-list callback as-is)", () => {
    const src = `(define (f examples) (map (lambda (x) x) examples))`;
    expect(emit(src, singularizeHofParams)).toBe(emit(src, (u) => u)); // byte-identical to no-op
  });

  it("control: a receiver shape with no derivable name (e.g. a Cond, not a Ref/Call/Index/Member) leaves the generic param alone", () => {
    const src = `(define (f c xs ys others) (map combine (if c xs ys) others))`;
    expect(emit(src, singularizeHofParams)).toBe(emit(src, (u) => u));
  });
});

// ── leg 3: pure-region CSE ─────────────────────────────────────────────────────────

describe("pureRegionCse — pure-region common-subexpression elimination (constitution §3.5/§2.3)", () => {
  it("two identical pure calls dedupe to one Const, hoisted before the first use", () => {
    expect(emit(`(define (f x) (+ (g x) (g x)))`, (u) => pureRegionCse(u, testRegistry))).toBe(
      `function f(x) {\n    const __g = g(x);\n    return __g + __g;\n}\n`,
    );
  });

  it("a sink-provenance call is NEVER deduped — even carrying cacheClass \"pure\" (the defensive veto)", () => {
    const src = `(define (f x) (+ (sinkop x) (sinkop x)))`;
    expect(emit(src, (u) => pureRegionCse(u, testRegistry))).toBe(emit(src, (u) => u)); // unchanged
  });

  it("an infer pair dedupes — infer is cacheClass \"pure\" (constitution §2.3)", () => {
    expect(emit(`(define (f x) (+ (infer x) (infer x)))`, (u) => pureRegionCse(u, testRegistry))).toBe(
      `function f(x) {\n    const __infer = infer(x);\n    return __infer + __infer;\n}\n`,
    );
  });

  it("a single occurrence never hoists (≥2 sites required)", () => {
    const src = `(define (f x) (g x))`;
    expect(emit(src, (u) => pureRegionCse(u, testRegistry))).toBe(emit(src, (u) => u));
  });

  it("a registered symbol with no cacheClass declared at all is never eligible", () => {
    const src = `(define (f x) (+ (plainop x) (plainop x)))`;
    expect(emit(src, (u) => pureRegionCse(u, testRegistry))).toBe(emit(src, (u) => u));
  });
});

// ── the composed pass ──────────────────────────────────────────────────────────────

describe("legibility — the composed pass (destructure → singularize → CSE)", () => {
  it("destructure alone can collapse a doubly-nested car composition sharing one root into a single slot", () => {
    // `(car (car pairs))` occurring twice: `cdrOffsetOf` does not recognize a
    // NESTED Index as a cdr-composition (only Ref-direct or Method("slice",…)
    // chains — destructure.ts's own header), so only the INNER `(car pairs)` at
    // each occurrence qualifies (both at position 0) — `pairs` destructures to a
    // single `[head]` slot, and the (still-present) outer `head[0]` reads are
    // NOT further reachable by CSE (cse.ts's header: Call-only scope, Index
    // chains are out of this wave's scope) — a real, verified, non-obvious
    // interaction between the two legs, not a hand-guessed no-op.
    const src = `(define (f pairs) (+ (car (car pairs)) (car (car pairs))))`;
    const out = render(legibility(compile(src), { registry: testRegistry }));
    expect(out).toBe(`function f([head]) {\n    return head[0] + head[0];\n}\n`);
  });

  it("destructure + singularize compose: a destructured param is left alone by singularize (no double-rename)", () => {
    const src = `(define (f examples) (map (lambda (pair) (+ (car pair) (car (cdr pair)))) examples))`;
    const out = render(legibility(compile(src), { registry: testRegistry }));
    // The map here is single-list (passableFn forwards the lambda as-is — no fresh
    // param minted), so singularize has nothing to touch; destructure still fires
    // on the callback's own `pair` parameter.
    expect(out).toBe(
      `function f(examples) {\n    return examples.map(([first, second]) => first + second);\n}\n`,
    );
  });
});

// ── the real wiring: compileGreenfield (constitution §9's dual-path rule) ─────────

describe("legibility wired into compileGreenfield — the real pipeline, oracle session", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
  });

  it("an infer pair dedupes THROUGH the real ASYNC-IFY plane: one await, two sync Ref reads", () => {
    // The load-bearing golden for the pipeline-ordering decision (legibility.ts's
    // header): CSE runs pre-ASYNC-IFY, hoisting the duplicate infer call into an
    // ordinary sync-shaped Const BEFORE asyncness exists — ASYNC-IFY then awaits
    // that ONE Const's init exactly like any other seeded call, and both reads
    // are plain (unconditionally-sync) Refs. If this ever regresses to two
    // separate `await infer(...)` calls, the ordering decision broke.
    const out = compileGreenfield(session, `(define (f x) (+ (infer "sys" x) (infer "sys" x))) (f "hi")`);
    expect(out).toBe(
      `import { infer } from "./stage0.mts";\n` +
        `async function OracleMain() {\n` +
        `    const f = async (x) => {\n` +
        `        const __infer = await infer("sys", x);\n` +
        `        return __infer + __infer;\n` +
        `    };\n` +
        `    return await f("hi");\n` +
        `}\n` +
        `export { __oracleResult };\n` +
        `const __oracleResult = await OracleMain();\n`,
    );
  });

  it("a destructured tuple access agrees with the interpreter (oracle-verified, not just pretty)", async () => {
    const src = `((lambda (pair) (+ (car pair) (car (cdr pair)))) (list 10 20))`;
    expect(compileGreenfield(session, src)).toContain("([first, second]) => first + second");
    const verdict = await runOracle(session, src);
    expect(verdict.agree, verdict.detail).toBe(true);
  });

  it("an unrelated program is untouched — no false singularize/CSE noise", () => {
    const out = compileGreenfield(session, `(map (lambda (x) (* x x)) (list 1 2 3))`);
    expect(out).toBe(
      `import { list } from "./stage0.mts";\n` +
        `function OracleMain() {\n` +
        `    return list(1, 2, 3).map(x => x * x);\n` +
        `}\n` +
        `export { __oracleResult };\n` +
        `const __oracleResult = OracleMain();\n`,
    );
  });
});
