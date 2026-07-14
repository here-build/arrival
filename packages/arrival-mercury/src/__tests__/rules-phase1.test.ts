/**
 * Phase-1 symbol rules — every rule through the REAL pipeline (parse → desugar →
 * classify → walk(withRules overlay) → render) to inline goldens (pinned
 * typescript@6.0.2 printer bytes: 4-space indent, LF, trailing newline), plus the
 * withRules overlay contract: table-first lookup, base enrichment, names union, the
 * Law-N witness gate, narrows carriage into the type-emit grammar's key set, and the
 * doorCategory seam.
 *
 * Fact-directed rules (`not`, `filter`) run in both regimes: facts absent → the Law-F
 * conservative form; `{ boolean: true }` on the ARGUMENT node (Law A — argument facts)
 * → the clean flip; read register → clean unconditionally (constitution §1).
 */
import { describe, expect, it } from "vitest";

import type { TypeFacts } from "@here.build/arrival/emit";

import {
  type App as CfApp,
  classify,
  type ClassifyResult,
  type CompilationUnit,
  type DefineFn,
  desugar,
  type EmitRegistry,
  type EmitRegistryRow,
  narrowsMembersOf,
  type NodeId,
  parseSexprs,
  phase1Rules,
  render,
  runtimeRefsOf,
  walk,
  WalkDoorError,
  type WalkOptions,
  withRules,
} from "../index.js";

// ── the registry under test: the Phase-1 table over an EMPTY base ─────────────────────

const EMPTY: EmitRegistry = { lookup: () => undefined, names: new Set<string>() };
const registry = withRules(EMPTY, phase1Rules);

const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));
const compile = (src: string, over: Partial<WalkOptions> = {}): CompilationUnit =>
  walk(cf(src), { registry, register: "run", ...over });
const emit = (src: string, over: Partial<WalkOptions> = {}): string => render(compile(src, over));

/** Pin facts on ONE positional argument of the define-body's head App (Law A —
 *  the rules' clean branches key on ARGUMENT facts, never result types). */
const emitWithArgFacts = (src: string, argIndex: number, argFacts: TypeFacts): string => {
  const classified = cf(src);
  const app = (classified.forms[0] as DefineFn).body[0] as CfApp;
  const id: NodeId = app.positionalArgs[argIndex]!.id;
  return render(walk(classified, { registry, register: "run", facts: new Map<NodeId, TypeFacts>([[id, argFacts]]) }));
};

// ── §2.1 representation collapse: car / cdr / cons ─────────────────────────────────────

describe("car / cdr / cons — syntax over the array representation (§4.3, Law U)", () => {
  it("car → xs[0], unconditionally (no guard, no shim, no mode)", () => {
    expect(emit(`(define (f xs) (car xs))`)).toBe(`function f(xs) {\n    return xs[0];\n}\n`);
  });

  it("cdr → xs.slice(1)", () => {
    expect(emit(`(define (f xs) (cdr xs))`)).toBe(`function f(xs) {\n    return xs.slice(1);\n}\n`);
  });

  it("cons → [x, ...xs] (the spread golden)", () => {
    expect(emit(`(define (f x xs) (cons x xs))`)).toBe(`function f(x, xs) {\n    return [x, ...xs];\n}\n`);
  });

  it("fixed-arity mis-call doors at compile time (totality, never a walker crash)", () => {
    expect(() => emit(`(define (f x) (cons x))`)).toThrow(WalkDoorError);
    expect(() => emit(`(define (f) (car))`)).toThrow(/wants exactly 1 argument/);
  });
});

// ── Law T: not ─────────────────────────────────────────────────────────────────────────

describe("not — Law T on the operand (§5.2)", () => {
  const src = `(define (f x) (not x))`;

  it("no facts → the exact-Scheme guard `x === false` (Law F)", () => {
    expect(emit(src)).toBe(`function f(x) {\n    return x === false;\n}\n`);
  });

  it("argFacts[0].boolean → the clean `!x` (the flip)", () => {
    expect(emitWithArgFacts(src, 0, { boolean: true })).toBe(`function f(x) {\n    return !x;\n}\n`);
  });

  it("read register → clean unconditionally (glass is never executed, §1)", () => {
    expect(emit(src, { register: "read" })).toBe(`function f(x) {\n    return !x;\n}\n`);
  });
});

