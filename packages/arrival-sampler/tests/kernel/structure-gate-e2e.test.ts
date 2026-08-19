// structure-gate-e2e.test.ts — the PROOF that the type-derived list-structure gate FIRES end-to-end.
//
// structure-contract.test.ts pins the gate LOGIC in isolation over a hand-built OracleState. THIS file
// proves the full data path: a (mock) async type lens → narrowByTypeAsync stamps `slotIsArray` onto the
// OracleState → the real arrival oracle's structural state flows through → classifyCandidate / the shared
// kernel mask the wrong-shaped literal. Model-free: the lens is mocked (array-param callee ⇒ true,
// scalar-param callee ⇒ false), so the verdicts are deterministic and independent of the prelude.
//
// It runs in the DEFAULT suite (a verdict, per .claude/rules/tests.md).

// Resolved to arrival SOURCE via the vitest alias (vitest.config.ts) — the REAL oracle (Σ + structure).

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, expect, it } from "vitest";

import { classifyCandidate } from "../../src/mask-compiler.js";
import { selectConstrainedStep } from "../../src/select-constrained-step.js";
import { narrowByTypeAsync, type AsyncTypeLens } from "../../src/typed-scanner-async.js";

const callable = (x: unknown): unknown => x;

// Two bound callees so the arrival oracle reports an APPLICATION ARGUMENT slot at `(<callee> ⟨cur⟩`,
// plus a bare symbol the model could reference (a chained/computed arg — must stay legal at both).
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({
    "set-tags": callable,
    "set-name": callable,
    items: callable,
  });
}

/** A MOCK async lens: `getSlotIsArray` reports the slot's array-ness by the enclosing call's head —
 *  `set-tags*` ⇒ true (an array/list parameter), `set-name*` ⇒ false (a scalar parameter), anything
 *  else ⇒ null (unresolved). `getTypeValidCandidates` is identity (this test isolates the STRUCTURE
 *  axis from the Σ∩T axis). The head is read off the prefix with arrival's atom lexer, mirroring how
 *  the real lens's `scanInnermostCall` locates the callee. */
const ATOM = /[^\s()[\]{}"';]/;
function headOfOpenCall(prefix: string): string | null {
  // innermost open `(` then the first atom after it — enough for these single-level fixtures.
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
    getSlotIsArray: (scheme, schemeOffset) => {
      const head = headOfOpenCall(scheme.slice(0, schemeOffset));
      if (head === null) return Promise.resolve(null);
      if (head.startsWith("set-tags")) return Promise.resolve(true);
      if (head.startsWith("set-name")) return Promise.resolve(false);
      return Promise.resolve(null);
    },
    // This suite isolates the STRUCTURE axis — the scalar-string Σ exemption stays inert (null), so a
    // `set-name` scalar slot still masks `'`/`[` and an unbound bare word stays Σ-gated here.
    getSlotAcceptsBareWord: () => Promise.resolve(null),
    // CUT A's array-element axis stays inert here (this suite tests the OUTER-slot structure gate).
    getSlotElementType: () => Promise.resolve({ isStringy: null, enum: null }),
  };
}

