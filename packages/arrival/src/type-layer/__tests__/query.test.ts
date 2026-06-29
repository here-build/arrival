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

const lens = createQueryLens(
  assembleHarvestedPrelude([
    ["get_route", getRoute],
    ["sum_readings", sumReadings],
    ["set_timer", setTimer],
    ["make_route", makeRoute],
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