// ── null? / pair? — total .length reads ───────────────────────────────────────────────

describe("null? / pair? — .length over the collapsed representation", () => {
  it("null? → xs.length === 0", () => {
    expect(emit(`(define (f xs) (null? xs))`)).toBe(`function f(xs) {\n    return xs.length === 0;\n}\n`);
  });

  it("pair? → xs.length > 0", () => {
    expect(emit(`(define (f xs) (pair? xs))`)).toBe(`function f(xs) {\n    return xs.length > 0;\n}\n`);
  });
});

// ── §7 one-number: + - * / — plain folds, no dispatch ─────────────────────────────────

describe("+ - * / — plain left folds (§7: the platform's arithmetic IS the semantics)", () => {
  it("+ variadic → flat left fold", () => {
    expect(emit(`(define (f a b c) (+ a b c))`)).toBe(`function f(a, b, c) {\n    return a + b + c;\n}\n`);
  });

  it("(+) → 0, (+ x) → x, (*) → 1 (fold identities, no operator node)", () => {
    expect(emit(`(define (f) (+))`)).toBe(`function f() {\n    return 0;\n}\n`);
    expect(emit(`(define (f a) (+ a))`)).toBe(`function f(a) {\n    return a;\n}\n`);
    expect(emit(`(define (f) (*))`)).toBe(`function f() {\n    return 1;\n}\n`);
  });

  it("* binary", () => {
    expect(emit(`(define (f a b) (* a b))`)).toBe(`function f(a, b) {\n    return a * b;\n}\n`);
  });

  it("- unary → negate; n-ary → left fold", () => {
    expect(emit(`(define (f a) (- a))`)).toBe(`function f(a) {\n    return -a;\n}\n`);
    expect(emit(`(define (f a b c) (- a b c))`)).toBe(`function f(a, b, c) {\n    return a - b - c;\n}\n`);
  });

  it("/ is plain JS division; unary is the R7RS reciprocal", () => {
    expect(emit(`(define (f a b) (/ a b))`)).toBe(`function f(a, b) {\n    return a / b;\n}\n`);
    expect(emit(`(define (f a) (/ a))`)).toBe(`function f(a) {\n    return 1 / a;\n}\n`);
  });

  it("nullary - and / door (R7RS wants ≥ 1 argument)", () => {
    expect(() => emit(`(define (f) (-))`)).toThrow(WalkDoorError);
    expect(() => emit(`(define (f) (/))`)).toThrow(WalkDoorError);
  });
});

// ── = — chained === ────────────────────────────────────────────────────────────────────

describe("= — chained === (natively correct under §7)", () => {
  it("2-ary → one Bin", () => {
    expect(emit(`(define (f a b) (= a b))`)).toBe(`function f(a, b) {\n    return a === b;\n}\n`);
  });

  it("n-ary → the And-chain a === b && b === c", () => {
    expect(emit(`(define (f a b c) (= a b c))`)).toBe(`function f(a, b, c) {\n    return a === b && b === c;\n}\n`);
  });
});

// ── operator-identity residuals: quotient / modulo (Appendix B) ───────────────────────

describe("quotient / modulo — fixed operator-identity algorithms", () => {
  it("quotient → Math.trunc(a / b), and truncates toward zero like Scheme", () => {
    const ts = emit(`(define (f a b) (quotient a b))`);
    expect(ts).toBe(`function f(a, b) {\n    return Math.trunc(a / b);\n}\n`);
    const f = new Function(`${ts}return f;`)() as (a: number, b: number) => number;
    expect(f(-7, 2)).toBe(-3); // scheme (quotient -7 2) = -3; a floor would give -4
  });

  it("modulo → ((a % n) + n) % n, sign-correct on negative operands (the modulo-neg golden)", () => {
    const ts = emit(`(define (f a n) (modulo a n))`);
    expect(ts).toBe(`function f(a, n) {\n    return (a % n + n) % n;\n}\n`);
    const f = new Function(`${ts}return f;`)() as (a: number, n: number) => number;
    expect(f(-7, 3)).toBe(2); // scheme (modulo -7 3) = 2; JS -7 % 3 = -1 (remainder, sign-of-dividend)
    expect(f(7, -3)).toBe(-2); // scheme (modulo 7 -3) = -2 (sign-of-divisor)
    expect(f(7, 3)).toBe(1); // agreeing signs unchanged
  });
});

