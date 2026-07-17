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
  Bin,
  Binding as mkBinding,
  Block,
  Call,
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

  // ── field-destructure use-shape (item 2) — the dict-field twin of positional ──

  it("field-destructure use-shape: a param used only via literal-key field access reports fields + accesses", () => {
    const param = recordOrigin(mkBinding("c"), { mint: "declared", text: "c" });
    const access = Index(Ref(param), Lit("scores"));
    const unit: CompilationUnit = {
      decls: [FnDecl(recordOrigin(mkBinding("f"), { mint: "declared", text: "f" }), [param], Block([Return(access)]))],
      body: [],
    };
    const census = bindingCensusOf(unit);
    const site = census.bySite.get(param)!;
    expect(site.fieldDestructure).toBeDefined();
    expect(site.fieldDestructure!.fields).toEqual(["scores"]);
    expect(site.fieldDestructure!.accesses.get(access)).toBe("scores");
    expect(site.destructure).toBeUndefined(); // mutually exclusive with positional
  });

  it("field-destructure records multiple distinct fields in first-encountered order", () => {
    const param = recordOrigin(mkBinding("c"), { mint: "declared", text: "c" });
    const via = Index(Ref(param), Lit("via"));
    const analyze = Index(Ref(param), Lit("analyze"));
    const unit: CompilationUnit = {
      decls: [
        FnDecl(recordOrigin(mkBinding("f"), { mint: "declared", text: "f" }), [param], Block([Return(ArrayLit([via, analyze]))])),
      ],
      body: [],
    };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(param)!.fieldDestructure!.fields).toEqual(["via", "analyze"]);
  });

  it("a param used via BOTH car/cdr AND field access gets NEITHER shape — mixed use falls to bare (compose rule)", () => {
    const param = recordOrigin(mkBinding("c"), { mint: "declared", text: "c" });
    const positional = Index(Ref(param), Lit(0));
    const field = Index(Ref(param), Lit("x"));
    const unit: CompilationUnit = {
      decls: [
        FnDecl(
          recordOrigin(mkBinding("f"), { mint: "declared", text: "f" }),
          [param],
          Block([Return(ArrayLit([positional, field]))]),
        ),
      ],
      body: [],
    };
    const census = bindingCensusOf(unit);
    const site = census.bySite.get(param)!;
    expect(site.destructure).toBeUndefined();
    expect(site.fieldDestructure).toBeUndefined();
  });

  it("a param with one field access and one stray bare use gets no field-destructure (all-or-nothing)", () => {
    const param = recordOrigin(mkBinding("c"), { mint: "declared", text: "c" });
    const field = Index(Ref(param), Lit("x"));
    const unit: CompilationUnit = {
      decls: [
        FnDecl(
          recordOrigin(mkBinding("f"), { mint: "declared", text: "f" }),
          [param],
          Block([Return(ArrayLit([field, Ref(param)]))]),
        ),
      ],
      body: [],
    };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(param)!.fieldDestructure).toBeUndefined();
  });

  it("field-destructure suppresses singularize for the same fresh param (extends the destructure precedent)", () => {
    const recv = recordOrigin(mkBinding("pairs"), { mint: "declared", text: "pairs" });
    const el = recordOrigin(mkBinding("__item"), { mint: "fresh", text: "item" });
    const body = Index(Ref(el), Lit("x")); // el used only via field access — field-destructure-eligible
    const mapCall = Method(Ref(recv), "map", [Arrow([el], body)]);
    const unit: CompilationUnit = { decls: [], body: [mapCall] };
    const census = bindingCensusOf(unit);
    const site = census.bySite.get(el)!;
    expect(site.fieldDestructure).toBeDefined();
    expect(site.singularName).toBeUndefined();
  });

  // ── the singularize gate broadened beyond .map (item 3) ──────────────────

  it("singularize broadens to .filter: a fresh first param also gets the receiver's singular candidate", () => {
    const recv = recordOrigin(mkBinding("examples"), { mint: "declared", text: "examples" });
    const el = recordOrigin(mkBinding("__item"), { mint: "fresh", text: "item" });
    const filterCall = Method(Ref(recv), "filter", [Arrow([el], Ref(el))]);
    const unit: CompilationUnit = { decls: [], body: [filterCall] };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(el)!.singularName).toBe("example");
  });

  it("singularize broadens to forEach/some/every too (forward-compat: no emit rule constructs these as native methods today, unit-tested directly)", () => {
    for (const methodName of ["forEach", "some", "every"]) {
      const recv = recordOrigin(mkBinding("scores"), { mint: "declared", text: "scores" });
      const el = recordOrigin(mkBinding("__item"), { mint: "fresh", text: "item" });
      const call = Method(Ref(recv), methodName, [Arrow([el], Ref(el))]);
      const unit: CompilationUnit = { decls: [], body: [call] };
      const census = bindingCensusOf(unit);
      expect(census.bySite.get(el)!.singularName).toBe("score");
    }
  });

  it("the Law-T filter-guard wrapper shape declines the singularize candidate — the wrapper is plumbing, not the element", () => {
    // Mirrors arrival-core's srfi-1.ts filterEmitRule non-provably-boolean wrap:
    // `__x => (pred)(__x) !== false`. Regression pin: the wrapper param must
    // NOT claim a name (e.g. "rec", singularized from the receiver) that
    // pred's OWN inline-lambda parameter needs more.
    const recv = recordOrigin(mkBinding("recs"), { mint: "declared", text: "recs" });
    const x = recordOrigin(mkBinding("__x"), { mint: "fresh", text: "x" });
    const predParam = recordOrigin(mkBinding("rec"), { mint: "declared", text: "rec" });
    const guardBody = Bin("!==", Call(Arrow([predParam], Ref(predParam)), [Ref(x)]), Lit(false));
    const filterCall = Method(Ref(recv), "filter", [Arrow([x], guardBody)]);
    const unit: CompilationUnit = { decls: [], body: [filterCall] };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(x)!.singularName).toBeUndefined();
  });

  it("control: a DIRECT zip invocation (mapEmitRule's shape, no !== false wrapper) still singularizes — not caught by the Law-T exclusion", () => {
    const recv = recordOrigin(mkBinding("examples"), { mint: "declared", text: "examples" });
    const el = recordOrigin(mkBinding("__item"), { mint: "fresh", text: "item" });
    const userParam = recordOrigin(mkBinding("s"), { mint: "declared", text: "s" });
    const zipBody = Call(Arrow([userParam], Ref(userParam)), [Ref(el)]); // Call(Arrow, [Ref(el)]) — no comparison wrapper
    const mapCall = Method(Ref(recv), "map", [Arrow([el], zipBody)]);
    const unit: CompilationUnit = { decls: [], body: [mapCall] };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(el)!.singularName).toBe("example");
  });

  // ── the fold-role gate (item 4) — reduce's accumulator + item naming ─────

  it("a reduce fold over '+' names the accumulator 'total' and the item from the receiver's singular", () => {
    const recv = recordOrigin(mkBinding("scores"), { mint: "declared", text: "scores" });
    const acc = recordOrigin(mkBinding("__acc"), { mint: "fresh", text: "acc" });
    const item = recordOrigin(mkBinding("__item"), { mint: "fresh", text: "item" });
    const reduceCall = Method(Ref(recv), "reduce", [Arrow([acc, item], Bin("+", Ref(acc), Ref(item))), Lit(0)]);
    const unit: CompilationUnit = { decls: [], body: [reduceCall] };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(acc)!.singularName).toBe("total");
    expect(census.bySite.get(acc)!.kind).toBe("accumulator");
    expect(census.bySite.get(item)!.singularName).toBe("score");
    expect(census.bySite.get(item)!.kind).toBe("element");
  });

  it("a reduce fold over '*' names the accumulator 'product'", () => {
    const recv = recordOrigin(mkBinding("xs"), { mint: "declared", text: "xs" });
    const acc = recordOrigin(mkBinding("__acc"), { mint: "fresh", text: "acc" });
    const item = recordOrigin(mkBinding("__item"), { mint: "fresh", text: "item" });
    const reduceCall = Method(Ref(recv), "reduce", [Arrow([acc, item], Bin("*", Ref(acc), Ref(item))), Lit(1)]);
    const unit: CompilationUnit = { decls: [], body: [reduceCall] };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(acc)!.singularName).toBe("product");
  });

  it("an unrecognized fold operator declines the naming (never a guess)", () => {
    const recv = recordOrigin(mkBinding("xs"), { mint: "declared", text: "xs" });
    const acc = recordOrigin(mkBinding("__acc"), { mint: "fresh", text: "acc" });
    const item = recordOrigin(mkBinding("__item"), { mint: "fresh", text: "item" });
    const reduceCall = Method(Ref(recv), "reduce", [Arrow([acc, item], Bin("-", Ref(acc), Ref(item))), Lit(0)]);
    const unit: CompilationUnit = { decls: [], body: [reduceCall] };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(acc)!.singularName).toBeUndefined();
    expect(census.bySite.get(item)!.singularName).toBeUndefined();
  });

  it("a user-authored (declared-origin) two-arg reduce callback is never fold-role-named (never a user's own choice)", () => {
    const recv = recordOrigin(mkBinding("xs"), { mint: "declared", text: "xs" });
    const acc = recordOrigin(mkBinding("acc"), { mint: "declared", text: "acc" }); // DECLARED, not fresh
    const item = recordOrigin(mkBinding("item"), { mint: "declared", text: "item" });
    const reduceCall = Method(Ref(recv), "reduce", [Arrow([acc, item], Bin("+", Ref(acc), Ref(item))), Lit(0)]);
    const unit: CompilationUnit = { decls: [], body: [reduceCall] };
    const census = bindingCensusOf(unit);
    expect(census.bySite.get(acc)!.singularName).toBeUndefined();
    expect(census.bySite.get(item)!.singularName).toBeUndefined();
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

  // ── field-destructure Shape dissolution (naming lane item 1 + item 2) ─────

  it("field-destructure allocates one clean-named binding per field (kebab field key → camelCase local name)", () => {
    const param = recordOrigin(mkBinding("c"), { mint: "declared", text: "c" });
    const access = Index(Ref(param), Lit("my-field"));
    const unit: CompilationUnit = {
      decls: [FnDecl(recordOrigin(mkBinding("f"), { mint: "declared", text: "f" }), [param], Block([Return(access)]))],
      body: [],
    };
    const allocation = allocateNames(bindingCensusOf(unit), []);
    const fd = allocation.fieldDestructureOf.get(param)!;
    expect(fd.properties).toHaveLength(1);
    expect(fd.properties[0]!.key).toBe("my-field"); // the literal key — never renamed
    expect(fd.properties[0]!.binding.text).toBe("myField"); // the local binding — cleaned
  });

  it("two sibling field-destructure-eligible params contesting the same field name resolve in DECLARATION order (first wins the bare name)", () => {
    const a = recordOrigin(mkBinding("a"), { mint: "declared", text: "a" });
    const b = recordOrigin(mkBinding("b"), { mint: "declared", text: "b" });
    const accessA = Index(Ref(a), Lit("via"));
    const accessB = Index(Ref(b), Lit("via"));
    const unit: CompilationUnit = {
      decls: [
        FnDecl(
          recordOrigin(mkBinding("f"), { mint: "declared", text: "f" }),
          [a, b],
          Block([Return(ArrayLit([accessA, accessB]))]),
        ),
      ],
      body: [],
    };
    const allocation = allocateNames(bindingCensusOf(unit), []);
    expect(allocation.fieldDestructureOf.get(a)!.properties[0]!.binding.text).toBe("via");
    expect(allocation.fieldDestructureOf.get(b)!.properties[0]!.binding.text).toBe("via_2");
  });

  it("a destructure-eligible site falls back to a bare name when every T100 candidate is reserved (the Shape API's all-or-nothing safety net)", () => {
    const param = recordOrigin(mkBinding("c"), { mint: "declared", text: "c" });
    const access = Index(Ref(param), Lit(0));
    const unit: CompilationUnit = {
      decls: [FnDecl(recordOrigin(mkBinding("f"), { mint: "declared", text: "f" }), [param], Block([Return(access)]))],
      body: [],
    };
    // Reserve "head" and every "head_2".."head_50" fallback rung — exhausts the
    // T100 shape's entire candidate ladder, forcing the T80 bare shape. A
    // genuine behavioral gain over the pre-Shape-API design (which had no
    // allocation-time escape hatch once census decided destructure).
    const blocked = ["head", ...Array.from({ length: 49 }, (_, i) => `head_${i + 2}`)];
    const allocation = allocateNames(bindingCensusOf(unit), blocked);
    expect(allocation.destructureOf.has(param)).toBe(false);
    expect(allocation.nameOf.get(param)).toBe("c");
  });
});

