/**
 * type-emit — Law T (§5.2 type side) + the §5.3 narrowing-form grammar.
 *
 * Text + span-lens assertions over the VIRTUAL TS (type-emit-lawt.md Test plan;
 * these are the emit-shape rows — the tsc-behavior oracle rows [narrowing
 * actually composing at the checker] are the oracle/typefacts components' turf).
 *
 * `__scmTruth` DECLARATION ownership (documented expectation): the emitter only
 * ever REFERENCES `__scmTruth(…)`; the ambient declaration
 * `declare function __scmTruth(x: unknown): boolean` is the LENS PRELUDE's —
 * arrival/packages/arrival-type-lens/src/prelude/types.d.ts carries it since
 * Phase 0 — so the emitted module must contain no `declare` of its own (asserted
 * below), exactly like `__arr`/`sexpr`/`Dict`.
 */
import { describe, expect, it } from "vitest";

import { parseSexprs } from "../front/parse.js";
import { emitTypes } from "../type-emit/index.js";
import { narrowsMembersOf } from "../type-emit/narrows.js";
import type { EmitRegistry, EmitRegistryRow } from "../registry/index.js";

/** The six is-typed lens guards — the harvest's expected first population. Tests
 *  pass the set EXPLICITLY (the registry harvest supplies it at integration). */
const NARROWS: ReadonlySet<string> = new Set(["null?", "pair?", "string?", "number?", "boolean?", "array?", "list?"]);

/** Mirror of the integration surface: predicates are ambient `__arr` members
 *  (the lens harvests them into hostMembers), so wrapped-path emissions of the
 *  same heads stay `__arr[...]` calls, not free identifiers. */
const HOSTS: ReadonlySet<string> = new Set(["null?", "pair?", "string?", "number?"]);

const mappingAt = (r: { ts: string; mappings: { tsStart: number; tsLength: number; schemeStart: number; schemeLength: number }[] }, schemeStart: number, schemeLength: number) =>
  r.mappings.filter((m) => m.schemeStart === schemeStart && m.schemeLength === schemeLength);

describe("type-emit: Law T wrap (default)", () => {
  it("wraps the self-referencing headline shape — (if x x 'fallback)", () => {
    const r = emitTypes("(if x x 'fallback)");
    expect(r.ts).toContain('(__scmTruth(x) ? x : "fallback")');
  });

  it("wraps a bare literal condition — unconditional-wrap policy", () => {
    const r = emitTypes("(if 0 'a 'b)");
    expect(r.ts).toContain('(__scmTruth(0) ? "a" : "b")');
  });

  it("wraps a non-narrowing predicate call", () => {
    const r = emitTypes("(if (zero? n) 1 2)", { narrowsMembers: NARROWS });
    expect(r.ts).toContain('(__scmTruth(__arr["zero?"](n)) ? 1 : 2)');
  });

  it("wraps each nested if's condition independently — (if (if a b c) x y)", () => {
    const r = emitTypes("(if (if a b c) x y)");
    expect(r.ts).toContain("(__scmTruth((__scmTruth(a) ? b : c)) ? x : y)");
  });

  it("never declares __scmTruth — the lens prelude owns the ambient declaration", () => {
    const r = emitTypes("(if 0 1 2)");
    expect(r.ts).toContain("__scmTruth(");
    expect(r.ts).not.toContain("declare");
  });
});

