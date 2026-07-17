/**
 * The hybrid tree's hard side — E2 gate tests (engine plan §1 S1/S2, §2 E2;
 * docs/working-proposals/arrival-mercury/e2-substrate-evidence.md). Three
 * layers, matching the substrate's own seams:
 *
 *  - `residual/render.ts`'s chunk mechanics — verbatim vs substituted
 *    printing, the mutual-recursion rule ("never assume chunks are leaves"),
 *    and the expression/statement duality — exercised directly against
 *    hand-built `ChunkExpr`/`ChunkStmt` values (mirrors residual-render.test.ts's
 *    own per-constructor style).
 *  - `walker/walk.ts`'s ingestion fold (S2) — quoted data and `list` calls
 *    folding to chunks, the call-free slot-safety gate (`isCallFree`)
 *    aborting exactly where it should, and `runtimeRefsOf` seeing through a
 *    slot for the import census (mirrors walker.test.ts's own hand-rolled
 *    registry style).
 *  - Oracle agreement over the real session — the gate this wave answers to
 *    (values byte-strict, never bytes).
 */
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classify } from "../coreform/index.js";
import type { ClassifyResult } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { asyncnessOf, materializeAsyncness } from "../naming/asyncness.js";
import { compileGreenfield, openOracleSession, runOracle, type OracleSession } from "../oracle/harness.js";
import type { EmitRule } from "@inhuman.tools/arrival/emit";
import type { EmitRegistry, EmitRegistryRow } from "../registry/index.js";
import { arrayChunkAst, type ChunkElement } from "../residual/chunk.js";
import { render } from "../residual/render.js";
import type { CompilationUnit, R } from "../residual/types.js";
import {
  Arrow,
  Await,
  Binding,
  Block,
  Call,
  ChunkExpr,
  ChunkStmt,
  Const,
  ConstDecl,
  Index,
  Lit,
  Ref,
  Return,
  RuntimeRef,
} from "../residual/types.js";
import { runtimeRefsOf, walk, type WalkOptions } from "../walker/index.js";

const one = (node: R) => render({ decls: [], body: [node] });

const x = Binding("x");
const p = Binding("p");

// ─── residual/render.ts — chunk mechanics ─────────────────────────────────────────────

describe("ChunkExpr/ChunkStmt rendering (E2, engine plan §2 E2)", () => {
  it("Phase 1 — no slots: prints ast verbatim", () => {
    const chunk = ChunkExpr(arrayChunkAst([{ kind: "lit", value: 1 }, { kind: "lit", value: 2 }]));
    expect(one(chunk)).toBe("[1, 2];\n");
  });

  it("an empty (but present) slots Map normalizes to the Phase-1 shape", () => {
    const chunk = ChunkExpr(arrayChunkAst([{ kind: "lit", value: 1 }]), new Map());
    expect(one(chunk)).toBe("[1];\n");
  });

  it("Phase 2 — one slot: precomputes then substitutes by text match", () => {
    const chunk = ChunkExpr(
      arrayChunkAst([{ kind: "lit", value: 1 }, { kind: "slot", id: "__slot0" }]),
      new Map<string, R>([["__slot0", Ref(x)]]),
    );
    expect(one(chunk)).toBe("[1, x];\n");
  });

  it("two slots substitute independently, by id, not position", () => {
    const chunk = ChunkExpr(
      arrayChunkAst([
        { kind: "slot", id: "__slot0" },
        { kind: "lit", value: "mid" },
        { kind: "slot", id: "__slot1" },
      ]),
      new Map<string, R>([
        ["__slot0", Ref(x)],
        ["__slot1", Lit(9)],
      ]),
    );
    expect(one(chunk)).toBe('[x, "mid", 9];\n');
  });

  it("the \"ast\" element kind splices an already-built AST inline — nested literal, no slot", () => {
    const inner = arrayChunkAst([{ kind: "lit", value: 1 }, { kind: "lit", value: 2 }]);
    const outer = ChunkExpr(arrayChunkAst([{ kind: "ast", node: inner }, { kind: "lit", value: 3 }]));
    expect(one(outer)).toBe("[[1, 2], 3];\n");
  });

  it("mutual recursion: a slot whose fluid value is ITSELF a chunk recurses through the same dispatch", () => {
    const inner = ChunkExpr(arrayChunkAst([{ kind: "lit", value: 9 }]));
    const outer = ChunkExpr(
      arrayChunkAst([{ kind: "lit", value: 1 }, { kind: "slot", id: "__slot0" }]),
      new Map<string, R>([["__slot0", inner]]),
    );
    expect(one(outer)).toBe("[1, [9]];\n");
  });

  it("a slot's fluid value needing an Await renders correctly (insideAsync threaded through)", () => {
    const chunk = ChunkExpr(
      arrayChunkAst([{ kind: "slot", id: "__slot0" }]),
      new Map<string, R>([["__slot0", Await(Ref(p))]]),
    );
    expect(one(Arrow([], Block([Return(chunk)]), true))).toBe("async () => {\n    return [await p];\n};\n");
  });

  it("the original ast is never mutated — printing a substituted chunk twice is stable (§4.7 determinism)", () => {
    const chunk = ChunkExpr(
      arrayChunkAst([{ kind: "slot", id: "__slot0" }]),
      new Map<string, R>([["__slot0", Ref(x)]]),
    );
    expect(one(chunk)).toBe(one(chunk));
  });

  it("ChunkExpr reaching STATEMENT position renders as a bare expression statement", () => {
    const chunk = ChunkExpr(arrayChunkAst([{ kind: "lit", value: 1 }]));
    expect(render({ decls: [], body: [Const(x, chunk)] })).toBe("const x = [1];\n");
    // Statement position, value discarded — the position dispatch this wave's
    // duality rule covers (renderStmt's explicit ChunkExpr case).
    const asStmt: CompilationUnit = { decls: [], body: [chunk] };
    expect(render(asStmt)).toBe("[1];\n");
  });
});