// ── materializeNames — direct unit coverage ───────────────────────────────

describe("materializeNames", () => {
  it("renames every occurrence of a Binding in place (identity preserved)", () => {
    const b = recordOrigin(mkBinding("x"), { mint: "declared", text: "x" });
    const unit: CompilationUnit = { decls: [ConstDecl(b, Ref(b))], body: [Ref(b)] };
    const allocation: NameAllocation = { nameOf: new Map([[b, "renamed"]]), destructureOf: new Map(), fieldDestructureOf: new Map() };
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
      fieldDestructureOf: new Map(),
    };
    const out = materializeNames(unit, allocation);
    expect(render(out)).toBe(`function f([head]) {\n    return head;\n}\n`);
  });

  it("rewrites a field-destructured param's Pattern to an ObjectPattern and substitutes qualifying occurrences (shorthand)", () => {
    const param = recordOrigin(mkBinding("c"), { mint: "declared", text: "c" });
    const occurrence = Index(Ref(param), Lit("scores"));
    const unit: CompilationUnit = {
      decls: [FnDecl(recordOrigin(mkBinding("f"), { mint: "declared", text: "f" }), [param], Block([Return(occurrence)]))],
      body: [],
    };
    const scoresBinding = mkBinding("scores");
    const allocation: NameAllocation = {
      nameOf: new Map(),
      destructureOf: new Map(),
      fieldDestructureOf: new Map([
        [param, { properties: [{ key: "scores", binding: scoresBinding }], accesses: new Map([[occurrence, scoresBinding]]) }],
      ]),
    };
    const out = materializeNames(unit, allocation);
    expect(render(out)).toBe(`function f({ scores }) {\n    return scores;\n}\n`);
  });

  it("renders the explicit alias form when the field key and the local binding name differ", () => {
    const param = recordOrigin(mkBinding("c"), { mint: "declared", text: "c" });
    const occurrence = Index(Ref(param), Lit("my-field"));
    const unit: CompilationUnit = {
      decls: [FnDecl(recordOrigin(mkBinding("f"), { mint: "declared", text: "f" }), [param], Block([Return(occurrence)]))],
      body: [],
    };
    const local = mkBinding("myField");
    const allocation: NameAllocation = {
      nameOf: new Map(),
      destructureOf: new Map(),
      fieldDestructureOf: new Map([
        [param, { properties: [{ key: "my-field", binding: local }], accesses: new Map([[occurrence, local]]) }],
      ]),
    };
    const out = materializeNames(unit, allocation);
    expect(render(out)).toBe(`function f({ "my-field": myField }) {\n    return myField;\n}\n`);
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

  // ── WalkOptions.manifest threading (WALKER-NAMING audit finding #6) ─────────
  // `materializeImports`'s "collision with a user binding is impossible by
  // construction" claim (naming/imports.ts's own header) depends on THIS
  // reservation step and that later materialization step reading the SAME
  // manifest. `custom-fn` is deliberately NOT a real stage-0 symbol — proves
  // the reservation set comes from `opts.manifest` when supplied, not always
  // from the hardcoded STAGE0 import.
  const customFnRegistry = registryOf(row("custom-fn"));
  const customManifest = { "custom-fn": "customFn" };
  const customSrc = `(define pick custom-fn) (define (f) (let ((customFn (lambda () 99))) (customFn)))`;

  it("a symbol absent from STAGE0 is never reserved without an explicit manifest", () => {
    const out = render(walk(cf(customSrc), { registry: customFnRegistry, register: "run" }));
    expect(out).toContain("const customFn = () => 99;"); // no collision reserved — no suffix
  });

  it("opts.manifest overrides STAGE0 for the reservation set — the SAME symbol now collides", () => {
    const out = render(
      walk(cf(customSrc), { registry: customFnRegistry, register: "run", manifest: customManifest }),
    );
    expect(out).toContain("const customFn_2 = () => 99;"); // reserved via the custom manifest, forced to suffix
  });

  // ── field-destructure end to end (item 2) — keyword-accessor + `dict` are
  // walker-intrinsic special forms, so this needs no registry symbols at all ──

  it("a param used only via keyword-accessor field reads destructures to an object pattern", () => {
    const out = render(compile(`(define (f c) (dict :sum (:a c) :other (:b c)))`, registryOf()));
    expect(out).toBe(`function f({ a, b }) {\n    return { sum: a, other: b };\n}\n`);
  });

  it("a mixed-use param (field access AND a bare pass-through) stays bare — no partial destructure", () => {
    const out = render(compile(`(define (f c) (dict :field (:a c) :whole c))`, registryOf()));
    expect(out).toBe(`function f(c) {\n    return { field: c["a"], whole: c };\n}\n`);
  });
});
