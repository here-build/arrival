// scalar-enum-integration.test.ts — RED REPRODUCTION of the live LFM2-24B typed-mode corruption of
// SCALAR string-enum slots (bfcl-bench-1782106953831). DO NOT "fix" by relaxing these asserts — they
// encode the BUG, and a green run here is the fix's acceptance gate.
//
// THE EVIDENCE (live run): three BFCL params declared `type:"string"` with an `enum` were emitted
// correctly by python (default) but MANGLED in typed (Σ∩T) mode:
//   • route_type      (enum [fastest, scenic],            wants "fastest")   → typed emitted `#f`
//   • time_frame      (enum [six_months, year, …],        wants "six_months")→ typed emitted `(list six)`
//   • compounding_freq(enum [monthly, quarterly, annually],wants "monthly")  → typed emitted `(list '(#monthly))`
// Every right answer is IN the enum; the model knew it (python nailed all three). The CONSTRAINT
// corrupted values the model had right. The corruption decomposes into three gate behaviours that
// should fire at a scalar string-enum value slot and do NOT:
//   (1) string-slot-masks-boolean — `#f` should be masked at a string slot (`route_type`);
//   (2) scalar-slot-masks-list     — a `(list …)` literal should be masked at a scalar slot (`time_frame`);
//   (3) enum-narrow (Σ∩T)          — the slot's legal value-words should be exactly {fastest, scenic},
//                                    so a non-enum bare word is masked, AND the `'(` quote-list opener is
//                                    masked (the `'(#monthly)` surface of compounding_freq).
//
// WHAT THE DIAGNOSIS FOUND (so the fix lands in the right layer, not here):
//   • The type LENS classification is CORRECT for a scalar string-enum: getSlotIsArray → false,
//     getSlotAcceptsBareWord → false, getTypeValidCandidates drops `list`/keeps the enum members.
//     The Part-A mock encodes exactly those verdicts; the Part-B end-to-end builds them through the
//     REAL lens (createSchemeLanguageService) from a real `type:string, enum` param shape.
//   • The leak is in the GATE / decode-loop integration, not the lens:
//       - `violatesValueStructure` (mask-compiler.ts) at a scalar slot masks ONLY list-literal openers
//         (`'` / `[`). A wrong-typed SCALAR opener — `#f` (a `#`-literal) — is NOT masked there, and Σ
//         additionally exempts `#`/number value-literals at an argument (`passesSigmaOnState`). ⇒ (1).
//       - the same gate NEVER masks an ambiguous `(` opener (to preserve chained/computed args), so the
//         CALL `(list …)` opens unimpeded at a scalar slot. ⇒ (2).
//       - the scalar axes are stamped ONLY when the value-slot state is at `position === "argument"`.
//         When one model token spans the head-close + value-open (` '(`, ` #f`, ` (list …)`), the prefix
//         is at `position === "operator"`, midToken — the decode-loop's boundary re-analyze fires only
//         for `"argument"`, so the stamp misses on the very token that opens the value. ⇒ part of (3).
// Mirror of structure-gate-e2e.test.ts / scalar-string-exemption.test.ts (same mock-lens + REAL arrival
// oracle + REAL classifyCandidate / shared-kernel mask). Model-free (no GGUF, no model load). DEFAULT suite
// (a verdict, per .claude/rules/tests.md).

// Resolved to arrival SOURCE via the vitest alias (vitest.config.ts) — the REAL oracle (Σ + structure).

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
// The REAL type lens (Part B). createSchemeLanguageService reads its prelude from disk (hermetic, no tsgo
// wasm, no model) — resolves through the workspace devDependency to dist/. assembleHostPrelude builds the
// same `.d.ts` the BFCL adapter feeds the lens (the `WEATHER_HOST` shape in the lens's own tests).

import { assembleHostPrelude, createSchemeLanguageService } from "@inhuman.tools/arrival-lsp";
import { describe, expect, it } from "vitest";

import { classifyCandidate } from "../../src/mask-compiler.js";
import { selectConstrainedStep } from "../../src/select-constrained-step.js";
import { narrowByTypeAsync, type AsyncTypeLens } from "../../src/typed-scanner-async.js";

const callable = (x: unknown): unknown => x;

