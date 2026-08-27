// query — proves the Σ∩T narrow over a harvested prelude: the slot type is read off the
// checker, candidates are filtered against it, and — THE GOVERNING INVARIANT — the filter is
// CONSERVATIVE, DROPS-ONLY. A candidate is removed only when PROVABLY ill-typed at the slot;
// every valid or uncertain candidate is KEPT. These tests assert that directly: across a list,
// string, number, and top slot, no valid/uncertain candidate is ever dropped.

import { describe, expect, it } from "vitest";

import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import { assembleHarvestedPrelude } from "../prelude.js";
import { createQueryLens } from "../query.js";

// ── grant tools (built exactly as prelude.test.ts does — zod schemas → harvested signatures) ──
//
//   get_route     (a: List<unknown>, b: string) => Promise<string>   — list slot + string slot
//   sum_readings  (a: number[])                 => Promise<number>   — vector slot; number return
//   set_timer     (a: number)                   => Promise<void>     — scalar slot; void return
//   make_route    ()                            => Promise<List<unknown>>  — a list-RETURNING head
// `z.pair` is cons(value, value) — a dotted-pair codec, not list-shaped — `z.union([z.pair,
// z.nil])` is not "a proper list." z.list() is the actual proper-list constructor (prints List<unknown>).
const getRoute = symbol.rosetta`get-route: route between stops`(
  { input: [z.list(), z.string], output: [z.string] },
  () => "",
);
const sumReadings = symbol.rosetta`sum-readings: total the readings`(
  { input: [z.array(z.number)], output: [z.number] },
  () => 0,
);
const setTimer = symbol.rosetta`set-timer: start a timer`(
  { input: [z.number], output: [z.undefinedResult] },
  () => undefined,
);
const makeRoute = symbol.rosetta`make-route: build a fresh route`(
  { input: [], output: [z.list()] },
  // `symbol.rosetta` runs in JS space (auto-converts on crossing) — the impl returns the
  // raw JS array shape z.list() decodes to, never the boxed scheme `nil`.
  () => [],
);
//   plan_route   (a: "fast" | "scenic",          — a DIRECT closed string-literal enum slot
//                 b: ("fast" | "scenic")[],       — an ARRAY-of-enum slot (element is the enum)
//                 c: string)        => Promise<string>  — a free-form string slot
const planRoute = symbol.rosetta`plan-route: choose a routing mode`(
  { input: [z.enum(["fast", "scenic"]), z.array(z.enum(["fast", "scenic"])), z.string], output: [z.string] },
  () => "",
);

const lens = createQueryLens(
  assembleHarvestedPrelude([
    ["get_route", getRoute],
    ["sum_readings", sumReadings],
    ["set_timer", setTimer],
    ["make_route", makeRoute],
    ["plan_route", planRoute],
  ]),
);

/** Split a scheme containing a single `|` cursor marker into `[scheme, cursorOffset]`. */
function at(marked: string): [string, number] {
  const offset = marked.indexOf("|");
  if (offset < 0) throw new Error(`no cursor marker in ${JSON.stringify(marked)}`);
  return [marked.slice(0, offset) + marked.slice(offset + 1), offset];
}

const valid = (marked: string, cands: readonly string[]): string[] => {
  const [scheme, offset] = at(marked);
  return lens.getTypeValidCandidates(scheme, offset, cands);
};
const kind = (marked: string): "list" | "vector" | "scalar" | null => {
  const [scheme, offset] = at(marked);
  return lens.getSlotArrayKind(scheme, offset);
};
const element = (marked: string): { isStringy: boolean | null; enum: readonly string[] | null } => {
  const [scheme, offset] = at(marked);
  return lens.getSlotElementType(scheme, offset);
};
const bareWord = (marked: string): boolean | null => {
  const [scheme, offset] = at(marked);
  return lens.getSlotAcceptsBareWord(scheme, offset);
};
const stringTyped = (marked: string): boolean | null => {
  const [scheme, offset] = at(marked);
  return lens.getSlotIsStringTyped(scheme, offset);
};

