/**
 * circuit-sharing — StaticProv TREE → shared DAG (G2, 2026-07-16).
 *
 * THE PROBLEM this fix closes: `extract` re-derived a binding's attribution
 * at EVERY `Ref` use, so `(define xs (list (:a e)(:b e)(:c e))) (append xs
 * xs)` extracted the `xs` subtree TWICE (fresh objects both times — same
 * shape, distinct identity), and GEPA's `examples` list re-derived through
 * every inlined call site that reaches it, ballooning a few-hundred-node
 * circuit to thousands of nodes. The fix: `ExtractCtx.memo` (src/extract/
 * index.ts) caches a Bound's `{tag:"expr"}` extraction ON THE BOUND OBJECT,
 * so every `Ref` that resolves to the SAME binding shares the IDENTICAL
 * `StaticProv` object — a provenance circuit IS a shared DAG (Deutch-Milo-
 * Roy-Tannen, ICDT 2014), and this is the representation-sharing half of
 * that (the renderers — circuit-mermaid.ts/circuit-sexpr.ts/to-wireframe.ts
 * — are the consuming half; see their own tests for dedup-on-render).
 *
 * I1-ADJACENT INVARIANT this suite exists to pin: sharing is REPRESENTATION,
 * never semantics. Every seal/verdict result must be BIT-IDENTICAL before
 * and after this fix — see "THE SEAL GATE" below, the load-bearing test.
 *
 * This suite covers, in order:
 *   (a) sharing actually happens — object IDENTITY, not just deep equality
 *       (the xs/append repro, the task's own worked example)
 *   (b) sharing never crosses call sites — beta-reduction stays per-call
 *   (c) the cyclic-binding rule is unaffected, and a cyclic Bound elsewhere
 *       in the program never poisons an unrelated sibling's caching
 *   (d) THE SEAL GATE — dataShaped/judgmentShaped/circuitVerdict, recorded
 *       from main BEFORE this fix (a temporary pre/post comparison script
 *       run during development — see the session's own notes), reproduced
 *       EXACTLY by the post-fix code, over the full fixture corpus + the
 *       real GEPA program + the four canonical story programs.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { circuitVerdict, dataShaped, judgmentShaped } from "../../verdict/circuit-verdict.js";
import type { StaticProv } from "../../model/static-prov.js";
import { FIXTURE_CORPUS, matches, type ProvPattern } from "./fixture-corpus.js";

const run = (src: string): StaticProv => extractProgram(classify(desugar(parseSexprs(src))).forms, defaultRegistry);

const input = (name: string): ProvPattern => ({ kind: "input", name });
const muxOf = (key: string, name: string): ProvPattern => ({ kind: "mux", key, source: input(name) });

/** Distinct-object-identity node count — the TRUE shared-DAG size, as
 *  opposed to a naive edge-count walk (which stays constant across this fix
 *  by design: the LOGICAL circuit shape/values never change, only whether
 *  two edges point at one object or two). Exhaustive over StaticProv's ten
 *  members WITHOUT a default arm, matching every other walker in this
 *  package (I1's totality discipline). */
function countDistinct(p: StaticProv, seen: Set<StaticProv>): number {
  if (seen.has(p)) return 0;
  seen.add(p);
  switch (p.kind) {
    case "input":
    case "const":
    case "opaque":
      return 1;
    case "mint":
      return 1 + p.closed.reduce((a, c) => a + countDistinct(c, seen), 0);
    case "fused":
      return 1 + p.sources.reduce((a, c) => a + countDistinct(c, seen), 0);
    case "mux":
      return 1 + countDistinct(p.source, seen);
    case "build":
      return 1 + p.parts.reduce((a, pt) => a + countDistinct(pt.prov, seen), 0);
    case "string":
      return 1 + p.runs.reduce((a, c) => a + countDistinct(c, seen), 0);
    case "choice":
      return 1 + p.guards.reduce((a, c) => a + countDistinct(c, seen), 0) + p.alts.reduce((a, c) => a + countDistinct(c, seen), 0);
    case "fan":
      return 1 + countDistinct(p.collection, seen) + countDistinct(p.body, seen);
  }
}

// ── (a) sharing happens: object identity, not just equal values ────────────