describe("ChunkStmt duality — no fold site mints one this wave, but the substrate is built out fully", () => {
  // No production fold site builds a ChunkStmt yet (S2's ingestion fold only
  // ever produces expressions — see chunk.ts's own header) — a genuine
  // ts.Statement, hand-built here, is what a FUTURE fold site (or E2b's
  // rules-return-chunks) would hand to the ChunkStmt constructor.
  const throwStmt = ts.factory.createThrowStatement(
    ts.factory.createNewExpression(ts.factory.createIdentifier("Error"), undefined, [
      ts.factory.createStringLiteral("boom"),
    ]),
  );

  it("at STATEMENT position, prints ast verbatim as a statement", () => {
    const stmt = ChunkStmt(throwStmt);
    expect(render({ decls: [], body: [stmt] })).toBe('throw new Error("boom");\n');
  });

  it("reaching EXPRESSION position resolves through the SAME IIFE-vs-block rule Block uses", () => {
    const stmt = ChunkStmt(throwStmt);
    expect(one(Call(Ref(x), [stmt]))).toBe('x((() => {\n    throw new Error("boom");\n})());\n');
  });
});

// ─── walker/walk.ts — the ingestion fold (S2) ─────────────────────────────────────────

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

/** `car` folds INLINE to `Index` (no RuntimeRef at all in call position) — the
 *  same shape the real registry's `carRule` produces, needed so a folded
 *  `list` argument built from `(car x)` is genuinely call-free. */
const carRule: EmitRule<R> = {
  call: ([xs], ctx) => (xs === undefined ? ctx.door("car wants an argument") : Index(xs, Lit(0))),
};

const testRegistry = registryOf(
  row("list"), // no `.emit` → rung 3, exactly the real ambient's "list" row
  row("car", { emit: carRule }),
  row("reverse"), // no emit rule → rung 3 shim, the "contains a real Call" probe
);

const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));
const compile = (src: string, over: Partial<WalkOptions> = {}): CompilationUnit =>
  walk(cf(src), { registry: testRegistry, register: "run", ...over });
const emit = (src: string, over: Partial<WalkOptions> = {}): string => render(compile(src, over));

describe("quoted-data folding (always slot-free)", () => {
  it("a quoted list of constants folds to a literal array — byte-identical to the old ArrayLit path", () => {
    expect(emit(`'(1 2 3)`)).toBe("[1, 2, 3];\n");
  });

  it("nested quoted lists fold to ONE genuinely nested array (the \"ast\" splice, not a slot)", () => {
    expect(emit(`'(1 (2 3) "a")`)).toBe('[1, [2, 3], "a"];\n');
  });

  it("quoted symbols intern as strings (representation law §2.1), inside a nested list too", () => {
    expect(emit(`'(a b (c))`)).toBe('["a", "b", ["c"]];\n');
  });

  it("the empty quoted list still folds to []", () => {
    expect(emit(`'()`)).toBe("[];\n");
  });
});

