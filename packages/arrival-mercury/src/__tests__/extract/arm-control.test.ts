/**
 * ARM-B unit tests — App/DefineFn/Lambda/NamedLet/If/And/Or (arm-control.ts).
 *
 * `defaultRegistry` (arm-containers.ts) doesn't yet know `eq?`/`number->string`
 * as fuse heads (only ARM-B's own required set — `<, >, +, eq?, number->string`
 * — needs them for the fixture corpus's adversarial rows), so this file builds
 * its OWN minimal `HeadRegistry` rather than depending on the shared one. A few
 * extra heads (`car`/`cons`/`map`) are registered beyond that minimum purely to
 * exercise the mux/build/fan dispatch paths and the kwargs-rejection rule —
 * `defaultRegistry` already covers those for real programs.
 *
 * Rows 1, 2, 4, 5 of the fixture corpus (fixture-corpus.ts) are ARM-B's target
 * shapes (row 3 is a fold/fan row — ARM-C's `buildFan` body, not this arm) and
 * are re-run here directly against the SAME pattern matcher the J1 gate uses,
 * so a regression here is the same signal as a J1 regression.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import type { HeadClass, HeadRegistry, StaticProv } from "../../model/static-prov.js";
import { FIXTURE_CORPUS, mismatch } from "./fixture-corpus.js";

const FUSE_NAMES = new Set(["<", ">", "+", "eq?", "number->string"]);

/** Minimal test registry: the required fuse set, plus one head each for
 *  mux/build/fan so their dispatch paths (and the kwargs-rejection rule) are
 *  reachable without waiting on `defaultRegistry`'s own table growth. */
const testRegistry: HeadRegistry = {
  classifyHead(name: string): HeadClass {
    if (FUSE_NAMES.has(name)) return { role: "fuse" };
    if (name === "car") return { role: "mux", keyArg: "self" };
    if (name === "cons") return { role: "build", ctor: "pair" };
    if (name === "map") return { role: "fan", fanKind: "map" };
    return { role: "opaque", reason: `unknown-head/${name}` };
  },
};

const run = (src: string): StaticProv => {
  const { forms } = classify(desugar(parseSexprs(src)));
  return extractProgram(forms, testRegistry);
};

describe("fixture corpus — ARM-B's target rows (1, 2, 4, 5)", () => {
  const MY_ROWS = new Set(["guard-swap forge", "named-helper forge", "genuine content", "plain fuse"]);
  const rows = FIXTURE_CORPUS.filter((r) => MY_ROWS.has(r.name));

  it("selects exactly the 4 ARM-B rows (not accidentally 0 or all 5)", () => {
    expect(rows).toHaveLength(4);
  });

  for (const row of rows) {
    it(`${row.name}: ${row.why.slice(0, 70)}…`, () => {
      const prov = run(row.source);
      expect(mismatch(prov, row.expected)).toBeNull();
    });
  }
});

describe("If — guard-swap shape", () => {
  it("a literal alt stays a VISIBLE const, never swallowed by the guard", () => {
    const prov = run(`(if (< (:v e) 1000) "SAFE" (number->string (:v e)))`);
    expect(prov).toMatchObject({
      kind: "choice",
      guards: [{ kind: "fused" }],
      alts: [{ kind: "const" }, { kind: "fused" }],
    });
  });
});

describe("And / Or — n-ary chains", () => {
  it("or: guards is the length-1 prefix, alts is every arg", () => {
    const prov = run(`(or (:cached e) "DEFAULT")`);
    expect(prov).toMatchObject({
      kind: "choice",
      guards: [{ kind: "mux", key: "cached" }],
      alts: [{ kind: "mux", key: "cached" }, { kind: "const" }],
    });
  });

  it("and: 3-ary — guards drops only the last arg, alts keeps all 3", () => {
    const prov = run(`(and (:a e) (:b e) (:c e))`);
    expect(prov).toMatchObject({
      kind: "choice",
      guards: [{ kind: "mux", key: "a" }, { kind: "mux", key: "b" }],
      alts: [{ kind: "mux", key: "a" }, { kind: "mux", key: "b" }, { kind: "mux", key: "c" }],
    });
  });
});

