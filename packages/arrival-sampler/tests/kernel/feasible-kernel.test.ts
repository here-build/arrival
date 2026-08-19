// feasible-kernel.test.ts — THE ADVERSARIAL DRIVE of the pure feasibility kernel (`isCandidateLive`).
//
// The discipline (V): drive the kernel `feasible(generated, token)` directly, model-free, and put the
// structurally-WRONG token in AS the candidate — then assert the kernel VETOES it. These are the tests
// a green unit-suite over a broken LIVE decode could not have: each one names a gate (repeat-keyword,
// operator-slot, structure, Σ, profile-advance) and FAILS if that gate regresses. No tokenizer, no
// model, no logits — just the kernel composing the oracle ∩ Σ ∩ grammar ∩ structure ∩ profile gates.
//
// Setup mirrors positional-keyed-profile.test.ts: a grant env (the function operator + the
// list/array materializer callables + value symbols Σ admits) built inline so the sampler test stays
// import-free, and a POSITIONAL-KEYED ToolCallProfile pinning the required-keyword order.

// Resolved to arrival-scheme SOURCE via vitest alias (see vitest.config.ts) — the REAL oracle.

import { makeOracle, oracleEnvFromBindings } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import { isCandidateLive, type ToolCallProfile } from "../../src/mask-compiler.js";
import type { OracleScanner, OracleState } from "../../src/oracle-types.js";

// The kernel under test is `isCandidateLive` (mask-compiler.ts) — the one predicate every decode
// strategy composes. These local closures give it the `(generated, token)` view a strategy builds
// inline: `makeFeasible` curries scanner+profile, `closeable` reads the analyze() completion bit.
// They are byte-for-byte `isCandidateLive(scanner, g, t, profile, scanner.analyze(g))` — NOT a shipped
// wrapper (that orphan was swept), so the adversarial suite below drives the real kernel directly.
const makeFeasible =
  (scanner: OracleScanner, profile?: ToolCallProfile) =>
  (generated: string, token: string): boolean =>
    isCandidateLive(scanner, generated, token, profile, scanner.analyze(generated));
const closeable = (scanner: OracleScanner, generated: string): boolean => scanner.analyze(generated).closeable;

/** Identity stand-in for a callable binding value (a function value ⇒ callable in arrival's env). */
const callable = (x: unknown): unknown => x;

// A grant env mirroring a BFCL function `calculate_emissions` with three required params
// (distance / fuel_type / fuel_efficiency). Binds the operator + the `list`/`array` argument
// callables the adapter always binds + a value symbol Σ admits at a value slot. The SAME env shape
// `bfclToGrantEnv` builds, constructed here so the test stays import-free.
function grantEnvEmissions(): ReturnType<typeof makeOracle> {
  const env = oracleEnvFromBindings({
    calculate_emissions: callable,
    list: callable,
    array: callable,
    diesel: callable, // a value symbol Σ admits at a keyword's value slot.
  });
  return makeOracle(env);
}

// The positional-keyed profile: every arg a `:keyword value` pair, the three required keywords forced
// in declaration order. `requiredCount` is ignored in this variant but kept honest (= required.length).
const PROFILE: ToolCallProfile = {
  requiredCount: 3,
  optionalKeywords: [],
  requiredKeywords: ["distance", "fuel_type", "fuel_efficiency"],
};

// ── 1. REPEAT veto — a just-placed required keyword cannot recur (V's exact case) ────────────────────
//
// NOTE on the prefix (adaptation of V's literal string): the candidate must arrive at a TOP-LEVEL TOKEN
// BOUNDARY, i.e. the accepted prefix ends in whitespace, or the lexer GLUES the value and the keyword
// into one atom (`12000:distance`) and the keyword-order gate never sees a distinct keyword token — the
// candidate would then be admitted as a (malformed) value continuation, a FALSE pass. So the prefix is
// `"(calculate_emissions :distance 12000 "` (trailing space) — the boundary at which `:distance` is a
// fresh top-level keyword. (Confirmed against the oracle: without the space the verdict is "feasible"
// for the wrong reason; with it the repeat veto fires "structural".)
describe("feasible kernel — REPEAT veto: a placed required keyword cannot recur even if ranked top-1", () => {
  const feasible = makeFeasible(grantEnvEmissions(), PROFILE);

  it("vetoes `:distance` right after `:distance 12000` (the next forced keyword is `:fuel_type`)", () => {
    expect(feasible("(calculate_emissions :distance 12000 ", ":distance")).toBe(false);
  });
});