/** Drive the SHARED per-step kernel (`selectConstrainedStep` — the ONE decision both the lazy and llama.cpp
 *  backends call) over a toy vocab and return the kept token STRINGS. This is the gguf-aligned migration of
 *  the old `LazyOracleConstraintProcessor._call` + `Tensor`-mask vehicle: the kernel's `keepSet` IS the mask
 *  the shipping backends apply (lazy writes `-Inf` for every id ∉ `keepSet`; llama picks from `kept`), so
 *  `keepSet.has(id)` is exactly the old `logits.data[id] !== -Inf` readback — proven on the real decision,
 *  not a re-implementation. `keepN = ∞` / `topK = |vocab|` ⇒ the FULL mask, which is rank-INDEPENDENT (the
 *  toy logit ordering the `Tensor` once carried never affected the kept set). The `slotState` computation
 *  mirrors the shipping decode loop EXACTLY (lazy-processor.ts:250-254): at a mid-atom argument- OR
 *  operator-transition, re-analyze at `prefix + " "` so the gate reads the slot the NEXT value lands in. */
function keptStringsAt(
  scanner: ReturnType<typeof narrowByTypeAsync>,
  tokens: readonly { id: number; str: string }[],
  eosId: number,
  prefix: string,
): Set<string> {
  const idToStr = new Map(tokens.map((t) => [t.id, t.str]));
  const prefixState = scanner.analyze(prefix);
  const slotState =
    prefixState.midToken && (prefixState.position === "argument" || prefixState.position === "operator")
      ? scanner.analyze(`${prefix} `)
      : prefixState;
  const { keepSet } = selectConstrainedStep({
    scanner,
    prefix,
    rankedIds: () => tokens.map((t) => t.id),
    idToString: (id) => idToStr.get(id),
    allIds: () => idToStr.keys(),
    slotState,
    closeable: prefixState.closeable,
    keepN: Number.POSITIVE_INFINITY,
    topK: tokens.length,
    wideK: tokens.length,
    eos: { addId: eosId },
  });
  const kept = new Set<string>();
  for (const t of tokens) if (keepSet.has(t.id)) kept.add(t.str);
  return kept;
}

// ── PART A — the gate, over a mock lens encoding the enum verdicts the REAL lens returns ──────────────
//
// The mock reports, for the scalar string-enum callee `get_route` (param route_type = "fastest"|"scenic"):
//   getSlotIsArray         → false  (a scalar, not an array — the verified real verdict)
//   getSlotAcceptsBareWord → false  (an ENUM is NOT free-form string: its members are bound value-symbols)
//   getTypeValidCandidates → keep only the enum members {fastest, scenic} (drop `list`, non-enum words)
// This isolates the STRUCTURE + Σ∩T gates from the lens's TS machinery: every verdict is the one the
// real lens produces, so a failure here is a GATE gap, reproducible without the type checker.

/** Bind the function + its two enum value-symbols + the `list` constructor so the arrival oracle reports
 *  an APPLICATION ARGUMENT slot at `(get_route ⟨cur⟩` and admits `(list …)` / the bare enum words in Σ. */
function enumGrantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({
    get_route: callable,
    // Σ value-symbols for the enum members (bound so the model can NAME them — the typed path's surface).
    fastest: callable,
    scenic: callable,
    // `list` is a globally-bound constructor (the bfcl grant env binds it) — so `(list …)` is Σ-legal;
    // only the type gate could keep it out of a scalar slot. Its presence here is the point of test (2).
    list: callable,
    // `car` / `first` — element-returning ops, Σ-bound so `(car …)` is Σ-legal. The TYPE-REACHABILITY gate
    // must NOT mask them at a scalar slot (their RETURN is the element `T`, on a path to a valid value): the
    // green tests pin that `(car`/`(first` survive where `(list` dies — the discriminator enum-strict fails.
    car: callable,
    first: callable,
  });
}

const ENUM_MEMBERS = new Set(["fastest", "scenic"]);