// ── kebab / operator-named callees narrow too (the `_` namespace) ──────────────
// A scheme tool named with a hyphen (`get-route`) lowers its head to the ESCAPED, dotted member
// `_.get$dash$route` (name-escape.ts) — NOT a string index — so `typeof _.get$dash$route` is a
// legal type query and the slot type resolves: the narrow ENGAGES instead of falling to keep-all.
// Identifier (underscore/bfcl) callees stay bare (`typeof get_route`) — the same code path.
describe("getTypeValidCandidates — kebab/operator-named callees narrow", () => {
  const kebabLens = createQueryLens(
    assembleHarvestedPrelude([
      ["get-route", getRoute],
      ["make-route", makeRoute],
      ["set-timer", setTimer],
    ]),
  );
  const kvalid = (marked: string, cands: readonly string[]): string[] => {
    const [scheme, offset] = at(marked);
    return kebabLens.getTypeValidCandidates(scheme, offset, cands);
  };

  // One row per kebab-callee slot: arg 0 (get-route …) → _.get$dash$route(…), a list-typed slot;
  // arg 1 → a string-typed slot. make-route returns a list, set-timer returns void.
  it.each([
    {
      name: "a kebab callee's LIST slot narrows: drops the void-returner, keeps the list-returner + local",
      marked: "(get-route |)",
      cands: ["make-route", "set-timer", "my_local"],
      expected: ["make-route", "my_local"],
    },
    {
      name: "a kebab callee's STRING slot still narrows: drops the list-returner, keeps the local",
      marked: "(get-route 1 |)",
      cands: ["make-route", "my_local"],
      expected: ["my_local"],
    },
  ])("$name", ({ marked, cands, expected }) => {
    expect(kvalid(marked, cands)).toEqual(expected);
  });
});

// ── kwargs / object-value slots narrow to the PROPERTY type ────────────────────
// `(create_user :name |)` lowers to `create_user({ name: ‹cursor› })`; the cursor is the `name`
// property's VALUE, so the slot narrows to that property's type (`…[0]["name"]`), not the whole
// object. Every existing axis (candidates / arrayKind / elementType) then narrows the value for free.
describe("kwargs / object-value slots narrow to the property type", () => {
  const userTool = symbol.rosetta`create_user: make a user`(
    { input: [], inputRest: { name: z.string, mode: z.enum(["fast", "scenic"]).optional() }, output: [z.string] },
    () => "",
  );
  const kw = createQueryLens(
    assembleHarvestedPrelude([
      ["create_user", userTool],
      ["sum_readings", sumReadings],
    ]),
  );

  it("a string-valued kwarg: element-domain is free-form string; the value slot is scalar", () => {
    const [scheme, offset] = at("(create_user :name |)");
    expect(kw.getSlotElementType(scheme, offset)).toEqual({ isStringy: true, enum: null });
    expect(kw.getSlotArrayKind(scheme, offset)).toBe("scalar");
  });

  it("an enum-valued kwarg narrows to its members", () => {
    const [scheme, offset] = at("(create_user :mode |)");
    expect(kw.getSlotElementType(scheme, offset)).toEqual({ isStringy: null, enum: ["fast", "scenic"] });
  });

  it("drops-only: a number-returner is dropped at a string-valued kwarg; the unresolved local kept", () => {
    const [scheme, offset] = at("(create_user :name |)");
    expect(kw.getTypeValidCandidates(scheme, offset, ["sum_readings", "my_local"])).toEqual(["my_local"]);
  });
});