// ── 2. OPERATOR-SLOT veto — a keyword cannot be the operator (the bug that just bit us) ──────────────
describe("feasible kernel — OPERATOR-SLOT veto: a `:keyword` may not stand in the operator slot", () => {
  const feasible = makeFeasible(grantEnvEmissions(), PROFILE);

  it("vetoes `:distance` at the bare-`(` operator slot (must be a bare function symbol)", () => {
    // The live `(:distance …` bug: the operator was filled with a forced keyword instead of `calculate_emissions`.
    expect(feasible("(", ":distance")).toBe(false);
  });
  it("ADMITS the bare function symbol at the operator slot (the legal opener)", () => {
    expect(feasible("(", "calculate_emissions")).toBe(true);
    expect(feasible("(", "calc")).toBe(true); // a live PREFIX of the bound operator survives.
  });
});

// ── 3. POSITIVE advance — the NEXT required keyword is live ──────────────────────────────────────────
describe("feasible kernel — POSITIVE advance: the next required keyword in order is live", () => {
  const feasible = makeFeasible(grantEnvEmissions(), PROFILE);

  it("admits `:fuel_type` after `:distance 12000` (the 2nd required keyword)", () => {
    expect(feasible("(calculate_emissions :distance 12000 ", ":fuel_type")).toBe(true);
  });
  it("admits a PREFIX of the next required keyword (`:fuel`)", () => {
    expect(feasible("(calculate_emissions :distance 12000 ", ":fuel")).toBe(true);
  });
  it("vetoes skipping to the 3rd required keyword (`:fuel_efficiency` before `:fuel_type`)", () => {
    expect(feasible("(calculate_emissions :distance 12000 ", ":fuel_efficiency")).toBe(false);
  });
});

