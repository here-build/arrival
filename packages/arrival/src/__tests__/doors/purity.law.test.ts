// F6 — Doors (docs/test-suite-v2/DESIGN.md §F6, P5 errors-as-doors). Registry-driven
// form of the purity pass (docs/plan-2026-06-11-purity-pass.md): arrival is pure
// dataflow — dynamics (call/cc, dynamic-wind, make-parameter, delay/force) and
// mutators (set!, set-car!, vector-set!, …) are omitted BY DESIGN, each replaced
// with a teaching `PurityError` naming the reason and (where honest) an
// alternative. This file ABSORBS `../purity-doors.test.ts` into one `it.each`
// table (that file is kept, not deleted — VERDICTS.md's migration sweep retires
// v1 survivors only once their v2 cell is green) and adds the one row that file
// was missing: `set!` itself (r7rs/binding.ts's §4.1.6 door, verified via grep —
// see `.claude` archaeology; no hardcoded "set!" special form exists anywhere in
// eval/*.ts, so it resolves as an ordinary env binding, same mechanism as every
// other door here).

import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";
import { PurityError } from "../../errors.js";

/** A door "fires" if the PurityError surfaces either directly or through the
 *  evaluator's ArrivalError.cause wrap — mirrors purity-doors.test.ts's own
 *  `door` helper (the wrap shape is identical for every native-call throw). */
async function door(src: string): Promise<{ purity: boolean; message: string }> {
  try {
    await exec(src);
  } catch (e) {
    const direct = e instanceof PurityError;
    const viaCause = (e as { cause?: unknown })?.cause instanceof PurityError;
    return { purity: direct || viaCause, message: (e as Error)?.message ?? String(e) };
  }
  throw new Error(`expected a purity door for: ${src}`);
}

// [feature name, source that reaches the omitted door, message this feature's door
// is known to carry (per its symbol.notImplemented reason in the owning pack)].
const DYNAMICS_AND_MUTATORS: ReadonlyArray<readonly [name: string, src: string, expected: RegExp]> = [
  // R7RS §4.2.6/§6.11/§6.13.3 dynamics — env/r7rs/control.ts, all sharing the same
  // "omitted from arrival by design" phrasing (non-local re-entry / dynamic extent
  // severs value provenance — no single construction site to root lineage at).
  ["call/cc", "(call/cc (lambda (k) (k 1)))", /omitted from arrival by design/],
  ["call-with-current-continuation", "(call-with-current-continuation (lambda (k) (k 1)))", /omitted from arrival by design/],
  ["dynamic-wind", "(dynamic-wind (lambda () 1) (lambda () 2) (lambda () 3))", /omitted from arrival by design/],
  ["make-parameter", "(make-parameter 10)", /omitted from arrival by design/],
  ["parameterize", "(parameterize () 1)", /omitted from arrival by design/],
  ["delay", "(delay 1)", /omitted from arrival by design/],
  ["force", "(force 1)", /omitted from arrival by design/],
  ["make-promise", "(make-promise 1)", /omitted from arrival by design/],
  ["delay-force", "(delay-force (delay 1))", /omitted from arrival by design/],
  // R7RS §4.1.6 assignment — env/r7rs/binding.ts. `x` must already be bound (`let`)
  // before the door call, else applicative-order evaluation of the (unbound) first
  // argument would throw "Unbound variable" before ever reaching the door — the same
  // argument-evaluation-order caveat setf/defun have. [STALE-LABEL fix: this used to cite
  // `polyglot-rich-errors-stubs.test.ts`, which is retired — see declared-doors.law.test.ts's
  // header, which notes the setf/defun already-bound-vs-unbound-argument nuance specifically
  // is no longer exercised by any live test (that harness calls every door with zero
  // arguments uniformly, sidestepping the distinction entirely).]
  ["set!", "(let ((x 1)) (set! x 2))", /violates value provenance|mutates/],
  // Writing methods — every entity is frozen by construction; env/r7rs/lists.ts,
  // vectors.ts, strings.ts, bytevectors.ts.
  ["set-car!", "(set-car! (list 1 2) 9)", /frozen by design|construct a new value/],
  ["set-cdr!", "(set-cdr! (list 1 2) 9)", /frozen by design|construct a new value/],
  ["vector-set!", "(vector-set! (vector 1 2 3) 0 9)", /frozen by design|construct a new value/],
  ["vector-fill!", "(vector-fill! (vector 1 2 3) 0)", /frozen by design|construct a new value/],
  ["vector-copy!", "(vector-copy! (vector 1 2 3) 0 (vector 4 5 6))", /frozen by design|construct a new value/],
  ["string-set!", '(string-set! (string #\\a #\\b) 0 #\\z)', /frozen by design|construct a new value/],
  ["string-fill!", '(string-fill! (string #\\a #\\b) #\\z)', /frozen by design|construct a new value/],
  ["bytevector-u8-set!", "(bytevector-u8-set! (bytevector 1 2 3) 0 9)", /frozen by design|construct a new value/],
  ["bytevector-copy!", "(bytevector-copy! (bytevector 1 2 3) 0 (bytevector 4 5 6))", /frozen by design|construct a new value/],
] as const;

describe("F6 doors — purity doors (dynamics + mutator omissions, table-driven)", () => {
  // Anti-vacuity floor + a deliberate P16 drift alarm: 9 dynamics + 1 assignment +
  // 9 mutators. A count change here means a row was added/removed — update the
  // table above, don't just bump the number.
  it("table has the expected row count (drift alarm)", () => {
    expect(DYNAMICS_AND_MUTATORS.length).toBe(19);
  });

  it.each(DYNAMICS_AND_MUTATORS)("%s → purity door matching %s", async (_name, src, expected) => {
    const { purity, message } = await door(src);
    expect(purity).toBe(true);
    expect(message).toMatch(expected);
  });
});

describe("F6 doors — non-mutating copies still WORK (the sibling positive assertion)", () => {
  // Kept alongside the negative grid above (mirrors purity-doors.test.ts) — a
  // suite that only ever asserts "this throws" can't distinguish "purity is
  // enforced" from "everything here is broken."
  it("vector-copy returns a fresh vector", async () => {
    expect(await exec("(vector->list (vector-copy (vector 1 2 3)))")).toBeDefined();
  });
  it("bytevector-copy returns a fresh bytevector", async () => {
    expect(await exec("(bytevector-copy (bytevector 1 2 3))")).toBeDefined();
  });
});
