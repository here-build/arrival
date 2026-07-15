/**
 * The tail-fold recursion lift — RED SUITE (arm-control.ts's `recognizeTailFold`
 * / `buildRecursionFan`, 2026-07-15).
 *
 * §2c: map/filter/fold desugar to a Fan over the body (arm-containers.ts's
 * `buildFan`). arm-control.ts's own NamedLet comment names the next step: a
 * self-recursive tail DefineFn shaped like a counting/accumulating loop —
 * `(define (f p…) (if <base-guard> <bare-param-base> (f <stepped-args>)))` —
 * is semantically a fold, hand-written as recursion instead of passed as a
 * lambda, and should lift to `FanProv` instead of `opaque("cyclic-binding")`.
 *
 * SOUNDNESS: the lift gets `collapse:"lowered"` ALWAYS (never inferred, never
 * combine/route) — the accumulator's UPDATE expression (the recursive call's
 * own argument in the accumulator's slot) is extracted through the ordinary
 * `extract` dispatcher, so any internal `if`/const in the loop body surfaces
 * exactly as it would anywhere else. Row (c) below is the adversarial pin for
 * this: a const hidden behind an `if` inside the update expression, the same
 * shape as the fold-collapse forge (fixture-corpus's "hidden-const fold
 * (longcat)" row, one arm over — there it's a lambda passed to `fold`; here
 * it's the recursive call's own argument).
 *
 * OVER-LIFTING GUARD: rows (d)/(e) pin that anything OUTSIDE the narrow
 * recognized shape — non-tail recursion, mutual recursion — falls straight
 * through to the UNCHANGED `opaque("cyclic-binding")` default. `hasFan`/
 * `hasOpaqueReason` walk the WHOLE produced circuit (not just the root) since
 * neither row's root is itself opaque — the recursive call is buried inside a
 * `ChoiceProv`/`FusedProv`, and the assertion is "no Fan anywhere, the cyclic
 * guard still fires somewhere," not "the root is opaque."
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import type { StaticProv } from "../../model/static-prov.js";
import type { ProvPattern } from "./fixture-corpus.js";
import { mismatch } from "./fixture-corpus.js";

const run = (src: string): StaticProv => extractProgram(classify(desugar(parseSexprs(src))).forms, defaultRegistry);

const input = (name: string): ProvPattern => ({ kind: "input", name });
const muxOf = (key: string, name: string): ProvPattern => ({ kind: "mux", key, source: input(name) });

/** Walk the WHOLE circuit (every child of every kind) — used by the
 *  over-lifting-guard rows, where the interesting node (a Fan that must NOT
 *  exist, an opaque("cyclic-binding") that must) is buried, not the root. */
function walk(prov: StaticProv, visit: (p: StaticProv) => void): void {
  visit(prov);
  switch (prov.kind) {
    case "input":
    case "const":
    case "opaque":
      return;
    case "mint":
      for (const c of prov.closed) walk(c, visit);
      return;
    case "fused":
      for (const s of prov.sources) walk(s, visit);
      return;
    case "mux":
      walk(prov.source, visit);
      return;
    case "build":
      for (const p of prov.parts) walk(p.prov, visit);
      return;
    case "string":
      for (const r of prov.runs) walk(r, visit);
      return;
    case "choice":
      for (const g of prov.guards) walk(g, visit);
      for (const a of prov.alts) walk(a, visit);
      return;
    case "fan":
      walk(prov.collection, visit);
      walk(prov.body, visit);
      return;
  }
}

const hasFan = (prov: StaticProv): boolean => {
  let found = false;
  walk(prov, (p) => {
    if (p.kind === "fan") found = true;
  });
  return found;
};

const hasOpaqueReason = (prov: StaticProv, reason: string): boolean => {
  let found = false;
  walk(prov, (p) => {
    if (p.kind === "opaque" && p.reason === reason) found = true;
  });
  return found;
};

describe("tail-fold recursion lift — positive rows (recognizeTailFold landed in this change)", () => {
  it("gepa-shaped counting loop: root is a FanProv (collapse lowered), NOT opaque", () => {
    const prov = run(`(define (iterate step pool n) (if (= n 0) pool (iterate step (step pool) (- n 1))))\n(iterate f (list a) 3)`);
    expect(prov.kind).not.toBe("opaque");
    const pattern: ProvPattern = {
      kind: "fan",
      collapse: "lowered",
      collection: { kind: "build", ctor: "vector", parts: [{ key: 0, prov: input("a") }] },
      body: { kind: "opaque", reason: "unknown-callee" },
    };
    expect(mismatch(prov, pattern)).toBeNull();
  });

  it("simpler accumulator loop: (cons (:v e) acc) fold-shaped ⇒ FanProv", () => {
    const prov = run(`(define (loop acc n) (if (= n 0) acc (loop (cons (:v e) acc) (- n 1))))\n(loop (list) 5)`);
    expect(prov.kind).not.toBe("opaque");
    const pattern: ProvPattern = {
      kind: "fan",
      collapse: "lowered",
      collection: { kind: "build", ctor: "vector", parts: [] },
      body: {
        kind: "build",
        ctor: "pair",
        parts: [
          { key: 0, prov: muxOf("v", "e") },
          { key: 1, prov: { kind: "mux", key: null, source: { kind: "build", ctor: "vector", parts: [] } } },
        ],
      },
    };
    expect(mismatch(prov, pattern)).toBeNull();
  });
});

describe("tail-fold recursion lift — adversarial rows (plain it, MUST hold — the soundness guards)", () => {
  it("hidden-const-in-loop-body: the Fan body keeps the const VISIBLE — never collapsed away", () => {
    const prov = run(
      `(define (loop acc n) (if (= n 0) acc (loop (if (= n 1) "FABRICATED" (:v e)) (- n 1))))\n(loop (list) 3)`,
    );
    // The fold-collapse forge, one arm over: collapse must stay "lowered" and
    // the body's `if` must still carry a genuine `const` alt — never fused,
    // never routed away.
    const pattern: ProvPattern = {
      kind: "fan",
      collapse: "lowered",
      collection: { kind: "build", ctor: "vector", parts: [] },
      body: {
        kind: "choice",
        guards: [{ kind: "*" }],
        alts: [{ kind: "const" }, muxOf("v", "e")],
      },
    };
    expect(mismatch(prov, pattern)).toBeNull();
    if (prov.kind === "fan" && prov.body.kind === "choice") {
      expect(prov.body.alts.some((a) => a.kind === "const")).toBe(true);
    }
  });

  it("non-tail recursion (recursive call under `+`, not the tail): never a Fan; cyclic-binding still fires", () => {
    const prov = run(`(define (f n) (if (= n 0) 0 (+ 1 (f (- n 1)))))\n(f 3)`);
    expect(hasFan(prov)).toBe(false);
    expect(hasOpaqueReason(prov, "cyclic-binding")).toBe(true);
  });

  it("mutual recursion (isEven/isOdd): never a Fan; cyclic-binding still fires", () => {
    const prov = run(
      `(define (isEven n) (if (= n 0) 1 (isOdd (- n 1))))\n(define (isOdd n) (if (= n 0) 0 (isEven (- n 1))))\n(isEven 4)`,
    );
    expect(hasFan(prov)).toBe(false);
    expect(hasOpaqueReason(prov, "cyclic-binding")).toBe(true);
  });
});