/** A MOCK lens for the scalar string-enum callee `get_route`, returning the REAL lens's verified verdicts. */
function enumMockLens(): AsyncTypeLens {
  const ATOM = /[^\s()[\]{}"';]/;
  const headOfOpenCall = (prefix: string): string | null => {
    const open = prefix.lastIndexOf("(");
    if (open === -1) return null;
    let i = open + 1;
    while (i < prefix.length && /\s/.test(prefix[i])) i++;
    let head = "";
    while (i < prefix.length && ATOM.test(prefix[i])) head += prefix[i++];
    return head === "" ? null : head;
  };
  const atEnumSlot = (scheme: string, off: number): boolean => headOfOpenCall(scheme.slice(0, off)) === "get_route";
  return {
    // Σ∩T: at the get_route value slot, keep ONLY the enum members (drop `list`, drop non-enum words). The
    // real lens does this by assignability to the union; here we filter by membership.
    getTypeValidCandidates: (scheme, off, candidates) =>
      Promise.resolve(atEnumSlot(scheme, off) ? candidates.filter((c) => ENUM_MEMBERS.has(c)) : [...candidates]),
    // A scalar string-enum is NOT an array → false (the verified real verdict). Drives scalar-slot-masks-list.
    getSlotIsArray: (scheme, off) => Promise.resolve(atEnumSlot(scheme, off) ? false : null),
    // An ENUM resolves false — its members are bound value-symbols that pass Σ unaided (NOT a free-form
    // string slot). So the scalar-string Σ exemption must NOT loosen the enum (a bare non-member stays masked).
    getSlotAcceptsBareWord: (scheme, off) => Promise.resolve(atEnumSlot(scheme, off) ? false : null),
    // A scalar slot is not an array element — the element axis stays inert.
    getSlotElementType: () => Promise.resolve({ isStringy: null, enum: null }),
    // TYPE-REACHABILITY: `list` PROVABLY returns an array (a dead end at this scalar slot → the gate masks a
    // `(list` head); `car`/`first`/a field accessor return an element (NOT array → admitted, the pipe). The
    // real lens reads `ReturnType<typeof head>`; the mock encodes the verified verdicts.
    getHeadReturnsArray: (_scheme, head) =>
      Promise.resolve(head === "list" ? true : head === "car" || head === "first" ? false : null),
    // STRING-TYPED: the enum's type is `"fastest"|"scenic"`, a subtype of string → true (mask non-string
    // scalar literals — `#f`/`#t`, a number). The verified real verdict for a string-literal-union slot.
    getSlotIsStringTyped: (scheme, off) => Promise.resolve(atEnumSlot(scheme, off) ? true : null),
  };
}

describe("scalar-enum-integration (Part A) — the gate over the enum verdicts the real lens returns", () => {
  it("RED (1) string-slot-masks-boolean: `#f` at a scalar string-enum slot must be MASKED — route_type → #f", async () => {
    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), enumMockLens());
    const slot = "(get_route ";
    await scanner.prefill(slot); // warm the array/stringy stamps so the gate sees them synchronously
    const state = scanner.analyze(slot);
    // Sanity: the scalar stamp landed (the lens classified the enum slot correctly).
    expect(state.slotIsArray, "the enum slot is a scalar (not an array)").toBe(false);

    // THE BUG: `#f` (a boolean `#`-literal) is type-wrong at a string-enum slot, but the scalar structure
    // gate masks only LIST openers and Σ exempts `#`-literals as argument values — so `#f` survives.
    // EXPECTED (post-fix): masked. CURRENT (red): "feasible".
    expect(classifyCandidate(scanner, slot, "#f", undefined, state)).toBe("structural");
    expect(classifyCandidate(scanner, slot, "#t", undefined, state)).toBe("structural");
  });

  it("RED (2) scalar-slot-masks-list: `(list …)` at a scalar string-enum slot must be MASKED — time_frame → (list six)", async () => {
    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), enumMockLens());
    const slot = "(get_route ";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    expect(state.slotIsArray, "the enum slot is a scalar (not an array)").toBe(false);

    // TYPE-REACHABILITY (the principled fix, NOT enum-strict): `(list` is masked because its HEAD `list`
    // PROVABLY returns an array — `T[] ⊄ T` can never fill this scalar slot, a dead end. But the BARE `(` is
    // the SHARED PREFIX of both `(car …)` [admit — `car` returns the element `T`, on a path to a valid value]
    // and `(list …)` [mask]; masking the bare `(` is exactly the enum-strict PIPE-CUT the spec forbids (it
    // severs `(set-x (find-y …))` sequential execution). So `(list` is masked at the nested-operator head,
    // while `(` (no head yet — it prefixes EVERY op, including non-array ones) stays ADMITTED.
    expect(classifyCandidate(scanner, slot, "(list", undefined, state)).toBe("structural");
    expect(classifyCandidate(scanner, slot, "(", undefined, state)).toBe("feasible");
  });

  it("RED (3a) enum-narrow: a non-enum bare word at the scalar string-enum slot must be MASKED", async () => {
    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), enumMockLens());
    const slot = "(get_route ";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);

    // The enum members survive (the right answers the model had).
    expect(classifyCandidate(scanner, slot, "fastest", undefined, state)).toBe("feasible");
    expect(classifyCandidate(scanner, slot, "scenic", undefined, state)).toBe("feasible");
    // `six` is the prefix of `six_months` for a DIFFERENT enum — here it is a non-member bare word and
    // (being unbound at this slot) is already Σ-masked. This guards that the enum slot is genuinely narrowed
    // and a non-enum word cannot stand. EXPECTED & (today) holds via Σ — pinned so a fix can't regress it.
    expect(classifyCandidate(scanner, slot, "walking", undefined, state)).toBe("sigma");
  });

  it("RED (3b) enum slot masks the `'(` quote-list opener (incl. whitespace-led ` '`) — compounding_freq → (list '(#monthly))", async () => {
    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), enumMockLens());
    const slot = "(get_route ";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);

    // The inner `'(#monthly)` of the live corruption opens a quote-list at a scalar slot. That `'(` IS
    // masked by violatesValueStructure when the scalar stamp is present at an ARGUMENT boundary — this
    // pins that the enum slot closes the quote-list escape hatch (the `'` and the live ` '` token both).
    // `[` is the same story via the SAME gate (R-SCALAR-REJECTS-LIST — a vector literal at a scalar slot
    // is type-wrong; the grammar itself admits `[` since the reader gained vector literals).
    expect(classifyCandidate(scanner, slot, "'", undefined, state)).toBe("structural");
    expect(classifyCandidate(scanner, slot, " '", undefined, state)).toBe("structural");
    expect(classifyCandidate(scanner, slot, "[", undefined, state)).toBe("structural");
  });
});

