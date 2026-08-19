// constraint.test.ts — prove the masking with the REAL arrival oracle and a TOY tokenizer.
//
// Model-free / CI-safe: no model download, no tokenizer download. A handful of hand-built tokens
// stand in for a vocab; the oracle is the real `makeOracle()` (structural) and `makeOracle(env)`
// (Σ-live with a tiny grant env binding only car/cdr). The headline assertion: at operator position
// an UNBOUND symbol (`foo`) is masked to -Infinity while a BOUND callable (`car`) survives.

// Resolved to arrival-scheme SOURCE via vitest alias (see vitest.config.ts) — the REAL oracle. The
// alias is vitest-only, so eslint's resolver cannot see the subpath; the import is correct at runtime.

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import { compileMask, type Tokenizer } from "../../src/mask-compiler.js";

// ── Toy vocab ────────────────────────────────────────────────────────────────────────────────────
// id → string. EOS is its own id, excluded from `entries()`.
const TOKENS: { id: number; str: string }[] = [
  { id: 0, str: "(" },
  { id: 1, str: ")" },
  { id: 2, str: "car" },
  { id: 3, str: "cdr" },
  { id: 4, str: "foo" },
  { id: 5, str: "5" },
  { id: 6, str: " " },
];
const EOS_ID = 7;

const toyTok: Tokenizer = {
  eosId: EOS_ID,
  entries: () => TOKENS,
};

const idOf = (s: string): number => TOKENS.find((t) => t.str === s)!.id;

/** Identity stand-in for a callable binding value (a function value ⇒ callable in arrival's env). */
const callable = (x: unknown): unknown => x;

/** A tiny grant env binding ONLY `car`/`cdr` as callables (Σ-live). Mirrors arrival's own oracle
 *  spec test: `oracleEnvFromBindings(bindings)`; a function value ⇒ callable. */
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({
    car: callable,
    cdr: callable,
  });
}

describe("compileMask — structural oracle (makeOracle())", () => {
  const scanner = makeOracle();

  it('at prefix "" a closer ")" is masked, an opener "(" is allowed', () => {
    const mask = compileMask(scanner, "", toyTok);
    expect(mask.allowed.has(idOf("("))).toBe(true);
    expect(mask.allowed.has(idOf(")"))).toBe(false); // can't open a program with a closer
  });

  it('at prefix "(" a closer ")" is allowed (depth 1 closes)', () => {
    const mask = compileMask(scanner, "(", toyTok);
    expect(mask.allowed.has(idOf(")"))).toBe(true);
  });

  it("EOS is allowed at a closeable prefix and disallowed mid-form", () => {
    expect(compileMask(scanner, "(car 5)", toyTok).allowed.has(EOS_ID)).toBe(true); // balanced ⇒ closeable
    expect(compileMask(scanner, "(car", toyTok).allowed.has(EOS_ID)).toBe(false); // open ⇒ uncloseable
    expect(compileMask(scanner, "(car 5)", toyTok).canEnd).toBe(true);
    expect(compileMask(scanner, "(car", toyTok).canEnd).toBe(false);
  });
});

describe("compileMask — Σ-live oracle (makeOracle(grantEnv)) — the headline", () => {
  const scanner = makeOracle(grantEnv());

  it('at prefix "(" an UNBOUND operator "foo" is masked; a BOUND callable "car" survives', () => {
    const mask = compileMask(scanner, "(", toyTok);
    // THE MONEY SHOT: an unbound operator is ungeneratable.
    expect(mask.allowed.has(idOf("foo"))).toBe(false);
    expect(mask.allowed.has(idOf("car"))).toBe(true);
    expect(mask.allowed.has(idOf("cdr"))).toBe(true);
    // R-HEAD-IS-SYMBOL: a nested `(` at the OPERATOR/head slot is a sub-application head → masked. A tool
    // call's head must be a NAMED SYMBOL, never `((…) …)` (the parallel-collapse). Argument-position nesting
    // `(fn (g x))` stays legal — only the head slot (parent frame elems===0) is restricted.
    expect(mask.allowed.has(idOf("("))).toBe(false);
    // OPERATOR-POSITION FIX: a bare number in operator position is NOT exempt from Σ — `(5 …)` is not
    // a valid call, and `5` is not a prefix of any bound callable, so it is masked. Number literals
    // bypass Σ only at ARGUMENT position (where `(set-timer 5)` is fine). This is what collapses `(1)`.
    expect(mask.allowed.has(idOf("5"))).toBe(false);
  });

  it("Σ does NOT constrain at argument position once an operator is fixed (any bound symbol ok)", () => {
    // After "(car " the cursor is an ARGUMENT slot. `cdr` (bound) is fine; `foo` (unbound) is masked.
    const mask = compileMask(scanner, "(car ", toyTok);
    expect(mask.allowed.has(idOf("cdr"))).toBe(true);
    expect(mask.allowed.has(idOf("foo"))).toBe(false); // still unbound — masked at argument too
    expect(mask.allowed.has(idOf("5"))).toBe(true);
  });

  it("structural oracle (no env) does NOT mask foo — graceful degradation", () => {
    // Without a grant env Σ degrades to null, so foo is structurally possible at operator position.
    const structural = makeOracle();
    expect(compileMask(structural, "(", toyTok).allowed.has(idOf("foo"))).toBe(true);
  });
});