// ── map — the arity bridge, sync-shaped always (Law W) ────────────────────────────────

describe("map — single-list .map / multi-list index-zip", () => {
  it("single list → xs.map(f) bare", () => {
    expect(emit(`(define (g f xs) (map f xs))`)).toBe(`function g(f, xs) {\n    return xs.map(f);\n}\n`);
  });

  it("multi-list → the index-zip arrow (the zip golden; drives off lists[0])", () => {
    expect(emit(`(define (g f xs ys) (map f xs ys))`)).toBe(
      `function g(f, xs, ys) {\n    return xs.map((__item, __i) => f(__item, ys[__i]));\n}\n`,
    );
  });

  it("three lists zip the same way", () => {
    expect(emit(`(define (g f xs ys zs) (map f xs ys zs))`)).toBe(
      `function g(f, xs, ys, zs) {\n    return xs.map((__item, __i) => f(__item, ys[__i], zs[__i]));\n}\n`,
    );
  });
});

// ── filter — Law T on the predicate's verdict ─────────────────────────────────────────

describe("filter — the Law-T predicate guard", () => {
  const src = `(define (g p xs) (filter p xs))`;

  it("no facts → the guard (x) => p(x) !== false (Scheme keeps everything except #f)", () => {
    expect(emit(src)).toBe(`function g(p, xs) {\n    return xs.filter(__x => p(__x) !== false);\n}\n`);
  });

  it("argFacts[0].boolean on the predicate → bare .filter(p)", () => {
    expect(emitWithArgFacts(src, 0, { boolean: true })).toBe(`function g(p, xs) {\n    return xs.filter(p);\n}\n`);
  });

  it("read register → bare .filter(p) unconditionally", () => {
    expect(emit(src, { register: "read" })).toBe(`function g(p, xs) {\n    return xs.filter(p);\n}\n`);
  });
});

// ── apply — the reduce/arity bridge ───────────────────────────────────────────────────

describe("apply — reduce bridge for operator folds, spread for the generic case", () => {
  it("(apply + xs) → the reduce with identity 0 (the apply-plus golden)", () => {
    const unit = compile(`(define (g xs) (apply + xs))`);
    expect(render(unit)).toBe(`function g(xs) {\n    return xs.reduce((__acc, __item) => __acc + __item, 0);\n}\n`);
    // The operator's RuntimeRef is CONSUMED by the bridge — no runtime import remains.
    expect(runtimeRefsOf(unit)).toEqual(new Set());
  });

  it("(apply * xs) → identity 1", () => {
    expect(emit(`(define (g xs) (apply * xs))`)).toBe(
      `function g(xs) {\n    return xs.reduce((__acc, __item) => __acc * __item, 1);\n}\n`,
    );
  });

  it("(apply f xs) generic → spread f(...xs) (the picked form — not f.apply(null, xs))", () => {
    expect(emit(`(define (g f xs) (apply f xs))`)).toBe(`function g(f, xs) {\n    return f(...xs);\n}\n`);
  });

  it("leading fixed args compose: (apply f a xs) → f(a, ...xs)", () => {
    expect(emit(`(define (g f a xs) (apply f a xs))`)).toBe(
      `function g(f, a, xs) {\n    return f(a, ...xs);\n}\n`,
    );
  });
});

// ── infer family — sync-shaped call surface (Law W) ───────────────────────────────────

describe("infer family — Call(RuntimeRef(verb), args), framework axis on the shim", () => {
  it("infer → infer(m, prompt) — sync-shaped, no await anywhere (Law W)", () => {
    const unit = compile(`(define (g m) (infer m "hi"))`);
    const ts = render(unit);
    expect(ts).toBe(`function g(m) {\n    return infer(m, "hi");\n}\n`);
    expect(ts).not.toContain("await");
    expect(runtimeRefsOf(unit)).toEqual(new Set(["infer"]));
  });

  it("kwargs ride as the ONE trailing options ObjectLit (walker collapse; the rule adds nothing)", () => {
    expect(emit(`(define (g m) (infer m "hi" :max-tokens 100))`)).toBe(
      `function g(m) {\n    return infer(m, "hi", { maxTokens: 100 });\n}\n`,
    );
  });

  it("family members ride the same rule; the raw RuntimeRef symbol awaits FRAME aliasing", () => {
    const unit = compile(`(define (g m ms) (infer/chat m ms))`);
    // `infer/chat` is NOT a legal JS identifier — the census is the seam FRAME will
    // alias through; the render pins today's (pre-FRAME) raw-symbol behavior.
    expect(runtimeRefsOf(unit)).toEqual(new Set(["infer/chat"]));
    expect(render(unit)).toBe(`function g(m, ms) {\n    return infer/chat(m, ms);\n}\n`);
  });
});