// ── PART B — END-TO-END through the REAL type lens (the integration the prompt targets) ───────────────
//
// Build the per-param `.d.ts` exactly as the BFCL adapter feeds the lens — a `type:"string", enum:[…]`
// param becomes a string-literal UNION alias, the function's param typed to it, each enum member declared
// as a value-symbol on ArrShape. This is the same shape the lens's own WEATHER_HOST exercises and what
// `bfclToPrelude` emits. Then wrap the SYNC lens as an AsyncTypeLens (mirroring bfcl-generator.ts's
// `buildLensForPrelude`) and drive the REAL Σ∩T scanner. A failure here is the genuine integration bug —
// the scalar string-enum slot, classified by the real TS checker, still admits the corruptions.

/** The host prelude for a single string-enum param `route_type` of `get_route`, byte-shaped like the BFCL
 *  adapter's output (verified against arrival-lsp WEATHER_HOST + bfcl-types.ts:bfclToPrelude). */
function routeTypeHost(): ReturnType<typeof assembleHostPrelude> {
  return assembleHostPrelude(
    [
      // The function: its one param typed to the string-literal union (NOT `T_…[]` — a scalar enum, the
      // `param.type === "array" ? "[]" : ""` branch in bfcl-types.ts emits the bare alias here).
      ["get_route", "(route_type: T_get_route_route_type): string"],
      // The enum members as value-symbols on ArrShape, each typed to the union (the typed path's surface —
      // the model NAMES the bare symbol; the lens narrows WHICH per slot).
      ["fastest", ": T_get_route_route_type"],
      ["scenic", ": T_get_route_route_type"],
    ],
    { preamble: `type T_get_route_route_type = "fastest" | "scenic";` },
  );
}

/** Wrap the SYNC lens as the sampler's AsyncTypeLens — the EXACT adapter bfcl-generator.ts:buildLensForPrelude
 *  uses on the live llama path (Promise.resolve over the sync verdicts). This is the real type/PROFILE
 *  construction → arrival-lsp classification path the bug rides. */
