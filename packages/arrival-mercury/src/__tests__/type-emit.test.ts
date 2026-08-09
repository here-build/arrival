/**
 * type-emit — Law T (§5.2 type side) + the §5.3 narrowing-form grammar.
 *
 * Text + span-lens assertions over the VIRTUAL TS (type-emit-lawt.md Test plan;
 * these are the emit-shape rows — the tsc-behavior oracle rows [narrowing
 * actually composing at the checker] are the oracle/typefacts components' turf).
 *
 * Condition coerce is inline `(expr !== false)` — Scheme truth; no ambient helper.
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
    contains: ['((x !== false) ? x : "fallback")'],
  },
  {
    topic: "type-emit: Law T wrap (default)",
    name: "wraps a bare literal condition — unconditional-wrap policy",
    src: "(if 0 'a 'b)",
    contains: ['((0 !== false) ? "a" : "b")'],
  },
  {
    topic: "type-emit: Law T wrap (default)",
    name: "wraps a non-narrowing predicate call",
    src: "(if (zero? n) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ['((zero$qmark$(n) !== false) ? 1 : 2)'],
  },
  {
    topic: "type-emit: Law T wrap (default)",
    name: "wraps each nested if's condition independently — (if (if a b c) x y)",
    src: "(if (if a b c) x y)",
    contains: ["((((a !== false) ? b : c) !== false) ? x : y)"],
  },

  {
    topic: "type-emit: narrowing-form grammar (§5.3)",
    name: "emits a flagged predicate bare — (if (null? xs) …)",
    src: "(if (null? xs) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ['(null$qmark$(xs) ? 1 : 2)'],
    excludes: ["__scmTruth"],
  },
  {
    topic: "type-emit: narrowing-form grammar (§5.3)",
    name: "lowers not to native ! — (if (not (null? xs)) …)",
    src: "(if (not (null? xs)) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ['(!null$qmark$(xs) ? 1 : 2)'],
    excludes: ["__scmTruth", "not"],
  },
  {
    topic: "type-emit: narrowing-form grammar (§5.3)",
    name: "lowers and to native && — the constitution's own second guard shape",
    src: "(if (and (pair? x) (pair? (cdr x))) 1 2)",
    opts: { narrowsMembers: NARROWS },
    // cdr stays ambient (IDE C1); and still lowers to native &&
    contains: ["((pair$qmark$(x) && pair$qmark$(cdr(x))) ? 1 : 2)"],
    excludes: ["__scmTruth", "and", ".slice("],
  },
  {
    topic: "type-emit: narrowing-form grammar (§5.3)",
    name: "lowers or (and not-inside-or) to native || / !",
    src: "(if (or (string? x) (not (number? x))) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ['((string$qmark$(x) || !number$qmark$(x)) ? 1 : 2)'],
    excludes: ["__scmTruth"],
  },

  {
    topic: "type-emit: all-or-nothing (mixed clauses wrap whole)",
    name: "wraps the WHOLE condition when one and-operand is not flagged",
    src: "(if (and (pair? x) (f x)) 1 2)",
    opts: { narrowsMembers: NARROWS, hostMembers: HOSTS },
    contains: ['((and(pair$qmark$(x), f(x)) !== false) ? 1 : 2)'],
    excludes: [" && "],
  },
  {
    topic: "type-emit: all-or-nothing (mixed clauses wrap whole)",
    name: "wraps on a bare-variable operand too — (and (string? x) flag)",
    src: "(if (and (string? x) flag) 1 2)",
    opts: { narrowsMembers: NARROWS, hostMembers: HOSTS },
    contains: ['((and(string$qmark$(x), flag) !== false) ? 1 : 2)'],
  },
  {
    topic: "type-emit: all-or-nothing (mixed clauses wrap whole)",
    name: "zero-arity (and) is a value form, not a guard — wraps, no invalid `()`",
    src: "(if (and) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ["((and() !== false) ? 1 : 2)"],
  },
  {
    topic: "type-emit: all-or-nothing (mixed clauses wrap whole)",
    name: "wrong-arity not is not an NForm — (not a b) wraps",
    src: "(if (not a b) 1 2)",
    opts: { narrowsMembers: NARROWS },
    contains: ["((not(a, b) !== false) ? 1 : 2)"],
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

  it("coerces non-narrowing conditions with !== false (Scheme truth, no __scmTruth helper)", () => {
    const r = emitTypes("(if x 1 2)");
    expect(r.ts).toContain("(x !== false)");
    expect(r.ts).not.toContain("__scmTruth");
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
      expect(r.ts.slice(m!.tsStart, m!.tsStart + m!.tsLength)).toBe('string$qmark$(x)');
    }
    expect(bare.ts).toContain('(string$qmark$(x) ? 1 : 2)');
    expect(wrapped.ts).toContain('((string$qmark$(x) !== false) ? 1 : 2)');
  });
});

describe("type-emit: all-or-nothing (mixed clauses wrap whole)", () => {
  for (const c of casesIn("type-emit: all-or-nothing (mixed clauses wrap whole)")) {
    it(c.name, () => runTypeEmitCase(c));
  }
});

describe("type-emit: inputRest kwargs vs keyword-as-fn", () => {
  it("(map :id xs) — unconstrained A + conditional return (HOF-safe)", () => {
    const r = emitTypes("(map :id xs)");
    // Free A so map's (a: unknown) => … accepts this; return precise when A is a row.
    expect(r.ts).toContain('<A,>(x: A): A extends { id: infer S } ? S : unknown => (x as any)["id"]');
    expect(r.ts).not.toContain("map({");
    expect(r.ts).not.toContain('(x) => x["id"]');
    expect(r.ts).not.toContain("A extends { id: any }");
  });

  it("(where :mismatch #f) — two positionals, key is accessor eta", () => {
    const r = emitTypes("(define (where key val) (lambda (r) (equal? (key r) val)))\n(where :mismatch #f)");
    expect(r.ts).toContain(
      '<A,>(x: A): A extends { mismatch: infer S } ? S : unknown => (x as any)["mismatch"]',
    );
    expect(r.ts).not.toContain("where({");
  });

  it("kwargs head collapses :k v; single leading positional → key in the bag", () => {
    const r = emitTypes('(tool "path" :label "L" :reasons xs)', {
      hostMembers: new Set(["tool"]),
      kwargsMembers: new Set(["tool"]),
    });
    // One arg: leading "path" promoted to key (same rule as .prompt call-sites).
    expect(r.ts).toContain('tool({ key: "path", label: "L", reasons: xs })');
    expect(r.ts).not.toContain("undefined as unknown");
  });

  it("non-kwargs host head keeps :keyword as accessor (no collapse)", () => {
    const r = emitTypes("(field :name row)", {
      hostMembers: new Set(["field"]),
      // field is NOT in kwargsMembers
    });
    expect(r.ts).toContain(
      'field(<A,>(x: A): A extends { name: infer S } ? S : unknown => (x as any)["name"], row)',
    );
    expect(r.ts).not.toContain("field({");
  });

  it('((require "x.prompt") path :label l) — path promotes to key in the kwargs bag', () => {
    const r = emitTypes('((require "x.prompt") "cache/key" :label lab :reasons rs)');
    // Leading positional is call-site identity → `key` field, one arg (not 2).
    expect(r.ts).toContain('require("x.prompt")({ key: "cache/key", label: lab, reasons: rs })');
    expect(r.ts).not.toContain('require("x.prompt")("cache/key"');
    expect(r.ts).not.toContain("undefined as unknown");
    expect(r.ts).not.toContain("sexpr(");
  });

  it("explicit :key wins over positional promotion", () => {
    const r = emitTypes('((require "x.prompt") :key "k" :label lab)');
    expect(r.ts).toContain('require("x.prompt")({ key: "k", label: lab })');
  });

  it("local binding of (require ….prompt) is a kwargs head", () => {
    const r = emitTypes(
      '(define triage (require "triage.prompt"))\n(triage "k" :summary s :tagline t)',
    );
    expect(r.ts).toContain('triage({ key: "k", summary: s, tagline: t })');
  });
});

describe("type-emit: bare formals (lambda args …)", () => {
  it("(lambda args …) → (...args) => … — polyglot str shape, not zero-arg", () => {
    // R5RS bare formals: whole arg list bound to `args`. Without rest emit this
    // collapsed to `() => …` and (str a b c d) reported "Expected 0 arguments, but got 4".
    const r = emitTypes(
      '(define str (lambda args (apply string-append (map (lambda (x) x) args))))\n(str "a" 1 "b" "c")',
    );
    expect(r.ts).toMatch(/\(\.\.\.args\)\s*=>/);
    expect(r.ts).toContain('str("a", 1, "b", "c")');
    expect(r.ts).not.toMatch(/const str = \(\)\s*=>/);
  });

  it("(lambda (a . rest) …) still dotted-rest emits", () => {
    const r = emitTypes("(define f (lambda (a . rest) rest))\n(f 1 2 3)");
    expect(r.ts).toMatch(/\(a, \.\.\.rest\)\s*=>/);
    expect(r.ts).toContain("f(1, 2, 3)");
  });
});

describe("type-emit: compose/pipe pipeline generics", () => {
  it("(compose :state last :versions) → structural generic over A", () => {
    const r = emitTypes("(define state-of (compose :state last :versions))");
    // Input: { versions: List<{ state: any }> }; return A["versions"][number]["state"]
    expect(r.ts).toContain('<A extends { versions: List<{ state: any }> }>');
    expect(r.ts).toContain('(it: A): A["versions"][number]["state"]');
    expect(r.ts).toContain('(last((it)["versions"]))["state"]');
  });

  it("(pipe :versions last :state) is the same shape (LTR desugar)", () => {
    const r = emitTypes("(define state-of (pipe :versions last :state))");
    expect(r.ts).toContain('<A extends { versions: List<{ state: any }> }>');
    expect(r.ts).toContain('A["versions"][number]["state"]');
  });

  it("(compose car) → List domain, element return", () => {
    const r = emitTypes("(define head1 (compose car))");
    expect(r.ts).toContain("<A extends List<any>>");
    expect(r.ts).toContain("(it: A): A[number]");
  });
});

describe("type-emit: cxr → ambient PRE calls (IDE contract C1)", () => {
  // Type lens keeps car/cdr as declare-function calls so a wrong arg is TS2345
  // on the atom — not native index/slice (which bites as TS7053 on the form).
  const cases: Array<[string, string]> = [
    ["(car x)", "car(x)"],
    ["(cdr x)", "cdr(x)"],
    ["(cadr x)", "cadr(x)"],
    ["(caddr x)", "caddr(x)"],
    ["(cadddr x)", "cadddr(x)"],
    ["(cddr x)", "cddr(x)"],
    ["(cdddr x)", "cdddr(x)"],
    ["(caar x)", "caar(x)"],
    ["(cdar x)", "cdar(x)"],
    ["(caadr x)", "caadr(x)"],
    ["(cadar x)", "cadar(x)"],
  ];
  for (const [src, fragment] of cases) {
    it(`${src} → ${fragment}`, () => {
      const r = emitTypes(src);
      expect(r.ts).toContain(fragment);
      expect(r.ts).not.toContain("[0]");
      expect(r.ts).not.toContain(".slice(");
    });
  }

  it("bare car in value position stays the ambient name (eta / map car)", () => {
    const r = emitTypes("(map car xs)");
    expect(r.ts).toContain("map(car, xs)");
    expect(r.ts).not.toContain("[0]");
  });

  it("nested (car (cdr x)) stays nested ambient calls (does not fuse to cadr)", () => {
    const r = emitTypes("(car (cdr x))");
    expect(r.ts).toContain("car(cdr(x))");
  });

  it("wrong-arity car falls through to ambient call so tsc can bite", () => {
    const r = emitTypes("(car)");
    expect(r.ts).toContain("car()");
  });
});

describe("type-emit: grammar gates (shadowing, Law F, value position)", () => {
  it("Law F: absent narrowsMembers ⇒ every condition wraps, even a would-be guard", () => {
    const r = emitTypes("(if (string? x) 1 2)", { hostMembers: HOSTS });
    expect(r.ts).toContain('((string$qmark$(x) !== false) ? 1 : 2)');
  });

  it("a user rebinding shadows the grammar exactly like builtin dispatch", () => {
    const r = emitTypes("(define (null? x) #t)\n(if (null? y) 1 2)", { narrowsMembers: NARROWS });
    // encodeSchemeIdent("null?") → null$qmark$; user const shadows ambient declare function
    expect(r.ts).toContain("const null$qmark$ = (x) => true");
    expect(r.ts).toContain("((null$qmark$(y) !== false) ? 1 : 2)");
  });

  it("value-position and/or stay ambient calls — emitCondition never leaks", () => {
    const r = emitTypes("(define ok (and (pair? x) (pair? y)))", { narrowsMembers: NARROWS, hostMembers: HOSTS });
    expect(r.ts).toContain('const ok = and(pair$qmark$(x), pair$qmark$(y))');
    expect(r.ts).not.toContain(" && ");
    expect(r.ts).not.toContain("__scmTruth");
  });
});

describe("type-emit: span lens (mappings for the extractor)", () => {
  it("maps the coerced condition's inner expression at its shifted offset", () => {
    const src = "(if x x 'fallback)";
    const r = emitTypes(src);
    // condition `x` (offset 4) — mapped; its TS extent is exactly the identifier
    const [cond] = mappingAt(r, 4, 1);
    expect(cond).toBeDefined();
    expect(r.ts.slice(cond!.tsStart, cond!.tsStart + cond!.tsLength)).toBe("x");
    // sits inside `(x !== false)` — suffix after the identifier
    expect(r.ts.slice(cond!.tsStart + cond!.tsLength, cond!.tsStart + cond!.tsLength + " !== false)".length)).toBe(
      " !== false)",
    );
    // the whole-if span still records around everything
    const [whole] = mappingAt(r, 0, src.length);
    expect(whole).toBeDefined();
    expect(r.ts.slice(whole!.tsStart, whole!.tsStart + whole!.tsLength)).toBe('((x !== false) ? x : "fallback")');
  });

  it("records a span PER NForm level — leaf, not-form, and the inner argument", () => {
    const src = "(if (not (null? xs)) 1 2)";
    const r = emitTypes(src, { narrowsMembers: NARROWS });
    const notForm = "(not (null? xs))";
    const leafForm = "(null? xs)";
    const [notM] = mappingAt(r, src.indexOf(notForm), notForm.length);
    expect(notM).toBeDefined();
    expect(r.ts.slice(notM!.tsStart, notM!.tsStart + notM!.tsLength)).toBe('!null$qmark$(xs)');
    const [leafM] = mappingAt(r, src.indexOf(leafForm), leafForm.length);
    expect(leafM).toBeDefined();
    expect(r.ts.slice(leafM!.tsStart, leafM!.tsStart + leafM!.tsLength)).toBe('null$qmark$(xs)');
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
      '(string$qmark$(x) && number$qmark$(y))',
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
    expect(r.ts).toContain("((0 !== false) ? 1 : 2)");
    expect(r.ts).not.toContain("require");
  });

  it("desugared conditions classify too — (when (null? xs) 1) reaches the grammar as if", () => {
    const r = emitTypes("(when (null? xs) 1)", { narrowsMembers: NARROWS });
    expect(r.ts).toContain('(null$qmark$(xs) ? 1 : ');
  });

  it("parenthesizes a sole dict body on an arrow — else `{` is a block, not a return", () => {
    // `(lambda (a b) (dict :a a :b b))` must be `=> ({ a: a, b: b })`, never
    // `=> { a: a, b: b }` (labels, no value).
    const r = emitTypes("(define (make a b) (dict :a a :b b))");
    expect(r.ts).toContain("const make = (a, b) => ({ ");
    expect(r.ts).toContain("a: a");
    expect(r.ts).toContain("b: b");
    expect(r.ts).toMatch(/=> \(\{[\s\S]*\}\)/);
    // Unparenthesized block form must not appear as the arrow body.
    expect(r.ts).not.toMatch(/=> \{\s*a:/);
  });

  it("parenthesizes a top-level dict expression statement — else `{` is a block", () => {
    // Bare `{ tree: … };` is a block (labels), not a value expression.
    const r = emitTypes('(define buckets 1)\n(dict :tree results :buckets buckets)');
    expect(r.ts).toContain("const buckets = 1;");
    expect(r.ts).toMatch(/\(\{\s*tree: results/);
    expect(r.ts).toMatch(/buckets: buckets\s*\}\);/);
    // Must not be an unparenthesized block statement.
    expect(r.ts).not.toMatch(/\n\{\s*tree:/);
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
