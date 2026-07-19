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
 *
 * Everything below the corpus describe is ONE protocol table (`ARM_B_CASES`):
 * `{ topic, name, src, expected }` — each row runs `extractProgram` and asserts
 * `toMatchObject(expected)`. The topical describes are generated from the
 * table; adding a case is appending a row.
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

interface ArmBCase {
  /** The topical describe this row lands in (describes are generated in first-seen order). */
  readonly topic: string;
  /** The behavior claim — becomes the it name. */
  readonly name: string;
  readonly src: string;
  /** The `toMatchObject` shape the extracted StaticProv must satisfy. */
  readonly expected: Record<string, unknown>;
}

const ARM_B_CASES: readonly ArmBCase[] = [
  {
    topic: "If — guard-swap shape",
    name: "a literal alt stays a VISIBLE const, never swallowed by the guard",
    src: `(if (< (:v e) 1000) "SAFE" (number->string (:v e)))`,
    expected: {
      kind: "choice",
      guards: [{ kind: "fused" }],
      alts: [{ kind: "const" }, { kind: "fused" }],
    },
  },

  {
    topic: "And / Or — n-ary chains",
    name: "or: guards is the length-1 prefix, alts is every arg",
    src: `(or (:cached e) "DEFAULT")`,
    expected: {
      kind: "choice",
      guards: [{ kind: "mux", key: "cached" }],
      alts: [{ kind: "mux", key: "cached" }, { kind: "const" }],
    },
  },
  {
    topic: "And / Or — n-ary chains",
    name: "and: 3-ary — guards drops only the last arg, alts keeps all 3",
    src: `(and (:a e) (:b e) (:c e))`,
    expected: {
      kind: "choice",
      guards: [{ kind: "mux", key: "a" }, { kind: "mux", key: "b" }],
      alts: [{ kind: "mux", key: "a" }, { kind: "mux", key: "b" }, { kind: "mux", key: "c" }],
    },
  },

  {
    topic: "App — beta-reduction",
    name: "named-helper forge: beta-reduction exposes the callee's hidden guard",
    src: `(define (f x) (if (> x 5) "SAFE" x))\n(f (:score e))`,
    expected: {
      kind: "choice",
      guards: [{ kind: "fused" }],
      alts: [{ kind: "const" }, { kind: "mux", key: "score" }],
    },
  },
  {
    topic: "App — beta-reduction",
    name: "IIFE beta-reduces exactly like a resolved named user fn",
    src: `((lambda (x) (if (> x 5) "SAFE" x)) (:score e))`,
    expected: {
      kind: "choice",
      guards: [{ kind: "fused" }],
      alts: [{ kind: "const" }, { kind: "mux", key: "score" }],
    },
  },
  {
    topic: "App — beta-reduction",
    name: "recursive fn hits the cycle guard: opaque(cyclic-binding), not infinite regress",
    src: `(define (loop x) (if (eq? x 0) 0 (loop x)))\n(loop (:n e))`,
    expected: {
      kind: "choice",
      alts: [{ kind: "const" }, { kind: "opaque", reason: "cyclic-binding" }],
    },
  },
  {
    topic: "App — beta-reduction",
    name: "arity mismatch (too few args): opaque(callee-arity)",
    src: `(define (f x y) x)\n(f (:a e))`,
    expected: { kind: "opaque", reason: "callee-arity" },
  },
  {
    topic: "App — beta-reduction",
    name: "a rest-param callee is beyond static beta-reduction: opaque(callee-arity)",
    src: `(define (f x . rest) x)\n(f (:a e) (:b e))`,
    expected: { kind: "opaque", reason: "callee-arity" },
  },
  {
    topic: "App — beta-reduction",
    name: "kwargs fold into the flat, positional arg list for beta-reduction too",
    // 1 fixed param + 1 kwarg folds to 2 total args — matches `f`'s 2 params.
    src: `(define (f x y) (+ x y))\n(f (:a e) :y 1)`,
    expected: {
      kind: "fused",
      sources: [{ kind: "mux", key: "a" }, { kind: "const" }],
    },
  },
  {
    topic: "App — beta-reduction",
    name: "an internal helper define inside a beta-reduced body is visible to the tail form",
    src: `(define (f x)\n  (define helper (:tag e))\n  (if (> x 5) "SAFE" helper))\n(f (:score e))`,
    expected: {
      kind: "choice",
      guards: [{ kind: "fused" }],
      alts: [{ kind: "const" }, { kind: "mux", key: "tag" }],
    },
  },
  {
    topic: "App — beta-reduction",
    name: "calling a name bound to a non-function value: opaque(unknown-callee)",
    src: `(define x (:a e))\n(x (:b e))`,
    expected: { kind: "opaque", reason: "unknown-callee" },
  },
  {
    topic: "App — beta-reduction",
    name: "a computed callee (not Ref/Lambda/keyword) is opaque(unknown-callee)",
    src: `((if (eq? 1 1) car cdr) (:a e))`,
    expected: { kind: "opaque", reason: "unknown-callee" },
  },
  {
    topic: "App — beta-reduction",
    name: "an empty-bodied IIFE (classify()'s `(lambda (x))` gap) is total, not a crash",
    src: `((lambda (x)) 1)`,
    expected: { kind: "opaque", reason: "empty-body" },
  },

  {
    topic: "App — known-head dispatch (registry)",
    name: "kwargs fold into a fuse head's sources — never silently dropped",
    src: `(+ (:a e) :bonus 5)`,
    expected: {
      kind: "fused",
      sources: [{ kind: "mux", key: "a" }, { kind: "const" }],
    },
  },
  {
    topic: "App — known-head dispatch (registry)",
    name: "kwargs to a mux head are rejected outright: opaque(kwargs-unsupported-head)",
    src: `(car (:xs e) :extra 1)`,
    expected: { kind: "opaque", reason: "kwargs-unsupported-head" },
  },
  {
    topic: "App — known-head dispatch (registry)",
    name: "kwargs to a build head are rejected outright: opaque(kwargs-unsupported-head)",
    src: `(cons (:a e) (:b e) :extra 1)`,
    expected: { kind: "opaque", reason: "kwargs-unsupported-head" },
  },
  {
    topic: "App — known-head dispatch (registry)",
    name: "a kwargs-only call to an unknown head gets the specific opaque(kwargs-only-call)",
    src: `(mystery-fn :only 1)`,
    expected: { kind: "opaque", reason: "kwargs-only-call" },
  },
  {
    topic: "App — known-head dispatch (registry)",
    name: "mux (self-key, e.g. `car`) projects the operand under the head's own name",
    src: `(car (:xs e))`,
    expected: { kind: "mux", key: "car", source: { kind: "mux", key: "xs" } },
  },
  {
    topic: "App — known-head dispatch (registry)",
    name: "map desugars through ARM-C's buildFan into a FanProv",
    src: `(map (lambda (x) x) (:xs e))`,
    expected: { kind: "fan" },
  },

  {
    topic: "DefineFn / Lambda in value position",
    name: "a Lambda literal used as a bare value (not applied) is opaque(fn-as-value)",
    src: `(+ (lambda (x) x) 1)`,
    expected: {
      kind: "fused",
      sources: [{ kind: "opaque", reason: "fn-as-value" }, { kind: "const" }],
    },
  },

  {
    topic: "NamedLet — the sound default",
    name: "is always opaque(named-let/unliftable), never a guessed lift",
    src: `(let loop ((acc 0) (n (:count e))) (if (eq? n 0) acc (loop (+ acc 1) n)))`,
    expected: { kind: "opaque", reason: "named-let/unliftable" },
  },
];

const ARM_B_TOPICS = [...new Set(ARM_B_CASES.map((c) => c.topic))];
for (const topic of ARM_B_TOPICS) {
  describe(topic, () => {
    for (const c of ARM_B_CASES.filter((x) => x.topic === topic)) {
      it(c.name, () => {
        expect(run(c.src)).toMatchObject(c.expected);
      });
    }
  });
}