function realEnumLens(): AsyncTypeLens {
  const ls = createSchemeLanguageService({ host: routeTypeHost() });
  return {
    getTypeValidCandidates: (scheme, offset, candidates) =>
      Promise.resolve(ls.getTypeValidCandidates(scheme, offset, [...candidates])),
    getSlotIsArray: (scheme, offset) => Promise.resolve(ls.getSlotIsArray(scheme, offset)),
    getSlotAcceptsBareWord: (scheme, offset) => Promise.resolve(ls.getSlotAcceptsBareWord(scheme, offset)),
    getSlotElementType: (scheme, offset) => Promise.resolve(ls.getSlotElementType(scheme, offset)),
    getHeadReturnsArray: (scheme, head) => Promise.resolve(ls.getHeadReturnsArray(scheme, head)),
    getSlotIsStringTyped: (scheme, offset) => Promise.resolve(ls.getSlotIsStringTyped(scheme, offset)),
  };
}

describe("scalar-enum-integration (Part B) — END-TO-END through the REAL type lens", () => {
  it("the real lens classifies the string-enum slot as a SCALAR (slotIsArray:false, acceptsBareWord:false)", () => {
    // This pins the lens half of the integration: a `type:string, enum` param is NOT array-typed and NOT
    // free-form string. (If THIS regresses, the bug moved into the lens; today it passes — the lens is sound.)
    const ls = createSchemeLanguageService({ host: routeTypeHost() });
    const slot = "(get_route ";
    expect(ls.getSlotIsArray(slot, slot.length), "a scalar string-enum is not an array").toBe(false);
    expect(ls.getSlotAcceptsBareWord(slot, slot.length), "an enum is not a free-form string slot").toBe(false);
    // And the value-narrowing keeps the enum members while dropping the `list` constructor (a non-member).
    const kept = new Set(ls.getTypeValidCandidates(slot, slot.length, ["fastest", "scenic", "list"]));
    expect(kept.has("fastest"), "enum member kept").toBe(true);
    expect(kept.has("scenic"), "enum member kept").toBe(true);
    expect(kept.has("list"), "the list constructor is NOT a member of the enum → dropped").toBe(false);
  });

  it("RED end-to-end: at the real-lens-classified enum slot, `#f` / `(list …)` / `'(` must be MASKED", async () => {
    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), realEnumLens());
    const slot = "(get_route ";
    await scanner.prefill(slot); // warm the real-lens stamps for the value slot
    const state = scanner.analyze(slot);
    // The real lens stamped the scalar verdict onto the OracleState (the integration carried it through).
    expect(state.slotIsArray, "the real lens's scalar verdict reached the OracleState").toBe(false);

    // The three live corruptions, each must be masked at a scalar string-enum slot:
    expect(classifyCandidate(scanner, slot, "#f", undefined, state), "route_type → #f").toBe("structural");
    expect(classifyCandidate(scanner, slot, "(list", undefined, state), "time_frame → (list six)").toBe("structural");
    expect(classifyCandidate(scanner, slot, "'", undefined, state), "compounding_freq → '(#monthly)").toBe(
      "structural",
    );
    expect(classifyCandidate(scanner, slot, " '", undefined, state), "whitespace-led ` '` token").toBe("structural");
    // The enum members the model had RIGHT must survive (no over-masking of the correct answer).
    expect(classifyCandidate(scanner, slot, "fastest", undefined, state), "the right answer survives").toBe("feasible");
  });

  it("RED end-to-end (shared-kernel mask): the per-step kernel must MASK the boolean/list/quote opener at the enum slot", async () => {
    // Drive the SHARED per-step kernel (`selectConstrainedStep`, the decision both backends apply) over a toy
    // vocab so the failure is proven on the real mask, not just the classifier — per the project's
    // adversarial-distribution rule (feed the structurally-wrong token and assert the mask vetoes it). The
    // vocab spells `(get_route ` plus the corruption openers under test.
    const TOKENS = [
      { id: 0, str: "(" },
      { id: 1, str: "get_route" },
      { id: 2, str: " " },
      { id: 3, str: "#f" }, // boolean — the route_type corruption
      { id: 4, str: "list" }, // the `(list …)` constructor head (with id 0 `(` ⇒ `(list`)
      { id: 5, str: "'" }, // quote-list opener — the compounding_freq corruption
      { id: 6, str: "fastest" }, // the right answer (must survive)
      { id: 7, str: "scenic" }, // the other enum member
      { id: 8, str: ")" },
    ];
    const EOS_ID = 9;

    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), realEnumLens());
    // Warm BOTH the value slot AND the nested-operator slot the incremental `(list` rides through. The toy
    // vocab splits `(list` into `(` (id 0) then `list` (id 4), so the `(list …)` corruption is prevented in
    // TWO steps: the bare `(` is ADMITTED (the pipe's shared prefix), then `list` is masked at the nested
    // operator `(get_route (` (its head reaches no scalar). Per the reachability principle, NOT by masking `(`.
    await scanner.prefill("(get_route ");
    await scanner.prefill("(get_route (");
    const kept = keptStringsAt(scanner, TOKENS, EOS_ID, "(get_route ");

    // EXPECTED (post-fix): the boolean `#f` and the quote `'` are masked at the scalar string-enum slot; the
    // enum members survive. The bare `(` SURVIVES (it is reachable — `(car …)` leads to a valid value); the
    // `(list …)` it could start is cut at the NEXT step (below), at the head, not here.
    expect(kept.has("#f"), "a boolean is masked at a string-enum slot").toBe(false);
    expect(kept.has("'"), "the quote-list opener is masked at a scalar slot").toBe(false);
    expect(kept.has("("), "the bare `(` is ADMITTED — the shared prefix of the reachable `(car …)` pipe").toBe(true);
    expect(kept.has("fastest"), "the right answer survives").toBe(true);
    expect(kept.has("scenic"), "the other enum member survives").toBe(true);

    // THE SECOND STEP — the incremental reachability cut: after the bare `(` commits (prefix `(get_route (`),
    // the nested-operator head is masked to the heads whose RETURN reaches the scalar slot. `list` (returns an
    // array) is masked here — this is where `(list …)` actually dies. (`car`/`first` are not in this toy vocab;
    // the classifier-level green tests below cover their ADMISSION.)
    const keptOp = keptStringsAt(scanner, TOKENS, EOS_ID, "(get_route (");
    expect(keptOp.has("list"), "`list` is masked at the nested operator inside a scalar slot").toBe(false);
  });
});

