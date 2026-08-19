/**
 * Phase-1 symbol rules — every rule through the REAL pipeline (parse → desugar →
 * classify → walk(withRules overlay) → render) to inline goldens (pinned
 * typescript@6.0.2 printer bytes: 4-space indent, LF, trailing newline), plus the
 * withRules overlay contract: table-first lookup, base enrichment, names union, the
 * Law-N witness gate, narrows carriage into the type-emit grammar's key set, and the
 * doorCategory seam.
 *
 * Fact-directed rules (`not`, `filter`) used to run their Law-F clean/conservative
 * split through THIS file's own `emitWithArgFacts` helper, against the EMPTY-based
 * registry below. Both have since relocated onto their own Contract (`not`:
 * equality.ts, Wave 2; `filter`: srfi-1.ts, Wave 3) and carry that same proof at the
 * Contract level now (equality-emit.test.ts / srfi-1-emit.test.ts) — `filter`'s table
 * row stayed for a full follow-up wave (`scheme/srfi-1` was invisible to the oracle's
 * harvest; see phase1.ts's own relocation note), but that ambient gap is now closed
 * (oracle/harness.ts's `greenfieldRegistryFor`), so `emitWithArgFacts` is RETIRED here
 * — it has no registry left to be useful against (this file's EMPTY base can no
 * longer resolve `filter` at all; the full-pipeline proof runs through the real
 * harvest instead, exactly like `not`'s already did).
 */
import { describe, expect, it } from "vitest";

import {
  classify,
  type ClassifyResult,
  type CompilationUnit,
  desugar,
  type EmitRegistry,
  type EmitRegistryRow,
  narrowsMembersOf,
  parseSexprs,
  phase1Rules,
  render,
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

// ── §2.1 representation collapse: car / cdr ─────────────────────────────────────────────

describe("car / cdr — syntax over the array representation (§4.3, Law U)", () => {
  it("car → xs[0], unconditionally (no guard, no shim, no mode)", () => {
    // `xs` is used ONLY through this single car access — engine plan §2 E1a
    // moved implicit destruction INTO walk() itself (naming/census.ts's
    // use-shape analysis + naming/allocate.ts's naming policy), so this now
    // destructures to a one-slot ArrayPattern (see walker.test.ts's own
    // analogous golden and legibility.test.ts's "implicit destruction"
    // describe block).
    expect(emit(`(define (f xs) (car xs))`)).toBe(`function f([head]) {\n    return head;\n}\n`);
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

// ── map / apply / filter — RELOCATED (Phase-2 relocation drill, constitution §9,
// Wave 3) ──────────────────────────────────────────────────────────────────────────
// None of the three carries a RULE in `phase1Rules` anymore — each is now the `emit`
// field of its own Contract (map/apply: foundations/arrival/arrival/src/env/r7rs/
// lists.ts; filter: foundations/arrival/arrival/src/env/srfi/srfi-1.ts), so this
// file's EMPTY-based registry (`withRules(EMPTY, phase1Rules)`, above) can no longer
// resolve their APPLICATION-position residuals (there is neither a table rule nor a
// base row to fall through to). Their coverage now lives in two places: the
// Contract-level rule-shape proof (lists-emit.test.ts for map/apply,
// srfi-1-emit.test.ts for filter, each calling `emit.call` directly against a
// synthetic ctx) and the full-pipeline proof through the REAL harvest —
// cross-pass-fixtures.test.ts's/gate3-goldens.test.ts's byte-level goldens
// (multi-list-map, apply-plus, apply-map-transpose, filter-truthy-zero) and
// bug-cell-corpus.test.ts's value-level oracle rows, all of which build their
// registry via `withRules(emitRegistryOf(session.ambient), phase1Rules)` — the
// harvested Contract row, not this file's stand-in table. (None of the three has a
// dedicated bug-cell row of its own but all are exercised pervasively across the
// existing corpus — also unchanged.)
//
// `filter` was the ONE Wave-3 symbol whose table row STAYED past this wave (and with
// it, a describe block here running `emitWithArgFacts` against the EMPTY registry):
// `scheme/srfi-1` was invisible to the oracle's harvest (see phase1.ts's own
// relocation note for the full account). That ambient gap is now CLOSED
// (oracle/harness.ts's `greenfieldRegistryFor` merges srfi-1's static harvest under
// the real ambient's own) — filter's table row is deleted, `emitWithArgFacts` is
// retired (see this file's header), and its fact-flip proof now runs exclusively
// through the real harvest, same as `not`'s already did.

// ── infer family — RELOCATED (R2, arrival-mercury constitution §9) ───────────────────
// The infer family's five real Contract-backed symbols (infer, infer/chat,
// infer/chat/system, infer/chat/user, infer/chat/assistant) no longer carry a RULE in
// `phase1Rules` — each is now the `emit` field of its own Contract in
// `@inhuman.tools/llm-plane/arrival-env`'s `src/infer.ts` (`arrivalInferCapability`),
// so this file's EMPTY-based registry (`withRules(EMPTY, phase1Rules)`, above) can no
// longer resolve their APPLICATION-position residuals (there is neither a table rule
// nor a base row to fall through to — `compile(...)`'s registry has no base at all,
// unlike the real harvest). Their coverage now lives in two places: the Contract-level
// rule-shape proof (llm-plane-arrival-env/src/__tests__/infer-emit.test.ts, calling
// `emit.call` directly against a synthetic ctx — the "sync-shaped, no Await" and
// "Call(RuntimeRef(verb), args)" goldens this describe block used to hold moved
// there verbatim) and the full-pipeline proof through the REAL harvest —
// legibility.test.ts's async-pipeline CSE test and model-spine.test.ts both compile
// `(infer …)` through `withRules(emitRegistryOf(session.ambient), phase1Rules)` —
// the harvested Contract row, not this file's stand-in table — unchanged by the
// relocation. (The infer family has no dedicated bug-cell row of its own but is
// exercised pervasively across the existing corpus, also unchanged.)
//
// `infer/scalar`/`infer/chat/scalar` — the infer-scalar-fold peephole's synthetic
// dispatch heads — are NOT part of this relocation (see phase1.ts's own relocation
// note): they back no Contract at all, so `phase1Rules` keeps their table rows.

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
    // "every" (was "modulo" pre-Wave-1, then "filter" pre-ambient-fix — both since
    // grew Contract-side rules and left this table entirely; "every" is the durable
    // exemplar here: a bare-presence SRFI-1 wiring-fix row that stays table-resident
    // even though its own Contract now ALSO harvests (the same ambient-gap fix that
    // let filter's row go) — see phase1.ts's own note on why `every`/`any` stay
    // regardless.)
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
