/**
 * ASYNC-IFY gate tests (constitution §5.2 Law W; async-await-plane.md). Everything runs
 * through the REAL pipeline — parse → desugar → classify → walk → asyncIfy → render —
 * against inline goldens (pinned typescript@6.0.2 printer bytes, matching walker.test.ts).
 *
 * The strict-compile check at the bottom is the "emitted text typechecks" gate the
 * mission asks for: a programmatic `ts.createProgram` over an in-memory file (no temp
 * file, no shell-out) with a `declare`d runtime preamble standing in for FRAME. It runs
 * with `noImplicitAny: false` (walker output has unannotated params) — the promise-flow
 * assertions survive that: return types still infer, so a missing `await` still turns
 * `string` into `Promise<string>` at a `string`-typed use and fails the check. The
 * negative control (the sync-shaped tree fails the same check) proves the teeth.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { EmitRule } from "@here.build/arrival/emit";

import { asyncIfy, AsyncIfyDoorError } from "../async-ify/index.js";
import { classify } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import type { EmitRegistry, EmitRegistryRow } from "../registry/index.js";
import { render } from "../residual/render.js";
import type { CompilationUnit, R } from "../residual/types.js";
import {
  ArrayLit,
  Bin,
  Binding,
  Block,
  Call,
  FnDecl,
  Method,
  Ref,
  Return,
  RuntimeRef,
} from "../residual/types.js";
import { walk } from "../walker/index.js";

// ── a hand-rolled registry (same convention as walker.test.ts) ────────────────────────

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

const hofRule = (method: string): EmitRule<R> => ({
  call: ([f, xs], ctx) =>
    f !== undefined && xs !== undefined ? Method(xs, method, [f]) : ctx.door(`${method} wants (fn xs)`),
});
const listRule: EmitRule<R> = { call: (args) => ArrayLit(args) };
const plusRule: EmitRule<R> = {
  call: (args, ctx) => (args.length === 2 ? Bin("+", args[0]!, args[1]!) : ctx.door("binary + wants exactly 2 args")),
};

const testRegistry = registryOf(
  row("infer"), // no emit rule → rung 3 shim: Call(RuntimeRef("infer"), args) — THE seed shape
  row("strlen"), // sync shim — the strict-compile test's string-consuming counterpart
  row("reverse"), // sync shim — identity fast-path fodder
  row("+", { emit: plusRule }),
  row("map", { emit: hofRule("map") }),
  row("filter", { emit: hofRule("filter") }),
  row("list", { emit: listRule }),
);

const SEEDS: ReadonlySet<string> = new Set(["infer"]);

const compile = (src: string): CompilationUnit =>
  walk(classify(desugar(parseSexprs(src))), { registry: testRegistry, register: "run" });
const asyncified = (src: string): CompilationUnit => asyncIfy(compile(src), { asyncSeeds: SEEDS });
const emit = (src: string): string => render(asyncified(src));

// ── plain insertion ────────────────────────────────────────────────────────────────────

describe("await insertion at value-consuming positions", () => {
  it("seed call in value position → awaited; enclosing FnDecl flips async", () => {
    expect(emit(`(define (f x) (infer x))`)).toBe(`async function f(x) {\n    return await infer(x);\n}\n`);
  });

  it("cascade through a helper: f calls the seed, g calls f → both async, g awaits f", () => {
    expect(emit(`(define (f x) (infer x)) (define (g y) (f y))`)).toBe(
      `async function f(x) {\n    return await infer(x);\n}\nasync function g(y) {\n    return await f(y);\n}\n`,
    );
  });

  it("argument position: the await lands INSIDE the outer call (no whole-node wrapping — C1)", () => {
    expect(emit(`(define (f s) (strlen (infer s)))`)).toBe(
      `async function f(s) {\n    return strlen(await infer(s));\n}\n`,
    );
  });

  it("top-level seed call awaits with no enclosing def (module top level is TLA-legal)", () => {
    expect(emit(`(infer "q")`)).toBe(`await infer("q");\n`);
  });

  it("Cond joins its branches — Promise<T>|T just awaits, once, around the whole conditional", () => {
    expect(emit(`(define (f p x) (if p (infer x) "n"))`)).toBe(
      `async function f(p, x) {\n    return await (p !== false ? infer(x) : "n");\n}\n`,
    );
  });

  it("guarded and-chain: the await lands once, at the guard temp's Const init", () => {
    expect(emit(`(define (f x y) (and (infer x) y))`)).toBe(
      `async function f(x, y) {\n    const __and = await infer(x);\n    return __and === false ? __and : y;\n}\n`,
    );
  });

  it("value-position Block gains an Await → the renderer synthesizes an async IIFE, awaited inline", () => {
    expect(emit(`(define (f x y) (+ 1 (and (infer x) y)))`)).toBe(
      `async function f(x, y) {\n    return 1 + await (async () => {\n        const __and = await infer(x);\n        return __and === false ? __and : y;\n    })();\n}\n`,
    );
  });
});

// ── the rewrite table ──────────────────────────────────────────────────────────────────

describe("rewrite table", () => {
  it("map with an async callback → await Promise.all(xs.map(async …)) — the golden", () => {
    expect(emit(`(define (f xs) (map (lambda (x) (infer x)) xs))`)).toBe(
      `async function f(xs) {\n    return await Promise.all(xs.map(async (x) => await infer(x)));\n}\n`,
    );
  });

  it("ArrayLit of two independent seed calls → ONE Promise.all (§2.3 by-right parallelization)", () => {
    expect(emit(`(define (f x y) (list (infer x) (infer y)))`)).toBe(
      `async function f(x, y) {\n    return await Promise.all([infer(x), infer(y)]);\n}\n`,
    );
  });

  it("a single promise sibling does NOT batch — plain element-wise await", () => {
    expect(emit(`(define (f x y) (list (infer x) y))`)).toBe(
      `async function f(x, y) {\n    return [await infer(x), y];\n}\n`,
    );
  });

  it("filter with a promise-typed predicate is a door, not silently-wrong output", () => {
    expect(() => asyncified(`(define (f xs) (filter (lambda (x) (infer x)) xs))`)).toThrow(AsyncIfyDoorError);
    expect(() => asyncified(`(define (f xs) (filter (lambda (x) (infer x)) xs))`)).toThrow(
      /filter-async-predicate/,
    );
  });
});

// ── the over-await fallback (Mechanics 7) ─────────────────────────────────────────────

describe("unknown edges over-await", () => {
  it("a call through a function parameter is unknown → awaited; the enclosing def flips async", () => {
    expect(emit(`(define (callit f x) (f x)) (define (h x) (callit (lambda (y) (infer y)) x))`)).toBe(
      `async function callit(f, x) {\n    return await f(x);\n}\n` +
        `async function h(x) {\n    return await callit(async (y) => await infer(y), x);\n}\n`,
    );
  });
});

// ── promiseWrap at the Law V join point (Mechanics 8) ─────────────────────────────────

describe("promiseWrap on flipped definitions", () => {
  it("a flipped FnDecl's returnType wraps in Promise<…> — the Scheme type itself never carries async", () => {
    const x = Binding("x");
    const unit: CompilationUnit = {
      decls: [
        FnDecl(Binding("f"), [x], Block([Return(Call(RuntimeRef("infer"), [Ref(x)]))]), {
          returnType: { k: "array", el: { k: "prim", name: "string" } },
        }),
      ],
      body: [],
    };
    expect(render(asyncIfy(unit, { asyncSeeds: SEEDS }))).toBe(
      `async function f(x): Promise<string[]> {\n    return await infer(x);\n}\n`,
    );
  });
});

// ── purity + identity ─────────────────────────────────────────────────────────────────

describe("purity and the identity fast-path", () => {
  it("no seed fires → the SAME unit reference comes back, and the render carries no asyncness", () => {
    const unit = compile(`(define (f xs) (reverse xs)) (define (g xs) (f xs))`);
    const out = asyncIfy(unit, { asyncSeeds: SEEDS });
    expect(out).toBe(unit);
    const text = render(out);
    expect(text).not.toContain("async");
    expect(text).not.toContain("await");
  });

  it("empty seed set → identity, even when the program calls runtime shims", () => {
    const unit = compile(`(define (f x) (infer x))`);
    expect(asyncIfy(unit, { asyncSeeds: new Set<string>() })).toBe(unit);
  });

  it("the input unit is never mutated (pure function: unit → unit)", () => {
    const unit = compile(`(define (f x) (infer x)) (define (g y) (f y))`);
    const before = structuredClone(unit);
    asyncIfy(unit, { asyncSeeds: SEEDS });
    expect(unit).toEqual(before);
  });

  it("Law W input contract: a pre-existing Await is refused loudly", () => {
    const unit = compile(`(define (f x) (infer x))`);
    const once = asyncIfy(unit, { asyncSeeds: SEEDS });
    expect(() => asyncIfy(once, { asyncSeeds: SEEDS })).toThrow(/law-w\/input-not-sync-shaped/);
  });
});

// ── the strict-compile gate ───────────────────────────────────────────────────────────

/** Typecheck one in-memory source against the real es2022 lib (constitutionally pinned
 *  typescript@6.0.2 from this package's own deps). `noImplicitAny` off — see header. */
