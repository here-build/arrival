// scalar-string-exemption.test.ts — the PROOF that the scalar-string Σ exemption (Option C) FIRES end-to-end.
//
// The over-mask failure this kills: at a free-form `string`/`any` argument slot, the model's rank-0 BARE
// VALUE-WORD (`men`, `classical`, `my`) was MASKED by the Σ bound-symbol gate (it is an UNBOUND symbol),
// forcing the decode into a `'(…)` list corruption (`'()` / `'(:x)` / `'("x")`). The fix: the type lens
// stamps `slotIsStringy === true` at such a slot → the Σ gate exempts the bare word (it lowers to the
// string), AND the structure gate masks the `'(` escape hatch there. Three things this file proves:
//   (1) at a STRINGY slot the bare word is "feasible" (admitted) — was "sigma" (masked);
//   (2) at a NUMBER slot it stays "sigma" — the exemption is strictly type-gated;
//   (3) at a STRINGY slot a `'`-opener (incl. the live whitespace-led ` '` token) is "structural" (masked) —
//       the escape hatch is closed.
//
// Model-free: the lens is mocked (string-param callee ⇒ stringy:true, number-param callee ⇒ stringy:false),
// so the verdicts are deterministic and independent of the prelude. Runs in the DEFAULT suite (a verdict).

// Resolved to arrival SOURCE via the vitest alias (vitest.config.ts) — the REAL oracle (Σ + structure).

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, expect, it } from "vitest";

import { classifyCandidate } from "../../src/mask-compiler.js";
import { narrowByTypeAsync, type AsyncTypeLens } from "../../src/typed-scanner-async.js";

const callable = (x: unknown): unknown => x;

// Bound callees so the arrival oracle reports an APPLICATION ARGUMENT slot at `(<callee> ⟨cur⟩`:
// `note` ⇒ a string-param slot (stringy), `count` ⇒ a number-param slot (NOT stringy). `pair` ⇒ a
// (number, string) two-arg callee (for the slot-TRANSITION test: arg0 number, arg1 stringy). `existing`
// is a bound symbol the model could legitimately reference at a slot (a chained/computed arg).
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({
    note: callable,
    count: callable,
    pair: callable,
    existing: callable,
  });
}