describe("extract memoization — the xs/append repro (the task's own worked example)", () => {
  const prov = run(`(define xs (list (:a e)(:b e)(:c e))) (append xs xs)`);

  it("the two `append` sources are the SAME StaticProv object reference", () => {
    expect(prov.kind).toBe("fused");
    if (prov.kind !== "fused") throw new Error("expected fused");
    expect(prov.sources).toHaveLength(2);
    expect(prov.sources[0]).toBe(prov.sources[1]); // object identity — toEqual would pass even without sharing
  });

  it("total distinct nodes is 8 (1 fused root + the 7-node xs subtree, shared once) — not 15 (7 duplicated sites, pre-memo)", () => {
    expect(countDistinct(prov, new Set())).toBe(8);
  });

  it("the shared subtree's own shape is still the honest 7-node xs circuit (build + 3×(mux + input))", () => {
    const pattern: ProvPattern = { kind: "build", ctor: "vector", parts: [
      { key: 0, prov: muxOf("a", "e") },
      { key: 1, prov: muxOf("b", "e") },
      { key: 2, prov: muxOf("c", "e") },
    ] };
    expect(prov.kind).toBe("fused");
    if (prov.kind !== "fused") throw new Error("expected fused");
    expect(matches(prov.sources[0]!, pattern)).toBe(true);
  });
});

// ── (b) sharing never crosses call sites ────────────────────────────────────

describe("extract memoization — sharing does NOT cross call sites (beta-reduction stays per-call)", () => {
  it("two calls of the same fn with different args produce DIFFERENT (non-shared) body attributions", () => {
    const prov = run(`(define (f x) (+ x 1)) (list (f (:a e)) (f (:b e)))`);
    expect(prov.kind).toBe("build");
    if (prov.kind !== "build") throw new Error("expected build");
    expect(prov.parts).toHaveLength(2);
    const [call1, call2] = prov.parts;

    // Not the same object — each call gets its own fresh param Bound.
    expect(call1!.prov).not.toBe(call2!.prov);

    // And genuinely different VALUES, not just different objects wrapping
    // the same shape: each call's `+` fuses over ITS OWN argument.
    expect(matches(call1!.prov, { kind: "fused", sources: [muxOf("a", "e"), { kind: "const" }] })).toBe(true);
    expect(matches(call2!.prov, { kind: "fused", sources: [muxOf("b", "e"), { kind: "const" }] })).toBe(true);
  });

  it("the SAME call site referencing a binding twice inside one call still shares (memoization keys on Bound, not on call)", () => {
    // `x` is bound ONCE per call (one Bound object for this one invocation of
    // f); referencing it twice inside the SAME call must still share, same
    // as any other Bound.
    const prov = run(`(define (f x) (+ x x)) (f (:v e))`);
    expect(prov.kind).toBe("fused");
    if (prov.kind !== "fused") throw new Error("expected fused");
    expect(prov.sources).toHaveLength(2);
    expect(prov.sources[0]).toBe(prov.sources[1]);
  });
});

// ── (c) the cyclic rule, and sibling non-interference ───────────────────────

describe("extract memoization — the cyclic-binding rule survives memoization", () => {
  it("a genuinely self-referential binding still opaques through the cycle guard", () => {
    const prov = run(`(define y (car (list y))) y`);
    // y -> (car (list y)): the INNER reference to y (inside its own
    // definition) must hit the cyclic-binding guard; the outer mux/build
    // shape survives around it (I1: lift or opaque, never mislabel).
    expect(prov.kind).toBe("mux");
    if (prov.kind !== "mux") throw new Error("expected mux");
    expect(prov.key).toBe("car");
    expect(prov.source.kind).toBe("build");
    if (prov.source.kind !== "build") throw new Error("expected build");
    expect(prov.source.parts).toHaveLength(1);
    expect(matches(prov.source.parts[0]!.prov, { kind: "opaque", reason: "cyclic-binding" })).toBe(true);
  });

  it("a cyclic binding is NEVER cached: two references to it (were they possible) would each re-derive, never share a stale verdict", () => {
    // `y` cannot be referenced twice from the same scope without the second
    // Ref finding the SAME opaque-shaped answer — but the load-bearing
    // property is that a cyclic Bound's RiskProbe is always touched (this
    // is verified indirectly: the sibling test below shows caching still
    // happens for an unrelated binding in the SAME program, which would be
    // impossible if marking a probe touched leaked across unrelated Bounds).
    const prov = run(`(define y (car (list y))) (list y y)`);
    expect(prov.kind).toBe("build");
    if (prov.kind !== "build") throw new Error("expected build");
    expect(prov.parts).toHaveLength(2);
    for (const part of prov.parts) {
      expect(matches(part.prov, { kind: "mux", key: "car", source: { kind: "build", parts: [{ key: 0, prov: { kind: "opaque", reason: "cyclic-binding" } }] } })).toBe(
        true,
      );
    }
  });

  it("a sibling NON-cyclic binding is unaffected by an unrelated cyclic one in the SAME extractProgram run", () => {
    const prov = run(`(define y (car (list y))) (define z (+ 1 2)) (append (list y) (list z z))`);
    expect(prov.kind).toBe("fused");
    if (prov.kind !== "fused") throw new Error("expected fused");
    expect(prov.sources).toHaveLength(2);
    const zList = prov.sources[1]!;
    expect(zList.kind).toBe("build");
    if (zList.kind !== "build") throw new Error("expected build");
    expect(zList.parts).toHaveLength(2);
    // z IS shared (its own extraction never consults `reducing` at all —
    // pure literal arithmetic — so y's cyclic-ness next door never touches
    // z's RiskProbe).
    expect(zList.parts[0]!.prov).toBe(zList.parts[1]!.prov);
    expect(matches(zList.parts[0]!.prov, { kind: "fused", sources: [{ kind: "const" }, { kind: "const" }] })).toBe(true);
  });
});