// ── PART C — the operator→argument TRANSITION (the live mechanism of `'(#monthly)`, NOW FIXED) ─────────
//
// The `'(` corruption leaks even though, at a CLEAN argument boundary, `violatesValueStructure` masks it
// (Part A test (3b) passes). The live mechanism: the model emits the head-close + value-open as ONE token
// (` '(`, ` #f`, ` (list six)`). At that step the committed prefix is `(get_route` — the head is still
// being typed, so `analyze(prefix)` is `position: "operator"`, `midToken: true`. The OLD decode-loop computed
// the gate's value-slot state re-analyzing at the boundary ONLY for `position === "argument"`:
//     slotState = (s.midToken && s.position === "argument") ? analyze(prefix + " ") : s   ← the BUG
// THE FIX (lazy-processor.ts, llama-cpp-generate.ts, decode-strategy.ts): re-analyze at `prefix + " "` for
// the operator-transition case TOO. At `(get_route` (midToken operator) the boundary `(get_route ` IS the
// scalar arg slot, so its `slotIsArray:false` + `slotIsStringTyped:true` + `arrayReturningHeads` stamps reach
// the gate, and every value-opener glued behind the head-close space (` #f`, ` '(`, ` (list six)`) is masked.

/** The FIXED live decode-loop's value-slot-state computation (lazy-processor.ts / decode-strategy.ts). The
 *  boundary re-analyze now fires for the OPERATOR-transition case too (the head is being typed and the next
 *  token closes it + opens the value), not only `position === "argument"` — so the scalar stamp from the
 *  value's true slot reaches the structure/reachability gate. */
function liveSlotState(
  scanner: ReturnType<typeof narrowByTypeAsync>,
  prefix: string,
): ReturnType<ReturnType<typeof narrowByTypeAsync>["analyze"]> {
  const prefixState = scanner.analyze(prefix);
  return prefixState.midToken && (prefixState.position === "argument" || prefixState.position === "operator")
    ? scanner.analyze(`${prefix} `)
    : prefixState;
}

