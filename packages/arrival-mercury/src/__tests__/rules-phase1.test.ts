/**
 * Phase-1 symbol rules — every rule through the REAL pipeline (parse → desugar →
 * classify → walk(withRules overlay) → render) to inline goldens (pinned
 * typescript@6.0.2 printer bytes: 4-space indent, LF, trailing newline), plus the
 * withRules overlay contract: table-first lookup, base enrichment, names union, the
 * Law-N witness gate, narrows carriage into the type-emit grammar's key set, and the
 * doorCategory seam.
 *
 * Fact-directed rules (`not`, `filter`) run their Law-F clean/conservative split
 * through THIS file's own `emitWithArgFacts` helper (facts absent → the conservative
 * form; `{ boolean: true }` on the ARGUMENT node, Law A — argument facts → the clean
 * flip; read register → clean unconditionally, constitution §1). `not` has since
 * relocated onto its own Contract (equality.ts, Wave 2) and carries that same proof at
 * the Contract level now (equality-emit.test.ts). `filter` ALSO grew a Contract emit
 * rule this wave (srfi-1.ts, Wave 3, proven independently by srfi-1-emit.test.ts) —
 * but UNLIKE `not`, its table row stays: `scheme/srfi-1` is invisible to the oracle's
 * harvest (see phase1.ts's own relocation note for the full account), so this file's
 * `emitWithArgFacts` proof below remains the reachable end-to-end coverage for
 * filter's fact-gated split, not a retired stand-in.
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

// ── §2.1 representation collapse: car / cdr ─────────────────────────────────────────────

describe("car / cdr — syntax over the array representation (§4.3, Law U)", () => {
  it("car → xs[0], unconditionally (no guard, no shim, no mode)", () => {
    expect(emit(`(define (f xs) (car xs))`)).toBe(`function f(xs) {\n    return xs[0];\n}\n`);
  });

  it("cdr → xs.slice(1)", () => {
    expect(emit(`(define (f xs) (cdr xs))`)).toBe(`function f(xs) {\n    return xs.slice(1);\n}\n`);
  });

  it("fixed-arity mis-call doors at compile time (totality, never a walker crash)", () => {
    expect(() => emit(`(define (f) (car))`)).toThrow(WalkDoorError);
    expect(() => emit(`(define (f) (car))`)).toThrow(/wants exactly 1 argument/);
  });
});

// ── cons / not / null? / pair? / + / - / * / / — RELOCATED (Phase-2 relocation drill,
// constitution §9, Wave 2) ──────────────────────────────────────────────────────────────
// None of these eight carry a RULE in `phase1Rules` anymore — each is now the `emit`
// field of its own Contract (cons: foundations/arrival/arrival/src/env/r7rs/lists.ts;
// not/null?/pair?: .../equality.ts; +/-/*//: .../numeric.ts), so this file's
// EMPTY-based registry (`withRules(EMPTY, phase1Rules)`, above) can no longer resolve
// any of their APPLICATION-position residuals (there is neither a table rule nor a
// base row to fall through to). `+`/`*` no longer carry even a bare presence row
// either (Wave 3 deleted it — see phase1.ts's own note): the row existed solely so
// the `apply` describe block below could exercise `applyRule`'s FOLD_OPS structural
// recognition, and `apply` itself relocated out of this table the same wave. Their
// coverage now lives in two places: the Contract-level rule-shape proof
// (foundations/arrival/arrival/src/env/r7rs/__tests__/lists-emit.test.ts,
// equality-emit.test.ts, numeric-emit.test.ts, calling `emit.call` directly against a
// synthetic ctx) and the full-pipeline proof through the REAL harvest — cross-pass-
// fixtures.test.ts's/gate3-goldens.test.ts's byte-level goldens and bug-cell-corpus
// .test.ts's value-level oracle rows, both of which build their registry via
// `withRules(emitRegistryOf(session.ambient), phase1Rules)` — the harvested Contract
// row, not this file's stand-in table. (Arithmetic/cons/not/null?/pair? have no
// dedicated bug-cell row of their own, unlike quotient/modulo/= below, but are
// exercised pervasively across the existing corpus — also unchanged.)