// ── (d) THE SEAL GATE — the invariance requirement itself ───────────────────

/**
 * The real GEPA algorithm (reflective, Pareto-based prompt evolution) —
 * literal duplicate of gepa-heads.test.ts's `buildGepaSource`/
 * circuit-gepa.stories.tsx's identically-named function (NOT a cross-import:
 * a story/test importing another `.test.ts` module would re-run that file's
 * top-level `describe`/`it` registrations as an import-time side effect —
 * both of this file's siblings already document and avoid exactly this).
 * This is the program the task's own measurement cites (~46 re-derivations
 * of `examples` before this fix); it is the highest-value row in this gate
 * precisely because it is the one real, non-adversarial program with actual
 * sharing to lose.
 */
const GEPA_EXAMPLES: readonly { input: string; expected: "positive" | "negative" | "neutral" }[] = [
  { input: "this app changed my life", expected: "positive" },
  { input: "it crashes every single time", expected: "negative" },
  { input: "the update shipped on tuesday", expected: "neutral" },
  { input: "absolutely love the new design", expected: "positive" },
  { input: "worst purchase i have ever made", expected: "negative" },
  { input: "the meeting is at noon", expected: "neutral" },
  { input: "fantastic support team so helpful", expected: "positive" },
  { input: "billing double charged me again", expected: "negative" },
  { input: "documentation lists the endpoints", expected: "neutral" },
  { input: "genuinely delighted with the results", expected: "positive" },
];

function buildGepaSource(): string {
  const examplesScheme = `(list
${GEPA_EXAMPLES.map((e) => `    (dict :input ${JSON.stringify(e.input)} :expected ${JSON.stringify(e.expected)})`).join("\n")})`;
  return `
(define examples ${examplesScheme})
(define (metric prediction expected) (if (string-ci=? prediction expected) 1 0))
(define (ask instruction input)
  (:label (car (infer/chat "qwen3.5-9b"
                 (list (infer/chat/user (string-append instruction "\\n\\n" input)))
                 (s/object (s/field/string "label"))
                 (string-append "predict/" instruction "/" input)))))
(define (reflect instruction failures)
  (:instruction (car (infer/chat "qwen3.5-9b"
                       (list (infer/chat/user (string-append
                         "Rewrite it to fix the failures"
                         (if (null? failures) "" (string-append " like: " (:input (car failures))))
                         ". Current instruction: " instruction)))
                       (s/object (s/field/string "instruction"))
                       (string-append "improve/" instruction)))))
(define (evaluate instruction)
  (map (lambda (ex) (metric (ask instruction (:input ex)) (:expected ex))) examples))
(define (assess instruction) (dict :instruction instruction :scores (evaluate instruction)))
(define (failing candidate) (map car (filter (lambda (pair) (zero? (cadr pair))) (map list examples (:scores candidate)))))
(define (mutate candidate) (assess (reflect (:instruction candidate) (failing candidate))))
(define (dominates? a b)
  (and (every >= (:scores a) (:scores b))
       (some  >  (:scores a) (:scores b))))
(define (frontier pool)
  (filter (lambda (c) (not (some (lambda (other) (dominates? other c)) pool))) pool))
(define (iterate step pool n) (if (zero? n) pool (iterate step (step pool) (- n 1))))
(define (generation pool) (frontier (append pool (map mutate pool))))
(define (gepa seed rounds)
  (max-by (lambda (c) (apply + (:scores c)))
          (iterate generation (list (assess seed)) rounds)))
(gepa "Label the text." 4)
`;
}

/** The four canonical campaign/walkthrough programs — circuit-full.stories.tsx
 *  / circuit-elk.stories.tsx's own literal constants, duplicated here for the
 *  same reason (a test importing a `.stories.tsx` would pull in Storybook's
 *  own module graph for no reason this file needs). */
