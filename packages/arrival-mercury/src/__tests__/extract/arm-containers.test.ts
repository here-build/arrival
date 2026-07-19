/**
 * ARM-C unit tests — Dict container, the head registry, the fan constructor.
 *
 * Fixtures come from the real front pipeline (`classify(desugar(parseSexprs(src)))`,
 * matching extract-corpus.test.ts's convention) — hand-rolling CoreForm object
 * literals by hand would fight the id/span bookkeeping `classify()` already does
 * correctly. Where a test needs a specific Lambda/Dict/Ref node in isolation (not
 * the whole program's last-value semantics), `buildFan`/`extractContainer` are
 * called DIRECTLY on that node rather than routed through `extractProgram` — the
 * App-level dispatch that would normally reach them for a real `(map f xs)` call
 * is ARM-B's (`arm-control.ts`'s `extractControl`), which is still a G1 stub as of
 * this writing. Calling ARM-C's own exports directly keeps these tests honest
 * unit tests of ARM-C's code, decoupled from a sibling arm's completion state.
 *
 * One test (the hidden-const fold shape) needs a REAL `if` inside a fold body —
 * that's ARM-B's `If` case, unavoidably. It runs `it.fails` for the same reason
 * extract-corpus.test.ts's rows do: red until the sibling arm lands, and a
 * surprise green would mean this file drifted out of sync with that landing.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import type { CoreForm, Dict, Lambda, NodeId } from "../../coreform/types.js";
import { buildFan, defaultRegistry, extractContainer } from "../../extract/arm-containers.js";
import { EMPTY_SCOPE, extract, extractProgram, type Bound, type ExtractCtx, type Scope } from "../../extract/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import type { HeadClass, StaticProv } from "../../model/static-prov.js";

function parseForm(src: string): CoreForm {
  const { forms } = classify(desugar(parseSexprs(src)));
  return forms[0]!;
}
function parseLambda(src: string): Lambda {
  return parseForm(src) as Lambda;
}
function baseCtx(): ExtractCtx {
  return { scope: EMPTY_SCOPE, registry: defaultRegistry, reducing: new Set(), memo: new WeakMap(), riskProbes: [] };
}

const collection: StaticProv = { kind: "input", site: 0 as NodeId, name: "xs" };

// ── defaultRegistry — totality ───────────────────────────────────────────────────

describe("defaultRegistry.classifyHead — every enumerated head, one row per line", () => {
  const CASES: readonly (readonly [string, HeadClass])[] = [
    // fuse
    ["+", { role: "fuse" }],
    ["-", { role: "fuse" }],
    ["*", { role: "fuse" }],
    ["/", { role: "fuse" }],
    ["=", { role: "fuse" }],
    ["<", { role: "fuse" }],
    [">", { role: "fuse" }],
    ["<=", { role: "fuse" }],
    [">=", { role: "fuse" }],
    ["abs", { role: "fuse" }],
    ["min", { role: "fuse" }],
    ["max", { role: "fuse" }],
    ["not", { role: "fuse" }],
    ["string-length", { role: "fuse" }],
    ["hash", { role: "fuse" }],
    // mux
    ["car", { role: "mux", keyArg: "self" }],
    ["cdr", { role: "mux", keyArg: "self" }],
    ["first", { role: "mux", keyArg: "self" }],
    ["rest", { role: "mux", keyArg: "self" }],
    ["nth", { role: "mux", keyArg: 1 }],
    ["vector-ref", { role: "mux", keyArg: 1 }],
    ["assoc", { role: "mux", keyArg: 0 }],
    ["dict-ref", { role: "mux", keyArg: 1 }],
    // build
    ["cons", { role: "build", ctor: "pair" }],
    ["list", { role: "build", ctor: "vector" }],
    ["vector", { role: "build", ctor: "vector" }],
    ["dict", { role: "build", ctor: "dict" }],
    ["make-vector", { role: "build", ctor: "vector" }],
    // string
    ["string-append", { role: "string" }],
    ["string-join", { role: "string" }],
    ["substring", { role: "string" }],
    ["format", { role: "string" }],
    // mint
    ["infer", { role: "mint", integrity: "evidence" }],
    ["infer/chat", { role: "mint", integrity: "evidence" }],
    ["read-file", { role: "mint", integrity: "evidence" }],
    ["require/eval", { role: "mint", integrity: "evidence" }],
    ["now", { role: "mint", integrity: "ambient" }],
    ["uuid", { role: "mint", integrity: "ambient" }],
    ["random", { role: "mint", integrity: "ambient" }],
    // fan
    ["map", { role: "fan", fanKind: "map" }],
    ["filter", { role: "fan", fanKind: "filter" }],
    ["fold", { role: "fan", fanKind: "fold" }],
    ["reduce", { role: "fan", fanKind: "fold" }],
    ["for-each", { role: "fan", fanKind: "map" }],
  ];

  it.each(CASES)("%s → %j", (head, expected) => {
    expect(defaultRegistry.classifyHead(head)).toEqual(expected);
  });

  it.each(["sqrt", "eq?", "when", "quasiquote", "totally-made-up-head-42", "fold-left", "fold-right"])(
    "unknown head %j → opaque unknown-head, never throw/undefined (I1)",
    (name) => {
      expect(defaultRegistry.classifyHead(name)).toEqual({ role: "opaque", reason: `unknown-head/${name}` });
    },
  );

  // A plain `in`/bracket lookup on an object literal is fooled by inherited
  // Object.prototype members — `"constructor" in {}` is true though no such head
  // was ever registered. classifyHead guards with Object.hasOwn; these names
  // prove the guard, not just the happy path.
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__", "isPrototypeOf", "propertyIsEnumerable"])(
    "Object.prototype member %j does not leak through as a false classification",
    (name) => {
      expect(defaultRegistry.classifyHead(name)).toEqual({ role: "opaque", reason: `unknown-head/${name}` });
    },
  );
});

// ── the s/ namespace family rule (V's ruling, 2026-07-16) ───────────────────────

describe("defaultRegistry.classifyHead — the s/ namespace is a FAMILY rule, not an enumeration", () => {
  // Any head under the reserved `s/` type-syntax prefix fuses — never opaque,
  // regardless of whether this specific member is ever added to a table (see
  // this file's own namespace-rule comment, above `classifyHead`'s `s/`
  // check, for the full account of why fuse is the honest classification).
  it.each(["s/object", "s/field/string", "s/field/number", "s/enum", "s/array", "s/anything-not-yet-invented"])(
    "%s → fuse (unenumerated s/-prefixed heads still fuse — the family rule, not a table miss)",
    (name) => {
      expect(defaultRegistry.classifyHead(name)).toEqual({ role: "fuse" });
    },
  );

  // Precision check: the rule is an exact "s/" PREFIX test, case-sensitive —
  // it must not over-match a name that merely contains "s/" elsewhere, drops
  // the slash, or differs only in case. Each of these still falls through to
  // the unchanged unknown-head opaque default.
  it.each(["s", "s-thing", "sobject", "S/object", "this-has-s/-in-the-middle"])(
    "%j does NOT match the s/ namespace rule → unchanged unknown-head opaque",
    (name) => {
      expect(defaultRegistry.classifyHead(name)).toEqual({ role: "opaque", reason: `unknown-head/${name}` });
    },
  );
});

// ── extractContainer — Dict → BuildProv ──────────────────────────────────────────

describe("extractContainer — Dict → BuildProv", () => {
  it("empty dict", () => {
    const form = parseForm("(dict)") as Dict;
    expect(extractContainer(form, baseCtx())).toEqual({ kind: "build", site: form.id, ctor: "dict", parts: [] });
  });

  it("per-entry attribution: keys preserved in call order, literal values are const (ARM-A's real Lit handling)", () => {
    const form = parseForm(`(dict :a 1 :b "x" :c #t)`) as Dict;
    const result = extractContainer(form, baseCtx());
    if (result.kind !== "build") throw new Error("expected build");
    expect(result.site).toBe(form.id);
    expect(result.ctor).toBe("dict");
    expect(result.parts.map((p) => p.key)).toEqual(["a", "b", "c"]);
    for (const part of result.parts) expect(part.prov.kind).toBe("const");
  });

  it("keys are program text, not content: same values under different keys attribute identically", () => {
    const ctx = baseCtx();
    const d1 = parseForm(`(dict :a 1 :b 2)`) as Dict;
    const d2 = parseForm(`(dict :x 1 :y 2)`) as Dict;
    const r1 = extractContainer(d1, ctx);
    const r2 = extractContainer(d2, ctx);
    if (r1.kind !== "build" || r2.kind !== "build") throw new Error("expected build");
    expect(r1.parts.map((p) => p.prov)).toEqual(r2.parts.map((p) => p.prov));
  });

  it("delegates each entry's value to the shared extract() dispatcher, preserving key/prov pairing and order", () => {
    const ctx = baseCtx();
    const form = parseForm(`(dict :a 1 :b (quote (1 2)))`) as Dict;
    const result = extractContainer(form, ctx);
    if (result.kind !== "build") throw new Error("expected build");
    expect(result.parts).toEqual(form.entries.map((e) => ({ key: e.key, prov: extract(e.value, ctx) })));
  });

  it("nested dict recurses through extractContainer itself — no sibling arm involved", () => {
    const form = parseForm(`(dict :inner (dict :x 1))`) as Dict;
    const result = extractContainer(form, baseCtx());
    const inner = form.entries[0]!.value as Dict;
    expect(result).toEqual({
      kind: "build",
      site: form.id,
      ctor: "dict",
      parts: [
        {
          key: "inner",
          prov: {
            kind: "build",
            site: inner.id,
            ctor: "dict",
            parts: [{ key: "x", prov: { kind: "const", site: inner.entries[0]!.value.id } }],
          },
        },
      ],
    });
  });

  it("a bound overridable input flows through end-to-end as InputProv (extractProgram → extract → extractContainer)", () => {
    const { forms } = classify(desugar(parseSexprs(`(define/overridable e string "")\n(dict :name e)`)));
    const dictForm = forms.at(-1) as Dict;
    const result = extractProgram(forms, defaultRegistry);
    expect(result).toEqual({
      kind: "build",
      site: dictForm.id,
      ctor: "dict",
      parts: [{ key: "name", prov: { kind: "input", site: dictForm.entries[0]!.value.id, name: "e" } }],
    });
  });
});

// ── buildFan — arity + fn-resolution errors (fully deterministic) ───────────────

describe("buildFan — arity and fn-resolution errors (short-circuit before touching the body; no sibling arm involved)", () => {
  it("map with 2 params → fan/arity", () => {
    const fn = parseLambda("(lambda (a b) a)");
    expect(buildFan("map", 0 as NodeId, fn, collection, null, baseCtx())).toEqual({
      kind: "opaque",
      site: 0,
      reason: "fan/arity",
    });
  });

  it("filter with 0 params → fan/arity", () => {
    const fn = parseLambda("(lambda () 1)");
    expect(buildFan("filter", 0 as NodeId, fn, collection, null, baseCtx())).toEqual({
      kind: "opaque",
      site: 0,
      reason: "fan/arity",
    });
  });

  it("fold with 1 param → fan/arity", () => {
    const fn = parseLambda("(lambda (x) x)");
    expect(buildFan("fold", 0 as NodeId, fn, collection, null, baseCtx())).toEqual({
      kind: "opaque",
      site: 0,
      reason: "fan/arity",
    });
  });

  it("fold with a dotted-rest param (count matches, shape doesn't) → fan/arity", () => {
    const fn = parseLambda("(lambda (a . rest) a)");
    expect(buildFan("fold", 0 as NodeId, fn, collection, null, baseCtx())).toEqual({
      kind: "opaque",
      site: 0,
      reason: "fan/arity",
    });
  });

  it("fn is not a function form at all → fan/fn-unresolvable", () => {
    const fn = parseForm("42");
    expect(buildFan("map", 0 as NodeId, fn, collection, null, baseCtx())).toEqual({
      kind: "opaque",
      site: fn.id,
      reason: "fan/fn-unresolvable",
    });
  });

  it("fn is a Ref to nothing bound → fan/fn-unresolvable", () => {
    const fn = parseForm("unbound-name");
    expect(buildFan("map", 0 as NodeId, fn, collection, null, baseCtx())).toEqual({
      kind: "opaque",
      site: fn.id,
      reason: "fan/fn-unresolvable",
    });
  });

  it("fn is a Ref bound to a synthetic prov (no expr to inline) → fan/fn-unresolvable", () => {
    const fn = parseForm("f");
    const scope: Scope = {
      names: new Map([["f", { tag: "prov", prov: { kind: "const", site: 0 as NodeId } }]]),
      parent: null,
    };
    expect(buildFan("map", 0 as NodeId, fn, collection, null, { ...baseCtx(), scope })).toEqual({
      kind: "opaque",
      site: fn.id,
      reason: "fan/fn-unresolvable",
    });
  });

  it("fn is a Ref bound to a non-function expr → fan/fn-unresolvable", () => {
    const fn = parseForm("f");
    const litForm = parseForm("42");
    const scope: Scope = { names: new Map([["f", { tag: "expr", expr: litForm, scope: EMPTY_SCOPE }]]), parent: null };
    expect(buildFan("map", 0 as NodeId, fn, collection, null, { ...baseCtx(), scope })).toEqual({
      kind: "opaque",
      site: fn.id,
      reason: "fan/fn-unresolvable",
    });
  });

  it("fn is a Ref bound to ANOTHER Ref, which resolves to a non-function expr → fan/fn-unresolvable (the chase terminates, never guesses)", () => {
    // The chase (resolveCallee, index.ts) must fail closed at the end of a
    // multi-hop chain exactly as it does at the end of a one-hop chain — this
    // row is the two-hop analogue of the row directly above it.
    const fn = parseForm("f");
    const litForm = parseForm("42");
    const gForm = parseForm("g");
    // Self-referential scope (letrec-style — matches arm-atoms.ts's own
    // `extendForLet` idiom): `f`'s Bound must resolve `g` in THIS scope, not
    // an unrelated empty one, or the chase would (wrongly) bottom out on an
    // unbound name instead of genuinely reaching `g`'s non-function value.
    const names = new Map<string, Bound>();
    const scope: Scope = { names, parent: null };
    names.set("f", { tag: "expr", expr: gForm, scope });
    names.set("g", { tag: "expr", expr: litForm, scope });
    expect(buildFan("map", 0 as NodeId, fn, collection, null, { ...baseCtx(), scope })).toEqual({
      kind: "opaque",
      site: fn.id,
      reason: "fan/fn-unresolvable",
    });
  });

  it("fn is a Ref bound to ANOTHER Ref, which resolves to a DefineFn → resolves through the chase, NOT fan/fn-unresolvable (S6: single-sourced resolver)", () => {
    // Before single-sourcing the resolver, `resolveFanFn` only checked ONE
    // hop (`bound.tag === "expr" && isFnForm(bound.expr)`), so a fan target
    // one alias removed from its DefineFn opaqued as unresolvable — the
    // identical alias called directly (arm-control.ts's `resolveCallee`)
    // already chased through as many hops as it takes. This row pins the fix:
    // `(map step v)` with `step` bound to `Ref(inc)` now resolves.
    const { forms } = classify(desugar(parseSexprs(`(define (inc y) (+ y 1))\n(define step inc)\n(map step (list 1 2 3))`)));
    const prov = extractProgram(forms, defaultRegistry);
    expect(prov).toMatchObject({ kind: "fan" });
    if (prov.kind !== "fan") throw new Error("expected fan");
    expect(prov.body).toMatchObject({ kind: "fused" });
  });

  it("cyclic binding: the resolved lambda is already in ctx.reducing → cyclic-binding (shared reason across arms)", () => {
    const fn = parseLambda("(lambda (x) x)");
    const reducing = new Set<CoreForm>([fn]);
    expect(buildFan("map", 0 as NodeId, fn, collection, null, { ...baseCtx(), reducing })).toEqual({
      kind: "opaque",
      site: 0,
      reason: "cyclic-binding",
    });
  });
});

// ── buildFan — map/filter/fold desugar shapes ────────────────────────────────────

describe("buildFan — map/filter/fold desugar shapes (bodies stay within ARM-A + ARM-C, avoiding the ARM-B App/If gap)", () => {
  it("map: an identity lambda's body is exactly the element projection — collapse ROUTE (route-last, ignores acc)", () => {
    const fn = parseLambda("(lambda (x) x)");
    const result = buildFan("map", 7 as NodeId, fn, collection, null, baseCtx());
    expect(result).toEqual({
      kind: "fan",
      site: 7,
      collection,
      body: { kind: "mux", site: fn.id, key: null, source: collection },
      collapse: "route",
    });
  });

  it("filter: body wraps the predicate in a choice whose alt is the kept element — collapse ROUTE (selection mask)", () => {
    const fn = parseLambda("(lambda (x) x)");
    const result = buildFan("filter", 7 as NodeId, fn, collection, null, baseCtx());
    const element: StaticProv = { kind: "mux", site: fn.id, key: null, source: collection };
    expect(result).toEqual({
      kind: "fan",
      site: 7,
      collection,
      body: { kind: "choice", site: fn.id, guards: [element], alts: [element] },
      collapse: "route",
    });
  });

  it("fold: param0 binds to init, referencing it flows init straight through", () => {
    const fn = parseLambda("(lambda (acc x) acc)");
    const init: StaticProv = { kind: "const", site: 3 as NodeId };
    const result = buildFan("fold", 7 as NodeId, fn, collection, init, baseCtx());
    expect(result).toEqual({ kind: "fan", site: 7, collection, body: init, collapse: "lowered" });
  });

  it("fold: param1 binds to the element, independent of acc/init — collapse ROUTE (route-last, ignores acc)", () => {
    const fn = parseLambda("(lambda (acc x) x)");
    const result = buildFan("fold", 7 as NodeId, fn, collection, null, baseCtx());
    expect(result).toEqual({
      kind: "fan",
      site: 7,
      collection,
      body: { kind: "mux", site: fn.id, key: null, source: collection },
      collapse: "route",
    });
  });

  it("fold: a missing init is a normal (if maximally uninformative) binding, not a whole-call short-circuit — " +
    "the opaque flows through AS the fan's body, the Fan wrapper (site/collection) stays intact", () => {
    const fn = parseLambda("(lambda (acc x) acc)");
    const result = buildFan("fold", 7 as NodeId, fn, collection, null, baseCtx());
    expect(result).toEqual({
      kind: "fan",
      site: 7,
      collection,
      body: { kind: "opaque", site: 7, reason: "fan/fold-missing-init" },
      collapse: "lowered",
    });
  });

  it("map body composing ARM-C's own Dict container (cross-checks extractContainer + buildFan together)", () => {
    const fn = parseLambda("(lambda (x) (dict :v x))");
    const result = buildFan("map", 7 as NodeId, fn, collection, null, baseCtx());
    const element: StaticProv = { kind: "mux", site: fn.id, key: null, source: collection };
    const dictForm = fn.body.at(-1) as Dict;
    expect(result).toEqual({
      kind: "fan",
      site: 7,
      collection,
      body: { kind: "build", site: dictForm.id, ctor: "dict", parts: [{ key: "v", prov: element }] },
      collapse: "lowered",
    });
  });

  it("collapse is INFERRED per body shape (T3a contract correction 2026-07-15): route for a selection body, lowered for a combinator body", () => {
    // Superseded the pre-T3a "unconditionally lowered" premise. buildFan owns
    // combine (needs the raw head — none of these bodies is a bare AC head);
    // inferCollapse owns route-vs-lowered over the extracted body.
    const identity = buildFan("map", 7 as NodeId, parseLambda("(lambda (x) x)"), collection, null, baseCtx());
    expect(identity.kind === "fan" && identity.collapse).toBe("route"); // body IS the element — route-last
    const builder = buildFan("map", 7 as NodeId, parseLambda("(lambda (x) (dict :v x))"), collection, null, baseCtx());
    expect(builder.kind === "fan" && builder.collapse).toBe("lowered"); // body is a build combinator — stays lowered
  });
});

// ── the hidden-const fold shape ──────────────────────────────────────────────────

describe("hidden-const fold shape (adversarial forge, fixture-corpus row 3)", () => {
  // Gated on ARM-B: the body is `(if (= x "s") "FABRICATED" x)` — If is
  // arm-control.ts's case, still a G1 stub as of this writing (`extractControl`
  // returns opaque("unimplemented/arm-b/If")), so `body` below is that opaque
  // value rather than a ChoiceProv. This is NOT a claim that ARM-C's own collapse
  // logic is unproven — the dedicated "collapse is unconditionally lowered" test
  // above already covers that from ARM-C's side alone. This row is the one that
  // needs BOTH arms: flip `.fails` off once arm-control.ts lands `If` (mirrors
  // extract-corpus.test.ts's own J1 convention — a row that stays red at J1 is a
  // real defect, one that goes green early means a stub stopped being a stub
  // without the merge owner knowing).
  it("fold+if: collapse stays lowered, the const alt stays a visible const — never collapses to combine", () => {
    const fn = parseLambda(`(lambda (acc x) (if (= x "s") "FABRICATED" x))`);
    const init: StaticProv = { kind: "const", site: 1 as NodeId };
    const result = buildFan("fold", 7 as NodeId, fn, collection, init, baseCtx());
    expect(result.kind).toBe("fan");
    if (result.kind !== "fan") throw new Error("expected fan");
    expect(result.collapse).toBe("lowered");
    expect(result.body.kind).toBe("choice");
    if (result.body.kind !== "choice") throw new Error("expected choice");
    expect(result.body.alts.some((a) => a.kind === "const")).toBe(true);
  });
});