describe("scalar-enum-integration (Part C) — the operator→argument transition", () => {
  it("a single token spanning head-close + value-open is MASKED (` '(` / ` (list …)` / ` #f`)", async () => {
    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), realEnumLens());
    // The head is being typed — the next token will both CLOSE `get_route` and OPEN the first value.
    const prefix = "(get_route";
    await scanner.prefill(prefix); // prefill warms `prefix` AND `prefix + " "` (the next-boundary slot)
    const slotState = liveSlotState(scanner, prefix);

    // The FIXED slotState carries the scalar arg-0 stamps (the boundary `(get_route ` re-analyze), so every
    // value-opening token glued behind the head-close space is masked: `'(` and `#f` by the literal arms,
    // ` (list six)` by the TYPE-REACHABILITY arm (its head `list` returns an array → a scalar-slot dead end).
    expect(classifyCandidate(scanner, prefix, " '(", undefined, slotState), "compounding_freq → '(#monthly)").toBe(
      "structural",
    );
    expect(classifyCandidate(scanner, prefix, " (list six)", undefined, slotState), "time_frame → (list six)").toBe(
      "structural",
    );
    expect(classifyCandidate(scanner, prefix, " #f", undefined, slotState), "route_type → #f").toBe("structural");
    // The pipe SURVIVES the transition: a bare ` (` opener and ` (car …)` (element-returning head) are
    // ADMITTED at the same operator-transition step — only the array-returning head dies.
    expect(classifyCandidate(scanner, prefix, " (", undefined, slotState), "bare ( — the shared pipe prefix").toBe(
      "feasible",
    );
    expect(
      classifyCandidate(scanner, prefix, " (car", undefined, slotState),
      "(car — element-returning, reachable",
    ).toBe("feasible");
  });

  it("CONTRAST: at the CLEAN argument boundary `'` IS masked — proving the leak is the transition, not the gate", async () => {
    // This is the SAME scalar slot, reached cleanly (the head already closed). Here `violatesValueStructure`
    // fires (position === "argument", slotIsArray stamped false), so `'` is masked — the quote-list gate
    // WORKS when the stamp is present. The Part-C leak above is therefore purely the operator-transition
    // stamp-miss, not a missing gate. (This passes today; it pins the contrast so a fix can't blur it.)
    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), realEnumLens());
    const slot = "(get_route ";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    expect(state.position, "the clean boundary is an argument slot").toBe("argument");
    expect(state.slotIsArray, "the scalar stamp is present at the clean boundary").toBe(false);
    expect(classifyCandidate(scanner, slot, "'", undefined, state), "`'` masked at the clean boundary").toBe(
      "structural",
    );
  });
});

// ── GREEN — the TYPE-REACHABILITY pipe SURVIVES (the discriminator an enum-strict fix CANNOT fake) ─────
//
// Red alone (Parts A–C) is satisfiable by enum-strict (mask EVERY `(` at the enum slot — the pipe-cutter).
// These GREEN rows prove the SOUND polarity: a head whose RETURN reaches the slot type is ADMITTED, so the
// sequential-execution pipe (`(car …)` / `(first …)` / `(:field …)` → a value of type T) survives. A change
// that passes A–C but fails these is the cheap cut in disguise.

