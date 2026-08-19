// mid-atom-continuation.test.ts — the BUG-2 over-mask fix: the type-derived structure gates must NOT fire on
// a mid-atom CONTINUATION (they only gate a fresh value OPENER).
//
// THE BUG. The decode loop RE-BASES the value-slot state to `analyze(prefix + " ")` whenever the true cursor
// is mid-atom at an arg/operator slot (greedyDescend.ts), so the type gates describe the slot the NEXT value
// opens in. That re-based state has `midToken:false`, so when the model is mid-NUMBER (`(fn 19`) and the next
// token CONTINUES it (`45`), the array / string-typed structure arm read the continuation's first char (`4`)
// as a fresh value-opener and MASK it — truncating `1945`→`1` (spiral / full-width-unicode escape), eating the
// sign `-2`→`2` and the fraction `4.5`→`4` (silent wrong-but-valid). Σ (grammar mode) gets every one right, so
// the corruption is purely the T intersection over-masking a continuation.
//
// THE FIX (mask-compiler.ts `classifyCandidate`). The candidate EXTENDS the in-progress atom iff the prefix
// ends mid-atom AND the candidate's first char is not a terminator; for such a continuation the structure
// gates are skipped (Σ, which re-scans `next` mid-atom-aware, still governs). The DECISIVE proof is the
// contrast: the SAME digit token is masked as a fresh opener at a clean boundary, but admitted as a
// continuation of a number already in progress.

import { makeOracle, oracleEnvFromBindings } from "@inhuman.tools/arrival/oracle";
import { describe, expect, it } from "vitest";

import { classifyCandidate } from "../../src/mask-compiler.js";
import type { OracleState } from "../../src/oracle-types.js";

const callable = (x: unknown): unknown => x;

// A real structural+Σ oracle that binds the operator `fn` (so `(fn …)` is a feasible application and the
// number arguments pass Σ via the literal exemption). The type STAMP is supplied separately as `slotState`.
const scanner = makeOracle(oracleEnvFromBindings({ fn: callable }));

/** The value-slot state the loop threads into `classifyCandidate`. The structural fields are what
 *  `analyze(prefix + " ")` produces at an application argument boundary (`midToken:false`); the type STAMP
 *  (`slotIsArray` / `slotIsStringTyped`) is what the type lens adds — the field that activates the gate. */
function slot(stamp: Partial<OracleState>): OracleState {
  return {
    midToken: false,
    position: "argument",
    formKind: "application",
    closeable: false,
    overClosed: false,
    validSymbols: () => null,
    ...stamp,
  };
}

describe("mid-atom continuation — the array-slot digit arm", () => {
  const arraySlot = slot({ slotIsArray: true });

  it("MASKS a bare number as a FRESH opener at an array slot (the legit gate — scalar literal ⊄ array)", () => {
    // Clean boundary: the prefix ends at a token boundary, so `945` OPENS a fresh value — a scalar literal at
    // an array slot is type-wrong and must be masked.
    expect(classifyCandidate(scanner, "(fn ", "945", undefined, arraySlot)).toBe("structural");
  });

  it("ADMITS the SAME digit token as a CONTINUATION of a number already in progress (the fix)", () => {
    // `(fn 19` is mid-number; `45` extends `1945`. Before the fix the re-based array arm masked `4` as a fresh
    // scalar opener → `1945`→`1`. Now the continuation is recognised and the structure gate is skipped.
    expect(classifyCandidate(scanner, "(fn 19", "45", undefined, arraySlot)).toBe("feasible");
  });
});

describe("mid-atom continuation — the string-typed-slot digit/# arm", () => {
  // A real string-typed slot is non-array: the lens stamps both (`slotIsArray:false` activates the `scalar`
  // branch in violatesValueStructure that the string-typed `#`/number arm sits behind).
  const stringSlot = slot({ slotIsStringTyped: true, slotIsArray: false });

  it("MASKS a number opener at a string-typed slot (the legit gate)", () => {
    expect(classifyCandidate(scanner, "(fn ", "945", undefined, stringSlot)).toBe("structural");
  });

  it("ADMITS the digit continuation of `1945` (no truncation)", () => {
    expect(classifyCandidate(scanner, "(fn 19", "45", undefined, stringSlot)).toBe("feasible");
  });

  it("ADMITS the digit continuation after a leading minus — `-2` survives, not `2`", () => {
    // `(fn -` is a number-in-progress (the lone `-` is a partial negative, isLiteralValue). The `2` continues
    // it. The bug ate the sign by masking the digit as a fresh opener at the string-typed slot.
    expect(classifyCandidate(scanner, "(fn -", "2", undefined, stringSlot)).toBe("feasible");
  });

  it("ADMITS the digit continuation after a decimal point — `4.5` survives, not `4`", () => {
    expect(classifyCandidate(scanner, "(fn 4.", "5", undefined, stringSlot)).toBe("feasible");
  });
});

describe("mid-atom continuation — a candidate that CLOSES the atom still gates the next opener", () => {
  // The discriminator is the candidate's FIRST char: a leading terminator (whitespace / paren) closes the
  // in-progress atom and OPENS a fresh value, where the re-based stamp legitimately applies. Only a
  // non-terminator-led candidate (a true continuation) skips the gate — so the fix never weakens the boundary.
  const arraySlot = slot({ slotIsArray: true });

  it("a whitespace-led candidate after a closed number re-opens the gate (still masks a scalar opener)", () => {
    // `(fn 19 ` closes `19`; ` 9` (space-led) opens a NEW value at the array slot → a scalar opener, masked.
    expect(classifyCandidate(scanner, "(fn 19", " 9", undefined, arraySlot)).toBe("structural");
  });
});
