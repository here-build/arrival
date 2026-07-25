/**
 * Wave-B pipeline smoke — the WHOLE compiler spine in one breath, through the
 * package barrel: source string → classify → extractFacts (type-emit + tsc over
 * the real lens prelude) → walk(facts) → render.
 *
 * The one program under test: `(define (f xs) (if (null? xs) 0 (car xs)))`.
 * It crosses every Wave-A/Wave-B seam at once:
 *
 *   - registry → grammar: `narrowsMembersOf` reduces the `null?` row's Law-N
 *     `narrows` declaration to the key set `emitTypes` consumes, so the
 *     condition emits as the BARE NForm `null$qmark$(xs)` (boolean-typed);
 *   - tsc → facts: `extractFacts` derives `{ boolean: true }` on the condition
 *     App node, keyed by the SAME NodeIds `walk` reads (`extraction.facts`
 *     flows into `WalkOptions.facts` with no cast — the type-alignment proof);
 *   - facts → Law T: with the boolean fact the walker drops the `!== false`
 *     guard (the flip); with facts absent the guard stays (Law F: absence of a
 *     fact is only ever conservative, never wrong);
 *   - App ladder: `null?` rides rung 1 (its emit rule), `car` has no rule and
 *     falls to rung 3 — the RuntimeRef shim — so the identifier-shaped name
 *     `car` appears in the output and `runtimeRefsOf` reports it (the census
 *     seam FRAME turns into an import), while the ruled `null?` does NOT.
 */
import { describe, expect, it } from "vitest";

import type { EmitRule } from "@inhuman.tools/arrival/emit";

import {
  classify,
  type DefineFn,
  desugar,
  type EmitRegistry,
  type EmitRegistryRow,
  extractFacts,
  type If as CfIf,
  narrowsMembersOf,
  parseSexprs,
  render,
  runtimeRefsOf,
  walk,
} from "../index.js";
// Residual constructors are deliberately not on the public barrel yet (they
// surface with the symbol-rules wave); test rules reach them directly.
import { Bin, Lit, Member, type R } from "../residual/types.js";

const SRC = `(define (f xs) (if (null? xs) 0 (car xs)))`;

// ── the smoke registry: one ruled+narrows row, one unruled (shim) row ────────

/** `null?` over the array representation of lists — the honest rung-1 rule. */
const nullQRule: EmitRule<R> = {
  call: ([xs], ctx) =>
    xs === undefined ? ctx.door("null? wants exactly 1 argument") : Bin("===", Member(xs, "length"), Lit(0)),
};

const rows: EmitRegistryRow[] = [
  {
    symbol: "null?",
    capability: "«smoke»",
    kind: "rosetta",
    refPolicy: "shim",
    emit: nullQRule,
    narrows: { witness: "null?" },
  },
  // No emit rule → the App ladder's rung 3: the RuntimeRef shim.
  { symbol: "car", capability: "«smoke»", kind: "rosetta", refPolicy: "shim" },
];
const registry: EmitRegistry = (() => {
  const m = new Map(rows.map((r) => [r.symbol, r]));
  return { lookup: (n) => m.get(n), names: new Set(m.keys()) };
})();

describe("pipeline smoke: classify → extractFacts → walk → render", () => {
  it("the registry reduces to narrows={null?}", () => {
    expect(narrowsMembersOf(registry)).toEqual(new Set(["null?"]));
  });

  it("facts regime: the condition emits the NARROWED bare form; car shims through RuntimeRef", () => {
    const extraction = extractFacts(SRC, { narrowsMembers: narrowsMembersOf(registry) });
    expect(extraction.parseFailure).toBe(false);
    const classified = extraction.classified!;

    // The extraction proved the flip's premise at the exact NodeId walk reads.
    const cond = ((classified.forms[0] as DefineFn).body[0] as CfIf).cond;
    expect(extraction.facts.get(cond.id)).toEqual({ boolean: true });

    // extraction.facts → WalkOptions.facts with NO cast — the alignment proof.
    const unit = walk(classified, { registry, facts: extraction.facts, register: "run" });
    expect(render(unit)).toBe(`function f(xs) {\n    return xs.length === 0 ? 0 : car(xs);\n}\n`);

    // The census carries exactly the unruled shim — FRAME's import seam.
    expect([...runtimeRefsOf(unit)]).toEqual(["car"]);
  });

  it("empty facts, same classification: the conservative !== false guard (Law F)", () => {
    const extraction = extractFacts(SRC, { narrowsMembers: narrowsMembersOf(registry) });
    const unit = walk(extraction.classified!, { registry, register: "run" });
    expect(render(unit)).toBe(`function f(xs) {\n    return xs.length === 0 !== false ? 0 : car(xs);\n}\n`);
    expect([...runtimeRefsOf(unit)]).toEqual(["car"]);
  });

  it("a fresh classification (no extraction in sight) renders byte-identically to the empty regime", () => {
    const fresh = walk(classify(desugar(parseSexprs(SRC))), { registry, register: "run" });
    const emptyRegime = walk(extractFacts(SRC, { narrowsMembers: narrowsMembersOf(registry) }).classified!, {
      registry,
      register: "run",
    });
    expect(render(fresh)).toBe(render(emptyRegime));
  });
});