describe("scalar-enum-integration (GREEN) — the reachable pipe survives at the scalar enum slot", () => {
  it("`(car` / `(first` / `:field` are ADMITTED — their return reaches the scalar value (the pipe)", async () => {
    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), realEnumLens());
    const slot = "(get_route ";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    // The scalar context is stamped (the reachability arm is ACTIVE — not a vacuous pass).
    expect(state.slotIsArray, "the slot is scalar").toBe(false);
    expect(state.arrayReturningHeads !== undefined, "the reachability stamp is present").toBe(true);
    expect([...(state.arrayReturningHeads ?? [])], "only `list` is provably array-returning").toEqual(["list"]);

    // `(car` / `(first` open a call whose head returns the ELEMENT `T` (NOT an array) — on a path to a valid
    // scalar value, so ADMITTED. `(list` (the same SHAPE, an array-returning head) is MASKED — the contrast
    // that proves it is reachability, not "mask all `(`".
    expect(classifyCandidate(scanner, slot, "(car", undefined, state), "(car — element-returning").toBe("feasible");
    expect(classifyCandidate(scanner, slot, "(first", undefined, state), "(first — element-returning").toBe("feasible");
    expect(classifyCandidate(scanner, slot, "(list", undefined, state), "(list — array-returning, the dead end").toBe(
      "structural",
    );
    // `:field` (a keyword member-read, `(:field row)` → the field value) is a `T`-producer too — ADMITTED
    // (Σ exempts the `:`-accessor; the reachability arm only fires on a `(`-call opener).
    expect(classifyCandidate(scanner, slot, ":field", undefined, state), ":field — a field accessor").toBe("feasible");
    // The bare enum member — the literal path — survives (the right answer the model had).
    expect(classifyCandidate(scanner, slot, "fastest", undefined, state), "the enum member").toBe("feasible");
  });

  it("`(list` is ADMITTED INSIDE `(car █)` — that argument slot WANTS `T[]`, so a list head reaches it", async () => {
    // The load-bearing type-contextuality: the SAME symbol `list` is MASKED at the scalar `get_route` slot
    // (above) and ADMITTED here, decided ONLY by the wanted wire-type. `car`'s argument is `List<T>` — an
    // array slot — where a `(list …)` materializer is exactly right (and a scalar literal is wrong).
    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), realEnumLens());
    const slot = "(get_route (car ";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    expect(state.slotIsArray, "car's argument slot is an array (List<T>)").toBe(true);
    // At an ARRAY slot the reachability arm is NOT stamped (arrayReturningHeads present only at scalar slots),
    // so a `(list` head is ADMITTED; the literal arm forces a list (a scalar literal is masked).
    expect(state.arrayReturningHeads, "no reachability stamp at an array slot").toBe(undefined);
    expect(classifyCandidate(scanner, slot, "(list", undefined, state), "`(list` reaches the T[] slot").toBe(
      "feasible",
    );
    expect(classifyCandidate(scanner, slot, '"oops"', undefined, state), "a scalar literal is masked at T[]").toBe(
      "structural",
    );
  });

  it("REGRESSION: the array-slot structure gate is UNCHANGED — `(list` admitted, scalar literal masked", async () => {
    // The reachability arm only ADDS masks at SCALAR slots; the existing ARRAY-slot behaviour (force a list)
    // is untouched. Pinned against a regression where the new arm bleeds into the array path.
    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), realEnumLens());
    const slot = "(get_route (car ";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    expect(classifyCandidate(scanner, slot, "(", undefined, state), "a call opener survives at T[]").toBe("feasible");
    expect(classifyCandidate(scanner, slot, "5", undefined, state), "a number literal masked at T[]").toBe(
      "structural",
    );
    expect(
      classifyCandidate(scanner, slot, "[", undefined, state),
      "the `[` vector literal is first-class at T[] (R-NO-BRACKETS retired; the reader parses it)",
    ).toBe("feasible");
  });

  it("REAL MASK PATH (adversarial): `(list` is VETOED while `(car` is ADMITTED at the enum slot", async () => {
    // Drive the SHARED per-step kernel (per feedback-sampler-test-adversarial-distribution): feed a vocab
    // where the structurally-WRONG head (`list`) and the RIGHT head (`car`) are both reachable as the FIRST
    // token after the bare `(`, and assert the mask vetoes the array head but keeps the element head. The
    // mask is rank-INDEPENDENT (`keepN = ∞` keeps every feasible token), so the veto holds even when `list`
    // is the model's top pick — the old Tensor vehicle spiked `list`'s logit to prove this; the kernel masks
    // by feasibility, not rank, so the adversarial ordering is irrelevant by construction.
    const TOKENS = [
      { id: 0, str: "(" },
      { id: 1, str: "get_route" },
      { id: 2, str: " " },
      { id: 3, str: "list" }, // array-returning head — MASKED at the nested operator inside the scalar slot
      { id: 4, str: "car" }, // element-returning head — ADMITTED (the pipe)
      { id: 5, str: "first" }, // element-returning head — ADMITTED
      { id: 6, str: "fastest" },
      { id: 7, str: ")" },
    ];
    const EOS_ID = 8;

    const scanner = narrowByTypeAsync(makeOracle(enumGrantEnv()), realEnumLens());
    await scanner.prefill("(get_route ");
    await scanner.prefill("(get_route (");
    // At the nested operator (the `(` committed), the head set is narrowed by RETURN-reachability:
    const keptOp = keptStringsAt(scanner, TOKENS, EOS_ID, "(get_route (");
    expect(keptOp.has("list"), "the array-returning head is VETOED at the scalar slot").toBe(false);
    expect(keptOp.has("car"), "the element-returning head survives (the pipe)").toBe(true);
    expect(keptOp.has("first"), "the other element-returning head survives").toBe(true);
  });
});