// ── Direct (classifyCandidate) — the per-candidate verdict with the SURFACED state ──────────────────
describe("structure-gate-e2e — classifyCandidate over the lens-stamped state", () => {
  it("ARRAY slot (set-tags): scalar literals masked; `(`/`'`/`[`/symbol pass", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(set-tags ";
    await scanner.prefill(slot); // warm the arrayCache so the stamp is present synchronously
    const state = scanner.analyze(slot);
    expect(state.slotIsArray, "the array-slot stamp must reach the OracleState").toBe(true);

    // Scalars MASKED (under-listing fix): string / number / #-literal.
    expect(classifyCandidate(scanner, slot, '"a"', undefined, state)).toBe("structural");
    expect(classifyCandidate(scanner, slot, "5", undefined, state)).toBe("structural");
    expect(classifyCandidate(scanner, slot, "#t", undefined, state)).toBe("structural");
    // The list materializers + a CALL + a bare symbol PASS (computed / chained args stay legal).
    expect(classifyCandidate(scanner, slot, "'", undefined, state)).toBe("feasible");
    expect(classifyCandidate(scanner, slot, "(", undefined, state)).toBe("feasible");
    expect(classifyCandidate(scanner, slot, "items", undefined, state)).toBe("feasible");
    // `[` is the VECTOR-LITERAL materializer — first-class at an array slot since the reader gained
    // `[a b c]` (the anticipatory isListLiteral path in violatesValueStructure, now actually live).
    expect(classifyCandidate(scanner, slot, "[", undefined, state)).toBe("feasible");
    expect(classifyCandidate(scanner, slot, " [{", undefined, state)).toBe("feasible");
  });

  it("SCALAR slot (set-name): list literals are masked; scalars/`(`/symbol pass", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(set-name ";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    expect(state.slotIsArray, "the scalar-slot stamp must reach the OracleState").toBe(false);

    // List literals MASKED (the literal over-listing).
    expect(classifyCandidate(scanner, slot, "[", undefined, state)).toBe("structural");
    expect(classifyCandidate(scanner, slot, "'", undefined, state)).toBe("structural");
    // Scalars + a CALL + a bound bare symbol PASS the structure gate (`items` is Σ-bound, so the Σ
    // gate also passes — isolating the structure axis; an UNBOUND symbol would be `sigma`, a
    // different axis).
    expect(classifyCandidate(scanner, slot, '"km/h"', undefined, state)).toBe("feasible");
    expect(classifyCandidate(scanner, slot, "546382", undefined, state)).toBe("feasible");
    expect(classifyCandidate(scanner, slot, "(", undefined, state)).toBe("feasible");
    expect(classifyCandidate(scanner, slot, "items", undefined, state)).toBe("feasible");
  });

  it("UNKNOWN callee (no verdict): the gate stays a no-op — every opener passes", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(items "; // `items` is bound (callable) but the mock returns null for it
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    expect(state.slotIsArray ?? null, "no verdict ⇒ slotIsArray absent/null").toBeNull();
    // The string literal survives — the superset-safe disable surface (the REAL lens returns null for an
    // unresolved type). `[` survives too: with no type verdict NOTHING is structure-masked, and the
    // grammar admits the vector literal (R-NO-BRACKETS retired).
    expect(classifyCandidate(scanner, slot, '"a"', undefined, state)).toBe("feasible");
    expect(classifyCandidate(scanner, slot, "[", undefined, state)).toBe("feasible");
  });
});

