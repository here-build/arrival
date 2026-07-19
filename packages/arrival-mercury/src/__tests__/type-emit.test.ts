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
 * arrival/packages/arrival-lsp/src/prelude/types.d.ts carries it since
 * Phase 0 — so the emitted module must contain no `declare` of its own (asserted
 * below), exactly like `__arr`/`sexpr`/`Dict`.
 */
import { describe, expect, it } from "vitest";

import { parseSexprs } from "../front/parse.js";
import { emitTypes, type EmitTypesOptions } from "../type-emit/index.js";
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

// ── the emit-shape protocol table: one row per (source, emission) claim ────
// Every row runs `emitTypes(src, opts)` and asserts each `contains` fragment
// IS present in `r.ts` (in row order), then each `excludes` fragment is NOT
// (in row order) — exactly the assertions, and assertion order, of the
// original its. `topic` names the topical describe the row lands in (each
// describe loops its own rows). Rows whose assertion shape drifts beyond
// contains/excludes (mapping-lens comparisons, multi-emit loops, the grammar
// gates) stay plain its in their describes below.
interface TypeEmitCase {
  /** The topical describe this row lands in (describes filter their own rows). */
  readonly topic: string;
  /** The behavior claim — becomes the it name. */
  readonly name: string;
  readonly src: string;
  readonly opts?: EmitTypesOptions;
  /** Fragments asserted present via toContain, in assertion order. */
  readonly contains: readonly string[];
  /** Fragments asserted absent via not.toContain, in assertion order (after `contains`). */
  readonly excludes?: readonly string[];
}

const TYPE_EMIT_CASES: readonly TypeEmitCase[] = [
  {
    topic: "type-emit: Law T wrap (default)",
    name: "wraps the self-referencing headline shape — (if x x 'fallback)",
    src: "(if x x 'fallback)",
    contains: ['(__scmTruth(x) ? x : "fallback")'],
  },
  {
    topic: "type-emit: Law T wrap (default)",
    name: "wraps a bare literal condition — unconditional-wrap policy",
    src: "(if 0 'a 'b)",
    contains: ['(__scmTruth(0) ? "a" : "b")'],
  },
  {
    topic: "type-emit: Law T wrap (default)",
    name: "wraps a non-narrowing predicate call",
    src: "(if (zero? n) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ['(__scmTruth(__arr["zero?"](n)) ? 1 : 2)'],
  },
  {
    topic: "type-emit: Law T wrap (default)",
    name: "wraps each nested if's condition independently — (if (if a b c) x y)",
    src: "(if (if a b c) x y)",
    contains: ["(__scmTruth((__scmTruth(a) ? b : c)) ? x : y)"],
  },

  {
    topic: "type-emit: narrowing-form grammar (§5.3)",
    name: "emits a flagged predicate bare — (if (null? xs) …)",
    src: "(if (null? xs) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ['(__arr["null?"](xs) ? 1 : 2)'],
    excludes: ["__scmTruth"],
  },
  {
    topic: "type-emit: narrowing-form grammar (§5.3)",
    name: "lowers not to native ! — (if (not (null? xs)) …)",
    src: "(if (not (null? xs)) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ['(!__arr["null?"](xs) ? 1 : 2)'],
    excludes: ["__scmTruth", "__arr.not"],
  },
  {
    topic: "type-emit: narrowing-form grammar (§5.3)",
    name: "lowers and to native && — the constitution's own second guard shape",
    src: "(if (and (pair? x) (pair? (cdr x))) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ['((__arr["pair?"](x) && __arr["pair?"](__arr.cdr(x))) ? 1 : 2)'],
    excludes: ["__scmTruth", "__arr.and"],
  },
  {
    topic: "type-emit: narrowing-form grammar (§5.3)",
    name: "lowers or (and not-inside-or) to native || / !",
    src: "(if (or (string? x) (not (number? x))) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ['((__arr["string?"](x) || !__arr["number?"](x)) ? 1 : 2)'],
    excludes: ["__scmTruth"],
  },

  {
    topic: "type-emit: all-or-nothing (mixed clauses wrap whole)",
    name: "wraps the WHOLE condition when one and-operand is not flagged",
    src: "(if (and (pair? x) (f x)) 1 2)",
    opts: { narrowsMembers: NARROWS, hostMembers: HOSTS },
    contains: ['(__scmTruth(__arr.and(__arr["pair?"](x), f(x))) ? 1 : 2)'],
    excludes: [" && "],
  },
  {
    topic: "type-emit: all-or-nothing (mixed clauses wrap whole)",
    name: "wraps on a bare-variable operand too — (and (string? x) flag)",
    src: "(if (and (string? x) flag) 1 2)",
    opts: { narrowsMembers: NARROWS, hostMembers: HOSTS },
    contains: ['(__scmTruth(__arr.and(__arr["string?"](x), flag)) ? 1 : 2)'],
  },
  {
    topic: "type-emit: all-or-nothing (mixed clauses wrap whole)",
    name: "zero-arity (and) is a value form, not a guard — wraps, no invalid `()`",
    src: "(if (and) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ["(__scmTruth(__arr.and()) ? 1 : 2)"],
  },
  {
    topic: "type-emit: all-or-nothing (mixed clauses wrap whole)",
    name: "wrong-arity not is not an NForm — (not a b) wraps",
    src: "(if (not a b) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ["(__scmTruth(__arr.not(a, b)) ? 1 : 2)"],
  },
];

const casesIn = (topic: string): readonly TypeEmitCase[] => TYPE_EMIT_CASES.filter((c) => c.topic === topic);

const runTypeEmitCase = (c: TypeEmitCase): void => {
  const r = emitTypes(c.src, c.opts);
  for (const s of c.contains) expect(r.ts).toContain(s);
  for (const s of c.excludes ?? []) expect(r.ts).not.toContain(s);
};

describe("type-emit: Law T wrap (default)", () => {
  for (const c of casesIn("type-emit: Law T wrap (default)")) {
    it(c.name, () => runTypeEmitCase(c));
  }

  it("never declares __scmTruth — the lens prelude owns the ambient declaration", () => {
    const r = emitTypes("(if 0 1 2)");
    expect(r.ts).toContain("__scmTruth(");
    expect(r.ts).not.toContain("declare");
  });
});

describe("type-emit: narrowing-form grammar (§5.3)", () => {
  for (const c of casesIn("type-emit: narrowing-form grammar (§5.3)")) {
    it(c.name, () => runTypeEmitCase(c));
  }

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
  for (const c of casesIn("type-emit: all-or-nothing (mixed clauses wrap whole)")) {
    it(c.name, () => runTypeEmitCase(c));
  }
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