// ── 4. STRUCTURE gate — a type-stamped slot vetoes the wrong literal SHAPE ───────────────────────────
//
// The list-structure gate (`violatesValueStructure`) keys off `OracleState.slotIsArray`, which the
// BASE structural oracle leaves UNSET — it is stamped only by the async typed scanner / type lens. So
// to drive the gate THROUGH the kernel we wrap the real oracle in a tiny synchronous scanner that
// stamps `slotIsArray` on the analyzed state at the keyword-VALUE slot, exactly as `narrowByTypeAsync`
// does at runtime (`feasible` delegates to the base; `analyze` re-presents the state with the stamp).
// This proves the kernel's `scanner.analyze(generated)` slot-state term reaches the structure gate.
describe("feasible kernel — STRUCTURE gate: a type-stamped slot vetoes the wrong literal shape", () => {
  /** Wrap `base` so the value slot at the END of `valuePrefix` reports `slotIsArray`. Mirrors the
   *  runtime typed scanner: delegate `feasible`, restamp the `analyze` state at that one slot. */
  function withSlotArrayAt(base: OracleScanner, valuePrefix: string, isArray: boolean): OracleScanner {
    return {
      feasible: (prefix) => base.feasible(prefix),
      analyze: (prefix): OracleState => {
        const st = base.analyze(prefix);
        if (prefix !== valuePrefix) return st;
        return { ...st, slotIsArray: isArray };
      },
    };
  }

  it("ARRAY slot vetoes a scalar-literal opener (a string) and admits a list materializer", () => {
    // A non-keyed profile (free positional) so the structure gate, not the keyword gate, is the only
    // thing that can veto at this value slot.
    const noKey: ToolCallProfile = { requiredCount: 1, optionalKeywords: [] };
    const arrAt = withSlotArrayAt(grantEnvEmissions(), "(calculate_emissions ", true);
    const feasible = makeFeasible(arrAt, noKey);
    // array slot: a scalar literal opener is wrong-shape → vetoed.
    expect(feasible("(calculate_emissions ", '"diesel"')).toBe(false);
    expect(feasible("(calculate_emissions ", "5")).toBe(false);
    // array slot: the list materializers + a `(`-call survive (the lens narrows the callee).
    expect(feasible("(calculate_emissions ", "'")).toBe(true); // '(…) quote-list opener
    expect(feasible("(calculate_emissions ", "(")).toBe(true); // (list …) call opener
  });

  it("SCALAR slot vetoes a list-literal opener (`[` / `'`) and admits a scalar", () => {
    const noKey: ToolCallProfile = { requiredCount: 1, optionalKeywords: [] };
    const scaAt = withSlotArrayAt(grantEnvEmissions(), "(calculate_emissions ", false);
    const feasible = makeFeasible(scaAt, noKey);
    // scalar slot: a quote-list / vector literal opener is wrong-shape → vetoed.
    expect(feasible("(calculate_emissions ", "'")).toBe(false);
    expect(feasible("(calculate_emissions ", "[")).toBe(false);
    // scalar slot: a scalar literal survives.
    expect(feasible("(calculate_emissions ", '"diesel"')).toBe(true);
    expect(feasible("(calculate_emissions ", "42")).toBe(true);
  });

  it("an UNSTAMPED slot (base oracle, slotIsArray unset) never structure-gates (no-op)", () => {
    // Sanity: through the bare scanner the structure gate is inert — a scalar at an argument slot is fine.
    const noKey: ToolCallProfile = { requiredCount: 1, optionalKeywords: [] };
    const feasible = makeFeasible(grantEnvEmissions(), noKey);
    expect(feasible("(calculate_emissions ", '"diesel"')).toBe(true);
  });
});

// ── 5. Σ gate — an unbound operator-symbol prefix that no bound symbol extends is vetoed ─────────────
describe("feasible kernel — Σ gate: an unbound operator prefix (no bound symbol extends it) is vetoed", () => {
  const feasible = makeFeasible(grantEnvEmissions(), PROFILE);

  it("vetoes a fully-unbound operator symbol (`zzz` prefixes no bound callable)", () => {
    expect(feasible("(", "zzz")).toBe(false);
  });
  it("vetoes an unbound operator FRAGMENT (`xy` prefixes nothing bound)", () => {
    expect(feasible("(", "xy")).toBe(false);
  });
  it("ADMITS a live prefix of the one bound operator (`calc` → `calculate_emissions`)", () => {
    expect(feasible("(", "calc")).toBe(true);
  });
});