describe("type-emit: narrowing-form grammar (§5.3)", () => {
  it("emits a flagged predicate bare — (if (null? xs) …)", () => {
    const r = emitTypes("(if (null? xs) 1 2)", { narrowsMembers: NARROWS });
    expect(r.ts).toContain('(__arr["null?"](xs) ? 1 : 2)');
    expect(r.ts).not.toContain("__scmTruth");
  });

  it("lowers not to native ! — (if (not (null? xs)) …)", () => {
    const r = emitTypes("(if (not (null? xs)) 1 2)", { narrowsMembers: NARROWS });
    expect(r.ts).toContain('(!__arr["null?"](xs) ? 1 : 2)');
    expect(r.ts).not.toContain("__scmTruth");
    expect(r.ts).not.toContain("__arr.not");
  });

  it("lowers and to native && — the constitution's own second guard shape", () => {
    const r = emitTypes("(if (and (pair? x) (pair? (cdr x))) 1 2)", { narrowsMembers: NARROWS });
    expect(r.ts).toContain('((__arr["pair?"](x) && __arr["pair?"](__arr.cdr(x))) ? 1 : 2)');
    expect(r.ts).not.toContain("__scmTruth");
    expect(r.ts).not.toContain("__arr.and");
  });

  it("lowers or (and not-inside-or) to native || / !", () => {
    const r = emitTypes("(if (or (string? x) (not (number? x))) 1 2)", { narrowsMembers: NARROWS });
    expect(r.ts).toContain('((__arr["string?"](x) || !__arr["number?"](x)) ? 1 : 2)');
    expect(r.ts).not.toContain("__scmTruth");
  });

  it("keeps every mapping-relevant span through both variants of the same head", () => {
    // The SAME source form emits unwrapped (flagged) vs wrapped (unflagged) —
    // and both variants still record the leaf call's span.
    const src = "(if (string? x) 1 2)";
    const bare = emitTypes(src, { narrowsMembers: NARROWS, hostMembers: HOSTS });
    const wrapped = emitTypes(src, { hostMembers: HOSTS });
    const leafStart = src.indexOf("(string? x)");
    for (const r of [bare, wrapped]) {
      const [m] = mappingAt(r, leafStart, "(string? x)".length);
      expect(m).toBeDefined();
      expect(r.ts.slice(m!.tsStart, m!.tsStart + m!.tsLength)).toBe('__arr["string?"](x)');
    }
    expect(bare.ts).toContain('(__arr["string?"](x) ? 1 : 2)');
    expect(wrapped.ts).toContain('(__scmTruth(__arr["string?"](x)) ? 1 : 2)');
  });
});

describe("type-emit: all-or-nothing (mixed clauses wrap whole)", () => {
  it("wraps the WHOLE condition when one and-operand is not flagged", () => {
    const r = emitTypes("(if (and (pair? x) (f x)) 1 2)", { narrowsMembers: NARROWS, hostMembers: HOSTS });
    expect(r.ts).toContain('(__scmTruth(__arr.and(__arr["pair?"](x), f(x))) ? 1 : 2)');
    expect(r.ts).not.toContain(" && ");
  });

  it("wraps on a bare-variable operand too — (and (string? x) flag)", () => {
    const r = emitTypes("(if (and (string? x) flag) 1 2)", { narrowsMembers: NARROWS, hostMembers: HOSTS });
    expect(r.ts).toContain('(__scmTruth(__arr.and(__arr["string?"](x), flag)) ? 1 : 2)');
  });

  it("zero-arity (and) is a value form, not a guard — wraps, no invalid `()`", () => {
    const r = emitTypes("(if (and) 1 2)", { narrowsMembers: NARROWS });
    expect(r.ts).toContain("(__scmTruth(__arr.and()) ? 1 : 2)");
  });

  it("wrong-arity not is not an NForm — (not a b) wraps", () => {
    const r = emitTypes("(if (not a b) 1 2)", { narrowsMembers: NARROWS });
    expect(r.ts).toContain("(__scmTruth(__arr.not(a, b)) ? 1 : 2)");
  });
});

describe("type-emit: grammar gates (shadowing, Law F, value position)", () => {
  it("Law F: absent narrowsMembers ⇒ every condition wraps, even a would-be guard", () => {
    const r = emitTypes("(if (string? x) 1 2)", { hostMembers: HOSTS });
    expect(r.ts).toContain('(__scmTruth(__arr["string?"](x)) ? 1 : 2)');
  });

  it("a user rebinding shadows the grammar exactly like builtin dispatch", () => {
    const r = emitTypes("(define (null? x) #t)\n(if (null? y) 1 2)", { narrowsMembers: NARROWS });
    // cleanName("null?") → "null" → reserved-word escape "null_"
    expect(r.ts).toContain("const null_ = (x) => true");
    expect(r.ts).toContain("(__scmTruth(null_(y)) ? 1 : 2)");
    expect(r.ts).not.toContain('__arr["null?"]');
  });

  it("value-position and/or stay __arr calls — emitCondition never leaks", () => {
    const r = emitTypes("(define ok (and (pair? x) (pair? y)))", { narrowsMembers: NARROWS, hostMembers: HOSTS });
    expect(r.ts).toContain('const ok = __arr.and(__arr["pair?"](x), __arr["pair?"](y))');
    expect(r.ts).not.toContain(" && ");
    expect(r.ts).not.toContain("__scmTruth");
  });
});