// ── withRules — the overlay contract ──────────────────────────────────────────────────

describe("withRules — table-first lookup, base enrichment, names union", () => {
  const baseRows = new Map<string, EmitRegistryRow>([
    ["car", { symbol: "car", capability: "«base»", kind: "rosetta", refPolicy: "shim", cacheClass: "pure" }],
    ["reverse", { symbol: "reverse", capability: "«base»", kind: "rosetta", refPolicy: "shim" }],
  ]);
  const base: EmitRegistry = { lookup: (n) => baseRows.get(n), names: new Set(baseRows.keys()) };
  const overlaid = withRules(base, phase1Rules);

  it("a table name wins the rule; base enrichment (capability/kind/cacheClass) survives", () => {
    const row = overlaid.lookup("car");
    expect(row?.emit).toBe(phase1Rules["car"]!.emit);
    expect(row?.capability).toBe("«base»");
    expect(row?.kind).toBe("rosetta");
    expect(row?.cacheClass).toBe("pure");
    // the table's refPolicy overrides the base's
    expect(row?.refPolicy).toBe("eta");
  });

  it("a base-only name passes through untouched (same row object)", () => {
    expect(overlaid.lookup("reverse")).toBe(baseRows.get("reverse"));
  });

  it("a table-only name synthesizes a row (capability «phase1-rules», kind native)", () => {
    const row = overlaid.lookup("modulo");
    expect(row?.capability).toBe("«phase1-rules»");
    expect(row?.kind).toBe("native");
    expect(row?.refPolicy).toBe("shim");
  });

  it("names is the union", () => {
    expect(overlaid.names.has("reverse")).toBe(true);
    expect(overlaid.names.has("modulo")).toBe(true);
    expect(overlaid.names.size).toBe(base.names.size + Object.keys(phase1Rules).length - 1); // "car" overlaps
  });

  it("a door-kind base row overlaid with a RULE stops dooring (kind flips to native)", () => {
    const doorBase: EmitRegistry = {
      lookup: (n) =>
        n === "car"
          ? { symbol: "car", capability: "«base»", kind: "door", refPolicy: "shim", doorReason: "no car yet" }
          : undefined,
      names: new Set(["car"]),
    };
    expect(withRules(doorBase, phase1Rules).lookup("car")?.kind).toBe("native");
  });
});

describe("withRules — narrows carriage (Law N) and the doorCategory seam", () => {
  it("table narrows surface on rows and feed the type-emit grammar's key set", () => {
    expect(registry.lookup("null?")?.narrows).toEqual({ witness: "null?" });
    expect(registry.lookup("pair?")?.narrows).toEqual({ witness: "pair?" });
    // narrowsMembersOf is the SAME reduction type-emit consumes (§5.3's NForm gate) —
    // overlay rows must be indistinguishable from Contract-carried ones here.
    expect(narrowsMembersOf(registry)).toEqual(new Set(["null?", "pair?"]));
  });

  it("an unregistered witness fails the overlay's Law-N gate (teaching throw)", () => {
    expect(() => withRules(EMPTY, { "foo?": { emit: phase1Rules["car"]!.emit, narrows: { witness: "bar?" } } })).toThrow(
      /witness "bar\?"/,
    );
  });

  it("doorCategory carries through to the row — the seam, applied to nothing yet", () => {
    const reg = withRules(EMPTY, { "set-car!": { doorCategory: "prohibited-dynamics" } });
    expect(reg.lookup("set-car!")?.doorCategory).toBe("prohibited-dynamics");
    expect(reg.names.has("set-car!")).toBe(true);
    // no Phase-1 entry sets it
    for (const name of Object.keys(phase1Rules)) {
      expect(registry.lookup(name)?.doorCategory).toBeUndefined();
    }
  });
});