// ── 6. PHANTOM-LIST veto — `'(list …)` masks the bare symbol `list` as a quote-list's first datum ─────
//
// The conflation bug: the constrained decoder emits `'(list "a" "b")` — a quoted list whose FIRST datum is
// the bare symbol `list` (the model fusing the `(list …)` constructor with the `'(…)` quote-list surface).
// The downstream scorer then reads that literal `list` as element #0 of the array. The grammar gate masks
// the candidate that places it. Driven through the KERNEL (`feasible(generated, token)`), no profile — the
// phantom-list veto lives in the tool-call grammar tightening, independent of the kwargs/keyed shape. The
// grant env binds `list` so the REAL constructor `(list …)` stays Σ-live (proving the veto is quote-scoped,
// not a blanket ban on the symbol `list`).
describe("feasible kernel — PHANTOM-LIST veto: `'(list …)` is masked, `(list …)` and `list-ref` are not", () => {
  const feasible = makeFeasible(grantEnvEmissions()); // NO profile — the grammar gate is the lever here.

  // The four V-specified kernel assertions.
  it("VETOES `list` as the first datum of a `'(`-opened quote-list (the phantom)", () => {
    expect(feasible("'(", "list")).toBe(false);
  });
  it("ADMITS a normal first datum `open` after `'(`", () => {
    expect(feasible("'(", "open")).toBe(true);
  });
  it("ADMITS the real `(list …)` constructor — a `(`-call, NO leading quote", () => {
    expect(feasible("(", "list")).toBe(true);
  });
  it("ADMITS `list-ref` after `'(` — a longer atom, NOT the complete bare `list`", () => {
    expect(feasible("'(", "list-ref")).toBe(true);
  });

  // MID-ATOM vs COMPLETE-ATOM: exact-string match on the first-datum atom does the split. The candidate
  // boundary is the END of `next`, so `'(list` (candidate `list`) is the complete atom → vetoed, while a
  // shorter `'(lis` (candidate `lis`) is still an extendable prefix of BOTH `list` and `list-ref` → admitted.
  // Only the complete `list` token at that boundary is killed; the prefix that could become `list-ref` is not.
  it("ADMITS the in-progress prefix `lis` after `'(` (could still extend to `list` OR `list-ref`)", () => {
    expect(feasible("'(", "lis")).toBe(true);
  });
  it("ADMITS `lister` after `'(` (the atom is `lister`, `list` is only its prefix)", () => {
    expect(feasible("'(", "lister")).toBe(true);
  });

  // FIRST-datum only: `list` as a LATER element of the same quote-list stays legal.
  it('ADMITS `list` as a LATER element (`\'("a" list)`) — only the first datum is vetoed', () => {
    expect(feasible(`'("a" `, "list")).toBe(true);
  });

  // The phantom fires the same way when `list` arrives glued onto the `'(` in one candidate token, or as the
  // full chimera the scorer mis-reads.
  it("VETOES `'(list` emitted as ONE candidate token at a value slot", () => {
    expect(feasible("(f ", "'(list")).toBe(false);
  });
  it('VETOES the full chimera `\'(list "a" "b")` as one candidate', () => {
    expect(feasible("(f ", `'(list "a" "b")`)).toBe(false);
  });
});

// ── EOS / COMPLETION peer — `closeable(generated)` is feasible(generated, EOS) ───────────────────────
describe("feasible kernel — closeable(): the completion arm (feasible at EOS)", () => {
  const scanner = grantEnvEmissions();

  it("is FALSE for an unbalanced, mid-call program (cannot end here)", () => {
    expect(closeable(scanner, "(calculate_emissions :distance 12000")).toBe(false);
    expect(closeable(scanner, "(")).toBe(false);
  });
  it("is TRUE for a balanced, complete program (the EOS gate opens)", () => {
    expect(closeable(scanner, "(calculate_emissions :distance 12000 :fuel_type diesel :fuel_efficiency 30)")).toBe(
      true,
    );
  });
  it("is TRUE at the empty prefix (nothing open) and FALSE mid-string", () => {
    expect(closeable(scanner, "")).toBe(true);
    expect(closeable(scanner, '(calculate_emissions :distance "unterm')).toBe(false);
  });
});

// ── PURITY — identical inputs ⇒ identical verdict, no per-call state (greedy reproducibility) ─────────
describe("feasible kernel — PURE: identical (generated, token) ⇒ identical verdict (self-contained analyze)", () => {
  it("repeated calls on ONE kernel return the byte-identical boolean, even interleaved", () => {
    const feasible = makeFeasible(grantEnvEmissions(), PROFILE);
    const probes: [string, string, boolean][] = [
      ["(calculate_emissions :distance 12000 ", ":distance", false],
      ["(calculate_emissions :distance 12000 ", ":fuel_type", true],
      ["(", ":distance", false],
      ["(", "calculate_emissions", true],
      ["(", "zzz", false],
    ];
    for (const [gen, tok, expected] of probes) {
      const first = feasible(gen, tok);
      expect(first).toBe(expected);
      for (let i = 0; i < 6; i++) {
        feasible("(calculate_emissions :distance 12000 ", ":fuel_type"); // unrelated interleave.
        expect(feasible(gen, tok)).toBe(first);
      }
    }
  });
});
