/**
 * ASYNCNESS gate tests (constitution §5.2 Law W; async-await-plane.md; engine
 * plan §2 E1c). Ported verbatim from the dissolved `async-ify.test.ts` — same
 * goldens, same coverage, new call shape: `asyncnessOf` (the view) feeds
 * `materializeAsyncness` (the mechanical rewrite) instead of one combined
 * `asyncIfy` call. Everything runs through the REAL pipeline — parse →
 * desugar → classify → walk → asyncnessOf → materializeAsyncness → render —
 * against inline goldens (pinned typescript@6.0.2 printer bytes, matching
 * walker.test.ts).
 *
 * The strict-compile check at the bottom is the "emitted text typechecks" gate
 * the mission asks for: a programmatic `ts.createProgram` over an in-memory
 * file (no temp file, no shell-out) with a `declare`d runtime preamble
 * standing in for FRAME. It runs with `noImplicitAny: false` (walker output
 * has unannotated params) — the promise-flow assertions survive that: return
 * types still infer, so a missing `await` still turns `string` into
 * `Promise<string>` at a `string`-typed use and fails the check. The negative
 * control (the sync-shaped tree fails the same check) proves the teeth.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { EmitRule } from "@here.build/arrival/emit";

import { classify } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { AsyncnessDoorError, asyncnessOf, materializeAsyncness } from "../naming/index.js";
import type { EmitRegistry, EmitRegistryRow } from "../registry/index.js";
import { render } from "../residual/render.js";
import type { CompilationUnit, R } from "../residual/types.js";
import {
  ArrayLit,
  Arrow,
  Bin,
  Binding,
  Block,
  Call,
  Const,
  ConstDecl,
  FnDecl,
  Lit,
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
const asyncified = (src: string): CompilationUnit => materializeAsyncness(asyncnessOf(compile(src), SEEDS));
const emit = (src: string): string => render(asyncified(src));

// ── plain insertion ────────────────────────────────────────────────────────────────────

describe("await insertion at value-consuming positions", () => {
  // R-G3 (gate3-human-grade-rulings.md): a bare tail return of a promise-typed
  // value needs neither `await` nor `async` — `f` still returns a promise to
  // its own callers (facts.arrowAsync stays true, exercised indirectly by the
  // NEXT test's cascade), it just no longer spells out the keyword to do it.
  it("seed call in TAIL position → neither async nor await (R-G3); a plain pass-through", () => {
    expect(emit(`(define (f x) (infer x))`)).toBe(`function f(x) {\n    return infer(x);\n}\n`);
  });

  it("cascade through a helper: f and g are BOTH pass-throughs (R-G3) — g still forwards f's promise untouched", () => {
    expect(emit(`(define (f x) (infer x)) (define (g y) (f y))`)).toBe(
      `function f(x) {\n    return infer(x);\n}\nfunction g(y) {\n    return f(y);\n}\n`,
    );
  });

  // R-G3 KEEP case: `strlen(...)` reads THROUGH infer's resolved value (a
  // further call argument, the ruling's own example of what must NOT elide)
  // — this await sits inside a Call's arg list, never the bare tail value
  // consumeTail inspects, so it is untouched and `f` stays async.
  it("argument position: the await lands INSIDE the outer call (no whole-node wrapping — C1)", () => {
    expect(emit(`(define (f s) (strlen (infer s)))`)).toBe(
      `async function f(s) {\n    return strlen(await infer(s));\n}\n`,
    );
  });

  it("top-level seed call awaits with no enclosing def (module top level is TLA-legal)", () => {
    expect(emit(`(infer "q")`)).toBe(`await infer("q");\n`);
  });

  it("Cond joins its branches at a TAIL position — R-G3 elides the join's own await too", () => {
    expect(emit(`(define (f p x) (if p (infer x) "n"))`)).toBe(
      `function f(p, x) {\n    return p !== false ? infer(x) : "n";\n}\n`,
    );
  });

  // R-G3 KEEP case: the Const init is not a tail position (its value is read
  // back TWICE by the guard's own Cond, `__and === false ? __and : y`) — a
  // genuinely-consumed await, untouched by consumeTail. The RETURN itself
  // (`__and === false ? __and : y`) is already a plain Cond of two Refs
  // (always sync — see makeRewriter's boxed note), so there was never a
  // tail-position await here to elide in the first place.
  it("guarded and-chain: the await lands once, at the guard temp's Const init", () => {
    expect(emit(`(define (f x y) (and (infer x) y))`)).toBe(
      `async function f(x, y) {\n    const __and = await infer(x);\n    return __and === false ? __and : y;\n}\n`,
    );
  });

  // R-G3 KEEP case: the await is a Bin ("+") operand (arithmetic, the
  // ruling's own example of what must NOT elide) — untouched, and the
  // render-time async-IIFE synthesis (residual/render.ts, out of R-G3's
  // boundary) is unaffected since asyncness.ts never wraps a Block itself.
  it("value-position Block gains an Await → the renderer synthesizes an async IIFE, awaited inline", () => {
    expect(emit(`(define (f x y) (+ 1 (and (infer x) y)))`)).toBe(
      `async function f(x, y) {\n    return 1 + await (async () => {\n        const __and = await infer(x);\n        return __and === false ? __and : y;\n    })();\n}\n`,
    );
  });

  // R-G3 dedicated KEEP case (task's own named example): `const y = await
  // f(); return y + 1;` — the resolved value is read back arithmetically, so
  // the Const-init await must survive even though it sits directly above a
  // trailing Return. Exercises a hand-built tree (not source-level `let`)
  // to pin the EXACT shape without depending on the front-end's own
  // desugaring choice for `let`.
  it("KEEP: a Const-bound await consumed by later arithmetic is never elided, even directly above a Return", () => {
    const s = Binding("s");
    const y = Binding("y");
    const unit: CompilationUnit = {
      decls: [
        FnDecl(Binding("f"), [s], Block([Const(y, Call(RuntimeRef("infer"), [Ref(s)])), Return(Bin("+", Ref(y), Lit(1)))])),
      ],
      body: [],
    };
    expect(render(materializeAsyncness(asyncnessOf(unit, SEEDS)))).toBe(
      `async function f(s) {\n    const y = await infer(s);\n    return y + 1;\n}\n`,
    );
  });

  // R-G3 dedicated ELIDE case: an Arrow with a BLOCK body whose sole
  // statement is `return await E;` — the ruling's own explicit "{ return
  // await E }" shape, distinct from the expression-body case every OTHER
  // test in this file exercises. Hand-built: no current source-level shape
  // produces a Block-bodied Arrow via the front end.
  it("ELIDE: an Arrow with a Block body whose sole statement is `return await E` drops both", () => {
    const x = Binding("x");
    const unit: CompilationUnit = {
      decls: [
        ConstDecl(
          Binding("f"),
          Arrow([x], Block([Return(Call(RuntimeRef("infer"), [Ref(x)]))])),
        ),
      ],
      body: [],
    };
    expect(render(materializeAsyncness(asyncnessOf(unit, SEEDS)))).toBe(`const f = x => {\n    return infer(x);\n};\n`);
  });

  // R-G3 dedicated KEEP case at Arrow level (mirrors the FnDecl-level
  // guarded/arithmetic KEEP cases above, but for an Arrow whose OWN body
  // consumes the promise arithmetically rather than merely returning it) —
  // proves the elision is shape-restricted at the Arrow level too, not just
  // for FnDecl. `f` itself stays a plain pass-through (constructing a
  // closure is always sync — makeRewriter's Arrow row); the RETURNED
  // closure independently keeps async+await for its own arithmetic.
  it("KEEP at Arrow level: arithmetic on the awaited value keeps both async and await", () => {
    expect(emit(`(define (f x) (lambda (y) (+ 1 (infer y))))`)).toBe(
      `function f(x) {\n    return async (y) => 1 + await infer(y);\n}\n`,
    );
  });
});

// ── the rewrite table ──────────────────────────────────────────────────────────────────

describe("rewrite table", () => {
  // R-G3's OWN worked example (gate3-human-grade-rulings.md): the map
  // collapse still fires exactly as before (the golden's REWRITE mechanism
  // is unchanged — see async-await-plane.md Mechanics 3), but BOTH the
  // callback's `async (x) => await infer(x)` and the outer `await
  // Promise.all(...)` sit at tail positions now elided — a plain map/filter
  // pass-through, matching the target's own "reads like a human wrote it".
  it("map with an async callback → Promise.all(xs.map(...)) — the R-G3 golden, both tail awaits elided", () => {
    expect(emit(`(define (f xs) (map (lambda (x) (infer x)) xs))`)).toBe(
      `function f(xs) {\n    return Promise.all(xs.map(x => infer(x)));\n}\n`,
    );
  });

  it("ArrayLit of two independent seed calls → ONE Promise.all (§2.3 by-right parallelization), tail-elided (R-G3)", () => {
    expect(emit(`(define (f x y) (list (infer x) (infer y)))`)).toBe(
      `function f(x, y) {\n    return Promise.all([infer(x), infer(y)]);\n}\n`,
    );
  });

  // R-G3 KEEP case: the lone `await infer(x)` sits as ONE element of a
  // two-element ArrayLit (`[await infer(x), y]`) — the RETURNED value is the
  // ArrayLit itself, never a bare Await, so there is nothing at the tail for
  // consumeTail to strip; `f` correctly stays async.
  it("a single promise sibling does NOT batch — plain element-wise await (unaffected by R-G3: not a bare tail Await)", () => {
    expect(emit(`(define (f x y) (list (infer x) y))`)).toBe(
      `async function f(x, y) {\n    return [await infer(x), y];\n}\n`,
    );
  });

  it("filter with a promise-typed predicate is a door, not silently-wrong output", () => {
    expect(() => asyncified(`(define (f xs) (filter (lambda (x) (infer x)) xs))`)).toThrow(AsyncnessDoorError);
    expect(() => asyncified(`(define (f xs) (filter (lambda (x) (infer x)) xs))`)).toThrow(
      /filter-async-predicate/,
    );
  });
});

// ── the over-await fallback (Mechanics 7) ─────────────────────────────────────────────

describe("unknown edges over-await", () => {
  // R-G3: the "unknown" over-await fallback (Mechanics 7) composes with the
  // tail elision exactly like a known-promise callee does — `callit`'s own
  // `f(x)` was an "unknown → over-await" edge before this ruling; it is now
  // ALSO a bare tail return, so it elides just the same. `callit` still
  // returns a promise to `h` (facts.arrowAsync unaffected — see model.ts's
  // own consumer, unchanged), it just never spells `await`/`async` to do it.
  it("a call through a function parameter is unknown, at a TAIL position → still elides (R-G3); callit/h are both pass-throughs", () => {
    expect(emit(`(define (callit f x) (f x)) (define (h x) (callit (lambda (y) (infer y)) x))`)).toBe(
      `function callit(f, x) {\n    return f(x);\n}\n` + `function h(x) {\n    return callit(y => infer(y), x);\n}\n`,
    );
  });
});

// ── promiseWrap at the Law V join point (Mechanics 8) ─────────────────────────────────

describe("promiseWrap on flipped definitions", () => {
  // R-G3: `f`'s own body is a bare tail return (test 1's exact shape) — it
  // no longer carries `async`/`await` at all, but `returnType` still wraps
  // in `Promise<…>`: promiseWrap reads facts.arrowAsync ("does calling f
  // yield a promise"), which R-G3 leaves unchanged, NOT the printing
  // decision. A non-async function declared to return a Promise is exactly
  // the shape a human writes for a pass-through wrapper.
  it("a flipped FnDecl's returnType wraps in Promise<…> even with no async keyword left to carry it", () => {
    const x = Binding("x");
    const unit: CompilationUnit = {
      decls: [
        FnDecl(Binding("f"), [x], Block([Return(Call(RuntimeRef("infer"), [Ref(x)]))]), {
          returnType: { k: "array", el: { k: "prim", name: "string" } },
        }),
      ],
      body: [],
    };
    expect(render(materializeAsyncness(asyncnessOf(unit, SEEDS)))).toBe(
      `function f(x): Promise<string[]> {\n    return infer(x);\n}\n`,
    );
  });
});

// ── purity + identity ─────────────────────────────────────────────────────────────────

describe("purity and the identity fast-path", () => {
  it("no seed fires → the SAME unit reference comes back, and the render carries no asyncness", () => {
    const unit = compile(`(define (f xs) (reverse xs)) (define (g xs) (f xs))`);
    const out = materializeAsyncness(asyncnessOf(unit, SEEDS));
    expect(out).toBe(unit);
    const text = render(out);
    expect(text).not.toContain("async");
    expect(text).not.toContain("await");
  });

  it("empty seed set → identity, even when the program calls runtime shims", () => {
    const unit = compile(`(define (f x) (infer x))`);
    expect(materializeAsyncness(asyncnessOf(unit, new Set<string>()))).toBe(unit);
  });

  it("the input unit is never mutated (pure function: unit → unit)", () => {
    const unit = compile(`(define (f x) (infer x)) (define (g y) (f y))`);
    const before = structuredClone(unit);
    materializeAsyncness(asyncnessOf(unit, SEEDS));
    expect(unit).toEqual(before);
  });

  // R-G3 changed this test's SOURCE (not its intent): `(define (f x) (infer
  // x))` used to leave a real `Await`/`async: true` behind after
  // materialization — the exact trace this test re-feeds to prove Law W's
  // re-entrancy guard fires. Under R-G3 that program now fully elides (a
  // bare tail return, test 1 above), so materializing it TWICE would no
  // longer carry any asyncness to detect — indistinguishable from a program
  // that was never processed at all, not a Law-W violation. `strlen(infer
  // s)` (the argument-position KEEP case, unaffected by R-G3) still leaves
  // a genuine `Await` and `async: true` behind, so it still proves the gate.
  it("Law W input contract: a pre-existing Await is refused loudly", () => {
    const unit = compile(`(define (f s) (strlen (infer s)))`);
    const once = materializeAsyncness(asyncnessOf(unit, SEEDS));
    expect(() => asyncnessOf(once, SEEDS)).toThrow(/law-w\/input-not-sync-shaped/);
  });
});

// ── the strict-compile gate ───────────────────────────────────────────────────────────

/** Typecheck one in-memory source against the real es2022 lib (constitutionally pinned
 *  typescript@6.0.2 from this package's own deps). `noImplicitAny` off — see header. */
function strictDiagnostics(source: string): readonly string[] {
  const fileName = "/asyncness-check.ts";
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
