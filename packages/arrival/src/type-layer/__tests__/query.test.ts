// query — proves the Σ∩T narrow over a harvested prelude: the slot type is read off the
// checker, candidates are filtered against it, and — THE GOVERNING INVARIANT — the filter is
// CONSERVATIVE, DROPS-ONLY. A candidate is removed only when PROVABLY ill-typed at the slot;
// every valid or uncertain candidate is KEPT. These tests assert that directly: across a list,
// string, number, and top slot, no valid/uncertain candidate is ever dropped.

import { describe, expect, it } from "vitest";

import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { nil } from "../../values/primitives/ANil.js";
import { assembleHarvestedPrelude } from "../prelude.js";
import { createQueryLens } from "../query.js";

// ── grant tools (built exactly as prelude.test.ts does — zod schemas → harvested signatures) ──
//
//   get_route     (a: List<unknown>, b: string) => Promise<string>   — list slot + string slot
//   sum_readings  (a: number[])                 => Promise<number>   — vector slot; number return
//   set_timer     (a: number)                   => Promise<void>     — scalar slot; void return
//   make_route    ()                            => Promise<List<unknown>>  — a list-RETURNING head
const getRoute = symbol.rosetta`get-route: route between stops`(
  { input: [z.union([z.pair, z.nil]), z.string], output: [z.string] },
  () => "",
);
const sumReadings = symbol.rosetta`sum-readings: total the readings`(
  { input: [z.array(z.number)], output: [z.number] },
  () => 0,
);
const setTimer = symbol.rosetta`set-timer: start a timer`(
  { input: [z.number], output: [z.void()] },
  () => undefined,
);
const makeRoute = symbol.rosetta`make-route: build a fresh route`(
  { input: [], output: [z.union([z.pair, z.nil])] },
  () => nil,
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

  it("a kebab callee's LIST slot narrows: drops the void-returner, keeps the list-returner + local", () => {
    // (get-route …) → _.get$dash$route(…); arg 0 is List<unknown>. make-route returns a list (kept),
    // set-timer returns void (PROVABLY ill-typed — dropped), my_local is uncertain (kept).
    expect(kvalid("(get-route |)", ["make-route", "set-timer", "my_local"])).toEqual(["make-route", "my_local"]);
  });

  it("a kebab callee's STRING slot still narrows: drops the list-returner, keeps the local", () => {
    expect(kvalid("(get-route 1 |)", ["make-route", "my_local"])).toEqual(["my_local"]);
  });
});