describe("`list` call folding — literal data (S2's named example)", () => {
  it("a fully-literal `list` call folds to an array literal — the stage-0 shim never appears", () => {
    expect(emit(`(list 1 2 3)`)).toBe("[1, 2, 3];\n");
  });

  it("zero-argument `(list)` folds to []", () => {
    expect(emit(`(list)`)).toBe("[];\n");
  });

  it("nested `list` calls fold to one genuinely nested array (recursive ast-splice)", () => {
    expect(emit(`(list (list 1 2) (list 3 4))`)).toBe("[[1, 2], [3, 4]];\n");
  });
});

describe("`list` call folding — mixed literal/variable (slots at variable positions)", () => {
  it("a bound variable argument mints a slot", () => {
    expect(emit(`(define (f x) (list 1 x 2))`)).toBe("function f(x) {\n    return [1, x, 2];\n}\n");
  });

  it("a call-free derived expression (car folds inline to Index) is slot-safe — and the destructure census sees it there", () => {
    // The Index(x, 0) occurrence lives INSIDE the slot; the census counts it
    // (chunks are never leaves), so the param destructures and the
    // substitution reaches through the slot: `[head]`, not a stale `x[0]`
    // referencing a parameter the census thought was never chain-accessed.
    expect(emit(`(define (f x) (list (car x) 2))`)).toBe("function f([head]) {\n    return [head, 2];\n}\n");
  });

  it("a bare registry symbol used as a VALUE (never called) is slot-safe", () => {
    expect(emit(`(define (f) (list 1 car 2))`)).toBe("function f() {\n    return [1, car, 2];\n}\n");
  });
});

describe("`list` call folding — the conservative abort gate (isCallFree)", () => {
  it("an argument containing a real Call aborts the WHOLE fold — falls back to the shim, unchanged", () => {
    expect(emit(`(define (f x) (list 1 (reverse x) 2))`)).toBe(
      "function f(x) {\n    return list(1, reverse(x), 2);\n}\n",
    );
  });

  it("an embedded lambda (Arrow) aborts the fold — computation, not data (fold-scope policy; see isCallFree's doc)", () => {
    expect(emit(`(list 1 (lambda (y) y) 2)`)).toBe("list(1, y => y, 2);\n");
  });

  it("kwargs present aborts the fold — `list` taking a trailing options object is not the folded shape", () => {
    expect(emit(`(list 1 :a 2)`)).toBe('list(1, { a: 2 });\n');
  });

  it("folding is per-call-site: an outer call wrapping a Call-shaped argument still folds ITS OWN literal siblings/nested list arguments", () => {
    // Mirrors member-assoc.ts's real committed shape: the outer `list` (wrapping
    // `reverse`-shaped calls) does not fold, but a NESTED literal `list` used as
    // one of THOSE calls' own arguments still folds independently.
    expect(emit(`(define (f x) (list (reverse (list 1 2)) x))`)).toBe(
      "function f(x) {\n    return list(reverse([1, 2]), x);\n}\n",
    );
  });
});

