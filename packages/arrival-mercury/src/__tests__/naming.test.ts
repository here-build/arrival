/**
 * NAMING gate tests (engine plan §2 E1a; ../naming/). Two layers:
 *
 *  - Direct unit coverage of `bindingCensusOf`/`allocateNames`/`materializeNames`
 *    against small, hand-built `CompilationUnit`s — the census/allocation-level
 *    proof that legibility.test.ts's own "implicit destruction"/"element-name
 *    singularization" describe blocks promise (their end-to-end goldens pin
 *    the OUTCOME; these pin the DECISION).
 *  - A handful of `walk()`-level tests for behavior that only manifests once
 *    the whole tree exists (cross-scope collision ordering, the reservation
 *    scoping fix, the predicate-yields-to-plain-binding ladder trick) — the
 *    same "compile real source, read the render" convention walker.test.ts
 *    uses.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { allocateNames } from "../naming/allocate.js";
import { bindingCensusOf } from "../naming/census.js";
import { materializeNames } from "../naming/materialize.js";
import { recordOrigin } from "../naming/origin.js";
import type { NameAllocation } from "../naming/types.js";
import type { EmitRegistry, EmitRegistryRow } from "../registry/index.js";
import { render } from "../residual/render.js";
import {
  ArrayLit,
  Arrow,
  Binding as mkBinding,
  Block,
  Const,
  ConstDecl,
  FnDecl,
  Index,
  Let as LetStmt,
  Lit,
  Method,
  Ref,
  Return,
  type Binding,
  type CompilationUnit,
} from "../residual/types.js";
import { walk } from "../walker/index.js";

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
const cf = (src: string) => classify(desugar(parseSexprs(src)));
const compile = (src: string, registry: EmitRegistry): CompilationUnit => walk(cf(src), { registry, register: "run" });

// ── bindingCensusOf — direct unit coverage ────────────────────────────────

describe("bindingCensusOf", () => {
  it("classifies a top-level FnDecl as 'function' and its param as 'param'", () => {
    const p = recordOrigin(mkBinding("xs"), { mint: "declared", text: "xs" });
    const name = recordOrigin(mkBinding("f"), { mint: "declared", text: "f" });
    const unit: CompilationUnit = {
      decls: [FnDecl(name, [p], Block([Return(Ref(p))]))],
      body: [],
    };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(name)?.kind).toBe("function");
    expect(census.bySite.get(p)?.kind).toBe("param");
    // the FnDecl's own scope has one site (its name); its param scope is a child.
    expect(census.root.sites).toHaveLength(1);
    expect(census.root.children).toHaveLength(1);
    expect(census.root.children[0]!.sites).toHaveLength(1);
  });

  it("classifies a top-level ConstDecl bound to an Arrow as 'function', otherwise 'value'", () => {
    const fnName = recordOrigin(mkBinding("g"), { mint: "declared", text: "g" });
    const valName = recordOrigin(mkBinding("k"), { mint: "declared", text: "k" });
    const unit: CompilationUnit = {
      decls: [ConstDecl(fnName, Arrow([], Lit(1))), ConstDecl(valName, Lit(2))],
      body: [],
    };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(fnName)?.kind).toBe("function");
    expect(census.bySite.get(valName)?.kind).toBe("value");
  });

  it("classifies a Let (TCO loop var) as 'accumulator', distinct from an ordinary Const ('value')", () => {
    const loopVar = recordOrigin(mkBinding("i"), { mint: "declared", text: "i" });
    const plainVar = recordOrigin(mkBinding("x"), { mint: "declared", text: "x" });
    const unit: CompilationUnit = {
      decls: [],
      body: [LetStmt(loopVar, Lit(0)), Const(plainVar, Lit(1))],
    };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(loopVar)?.kind).toBe("accumulator");
    expect(census.bySite.get(plainVar)?.kind).toBe("value");
  });

  it("throws when it reaches a declaration site with no recorded origin (a walker bug guard)", () => {
    const noOrigin: Binding = mkBinding("mystery"); // never passed through recordOrigin
    const unit: CompilationUnit = { decls: [ConstDecl(noOrigin, Lit(1))], body: [] };
    expect(() => bindingCensusOf(unit)).toThrow(/no recorded mint origin/);
  });

  it("a bare global reference (e.g. Ref(Binding(\"Error\"))) is never registered as a site", () => {
    // Mirrors walk.ts's doorThrow: a raw, un-tracked Binding used only in Ref
    // (value) position is not a DECLARATION site — census must never visit it,
    // so it must never throw the missing-origin guard above.
    const raw = mkBinding("Error");
    const name = recordOrigin(mkBinding("f"), { mint: "declared", text: "f" });
    const unit: CompilationUnit = { decls: [ConstDecl(name, Ref(raw))], body: [] };
    expect(() => bindingCensusOf(unit)).not.toThrow();
  });

  it("destructure use-shape: a param used only via car/cdr-composed access reports positions + maxIndex", () => {
    const param = recordOrigin(mkBinding("pair"), { mint: "declared", text: "pair" });
    const idx0 = Index(Ref(param), Lit(0));
    const unit: CompilationUnit = {
      decls: [FnDecl(recordOrigin(mkBinding("f"), { mint: "declared", text: "f" }), [param], Block([Return(idx0)]))],
      body: [],
    };
    const census = bindingCensusOf(unit);
    const site = census.bySite.get(param)!;
    expect(site.destructure).toBeDefined();
    expect(site.destructure!.maxIndex).toBe(0);
    expect(site.destructure!.positions.get(idx0)).toBe(0);
  });

  it("singularize use-shape: a FRESH first param of a .map() Arrow gets the receiver's singular candidate", () => {
    const recv = recordOrigin(mkBinding("examples"), { mint: "declared", text: "examples" });
    const el = recordOrigin(mkBinding("__item"), { mint: "fresh", text: "item" });
    const mapCall = Method(Ref(recv), "map", [Arrow([el], Ref(el))]);
    const unit: CompilationUnit = { decls: [], body: [mapCall] };
    const census = bindingCensusOf(unit);
    const site = census.bySite.get(el)!;
    expect(site.kind).toBe("element");
    expect(site.singularName).toBe("example");
  });

  it("a DECLARED (user-authored) .map() callback param is never treated as an element/singularize candidate", () => {
    const recv = recordOrigin(mkBinding("examples"), { mint: "declared", text: "examples" });
    const userParam = recordOrigin(mkBinding("x"), { mint: "declared", text: "x" });
    const mapCall = Method(Ref(recv), "map", [Arrow([userParam], Ref(userParam))]);
    const unit: CompilationUnit = { decls: [], body: [mapCall] };
    const census = bindingCensusOf(unit);
    const site = census.bySite.get(userParam)!;
    expect(site.kind).toBe("param");
    expect(site.singularName).toBeUndefined();
  });

  it("destructure takes precedence over singularize for the same fresh param (mutually exclusive)", () => {
    const recv = recordOrigin(mkBinding("pairs"), { mint: "declared", text: "pairs" });
    const el = recordOrigin(mkBinding("__item"), { mint: "fresh", text: "item" });
    const body = Index(Ref(el), Lit(0)); // el used only via car — destructure-eligible
    const mapCall = Method(Ref(recv), "map", [Arrow([el], body)]);
    const unit: CompilationUnit = { decls: [], body: [mapCall] };
    const census = bindingCensusOf(unit);
    const site = census.bySite.get(el)!;
    expect(site.destructure).toBeDefined();
    expect(site.singularName).toBeUndefined(); // suppressed — destructure won
  });
});

// ── allocateNames — direct unit coverage ──────────────────────────────────

describe("allocateNames", () => {
  it("same-scope collision: the FIRST-declared site keeps the bare name; the later one gets the numeric fallback", () => {
    const outer = recordOrigin(mkBinding("x"), { mint: "declared", text: "x" });
    const inner = recordOrigin(mkBinding("x"), { mint: "declared", text: "x" });
    const unit: CompilationUnit = { decls: [], body: [Const(outer, Lit(1)), Const(inner, Lit(2))] };
    const allocation = allocateNames(bindingCensusOf(unit), []);
    expect(allocation.nameOf.get(outer)).toBe("x");
    expect(allocation.nameOf.get(inner)).toBe("x_2");
  });

  it("a fresh-glue collision (same hint, overlapping scope) uses the no-underscore numeric fallback ('__or', '__or2')", () => {
    const a = recordOrigin(mkBinding("__or"), { mint: "fresh", text: "or" });
    const b = recordOrigin(mkBinding("__or"), { mint: "fresh", text: "or" });
    // b is nested inside a's own scope (an Arrow body) so it reads as a CHILD —
    // reservation propagation, not a same-scope tie either way.
    const unit: CompilationUnit = { decls: [], body: [Const(a, Arrow([], Const(b, Lit(1))))] };
    const allocation = allocateNames(bindingCensusOf(unit), []);
    expect(allocation.nameOf.get(a)).toBe("__or");
    expect(allocation.nameOf.get(b)).toBe("__or2");
  });

  it("reservations block a candidate — the site falls to its numeric fallback", () => {
    const x = recordOrigin(mkBinding("list"), { mint: "declared", text: "list" });
    const unit: CompilationUnit = { decls: [], body: [Const(x, Lit(1))] };
    const allocation = allocateNames(bindingCensusOf(unit), ["list"]);
    expect(allocation.nameOf.get(x)).toBe("list_2");
  });

  it("sibling (disjoint) scopes may reuse the same bare name freely — no cross-sibling suffixing", () => {
    const a = recordOrigin(mkBinding("c"), { mint: "declared", text: "c" });
    const b = recordOrigin(mkBinding("c"), { mint: "declared", text: "c" });
    const outer1 = recordOrigin(mkBinding("h1"), { mint: "declared", text: "h1" });
    const outer2 = recordOrigin(mkBinding("h2"), { mint: "declared", text: "h2" });
    const unit: CompilationUnit = {
      decls: [],
      body: [Const(outer1, Arrow([a], Ref(a))), Const(outer2, Arrow([b], Ref(b)))],
    };
    const allocation = allocateNames(bindingCensusOf(unit), []);
    expect(allocation.nameOf.get(a)).toBe("c");
    expect(allocation.nameOf.get(b)).toBe("c");
  });

  it("a predicate yields the bare name to a co-scoped plain binding (content-aware ladder, front/scheme-scope.ts's own trick)", () => {
    const predicate = recordOrigin(mkBinding("picked"), { mint: "declared", text: "picked?" });
    const plain = recordOrigin(mkBinding("picked"), { mint: "declared", text: "picked" });
    // predicate declared FIRST (would win a naive first-come ladder) — the
    // content-aware reorder must still make it yield to the plain binding.
    const unit: CompilationUnit = { decls: [], body: [Const(predicate, Lit(1)), Const(plain, Lit(2))] };
    const allocation = allocateNames(bindingCensusOf(unit), []);
    expect(allocation.nameOf.get(predicate)).toBe("isPicked");
    expect(allocation.nameOf.get(plain)).toBe("picked");
  });
});

// ── materializeNames — direct unit coverage ───────────────────────────────

describe("materializeNames", () => {
  it("renames every occurrence of a Binding in place (identity preserved)", () => {
    const b = recordOrigin(mkBinding("x"), { mint: "declared", text: "x" });
    const unit: CompilationUnit = { decls: [ConstDecl(b, Ref(b))], body: [Ref(b)] };
    const allocation: NameAllocation = { nameOf: new Map([[b, "renamed"]]), destructureOf: new Map() };
    const out = materializeNames(unit, allocation);
    expect(b.text).toBe("renamed"); // the SAME object, mutated
    expect(render(out)).toContain("renamed");
  });

  it("rewrites a destructured param's Pattern to an ArrayPattern and substitutes qualifying occurrences", () => {
    const param = recordOrigin(mkBinding("pair"), { mint: "declared", text: "pair" });
    const occurrence = Index(Ref(param), Lit(0));
    const unit: CompilationUnit = {
      decls: [FnDecl(recordOrigin(mkBinding("f"), { mint: "declared", text: "f" }), [param], Block([Return(occurrence)]))],
      body: [],
    };
    const head = mkBinding("head");
    const allocation: NameAllocation = {
      nameOf: new Map(),
      destructureOf: new Map([[param, { slots: [head], positions: new Map([[occurrence, 0]]) }]]),
    };
    const out = materializeNames(unit, allocation);
    expect(render(out)).toBe(`function f([head]) {\n    return head;\n}\n`);
  });
});

// ── whole-pipeline behavior (walk()-level; the naming module's real consumer) ──

describe("walk() — the naming phase end to end", () => {
  const testRegistry = registryOf(row("odd?"), row("car"));

  it("a program that never references a stage-0 symbol never reserves its manifest name (the odd?/odd fix)", () => {
    // Regression pin for the reservation-scoping bug found while landing this
    // wave: reserving the WHOLE stage-0 manifest unconditionally (rather than
    // only the symbols THIS unit's surviving RuntimeRefs still need) forced
    // an unrelated user binding literally named "odd" to "odd_2".
    const out = render(compile(`(define (f n) (define (even) (odd)) (define (odd) (even)) (even))`, testRegistry));
    expect(out).toBe(`function f(n) {\n    const even = () => odd();\n    const odd = () => even();\n    return even();\n}\n`);
  });

  it("a program that DOES reference a stage-0 symbol in value position still reserves its manifest name", () => {
    // `pick`'s value-position reference to the bare `car` registry symbol
    // (refPolicy "shim" — this test registry declares no `.ref`) compiles to an
    // actual surviving RuntimeRef `naming/imports.ts`'s materializeImports will
    // later import as `car`; a same-named LOCAL binding elsewhere in the SAME
    // unit must still suffix.
    const out = render(compile(`(define pick car) (define (f xs) (let ((car (lambda (p) 99))) (car xs)))`, testRegistry));
    expect(out).toContain("const car_2 = p => 99;");
    expect(out).toContain("return car_2(xs);");
  });
});