const ATOM = /[^\s()[\]{}"';]/;
function headOfOpenCall(prefix: string): string | null {
  const open = prefix.lastIndexOf("(");
  if (open === -1) return null;
  let i = open + 1;
  while (i < prefix.length && /\s/.test(prefix[i])) i++;
  let head = "";
  while (i < prefix.length && ATOM.test(prefix[i])) head += prefix[i++];
  return head === "" ? null : head;
}

/** Count the COMPLETED top-level args after the innermost open call's head (the slot's argIndex at the
 *  cursor — a closed string / a whitespace-separated atom each count once). Enough for these flat fixtures. */
function argIndexOf(prefix: string): number {
  const open = prefix.lastIndexOf("(");
  if (open === -1) return 0;
  // tokens after the head atom, whitespace-separated (strings kept whole).
  const body = prefix.slice(open + 1).replace(/^\s*[^\s()"';]+/, ""); // drop the head atom
  const toks = body.match(/"(?:[^"\\]|\\.)*"?|[^\s()"';]+/g) ?? [];
  // The LAST token is the in-progress slot (not yet completed) unless the prefix ends in whitespace.
  const trailingWs = /\s$/.test(prefix);
  return trailingWs ? toks.length : Math.max(0, toks.length - 1);
}

/** A MOCK async lens. `getSlotAcceptsBareWord`: `note` ⇒ true (a free-form string slot), `count` ⇒ false
 *  (a number slot), `pair` ⇒ arg0 false (number) / arg1+ true (string) — the slot-TRANSITION fixture. Else
 *  null. `getSlotIsArray` reports false for the scalar callees so the structure gate treats them as scalar.
 *  `getTypeValidCandidates` is identity (isolates the Σ-exemption axis from the Σ∩T narrowing). */
function mockLens(): AsyncTypeLens {
  const head = (scheme: string, off: number): string | null => headOfOpenCall(scheme.slice(0, off));
  return {
    getTypeValidCandidates: (_s, _o, candidates) => Promise.resolve([...candidates]),
    getSlotIsArray: (scheme, off) => {
      const h = head(scheme, off);
      if (h === "note" || h === "count" || h === "pair") return Promise.resolve(false); // none is an array
      return Promise.resolve(null);
    },
    getSlotAcceptsBareWord: (scheme, off) => {
      const h = head(scheme, off);
      if (h === "note") return Promise.resolve(true); // free-form string slot
      if (h === "count") return Promise.resolve(false); // number slot
      if (h === "pair") return Promise.resolve(argIndexOf(scheme.slice(0, off)) >= 1); // arg0 number, arg1 string
      return Promise.resolve(null);
    },
    // CUT A is orthogonal to the scalar-string exemption this test isolates — keep the element axis inert.
    getSlotElementType: () => Promise.resolve({ isStringy: null, enum: null }),
  };
}

describe("scalar-string Σ exemption — the bare value-word is admitted at a free-form string slot", () => {
  it("STRINGY slot (note): an UNBOUND bare word is 'feasible' (was 'sigma') — the over-mask fix", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(note ";
    await scanner.prefill(slot); // warm the stringyCache so the stamp is present synchronously
    expect(scanner.analyze(slot).slotIsStringy, "the stringy stamp must reach the OracleState").toBe(true);

    // The model's rank-0 free-form value-word — UNBOUND, so Σ would normally mask it. With the exemption it
    // is admitted (a fair materialization of the string value: `(note men)` ≡ `(note "men")`).
    expect(classifyCandidate(scanner, slot, "men")).toBe("feasible");
    expect(classifyCandidate(scanner, slot, "classical")).toBe("feasible");
    expect(classifyCandidate(scanner, slot, "my")).toBe("feasible");
    // The `"` string opener stays admitted too (multi-word values still quote).
    expect(classifyCandidate(scanner, slot, '"')).toBe("feasible");
    // A bound symbol still passes (the exemption doesn't break the normal Σ path).
    expect(classifyCandidate(scanner, slot, "existing")).toBe("feasible");
  });

  it("NUMBER slot (count): the bare word STAYS 'sigma' — the exemption is strictly type-gated", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(count ";
    await scanner.prefill(slot);
    expect(scanner.analyze(slot).slotIsStringy, "a number slot is NOT stringy").toBe(false);

    // An unbound bare word at a number slot is genuinely wrong — it must stay masked.
    expect(classifyCandidate(scanner, slot, "men")).toBe("sigma");
    expect(classifyCandidate(scanner, slot, "classical")).toBe("sigma");
    // A number literal is still fine (the literal-value exemption, unchanged).
    expect(classifyCandidate(scanner, slot, "42")).toBe("feasible");
  });

  it("STRINGY slot (note): the `'(` escape hatch is masked — incl. the whitespace-led ` '` token", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(note ";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);

    // A quote-list opener at a string slot is structurally wrong (a string is not a list). The live
    // corruption's first token is ` '` (space + quote) — the gate must catch it past the leading space.
    expect(classifyCandidate(scanner, slot, "'", undefined, state)).toBe("structural");
    expect(classifyCandidate(scanner, slot, " '", undefined, state)).toBe("structural");
    expect(classifyCandidate(scanner, slot, "[", undefined, state)).toBe("structural");
    // Scalars + a CALL still pass the structure gate.
    expect(classifyCandidate(scanner, slot, '"a"', undefined, state)).toBe("feasible");
    expect(classifyCandidate(scanner, slot, "(", undefined, state)).toBe("feasible");
  });

  it("UNTYPED (no stringy stamp): the exemption stays inert — an unbound bare word is 'sigma'", async () => {
    // No lens wrapping ⇒ slotIsStringy never stamped ⇒ the grammar path is byte-identical (bare word masked).
    const scanner = makeOracle(grantEnv());
    // `(note ` is an application argument; `men` is unbound and there is no stringy stamp.
    expect(classifyCandidate(scanner, "(note ", "men")).toBe("sigma");
  });

  it("SLOT TRANSITION: prefilling a mid-atom prefix warms the NEXT-boundary slot (the decode-loop fix)", async () => {
    // The live gap: at `(pair 5` the cursor is MID-`5` (arg0, a number slot); the model's next token closes
    // `5` and opens arg1 (a string slot). The loop computes the gate state at the boundary `prefix + " "`.
    // prefill must have warmed THAT slot (not just the mid-atom one) or the stamp misses on the opening token.
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const midAtom = "(pair 5"; // cursor mid-`5` — arg0 (number)
    await scanner.prefill(midAtom);

    // The prefix slot (arg0) is a NUMBER → not stringy.
    expect(scanner.analyze(midAtom).slotIsStringy ?? false).toBe(false);
    // The VALUE-OPEN boundary slot (arg1, where the next value lands) is STRINGY — and warmed by prefill, so
    // the stamp is present synchronously (no async miss on the very token that opens arg1).
    const boundary = scanner.analyze(`${midAtom} `);
    expect(boundary.slotIsStringy, "prefill must warm the next-boundary (arg1) slot").toBe(true);
    expect(boundary.midToken).toBe(false);
    expect(boundary.position).toBe("argument");

    // With the boundary state, the structure gate masks a quote-list opener (incl. whitespace-led ` '`) and
    // the Σ exemption admits a bare word at arg1 — the exact pair that fixes the slot-transition corruption.
    expect(classifyCandidate(scanner, midAtom, " '", undefined, boundary)).toBe("structural");
    expect(classifyCandidate(scanner, midAtom, " major")).toBe("feasible");
  });
});