describe("chunks are never leaves — slots are every walker's fluid re-entry points (mercury-ir.md's mutual-recursion rule)", () => {
  // The regression net for the review correction: an earlier draft treated a
  // chunk as a total leaf in the generic walkers, "safe" only because
  // `isCallFree` kept computation out of every fold-site slot. E2b's
  // rule-minted chunks won't pass through that gate, so the walkers must not
  // lean on it — each test below FAILS under the leaf treatment.

  it("REGRESSION: a seeded Call inside a slot flips the enclosing arrow async — the Await lands INSIDE the slot's rendered form", () => {
    // Hand-built: `const f = () => [1, ⟨(infer "m" "p")⟩]` with the seeded
    // call living in a chunk slot. Under leaf childrenOf the collection
    // pre-pass never sees the RuntimeRef → hasAsync stays false → the arrow
    // never flips → under-await, exactly the Law-W violation class the
    // correction names.
    const chunk = ChunkExpr(
      arrayChunkAst([
        { kind: "lit", value: 1 },
        { kind: "slot", id: "__slot0" },
      ]),
      new Map<string, R>([["__slot0", Call(RuntimeRef("infer"), [Lit("m"), Lit("p")])]]),
    );
    const unit: CompilationUnit = { decls: [ConstDecl(Binding("f"), Arrow([], chunk))], body: [] };
    const facts = asyncnessOf(unit, new Set(["infer"]));
    expect(facts.hasAsync).toBe(true); // the seed is FOUND through the slot
    // Round trip: the materialized rewrite mints the Await inside the rebuilt
    // slot map, the arrow flips async, and render substitutes the awaited
    // slot back into the verbatim ast.
    expect(render(materializeAsyncness(facts))).toBe('const f = async () => [1, await infer("m", "p")];\n');
  });

  it("REGRESSION: render's containsAwait sees a slot's Await — a Block holding an awaited-slot chunk becomes an ASYNC IIFE", () => {
    const chunk = ChunkExpr(
      arrayChunkAst([{ kind: "slot", id: "__slot0" }]),
      new Map<string, R>([["__slot0", Await(Ref(p))]]),
    );
    // Module top level is TLA-legal, so the async IIFE is awaited inline.
    // Under leaf rChildren, containsAwait answers false → a SYNC IIFE whose
    // body then hits the Law-W backstop throw ("Await under a non-async
    // function boundary") instead of this clean shape.
    expect(one(Const(x, Block([Return(chunk)])))).toBe(
      "const x = await (async () => {\n    return [await p];\n})();\n",
    );
  });

  it("REGRESSION: a param occurrence INSIDE a slot is visible to the destructure census — no undeclared-name emit", () => {
    // `(car pair)` folds inline to `Index(pair, 0)` — data-like, so the folded
    // `(list (car pair) 9)` carries the param's occurrence INSIDE a chunk
    // slot. Under leaf childrenOf the census missed it: destructure fired on
    // the OUTER occurrence alone and the slot kept referencing the
    // now-undeclared `pair` — broken emitted code, reachable TODAY (no E2b
    // needed). Seeing through the slot counts both occurrences, and the
    // materialize substitution reaches the slot too. (`head` — the designed
    // maxIndex-0 destructure name, naming/allocate.ts.)
    expect(emit(`(define (f pair) (reverse (car pair) (list (car pair) 9)))`)).toBe(
      "function f([head]) {\n    return reverse(head, [head, 9]);\n}\n",
    );
  });
});

describe("import census sees through a slot (runtimeRefsOf, walker/walk.ts's own copy)", () => {
  it("a `list` call fully literal needs NO import at all", () => {
    expect(runtimeRefsOf(compile(`(list 1 2 3)`))).toEqual(new Set());
  });

  it("a bare registry symbol bridged through a slot is still found for the import census", () => {
    expect(runtimeRefsOf(compile(`(define (f) (list 1 car 2))`))).toEqual(new Set(["car"]));
  });

  it("an aborted fold's Call is found the ordinary way (list itself needed too)", () => {
    expect(runtimeRefsOf(compile(`(define (f x) (list 1 (reverse x) 2))`))).toEqual(new Set(["list", "reverse"]));
  });
});

// ─── oracle agreement — the gate this wave answers to ─────────────────────────────────