const CANONICAL_FOUR: Readonly<Record<string, string>> = {
  genuine: `(let ((e (dict :v (car (infer "m" "v"))))) (number->string (:v e)))`,
  guardSwapForge: `(if (< (:v e) 1000) "SAFE" (number->string (:v e)))`,
  judgment: `(let ((e (dict :guilty (car (infer "m" "g"))))) (if (:guilty e) "GUILTY" "INNOCENT"))`,
  decoy: `(let ((e (dict :v (car (infer "m" "v")) :o "FAKE"))) (number->string (:o e)))`,
};

interface RecordedVerdict {
  readonly dataShaped: boolean;
  readonly judgmentShaped: boolean;
  readonly verdictData: ReturnType<typeof circuitVerdict>;
  readonly verdictJudgment: ReturnType<typeof circuitVerdict>;
}

function recordVerdict(prov: StaticProv): RecordedVerdict {
  return {
    dataShaped: dataShaped(prov),
    judgmentShaped: judgmentShaped(prov),
    verdictData: circuitVerdict(prov, "data"),
    verdictJudgment: circuitVerdict(prov, "judgment"),
  };
}

/**
 * Recorded from `main` BEFORE this session's extract-memo/verdict-memo fix
 * (a temporary side-by-side script ran both the pre-fix and post-fix
 * `extractProgram`/`circuit-verdict` over every row below and diffed the
 * results — 0 mismatches). These are hardcoded, not re-derived at test time,
 * on purpose: the whole point of this gate is "does the CURRENT code
 * reproduce what the OLD code did," not "is the current code
 * self-consistent."
 */
const EXPECTED: Readonly<Record<string, RecordedVerdict>> = {
  "fixture-corpus/guard-swap forge": { dataShaped: false, judgmentShaped: false, verdictData: "not-attestable", verdictJudgment: "not-attestable" },
  "fixture-corpus/named-helper forge": { dataShaped: false, judgmentShaped: false, verdictData: "not-attestable", verdictJudgment: "not-attestable" },
  "fixture-corpus/hidden-const fold (longcat)": { dataShaped: false, judgmentShaped: false, verdictData: "not-attestable", verdictJudgment: "not-attestable" },
  "fixture-corpus/genuine content": { dataShaped: true, judgmentShaped: false, verdictData: "data-shaped", verdictJudgment: "not-attestable" },
  "fixture-corpus/plain fuse": { dataShaped: true, judgmentShaped: false, verdictData: "data-shaped", verdictJudgment: "not-attestable" },
  "fixture-corpus/shadowed-input forge": { dataShaped: false, judgmentShaped: false, verdictData: "not-attestable", verdictJudgment: "not-attestable" },
  "fixture-corpus/builtin-as-value laundering (F23)": { dataShaped: false, judgmentShaped: false, verdictData: "not-attestable", verdictJudgment: "not-attestable" },
  "fixture-corpus/tail-fold recursion lift": { dataShaped: true, judgmentShaped: false, verdictData: "data-shaped", verdictJudgment: "not-attestable" },
  gepa: { dataShaped: false, judgmentShaped: false, verdictData: "not-attestable", verdictJudgment: "not-attestable" },
  "canonical-four/genuine": { dataShaped: true, judgmentShaped: false, verdictData: "data-shaped", verdictJudgment: "not-attestable" },
  "canonical-four/guardSwapForge": { dataShaped: false, judgmentShaped: false, verdictData: "not-attestable", verdictJudgment: "not-attestable" },
  "canonical-four/judgment": { dataShaped: false, judgmentShaped: true, verdictData: "not-attestable", verdictJudgment: "judgment-shaped" },
  "canonical-four/decoy": { dataShaped: false, judgmentShaped: false, verdictData: "not-attestable", verdictJudgment: "not-attestable" },
};

describe("THE SEAL GATE — dataShaped/judgmentShaped/circuitVerdict are BIT-IDENTICAL pre/post the sharing fix", () => {
  it("every fixture-corpus row (all landed) matches the pre-fix recorded verdict", () => {
    expect(FIXTURE_CORPUS.every((row) => row.landed)).toBe(true); // this gate assumes no it.fails rows
    for (const row of FIXTURE_CORPUS) {
      const key = `fixture-corpus/${row.name}`;
      expect(EXPECTED[key], `missing EXPECTED entry for ${key}`).toBeDefined();
      expect(recordVerdict(run(row.source)), key).toEqual(EXPECTED[key]);
    }
  });

  it("the real GEPA program matches the pre-fix recorded verdict", () => {
    expect(recordVerdict(run(buildGepaSource()))).toEqual(EXPECTED.gepa);
  });

  it("all four canonical story programs match their pre-fix recorded verdicts", () => {
    for (const [name, source] of Object.entries(CANONICAL_FOUR)) {
      const key = `canonical-four/${name}`;
      expect(recordVerdict(run(source)), key).toEqual(EXPECTED[key]);
    }
  });
});
