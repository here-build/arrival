// THE SCOPE-CONFUSION DOOR (docs/working-proposals/manifold-scope-confusion-door.md, V-specified
// 2026-07-04). SIBLING of the unbound-in-expr did-you-mean door, on the DISJOINT class of names
// the MODEL ITSELF defined: a same-program cascade (an earlier statement failed so a later
// top-level define never bound), a cross-scope reference (X was only ever let/lambda-bound,
// never at top level), or the ≥2-local "don't force an implementation" case. Runs LAST in the
// unbound-in-expr classifier — after the three-tier tool-name door and the data-literal quoting
// hint (both unboundInExprDoor), and after arrival's own polyglot-rich-errors enrichment (which
// rides inline in the raw message by the time this door would run).
//
// PURE unit coverage only (no MCP wiring) — split from arrival-manifold's `scope-confusion.test.ts`
// (2026-07-05 package split); the e2e-through-a-real-manifold-tool half stays there.

import { describe, expect, it } from "vitest";

import { scopeConfusionDoor } from "../doors.js";
import { scanLocalBindings } from "../scope-scan.js";
import { createLocalBindingTracker } from "../session-history.js";

describe("scopeConfusionDoor — pure unit tests (doors.ts)", () => {
  it("cascade: names the FIRST failing statement, not the symptom", () => {
    const door = scopeConfusionDoor({
      name: "b",
      topLevelDefineStatementNumber: 2,
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [],
      currentCallIndex: 5,
    });
    expect(door?.fact).toBe(
      "`b' was defined above in this program, but an earlier statement failed, so its (define) " +
        "never ran — every statement after the first error is skipped. Fix the FIRST error (see " +
        "the error at statement 1) and the rest will bind.",
    );
    expect(door?.code).toBe("envelope/scope-confusion");
  });

  it("cross-scope: exactly one prior local occurrence — 'N message(s) ago' / 'this message'", () => {
    const oneAgo = scopeConfusionDoor({
      name: "z",
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [1],
      currentCallIndex: 2,
    });
    expect(oneAgo?.fact).toBe(
      "`z' was defined inside a local scope (a let/lambda body) 1 message ago, not globally — a " +
        "local binding doesn't survive its form. Re-declare it at top level with (define z …), " +
        "or bind it locally with (let ((z …)) …) in the statement that uses it.",
    );
    const threeAgo = scopeConfusionDoor({
      name: "z",
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [1],
      currentCallIndex: 4,
    });
    expect(threeAgo?.fact).toContain("3 messages ago");
    const sameMessage = scopeConfusionDoor({
      name: "z",
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [2],
      currentCallIndex: 2,
    });
    expect(sameMessage?.fact).toContain("earlier in this message");
  });

  it("≥2-local: both paths acknowledged, neither forced (V's don't-force-an-implementation flag)", () => {
    const door = scopeConfusionDoor({
      name: "z",
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [1, 2],
      currentCallIndex: 3,
    });
    expect(door?.fact).toBe(
      "`z' is a local binding you've used before — it doesn't persist across statements. Either " +
        "bind it in the same statement that uses it, or (define z …) it at top level to reuse it " +
        "across calls.",
    );
  });

  it("cascade wins over local-binding history when both are present (priority order)", () => {
    const door = scopeConfusionDoor({
      name: "z",
      topLevelDefineStatementNumber: 3,
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [1, 2],
      currentCallIndex: 5,
    });
    expect(door?.fact).toContain("was defined above in this program");
  });

  it("none of (a)/(b)/(c) → undefined (case (d) — not this door's job)", () => {
    expect(
      scopeConfusionDoor({
        name: "csv-thing",
        firstErrorStatementNumber: 1,
        localBindingCallIndexes: [],
        currentCallIndex: 1,
      }),
    ).toBeUndefined();
  });
});

// ─── scanLocalBindings — the v1 tokenizer walk (scope-scan.ts) ───

describe("scanLocalBindings (scope-scan.ts)", () => {
  it("let binding names", () => {
    expect(scanLocalBindings("(let ((z 5)) z)")).toEqual(["z"]);
  });

  it("let* / letrec / letrec* bindings", () => {
    expect(scanLocalBindings("(let* ((a 1) (b 2)) (+ a b))").toSorted((a, b) => a.localeCompare(b))).toEqual([
      "a",
      "b",
    ]);
    expect(scanLocalBindings("(letrec ((f (lambda (n) n))) (f 1))").toSorted((a, b) => a.localeCompare(b))).toEqual([
      "f",
      "n",
    ]);
  });

  it("named let — the loop name is itself a local binding", () => {
    expect(
      scanLocalBindings("(let loop ((i 0)) (if (< i 5) (loop (+ i 1)) i))").toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["i", "loop"]);
  });

  it("lambda parameters, including the variadic single-symbol form", () => {
    expect(scanLocalBindings("(lambda (x y) (+ x y))").toSorted((a, b) => a.localeCompare(b))).toEqual(["x", "y"]);
    expect(scanLocalBindings("(lambda args args)")).toEqual(["args"]);
  });

  it("a NESTED define (inside a let/lambda body) is local; a TOP-LEVEL define is not", () => {
    expect(scanLocalBindings("(let ((y 1)) (define z 2) z)").toSorted((a, b) => a.localeCompare(b))).toEqual([
      "y",
      "z",
    ]);
    expect(scanLocalBindings("(define a (car 5))")).toEqual([]);
    expect(scanLocalBindings("(define f (lambda (x) (+ x 1)))")).toEqual(["x"]);
  });
});

describe("createLocalBindingTracker (session-history.ts)", () => {
  it("records occurrences per call index, deduping repeats within one call", () => {
    const tracker = createLocalBindingTracker();
    tracker.record(["z", "z"], 1);
    tracker.record(["z"], 1); // same call again — no duplicate
    tracker.record(["z"], 2);
    expect(tracker.occurrences("z")).toEqual([1, 2]);
    expect(tracker.occurrences("never-seen")).toEqual([]);
  });
});