// ── = / quotient / modulo — RELOCATED (Phase-2 relocation drill, constitution §9,
// Wave 1) ────────────────────────────────────────────────────────────────────────────
// These three no longer live in `phase1Rules` — they're now the `emit` field of their
// own Contract in foundations/arrival/arrival/src/env/r7rs/numeric.ts, so this file's
// EMPTY-based registry (`withRules(EMPTY, phase1Rules)`, above) can no longer resolve
// them at all (there is neither a table row nor a base row to fall through to). Their
// coverage now lives in two places: the Contract-level rule-shape proof
// (foundations/arrival/arrival/src/env/r7rs/__tests__/numeric-emit.test.ts, calling
// `emit.call` directly against a synthetic ctx) and the full-pipeline proof through the
// REAL harvest — cross-pass-fixtures.test.ts's quotient-neg/modulo-neg byte-level
// goldens and bug-cell-corpus.test.ts's quotient-neg/modulo-neg/exact-vs-inexact-eq
// value-level oracle rows, both of which build their registry via
// `withRules(emitRegistryOf(session.ambient), phase1Rules)` — the harvested Contract
// row, not this file's stand-in table.

// ── map / apply — RELOCATED (Phase-2 relocation drill, constitution §9, Wave 3) ──────
// Neither carries a RULE in `phase1Rules` anymore — both are now the `emit` field of
// their own Contract in foundations/arrival/arrival/src/env/r7rs/lists.ts, so this
// file's EMPTY-based registry (`withRules(EMPTY, phase1Rules)`, above) can no longer
// resolve their APPLICATION-position residuals (there is neither a table rule nor a
// base row to fall through to). Their coverage now lives in two places: the
// Contract-level rule-shape proof (foundations/arrival/arrival/src/env/r7rs/
// __tests__/lists-emit.test.ts, calling `emit.call` directly against a synthetic ctx)
// and the full-pipeline proof through the REAL harvest — cross-pass-fixtures.test.ts's/
// gate3-goldens.test.ts's byte-level goldens (multi-list-map, apply-plus,
// apply-map-transpose) and bug-cell-corpus.test.ts's value-level oracle rows, both of
// which build their registry via `withRules(emitRegistryOf(session.ambient),
// phase1Rules)` — the harvested Contract row, not this file's stand-in table.
// (Neither has a dedicated bug-cell row of its own but both are exercised pervasively
// across the existing corpus — also unchanged.)
//
// `filter` — the ONE Wave-3 symbol whose table row STAYS (and with it, this file's
// describe block below): its Contract twin (srfi-1.ts's `filterEmitRule`, proven by
// srfi-1-emit.test.ts) is unreachable through the real harvest because
// `scheme/srfi-1` is not part of the oracle's ambient — see phase1.ts's own
// relocation note for the full account.

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
    // "every" (was "modulo" pre-Wave-1, then "filter" — both since grew Contract-side
    // rules; "every" is the durable exemplar: a bare-presence SRFI-1 wiring-fix row
    // that stays table-only until the srfi-1 pack lands registry-side. "filter" would
    // still work today — its row stays, see the relocation note above — but points at
    // a row scheduled to leave.)
    const row = overlaid.lookup("every");
    expect(row?.capability).toBe("«phase1-rules»");
    expect(row?.kind).toBe("native");
    expect(row?.refPolicy).toBe("shim");
  });

  it("names is the union", () => {
    expect(overlaid.names.has("reverse")).toBe(true);
    expect(overlaid.names.has("every")).toBe(true);
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
  // `null?`/`pair?` used to be this test's live examples, but the Phase-2 relocation
  // (Wave 2) moved their `narrows` declaration onto their own Contracts (equality.ts),
  // so `phase1Rules` no longer carries ANY narrows-flagged row — this file's
  // EMPTY-based registry can no longer demonstrate the mechanism off a real table
  // entry. A synthetic self-witnessing table (same convention the "unregistered
  // witness" test below already uses) proves the SAME overlay mechanism —
  // narrowsMembersOf's real-registry reduction (with `null?`/`pair?` resolved via the
  // harvested Contract) is covered by narrows-fuzz.test.ts and type-emit.test.ts.
  it("table narrows surface on rows and feed the type-emit grammar's key set", () => {
    const synthetic = withRules(EMPTY, {
      "foo?": { emit: phase1Rules["car"]!.emit, narrows: { witness: "foo?" } },
      "bar?": { emit: phase1Rules["cdr"]!.emit, narrows: { witness: "bar?" } },
    });
    expect(synthetic.lookup("foo?")?.narrows).toEqual({ witness: "foo?" });
    expect(synthetic.lookup("bar?")?.narrows).toEqual({ witness: "bar?" });
    // narrowsMembersOf is the SAME reduction type-emit consumes (§5.3's NForm gate) —
    // overlay rows must be indistinguishable from Contract-carried ones here.
    expect(narrowsMembersOf(synthetic)).toEqual(new Set(["foo?", "bar?"]));
  });

  it("phase1Rules itself carries zero narrows-flagged rows post-relocation (car/cdr/infer* declare none; map/filter/apply are gone from the table entirely, Wave 3)", () => {
    expect(narrowsMembersOf(registry)).toEqual(new Set());
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