// ── Full stack (the shared kernel mask) — the gate biting on a real distribution ──────────────────────
describe("structure-gate-e2e — the shared kernel masks the wrong-shaped literal", () => {
  // A toy vocab = the CANDIDATE set walked this step: a literal opener of each kind, the two list
  // materializers, a call, a bare symbol, a closer, PLUS the callee atoms + a space (the prefix is passed
  // to the kernel directly, so these are just extra candidates the gate classifies — harmless, kept for
  // continuity with the slots `(set-tags `/`(set-name `/`(items ` under test).
  const TOKENS = [
    { id: 0, str: '"' }, // string-literal opener (scalar)
    { id: 1, str: "[" }, // vector materializer (list)
    { id: 2, str: "'" }, // quote-list materializer (list)
    { id: 3, str: "(" }, // a call (always legal)
    { id: 4, str: "items" }, // a bare symbol (always legal)
    { id: 5, str: ")" },
    { id: 6, str: " " }, // whitespace (slot boundary)
    { id: 7, str: "set-tags" }, // array-param callee
    { id: 8, str: "set-name" }, // scalar-param callee
  ];
  const EOS_ID = 9;

  /** Run the SHARED per-step kernel over the toy vocab at `prefix` and return the kept token STRINGS — the
   *  gguf-aligned migration of the old `LazyOracleConstraintProcessor._call` + `Tensor` mask. `keepSet`
   *  membership IS the `-Inf` mask the lazy processor wrote; `keepN = ∞` ⇒ the full, rank-independent mask.
   *  The `slotState` boundary re-analyze mirrors the shipping loop (lazy-processor.ts:250-254); these clean
   *  `… ` slots are not mid-atom, so it is a no-op here, but it keeps the helper faithful to the live path. */
  function keptStringsAt(scanner: ReturnType<typeof narrowByTypeAsync>, prefix: string): Set<string> {
    const idToStr = new Map(TOKENS.map((t) => [t.id, t.str]));
    const prefixState = scanner.analyze(prefix);
    const slotState =
      prefixState.midToken && (prefixState.position === "argument" || prefixState.position === "operator")
        ? scanner.analyze(`${prefix} `)
        : prefixState;
    const { keepSet } = selectConstrainedStep({
      scanner,
      prefix,
      rankedIds: () => TOKENS.map((t) => t.id),
      idToString: (id) => idToStr.get(id),
      allIds: () => idToStr.keys(),
      slotState,
      closeable: prefixState.closeable,
      keepN: Number.POSITIVE_INFINITY,
      topK: TOKENS.length,
      wideK: TOKENS.length,
      eos: { addId: EOS_ID },
    });
    const kept = new Set<string>();
    for (const t of TOKENS) if (keepSet.has(t.id)) kept.add(t.str);
    return kept;
  }

  async function keptAt(slot: string): Promise<{ kept: Set<string>; scanner: ReturnType<typeof narrowByTypeAsync> }> {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    await scanner.prefill(slot); // warm the structure verdict so the mask step sees the stamp
    return { kept: keptStringsAt(scanner, slot), scanner };
  }

  it("ARRAY slot: the string-literal token is -Inf'd; `'` `[` `(` symbol survive", async () => {
    const { kept } = await keptAt("(set-tags ");
    expect(kept.has('"'), "a string literal opens a SCALAR — masked at an array slot").toBe(false);
    expect(kept.has("["), "the vector-literal materializer is first-class at an array slot").toBe(true);
    expect(kept.has("'"), "the quote-list materializer survives").toBe(true);
    expect(kept.has("("), "a call survives (its return type is checked at the callee)").toBe(true);
    expect(kept.has("items"), "a bare symbol survives (chained/computed arg)").toBe(true);
  });

  it("SCALAR slot: `[` and `'` are -Inf'd; `\"` `(` symbol survive", async () => {
    const { kept } = await keptAt("(set-name ");
    expect(kept.has("["), "a vector literal is a LIST — masked at a scalar slot").toBe(false);
    expect(kept.has("'"), "a quote-list literal is masked at a scalar slot").toBe(false);
    expect(kept.has('"'), "a string scalar survives").toBe(true);
    expect(kept.has("("), "a call survives").toBe(true);
    expect(kept.has("items"), "a bare symbol survives").toBe(true);
  });

  it("UNKNOWN callee: nothing is structure-masked (the no-op surface)", async () => {
    const { kept } = await keptAt("(items ");
    // The structure gate disabled itself — EVERY literal opener survives, `[` included (the grammar
    // admits the vector literal; R-NO-BRACKETS retired).
    expect(kept.has('"')).toBe(true);
    expect(kept.has("[")).toBe(true);
    expect(kept.has("'")).toBe(true);
  });
});

// ── Parity guard: the typed scanner must stay session-less ────────────────────────────────────────────
// The gate reads `slotIsArray` off the state. narrowByTypeAsync stamps it on analyze() (the RE-SCAN path
// the kernel takes when no session is present), but NOT onto a session's state. If it ever exposed a bare
// passthrough session(), selectConstrainedStep would route to the session path (isCandidateLiveSession),
// whose gate reads `base.state.slotIsArray` (undefined) and would SILENTLY DISABLE the structure-gate on
// the perf path — a shipping-vs-reference divergence with no other test to catch it. So it must stay
// session-less until a session that re-stamps slotIsArray exists (the deferred perf path). Pins the invariant.
describe("structure-gate-e2e — the async typed scanner stays session-less (gate-parity guard)", () => {
  it("narrowByTypeAsync exposes NO session() — so the gate is enforced via the re-scan path only", () => {
    const typed = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    expect(
      typed.session,
      "a slotIsArray-stamping scanner must not expose a bare passthrough session (it would no-op the gate)",
    ).toBeUndefined();
  });
});