describe("getTypeValidCandidates — the Σ∩T mask is DROPS-ONLY", () => {
  // One row per slot — the candidate list in, the surviving candidates out. Only the provably
  // ill-typed candidate is ever absent; a valid or unresolved candidate always survives.
  it.each([
    {
      name: "LIST slot: drops the provably-non-list, KEEPS the list-returner AND the unresolved local",
      // get_route arg 0 is `List<unknown>`. make_route returns a list (kept), sum_readings
      // returns a number (PROVABLY ill-typed — dropped), my_local is undeclared (uncertain — kept).
      marked: "(get_route |)",
      cands: ["make_route", "sum_readings", "my_local"],
      expected: ["make_route", "my_local"],
    },
    {
      name: "LIST slot: the generic carrier `list` is KEPT (its return is a list)",
      marked: "(get_route |)",
      cands: ["list", "sum_readings"],
      expected: ["list"],
    },
    {
      name: "STRING slot: keeps the string-returner + the unresolved local; drops the rest",
      // get_route arg 1 is `string`. get_route itself returns a string (kept); set_timer
      // returns void and make_route returns a list (both PROVABLY ill-typed — dropped);
      // my_local kept.
      marked: "(get_route 1 |)",
      cands: ["get_route", "set_timer", "make_route", "my_local"],
      expected: ["get_route", "my_local"],
    },
    {
      name: "NUMBER slot: keeps the number-returner + the unresolved local; drops the string-returner",
      // set_timer arg 0 is `number`. sum_readings returns a number (kept); get_route returns a
      // string (dropped); my_local kept.
      marked: "(set_timer |)",
      cands: ["sum_readings", "get_route", "my_local"],
      expected: ["sum_readings", "my_local"],
    },
    {
      name: "TOP / no enclosing call: every candidate is kept (T never narrows an operator/top slot)",
      marked: "|",
      cands: ["sum_readings", "set_timer", "anything"],
      expected: ["sum_readings", "set_timer", "anything"],
    },
    {
      name: "OPERATOR slot (cursor at the head): every candidate is kept",
      marked: "(|)",
      cands: ["sum_readings", "set_timer", "make_route"],
      expected: ["sum_readings", "set_timer", "make_route"],
    },
    {
      name: "unknown callee → unresolved slot → every candidate kept (conservative)",
      marked: "(no_such_tool |)",
      cands: ["sum_readings", "set_timer"],
      expected: ["sum_readings", "set_timer"],
    },
    {
      name: "empty candidate list returns empty (no compile)",
      marked: "(get_route |)",
      cands: [],
      expected: [],
    },
  ])("$name", ({ marked, cands, expected }) => {
    expect(valid(marked, cands)).toEqual(expected);
  });

  // ★THE INVARIANT, asserted directly: across every slot, no VALID or UNCERTAIN candidate is
  // ever dropped — the unresolved local survives unconditionally, and each slot's genuinely-valid
  // candidate survives. Only the provably ill-typed candidate is absent.
  it("INVARIANT — a valid/uncertain candidate is NEVER dropped, at any slot", () => {
    const slots = ["(get_route |)", "(get_route 1 |)", "(set_timer |)", "(sum_readings |)"];
    for (const slot of slots) {
      // the uncertain candidate is kept everywhere
      expect(valid(slot, ["my_local"])).toEqual(["my_local"]);
      // a candidate is never dropped when it is the ONLY one and resolves to the slot via keep-on-uncertainty
      expect(valid(slot, ["my_local", "another_local"])).toEqual(["my_local", "another_local"]);
    }
    // each slot keeps its own genuinely-valid candidate
    expect(valid("(get_route |)", ["make_route"])).toEqual(["make_route"]); // list ← list-returner
    expect(valid("(get_route 1 |)", ["get_route"])).toEqual(["get_route"]); // string ← string-returner
    expect(valid("(set_timer |)", ["sum_readings"])).toEqual(["sum_readings"]); // number ← number-returner
  });
});

describe("getSlotArrayKind — the 3-way value verdict", () => {
  // One row per slot shape → its array-kind verdict.
  it.each([
    { name: 'a list param → "list"', marked: "(get_route |)", expected: "list" },
    { name: 'a vector (number[]) param → "vector"', marked: "(sum_readings |)", expected: "vector" },
    { name: 'a number param → "scalar"', marked: "(set_timer |)", expected: "scalar" },
    {
      name: 'a string param → "scalar" (string folds into scalar for the array verdict)',
      marked: "(get_route 1 |)",
      expected: "scalar",
    },
    { name: "an unresolved slot (unknown callee) → null", marked: "(no_such_tool |)", expected: null },
    { name: "a top / no-call cursor → null", marked: "|", expected: null },
  ])("$name", ({ marked, expected }) => {
    expect(kind(marked)).toBe(expected);
  });
});