describe("App — beta-reduction", () => {
  it("named-helper forge: beta-reduction exposes the callee's hidden guard", () => {
    const prov = run(`(define (f x) (if (> x 5) "SAFE" x))\n(f (:score e))`);
    expect(prov).toMatchObject({
      kind: "choice",
      guards: [{ kind: "fused" }],
      alts: [{ kind: "const" }, { kind: "mux", key: "score" }],
    });
  });

  it("IIFE beta-reduces exactly like a resolved named user fn", () => {
    const prov = run(`((lambda (x) (if (> x 5) "SAFE" x)) (:score e))`);
    expect(prov).toMatchObject({
      kind: "choice",
      guards: [{ kind: "fused" }],
      alts: [{ kind: "const" }, { kind: "mux", key: "score" }],
    });
  });

  it("recursive fn hits the cycle guard: opaque(cyclic-binding), not infinite regress", () => {
    const prov = run(`(define (loop x) (if (eq? x 0) 0 (loop x)))\n(loop (:n e))`);
    expect(prov).toMatchObject({
      kind: "choice",
      alts: [{ kind: "const" }, { kind: "opaque", reason: "cyclic-binding" }],
    });
  });

  it("arity mismatch (too few args): opaque(callee-arity)", () => {
    const prov = run(`(define (f x y) x)\n(f (:a e))`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "callee-arity" });
  });

  it("a rest-param callee is beyond static beta-reduction: opaque(callee-arity)", () => {
    const prov = run(`(define (f x . rest) x)\n(f (:a e) (:b e))`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "callee-arity" });
  });

  it("kwargs fold into the flat, positional arg list for beta-reduction too", () => {
    // 1 fixed param + 1 kwarg folds to 2 total args — matches `f`'s 2 params.
    const prov = run(`(define (f x y) (+ x y))\n(f (:a e) :y 1)`);
    expect(prov).toMatchObject({
      kind: "fused",
      sources: [{ kind: "mux", key: "a" }, { kind: "const" }],
    });
  });

  it("an internal helper define inside a beta-reduced body is visible to the tail form", () => {
    const prov = run(
      `(define (f x)\n  (define helper (:tag e))\n  (if (> x 5) "SAFE" helper))\n(f (:score e))`,
    );
    expect(prov).toMatchObject({
      kind: "choice",
      guards: [{ kind: "fused" }],
      alts: [{ kind: "const" }, { kind: "mux", key: "tag" }],
    });
  });

  it("calling a name bound to a non-function value: opaque(unknown-callee)", () => {
    const prov = run(`(define x (:a e))\n(x (:b e))`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "unknown-callee" });
  });

  it("a computed callee (not Ref/Lambda/keyword) is opaque(unknown-callee)", () => {
    const prov = run(`((if (eq? 1 1) car cdr) (:a e))`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "unknown-callee" });
  });

  it("an empty-bodied IIFE (classify()'s `(lambda (x))` gap) is total, not a crash", () => {
    const prov = run(`((lambda (x)) 1)`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "empty-body" });
  });
});

describe("App — known-head dispatch (registry)", () => {
  it("kwargs fold into a fuse head's sources — never silently dropped", () => {
    const prov = run(`(+ (:a e) :bonus 5)`);
    expect(prov).toMatchObject({
      kind: "fused",
      sources: [{ kind: "mux", key: "a" }, { kind: "const" }],
    });
  });

  it("kwargs to a mux head are rejected outright: opaque(kwargs-unsupported-head)", () => {
    const prov = run(`(car (:xs e) :extra 1)`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "kwargs-unsupported-head" });
  });

  it("kwargs to a build head are rejected outright: opaque(kwargs-unsupported-head)", () => {
    const prov = run(`(cons (:a e) (:b e) :extra 1)`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "kwargs-unsupported-head" });
  });

  it("a kwargs-only call to an unknown head gets the specific opaque(kwargs-only-call)", () => {
    const prov = run(`(mystery-fn :only 1)`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "kwargs-only-call" });
  });

  it("mux (self-key, e.g. `car`) projects the operand under the head's own name", () => {
    const prov = run(`(car (:xs e))`);
    expect(prov).toMatchObject({ kind: "mux", key: "car", source: { kind: "mux", key: "xs" } });
  });

  it("map desugars through ARM-C's buildFan into a FanProv", () => {
    const prov = run(`(map (lambda (x) x) (:xs e))`);
    expect(prov.kind).toBe("fan");
  });
});

describe("DefineFn / Lambda in value position", () => {
  it("a Lambda literal used as a bare value (not applied) is opaque(fn-as-value)", () => {
    const prov = run(`(+ (lambda (x) x) 1)`);
    expect(prov).toMatchObject({
      kind: "fused",
      sources: [{ kind: "opaque", reason: "fn-as-value" }, { kind: "const" }],
    });
  });
});

describe("NamedLet — the sound default", () => {
  it("is always opaque(named-let/unliftable), never a guessed lift", () => {
    const prov = run(`(let loop ((acc 0) (n (:count e))) (if (eq? n 0) acc (loop (+ acc 1) n)))`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "named-let/unliftable" });
  });
});
