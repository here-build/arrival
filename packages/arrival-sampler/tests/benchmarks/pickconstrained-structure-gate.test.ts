// pickconstrained-structure-gate.test.ts — proof that the REAL llama greedy core threads `slotState`.
//
// THE BUG THIS GUARDS: the type-derived list-structure gate threads a once-per-step `slotState` into
// `isCandidateLive`. Before the shared-decision extraction, lazy-processor was updated but the llama loop
// called the old 4-arg `isCandidateLive` (no slotState) — so the gate was DEAD on every GGUF model. The
// llama greedy pick now routes through `selectConstrainedStep` with `slotState` threaded. This file drives
// `pickConstrained` DIRECTLY (model-free — only `detokenize` is needed, stubbed) with a slotIsArray-stamping
// scanner and asserts the greedy constrained argmax SKIPS a scalar literal at an ARRAY slot for a list
// materializer. It is the llama-side twin of structure-gate-e2e.test.ts (which proves the lazy path).
//
// It lives in __benchmarks__/ because `pickConstrained` is defined there (its module imports node-llama-cpp
// at load), per .claude/rules/tests.md — but it loads NO GGUF and runs in milliseconds. It produces a
// verdict; only its native-addon import keeps it out of the default `__tests__` gate.

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { type LlamaModel, type Token } from "node-llama-cpp";
import { describe, expect, it } from "vitest";

import { pickConstrained } from "../../src/runners/local/llama-cpp-generate.js";
import { narrowByTypeAsync, type AsyncTypeLens } from "../../src/typed-scanner-async.js";

const callable = (x: unknown): unknown => x;
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({
    "set-tags": callable,
    "set-name": callable,
    items: callable,
  });
}

// A MOCK lens stamping the slot's array-ness by the enclosing call head (mirrors structure-gate-e2e).
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
function mockLens(): AsyncTypeLens {
  return {
    getTypeValidCandidates: (_s, _o, candidates) => Promise.resolve([...candidates]),
    getSlotIsArray: (scheme, off) => {
      const head = headOfOpenCall(scheme.slice(0, off));
      if (head === null) return Promise.resolve(null);
      if (head.startsWith("set-tags")) return Promise.resolve(true);
      if (head.startsWith("set-name")) return Promise.resolve(false);
      return Promise.resolve(null);
    },
    // The scalar-string Σ exemption is inert here (null) — this suite isolates the structure-gate axis.
    getSlotAcceptsBareWord: () => Promise.resolve(null),
    // The array-ELEMENT type query is inert here too — this suite is the array-vs-scalar structure axis.
    getSlotElementType: () => Promise.resolve({ isStringy: null, enum: null }),
  };
}

// A stub model: the greedy `pickConstrained` path needs ONLY `detokenize` (id → string). Token ids map to
// candidate strings; `detokenize` of an unknown id returns "" (skipped by the walk).
const TOKENS: Record<number, string> = {
  10: '"', // string-literal opener (scalar)
  11: "[", // vector materializer (list)
  12: "'", // quote-list materializer (list)
  13: "(", // a call (always legal)
  14: "items", // a bound bare symbol (always legal)
  15: "5", // number literal (scalar)
};
const stubModel = {
  detokenize: (ids: readonly Token[]): string => TOKENS[ids[0] as number] ?? "",
} as unknown as LlamaModel;

/** Build a prob-descending Map from an ordered id list (descending synthetic probs). */
function probMap(orderedIds: number[]): Map<Token, number> {
  const m = new Map<Token, number>();
  let p = 1;
  for (const id of orderedIds) m.set(id as Token, (p -= 0.1));
  return m;
}

const EOS = new Set<Token>([999 as Token]);
const NO_RNG = (): number => 0;

describe("pickConstrained — the llama greedy core threads slotState (the GGUF gate, model-free)", () => {
  it("ARRAY slot: greedy SKIPS a scalar string top-pick and lands on the list materializer", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(set-tags ";
    await scanner.prefill(slot); // warm the structure verdict so analyze() carries slotIsArray
    const slotState = scanner.analyze(slot);
    expect(slotState.slotIsArray, "the array-slot stamp must be present").toBe(true);

    // The model RANKS the scalar string `"` first (label-bias), then `[` (list), then `items`.
    const probs = probMap([10, 11, 14]);
    const picked = pickConstrained(
      scanner,
      slot,
      probs,
      EOS,
      slotState.closeable,
      64,
      256,
      stubModel,
      0,
      NO_RNG,
      undefined,
      slotState,
    );
    // The scalar `"` is structure-masked → the greedy constrained argmax is the vector materializer `[`.
    expect(picked.str).toBe("[");
    expect(picked.iterations, "the model's rank of the first feasible (rank 2 = `[`)").toBe(2);
  });

  it("ARRAY slot: a scalar NUMBER top-pick is likewise skipped", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(set-tags ";
    await scanner.prefill(slot);
    const slotState = scanner.analyze(slot);
    const probs = probMap([15, 12, 14]); // 5 (scalar), ' (list), items
    const picked = pickConstrained(
      scanner,
      slot,
      probs,
      EOS,
      slotState.closeable,
      64,
      256,
      stubModel,
      0,
      NO_RNG,
      undefined,
      slotState,
    );
    expect(picked.str).toBe("'"); // the quote-list materializer
  });

  it("SCALAR slot: greedy SKIPS a list-literal top-pick for the scalar", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(set-name ";
    await scanner.prefill(slot);
    const slotState = scanner.analyze(slot);
    expect(slotState.slotIsArray).toBe(false);
    const probs = probMap([11, 10, 14]); // [ (list, masked), " (scalar), items
    const picked = pickConstrained(
      scanner,
      slot,
      probs,
      EOS,
      slotState.closeable,
      64,
      256,
      stubModel,
      0,
      NO_RNG,
      undefined,
      slotState,
    );
    expect(picked.str).toBe('"'); // the string scalar survives; the `[` vector is masked
  });

  it("UNKNOWN callee: the gate stays a no-op — the scalar top-pick is taken (superset-safe)", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(items "; // `items` is bound but the mock returns null (unresolved) for it
    await scanner.prefill(slot);
    const slotState = scanner.analyze(slot);
    expect(slotState.slotIsArray ?? null, "no verdict ⇒ slotIsArray absent/null").toBeNull();
    const probs = probMap([10, 11, 14]); // " first — and with no verdict it stays the pick
    const picked = pickConstrained(
      scanner,
      slot,
      probs,
      EOS,
      slotState.closeable,
      64,
      256,
      stubModel,
      0,
      NO_RNG,
      undefined,
      slotState,
    );
    expect(picked.str, 'unresolved type ⇒ every opener survives, scalar `"` is taken').toBe('"');
  });
});