describe("oracle agreement over the real session", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
  });

  it("a fully-literal `list` call: no import, oracle agrees", async () => {
    const src = `(list 1 2 3)`;
    expect(compileGreenfield(session, src)).not.toContain("stage0");
    const verdict = await runOracle(session, src);
    expect(verdict.agree, verdict.detail).toBe(true);
  });

  it("mixed literal/variable `list` call agrees with the interpreter", async () => {
    const src = `(define (f x) (list 1 x (+ x 1))) (f 10)`;
    const verdict = await runOracle(session, src);
    expect(verdict.agree, verdict.detail).toBe(true);
  });

  it("an async-seeded call as a `list` argument aborts the fold AND still awaits correctly", () => {
    // `infer` is a real Call — isCallFree refuses this argument a slot (the
    // fold-scope policy; a folded-into-a-slot call would ALSO be awaited
    // correctly since every walker reads through slots — see the "chunks are
    // never leaves" describe below — but this wave keeps computation out of
    // chunks), so the whole call falls back to the unfolded shim shape and
    // ASYNC-IFY awaits the plain Call argument. Bytes
    // only, not oracle agreement — `infer` always throws (differently,
    // untaxonomized) on both sides of this harness by design (stage-0's own
    // placeholder + the session's stub `InferFn`; no existing suite runs the
    // oracle over an `infer`-containing program for this reason).
    const src = `(list "before" (infer "fast" "hello"))`;
    const out = compileGreenfield(session, src);
    // Unfolded — `list(...)` stays a Call (never an ArrayLit), so each
    // argument is awaited independently, never batched under Promise.all
    // (that rewrite is ArrayLit-specific — asyncness.ts's own "by-right
    // parallelization, structural case").
    expect(out).toContain('list("before", await infer("fast", "hello"))');
  });

  it("REGRESSION: a mangled-name registry VALUE in a slot resolves through materializeImports (RuntimeRef→Ref inside the slot)", async () => {
    // `odd?` in value position is RuntimeRef("odd?") — data-like, so it rides
    // a slot. materializeImports must rewrite it to Ref(odd) THROUGH the
    // chunk (tree.ts's mapChildren rebuilding the slot map); under the leaf
    // treatment the slot kept the raw RuntimeRef, which renders as the
    // scheme-spelled identifier `odd?` — invalid TS, a compile-side crash.
    const src = `(length (list 1 odd? 2))`;
    const out = compileGreenfield(session, src);
    expect(out).toContain("[1, odd, 2]"); // the manifest-safe name INSIDE the slot
    const verdict = await runOracle(session, src);
    expect(verdict.agree, verdict.detail).toBe(true);
  });

  it("member-assoc's real shape: outer call stays, inner literal lists fold — still oracle-agrees", async () => {
    const src = `(list (member 2 (list 1 2 3)) (assoc 2 (list (list 1 "a") (list 2 "b"))))`;
    const out = compileGreenfield(session, src);
    expect(out).toContain("list(member(2, [1, 2, 3]), assoc(2, [[1, \"a\"], [2, \"b\"]]))");
    const verdict = await runOracle(session, src);
    expect(verdict.agree, verdict.detail).toBe(true);
  });
});

// ─── E2b — a Contract-side RULE returning a ChunkExpr (residual-lite's type acceptance) ──
//
// `@inhuman.tools/arrival/emit`'s residual-lite.ts now accepts `ChunkExpr` as a legal
// `EmitRule<R>` return shape (type-level only — no constructor there; that file's own
// growth discipline waits for a real Contract rule to need one). This package owns the
// only `ChunkExpr` constructor that exists (`residual/types.ts`, via `chunk.ts`'s
// `arrayChunkAst`), so this is the consuming-side proof the type acceptance is safe to
// build on: a rule minting a chunk (exactly as a future Contract rule would) round-trips
// through `walk`/`asyncnessOf`/`materializeAsyncness`/`render` — the walker's
// slots-are-never-leaves discipline (E2a, the "chunks are never leaves" describe block
// above) already covers a rule-minted chunk exactly like a fold-site-minted one; nothing
// new is needed in the walker to make this safe, only proof that it IS safe.
describe("E2b — a rule-minted ChunkExpr round-trips through walk/asyncness/render", () => {
  /** A hand-written EmitRule whose `call` mints a ChunkExpr wrapping its OWN
   *  (already-lowered) argument in a slot — structurally the shape a future
   *  Contract rule would build once residual-lite grows a real constructor. */
  const chunkRule: EmitRule<R> = {
    call: (args) =>
      ChunkExpr(
        arrayChunkAst([{ kind: "lit", value: "before" }, { kind: "slot", id: "__slot0" }]),
        new Map([["__slot0", args[0]!]]),
      ),
  };
  const chunkRegistry = registryOf(row("magic-chunk", { emit: chunkRule }), row("infer"));

  it("a rule-minted chunk is a legal App residual — no walker change needed to accept it", () => {
    expect(emit(`(magic-chunk 1)`, { registry: chunkRegistry })).toBe('["before", 1];\n');
  });

  it("a seeded call living in the rule-minted chunk's slot flips asyncness and awaits INSIDE the slot", () => {
    // `(magic-chunk (infer "m" x))`: the walker lowers `(infer "m" x)` FIRST (the
    // ordinary argument-lowering step in `lowerApp`), then hands the ALREADY-LOWERED
    // `Call(RuntimeRef("infer"), …)` to `chunkRule.call` as `args[0]` — exactly the
    // shape a Contract rule inspecting/wrapping an argument would receive.
    const unit = walk(cf(`(define (f x) (magic-chunk (infer "m" x)))`), { registry: chunkRegistry, register: "run" });
    const facts = asyncnessOf(unit, new Set(["infer"]));
    expect(facts.hasAsync).toBe(true); // the seed is found THROUGH the rule-minted slot
    expect(render(materializeAsyncness(facts))).toBe(
      'async function f(x) {\n    return ["before", await infer("m", x)];\n}\n',
    );
  });
});