describe("type-emit: span lens (mappings for the extractor)", () => {
  it("maps the wrapped condition's inner expression at its shifted offset", () => {
    const src = "(if x x 'fallback)";
    const r = emitTypes(src);
    // condition `x` (offset 4) — mapped; its TS extent is exactly the identifier
    const [cond] = mappingAt(r, 4, 1);
    expect(cond).toBeDefined();
    expect(r.ts.slice(cond!.tsStart, cond!.tsStart + cond!.tsLength)).toBe("x");
    // and it sits INSIDE the wrapper — the prefix was appended before the inner emit
    expect(r.ts.slice(cond!.tsStart - "__scmTruth(".length, cond!.tsStart)).toBe("__scmTruth(");
    // the whole-if span still records around everything
    const [whole] = mappingAt(r, 0, src.length);
    expect(whole).toBeDefined();
    expect(r.ts.slice(whole!.tsStart, whole!.tsStart + whole!.tsLength)).toBe('(__scmTruth(x) ? x : "fallback")');
  });

  it("records a span PER NForm level — leaf, not-form, and the inner argument", () => {
    const src = "(if (not (null? xs)) 1 2)";
    const r = emitTypes(src, { narrowsMembers: NARROWS });
    const notForm = "(not (null? xs))";
    const leafForm = "(null? xs)";
    const [notM] = mappingAt(r, src.indexOf(notForm), notForm.length);
    expect(notM).toBeDefined();
    expect(r.ts.slice(notM!.tsStart, notM!.tsStart + notM!.tsLength)).toBe('!__arr["null?"](xs)');
    const [leafM] = mappingAt(r, src.indexOf(leafForm), leafForm.length);
    expect(leafM).toBeDefined();
    expect(r.ts.slice(leafM!.tsStart, leafM!.tsStart + leafM!.tsLength)).toBe('__arr["null?"](xs)');
    const [argM] = mappingAt(r, src.indexOf("xs"), 2);
    expect(argM).toBeDefined();
    expect(r.ts.slice(argM!.tsStart, argM!.tsStart + argM!.tsLength)).toBe("xs");
  });

  it("records the whole and-form's span around the native && composition", () => {
    const src = "(if (and (string? x) (number? y)) 1 2)";
    const r = emitTypes(src, { narrowsMembers: NARROWS });
    const andForm = "(and (string? x) (number? y))";
    const [andM] = mappingAt(r, src.indexOf(andForm), andForm.length);
    expect(andM).toBeDefined();
    expect(r.ts.slice(andM!.tsStart, andM!.tsStart + andM!.tsLength)).toBe(
      '(__arr["string?"](x) && __arr["number?"](y))',
    );
  });
});

describe("type-emit: input surface + module frame (byte-identical chunk behavior)", () => {
  it("accepts a pre-parsed forest (parseSexprs output) — same emission as the string path", () => {
    const src = "(if (null? xs) 1 2)";
    const viaString = emitTypes(src, { narrowsMembers: NARROWS });
    const viaForest = emitTypes(parseSexprs(src), { narrowsMembers: NARROWS });
    expect(viaForest.ts).toBe(viaString.ts);
    expect(viaForest.mappings).toEqual(viaString.mappings);
  });

  it("degrades a whole-program parse failure to an empty module", () => {
    const r = emitTypes("(((");
    expect(r.ts).toBe("export {};\n");
    expect(r.mappings).toEqual([]);
    expect(r.droppedForms).toEqual([]);
  });

  it("skips (require …) directives and records the drop", () => {
    const r = emitTypes('(require "lib/util.scm")\n(if 0 1 2)');
    expect(r.droppedForms).toEqual([0]);
    expect(r.ts).toContain("(__scmTruth(0) ? 1 : 2)");
    expect(r.ts).not.toContain("require");
  });

  it("desugared conditions classify too — (when (null? xs) 1) reaches the grammar as if", () => {
    const r = emitTypes("(when (null? xs) 1)", { narrowsMembers: NARROWS });
    expect(r.ts).toContain('(__arr["null?"](xs) ? 1 : ');
  });
});

describe("narrowsMembersOf: registry → grammar key-set reduction", () => {
  const row = (symbol: string, narrows?: { witness: string }): EmitRegistryRow => ({
    symbol,
    capability: "test-cap",
    kind: "native",
    refPolicy: "shim",
    narrows,
  });

  it("reduces to exactly the narrows-flagged names", () => {
    const rows = new Map<string, EmitRegistryRow>([
      ["null?", row("null?", { witness: "null?" })],
      ["pair?", row("pair?", { witness: "pair?" })],
      ["car", row("car")],
    ]);
    const registry: EmitRegistry = { lookup: (n) => rows.get(n), names: new Set(rows.keys()) };
    expect(narrowsMembersOf(registry)).toEqual(new Set(["null?", "pair?"]));
  });

  it("an empty registry reduces to the empty set (Law F default)", () => {
    const registry: EmitRegistry = { lookup: () => undefined, names: new Set() };
    expect(narrowsMembersOf(registry).size).toBe(0);
  });
});