function strictDiagnostics(source: string): readonly string[] {
  const fileName = "/async-ify-check.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    noImplicitAny: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ["lib.es2022.d.ts"],
    types: [],
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options, true);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (f) => f === fileName || baseFileExists(f);
  host.readFile = (f) => (f === fileName ? source : baseReadFile(f));
  host.getSourceFile = (f, languageVersion, onError, shouldCreateNew) =>
    f === fileName
      ? ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true)
      : baseGetSourceFile(f, languageVersion, onError, shouldCreateNew);
  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

// The FRAME stand-in: precise promise-shaped declares, so a missing await is a TYPE error
// (string-consuming `strlen` meets `Promise<string>`), not just a style miss.
const PREAMBLE = `declare function infer(prompt: string): Promise<string>;\ndeclare function strlen(s: string): number;\n`;

const CHECK_PROGRAM = `
(define (classify s) (infer s))
(define (both a b) (list (infer a) (classify b)))
(define (lens s) (strlen (classify s)))
(define (all xs) (map (lambda (x) (infer x)) xs))
`;

describe("render() output typechecks under tsc --strict", () => {
  it("the asyncified artifact has zero diagnostics", () => {
    expect(strictDiagnostics(PREAMBLE + emit(CHECK_PROGRAM))).toEqual([]);
  });

  it("negative control: the sync-shaped (pre-pass) tree FAILS the same check", () => {
    const syncText = render(compile(CHECK_PROGRAM));
    expect(strictDiagnostics(PREAMBLE + syncText)).not.toEqual([]);
  });
});