// ── kwargs / object-value slots narrow to the PROPERTY type ────────────────────
// `(create_user :name |)` lowers to `create_user({ name: ‹cursor› })`; the cursor is the `name`
// property's VALUE, so the slot narrows to that property's type (`…[0]["name"]`), not the whole
// object. Every existing axis (candidates / arrayKind / elementType) then narrows the value for free.
describe("kwargs / object-value slots narrow to the property type", () => {
  const userTool = symbol.rosetta`create_user: make a user`(
    { input: z.kwargs({ name: z.string, mode: z.enum(["fast", "scenic"]).optional() }), output: [z.string] },
    () => "",
  );
  const kw = createQueryLens(assembleHarvestedPrelude([["create_user", userTool], ["sum_readings", sumReadings]]));

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
  it("LIST slot: drops the provably-non-list, KEEPS the list-returner AND the unresolved local", () => {
    // get_route arg 0 is `List<unknown>`. make_route returns a list (kept), sum_readings returns
    // a number (PROVABLY ill-typed — dropped), my_local is undeclared (uncertain — kept).
    expect(valid("(get_route |)", ["make_route", "sum_readings", "my_local"])).toEqual(["make_route", "my_local"]);
  });

  it("LIST slot: the generic carrier `list` is KEPT (its return is a list)", () => {
    expect(valid("(get_route |)", ["list", "sum_readings"])).toEqual(["list"]);
  });

  it("STRING slot: keeps the string-returner + the unresolved local; drops the rest", () => {
    // get_route arg 1 is `string`. get_route itself returns a string (kept); set_timer returns
    // void and make_route returns a list (both PROVABLY ill-typed — dropped); my_local kept.
    expect(valid("(get_route 1 |)", ["get_route", "set_timer", "make_route", "my_local"])).toEqual([
      "get_route",
      "my_local",
    ]);
  });

  it("NUMBER slot: keeps the number-returner + the unresolved local; drops the string-returner", () => {
    // set_timer arg 0 is `number`. sum_readings returns a number (kept); get_route returns a
    // string (dropped); my_local kept.
    expect(valid("(set_timer |)", ["sum_readings", "get_route", "my_local"])).toEqual(["sum_readings", "my_local"]);
  });

  it("TOP / no enclosing call: every candidate is kept (T never narrows an operator/top slot)", () => {
    expect(valid("|", ["sum_readings", "set_timer", "anything"])).toEqual([
      "sum_readings",
      "set_timer",
      "anything",
    ]);
  });

  it("OPERATOR slot (cursor at the head): every candidate is kept", () => {
    expect(valid("(|)", ["sum_readings", "set_timer", "make_route"])).toEqual([
      "sum_readings",
      "set_timer",
      "make_route",
    ]);
  });

  it("unknown callee → unresolved slot → every candidate kept (conservative)", () => {
    expect(valid("(no_such_tool |)", ["sum_readings", "set_timer"])).toEqual(["sum_readings", "set_timer"]);
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

  it("empty candidate list returns empty (no compile)", () => {
    expect(valid("(get_route |)", [])).toEqual([]);
  });
});

describe("getSlotArrayKind — the 3-way value verdict", () => {
  it("a list param → \"list\"", () => {
    expect(kind("(get_route |)")).toBe("list");
  });

  it("a vector (number[]) param → \"vector\"", () => {
    expect(kind("(sum_readings |)")).toBe("vector");
  });

  it("a number param → \"scalar\"", () => {
    expect(kind("(set_timer |)")).toBe("scalar");
  });

  it("a string param → \"scalar\" (string folds into scalar for the array verdict)", () => {
    expect(kind("(get_route 1 |)")).toBe("scalar");
  });

  it("an unresolved slot (unknown callee) → null", () => {
    expect(kind("(no_such_tool |)")).toBeNull();
  });

  it("a top / no-call cursor → null", () => {
    expect(kind("|")).toBeNull();
  });
});

describe("getSlotElementType — the ENUM / closed-domain narrow (the highest-value axis)", () => {
  it("a DIRECT enum param → its members as enum (isStringy null)", () => {
    // plan_route arg 0 is `\"fast\" | \"scenic\"`. The domain is the slot itself (ElemOf is never
    // for a scalar) → a PROVED closed string set → its two members.
    expect(element("(plan_route |)")).toEqual({ isStringy: null, enum: ["fast", "scenic"] });
  });

  it("an ARRAY-of-enum param → the ELEMENT's members as enum", () => {
    // plan_route arg 1 is `(\"fast\" | \"scenic\")[]`. ElemOf recovers the enum element → same members.
    expect(element("(plan_route 'x |)")).toEqual({ isStringy: null, enum: ["fast", "scenic"] });
  });

  it("a free-form string param → isStringy true, enum null", () => {
    // plan_route arg 2 is `string` (ElemOf never → domain is the slot → free-form string).
    expect(element("(plan_route 'x (list) |)")).toEqual({ isStringy: true, enum: null });
    // get_route arg 1 is also `string`.
    expect(element("(get_route 1 |)")).toEqual({ isStringy: true, enum: null });
  });

  it("a number param → both null (a non-string domain narrows nothing)", () => {
    expect(element("(set_timer |)")).toEqual({ isStringy: null, enum: null });
  });

  it("a List<unknown> / vector<number> param → both null (the element isn't a string set)", () => {
    expect(element("(get_route |)")).toEqual({ isStringy: null, enum: null }); // element is `unknown`
    expect(element("(sum_readings |)")).toEqual({ isStringy: null, enum: null }); // element is `number`
  });

  // ★SUPERSET-SAFE: an unresolved slot and a no-call cursor BOTH return both-null, so a consumer
  // never narrows a domain we could not resolve.
  it("an unresolved slot (unknown callee) / a top cursor → both null", () => {
    expect(element("(no_such_tool |)")).toEqual({ isStringy: null, enum: null });
    expect(element("|")).toEqual({ isStringy: null, enum: null });
    expect(element("(|)")).toEqual({ isStringy: null, enum: null }); // operator slot
  });
});

describe("getSlotAcceptsBareWord — a bare word is admissible as a string", () => {
  it("a free-form string slot → true", () => {
    expect(bareWord("(get_route 1 |)")).toBe(true);
    expect(bareWord("(plan_route 'x (list) |)")).toBe(true);
  });

  it("a closed enum slot → false (a bare word is NOT any string here)", () => {
    expect(bareWord("(plan_route |)")).toBe(false);
  });

  it("a list / vector / number slot → false (not a string slot)", () => {
    expect(bareWord("(get_route |)")).toBe(false); // List<unknown>
    expect(bareWord("(sum_readings |)")).toBe(false); // number[]
    expect(bareWord("(set_timer |)")).toBe(false); // number
  });

  // ★SUPERSET-SAFE: unresolved → null (the gate no-ops), never a guessed boolean.
  it("an unresolved slot / a top cursor → null", () => {
    expect(bareWord("(no_such_tool |)")).toBeNull();
    expect(bareWord("|")).toBeNull();
    expect(bareWord("(|)")).toBeNull();
  });
});

describe("getSlotIsStringTyped — the slot is a string subtype, not an array", () => {
  it("a free-form string slot → true", () => {
    expect(stringTyped("(get_route 1 |)")).toBe(true);
  });

  it("a closed enum slot → true (an enum IS a string subtype)", () => {
    expect(stringTyped("(plan_route |)")).toBe(true);
  });

  it("a number / list / vector slot → false (not a string subtype)", () => {
    expect(stringTyped("(set_timer |)")).toBe(false); // number
    expect(stringTyped("(get_route |)")).toBe(false); // List<unknown>
    expect(stringTyped("(sum_readings |)")).toBe(false); // number[]
  });

  // ★SUPERSET-SAFE: unresolved → null.
  it("an unresolved slot / a top cursor → null", () => {
    expect(stringTyped("(no_such_tool |)")).toBeNull();
    expect(stringTyped("|")).toBeNull();
    expect(stringTyped("(|)")).toBeNull();
  });
});