describe("getSlotElementType — the ENUM / closed-domain narrow (the highest-value axis)", () => {
  // One row per slot shape → its { isStringy, enum } element-domain verdict.
  it.each([
    {
      // plan_route arg 0 is `"fast" | "scenic"`. The domain is the slot itself (ElemOf is never
      // for a scalar) → a PROVED closed string set → its two members.
      name: "a DIRECT enum param → its members as enum (isStringy null)",
      marked: "(plan_route |)",
      expected: { isStringy: null, enum: ["fast", "scenic"] },
    },
    {
      // plan_route arg 1 is `("fast" | "scenic")[]`. ElemOf recovers the enum element → same members.
      name: "an ARRAY-of-enum param → the ELEMENT's members as enum",
      marked: "(plan_route 'x |)",
      expected: { isStringy: null, enum: ["fast", "scenic"] },
    },
    {
      // plan_route arg 2 is `string` (ElemOf never → domain is the slot → free-form string).
      name: "a free-form string param → isStringy true, enum null (plan_route trailing string arg)",
      marked: "(plan_route 'x (list) |)",
      expected: { isStringy: true, enum: null },
    },
    {
      name: "a free-form string param → isStringy true, enum null (get_route string arg)",
      marked: "(get_route 1 |)",
      expected: { isStringy: true, enum: null },
    },
    {
      name: "a number param → both null (a non-string domain narrows nothing)",
      marked: "(set_timer |)",
      expected: { isStringy: null, enum: null },
    },
    {
      name: "a List<unknown> param → both null (the element isn't a string set)",
      marked: "(get_route |)", // element is `unknown`
      expected: { isStringy: null, enum: null },
    },
    {
      name: "a vector<number> param → both null (the element isn't a string set)",
      marked: "(sum_readings |)", // element is `number`
      expected: { isStringy: null, enum: null },
    },
    // ★SUPERSET-SAFE: an unresolved slot and a no-call cursor BOTH return both-null, so a
    // consumer never narrows a domain we could not resolve.
    {
      name: "an unresolved slot (unknown callee) → both null",
      marked: "(no_such_tool |)",
      expected: { isStringy: null, enum: null },
    },
    { name: "a top cursor → both null", marked: "|", expected: { isStringy: null, enum: null } },
    { name: "an operator slot cursor → both null", marked: "(|)", expected: { isStringy: null, enum: null } },
  ])("$name", ({ marked, expected }) => {
    expect(element(marked)).toEqual(expected);
  });
});

describe("getSlotAcceptsBareWord — a bare word is admissible as a string", () => {
  // One row per slot shape → whether a bare word is admissible there.
  it.each([
    { name: "a free-form string slot → true (get_route string arg)", marked: "(get_route 1 |)", expected: true },
    {
      name: "a free-form string slot → true (plan_route trailing string arg)",
      marked: "(plan_route 'x (list) |)",
      expected: true,
    },
    {
      name: "a closed enum slot → false (a bare word is NOT any string here)",
      marked: "(plan_route |)",
      expected: false,
    },
    { name: "a list slot → false (List<unknown>, not a string slot)", marked: "(get_route |)", expected: false },
    { name: "a vector slot → false (number[], not a string slot)", marked: "(sum_readings |)", expected: false },
    { name: "a number slot → false (number, not a string slot)", marked: "(set_timer |)", expected: false },
    // ★SUPERSET-SAFE: unresolved → null (the gate no-ops), never a guessed boolean.
    { name: "an unresolved slot → null", marked: "(no_such_tool |)", expected: null },
    { name: "a top cursor → null", marked: "|", expected: null },
    { name: "an operator slot cursor → null", marked: "(|)", expected: null },
  ])("$name", ({ marked, expected }) => {
    expect(bareWord(marked)).toBe(expected);
  });
});

describe("getSlotIsStringTyped — the slot is a string subtype, not an array", () => {
  // One row per slot shape → whether the slot is a string subtype.
  it.each([
    { name: "a free-form string slot → true", marked: "(get_route 1 |)", expected: true },
    { name: "a closed enum slot → true (an enum IS a string subtype)", marked: "(plan_route |)", expected: true },
    { name: "a number slot → false (not a string subtype)", marked: "(set_timer |)", expected: false },
    { name: "a list slot → false (List<unknown>, not a string subtype)", marked: "(get_route |)", expected: false },
    { name: "a vector slot → false (number[], not a string subtype)", marked: "(sum_readings |)", expected: false },
    // ★SUPERSET-SAFE: unresolved → null.
    { name: "an unresolved slot → null", marked: "(no_such_tool |)", expected: null },
    { name: "a top cursor → null", marked: "|", expected: null },
    { name: "an operator slot cursor → null", marked: "(|)", expected: null },
  ])("$name", ({ marked, expected }) => {
    expect(stringTyped(marked)).toBe(expected);
  });
});
