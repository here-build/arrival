/**
 * GEPA-heads — RED-FIRST gate for the ARM-C registry sweep that lets the REAL
 * GEPA program (reflective, Pareto-based prompt evolution) surface in the
 * provenance circuit (2026-07-15).
 *
 * Before this sweep, GEPA's static circuit was a SINGLE node: `max-by` (the
 * program's own outermost call — it wraps the whole return value) was an
 * unknown head, so its opaque discarded EVERYTHING beneath it — every
 * `infer/chat` crossing, the whole `iterate`/`generation` fan, all of it.
 * `append`, `cadr`, and three predicates (`zero?`/`null?`/`string-ci=?`) were
 * unknown too. The registry additions in `arm-containers.ts` (this sweep) fix
 * the data-carrying heads; `s/object`/`s/field/string`/`apply`/`every`/`some`
 * stay opaque deliberately (metadata/higher-order — see that file's header).
 *
 * `buildGepaSource` reconstructs the exact algorithm from the real fixture
 * (`inhuman/saas/studio/src/workbench/trace/__fixtures__/gepa-source.ts`'s
 * `GEPA_FIXTURE.program`, with its `examplesScheme`/`ROUNDS` template
 * interpolation already baked in there too) as a LITERAL copy — arrival-
 * mercury cannot import saas/studio (layering; studio depends on this
 * package, not the reverse), and this is a small, stable block, so it is
 * duplicated (not shared via cross-import) in `circuit-gepa.stories.tsx`,
 * matching `circuit-elk.stories.tsx`'s own documented precedent for exactly
 * this situation ("kept as literal copies … not a module worth coupling two
 * story files to").
 *
 * ── the one finding this sweep could NOT close (verified, not assumed) ─────
 *
 * GEPA's `(iterate generation (list (assess seed)) rounds)` passes the named
 * function `generation` BY VALUE into `iterate`'s `step` parameter, which
 * `iterate`'s body then calls as `(step pool)`. `step`'s scope binding is
 * `{expr: Ref("generation"), scope}` — a Ref bound to ANOTHER Ref, not
 * directly to a Lambda/DefineFn. `arm-control.ts`'s `extractApp` ladder
 * checks only ONE level (`bound.expr.kind === "DefineFn" || "Lambda"`) before
 * falling to `opaque("unknown-callee")` — it does not chase a second hop to
 * find the DefineFn `generation` actually is. This is confirmed to be a
 * GENERAL, pre-existing ARM-B limitation, independent of GEPA and of this
 * registry sweep — an isolated two-function repro with no GEPA machinery at
 * all (`(define (twice f x) (f (f x))) (define (inc y) (+ y 1)) (twice inc 5)`)
 * hits the exact same `opaque("unknown-callee")`. It is the documented
 * "callable-as-value"/tagless-apply gap (stage-3 remainder), not a defect in
 * the classifications this file's registry rows add. Fixing it means
 * extending `extractApp`'s general App-head ladder in `arm-control.ts` —
 * outside this sweep's authorized touch surface (`arm-containers.ts` + this
 * file + the story only). The `it.fails` row below stays red for THAT reason;
 * the plain `it` rows below it are the real, verified, achieved surfacing.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import type { StaticProv } from "../../model/static-prov.js";

// ── the real GEPA program (literal reconstruction — see header) ────────────

const GEPA_LABELS = ["positive", "negative", "neutral"] as const;

const GEPA_EXAMPLES: { input: string; expected: (typeof GEPA_LABELS)[number] }[] = [
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

const GEPA_ROUNDS = 4;

/** Builds the exact self-contained Scheme source `extractProgram` runs over:
 *  the real `gepa.scm` algorithm (evaluate → assess → mutate → dominate →
 *  frontier → iterate) with its two `.prompt` requires inlined as
 *  `(infer/chat …)` (the `.prompt` require is broken on main — see
 *  gepa-source.ts's header for why), examples/rounds baked in inline. */
export function buildGepaSource(): string {
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

(gepa "Label the text." ${GEPA_ROUNDS})
`;
}

function extractSource(source: string): StaticProv {
  const { forms } = classify(desugar(parseSexprs(source)));
  return extractProgram(forms, defaultRegistry);
}

/** Exhaustive walk collecting every reachable `mint` node's `head` — the
 *  reachability census the POSITIVE rows below need. Exhaustive over
 *  `StaticProv.kind` (tsc's no-default-arm check is the totality proof, same
 *  discipline `extract`'s own dispatcher holds). */
function collectMintHeads(prov: StaticProv, out: string[] = []): string[] {
  switch (prov.kind) {
    case "mint":
      out.push(prov.head);
      prov.closed.forEach((c) => collectMintHeads(c, out));
      return out;
    case "input":
    case "const":
    case "opaque":
      return out;
    case "fused":
      prov.sources.forEach((s) => collectMintHeads(s, out));
      return out;
    case "mux":
      collectMintHeads(prov.source, out);
      return out;
    case "build":
      prov.parts.forEach((p) => collectMintHeads(p.prov, out));
      return out;
    case "string":
      prov.runs.forEach((r) => collectMintHeads(r, out));
      return out;
    case "choice":
      prov.guards.forEach((g) => collectMintHeads(g, out));
      prov.alts.forEach((a) => collectMintHeads(a, out));
      return out;
    case "fan":
      collectMintHeads(prov.collection, out);
      collectMintHeads(prov.body, out);
      return out;
  }
}

// ── POSITIVE: GEPA's circuit reaches its infer/chat crossings ──────────────

describe("GEPA — the real program's circuit surfaces past max-by/append/etc (was: one opaque node)", () => {
  it("the root is no longer a single opaque(unknown-head/max-by) swallowing the whole program", () => {
    const prov = extractSource(buildGepaSource());
    expect(prov.kind).not.toBe("opaque");
  });

  it("the ask/predict infer/chat crossing (inside the initial pool's assess(seed)) is reachable — ≥1 infer/chat mint", () => {
    const prov = extractSource(buildGepaSource());
    const mints = collectMintHeads(prov);
    expect(mints.filter((h) => h === "infer/chat").length).toBeGreaterThanOrEqual(1);
  });

  // See this file's header for the full account: reaching the SECOND
  // infer/chat crossing (reflect/improve, inside `mutate` inside
  // `generation`) needs `(step pool)` to resolve `step` through a
  // Ref-to-Ref indirection to the DefineFn `generation` — a general ARM-B
  // App-head-ladder gap (verified via an isolated non-GEPA repro), not
  // something this registry-only sweep's touch surface can fix. Stays
  // it.fails for that reason, not because the registry rows above are
  // incomplete — the two rows above independently verify what this sweep DID
  // land.
  it.fails("the full circuit reaches BOTH infer/chat crossings (ask/predict AND reflect/improve) — ≥2 mints", () => {
    const prov = extractSource(buildGepaSource());
    const mints = collectMintHeads(prov);
    expect(mints.filter((h) => h === "infer/chat").length).toBeGreaterThanOrEqual(2);
  });
});

// ── ADVERSARIAL: the new data-head classifications never hide a const ──────

describe("soundness — the new classifications pass content through, never hide a const", () => {
  it("(infer/chat/user \"FABRICATED\") keeps FABRICATED a visible const BUILD part", () => {
    const prov = extractSource(`(infer/chat/user "FABRICATED")`);
    expect(prov.kind).toBe("build");
    if (prov.kind !== "build") throw new Error("expected build");
    expect(prov.parts).toHaveLength(1);
    expect(prov.parts[0]!.prov.kind).toBe("const");
  });

  it('(append "FAB" (:v e)) keeps "FAB" a visible const FUSE source, alongside the real evidence projection', () => {
    const prov = extractSource(`(append "FAB" (:v e))`);
    expect(prov.kind).toBe("fused");
    if (prov.kind !== "fused") throw new Error("expected fused");
    expect(prov.sources).toHaveLength(2);
    expect(prov.sources[0]!.kind).toBe("const");
    const second = prov.sources[1]!;
    expect(second.kind).toBe("mux");
    if (second.kind !== "mux") throw new Error("expected mux");
    expect(second.key).toBe("v");
    expect(second.source).toEqual({ kind: "input", site: second.source.site, name: "e" });
  });

  it("a nonsense head still lifts to opaque(unknown-head/…), never mislabeled (I1)", () => {
    const prov = extractSource(`(totally-bogus-head-42 "x")`);
    expect(prov.kind).toBe("opaque");
    if (prov.kind !== "opaque") throw new Error("expected opaque");
    expect(prov.reason).toBe("unknown-head/totally-bogus-head-42");
  });
});

// ── max-by: verify the mux takes the LIST arg, never the comparator fn ─────

describe("max-by — mux over the list argument (arg index 1), never the comparator fn (arg 0)", () => {
  it("the comparator fn is discarded; the list's own attribution (an evidence projection) flows through", () => {
    const prov = extractSource(`(max-by (lambda (c) c) (:v e))`);
    expect(prov.kind).toBe("mux");
    if (prov.kind !== "mux") throw new Error("expected mux");
    expect(prov.key).toBeNull();
    const source = prov.source;
    expect(source.kind).toBe("mux");
    if (source.kind !== "mux") throw new Error("expected mux");
    expect(source.key).toBe("v");
    expect(source.source).toEqual({ kind: "input", site: source.source.site, name: "e" });
  });

  it("even a malformed call (a Lit where the comparator fn belongs) never hides the list's source — key may mislabel, content never does", () => {
    const prov = extractSource(`(max-by 999 (:v e))`);
    expect(prov.kind).toBe("mux");
    if (prov.kind !== "mux") throw new Error("expected mux");
    // The source (the list) is unconditionally present regardless of what
    // the (malformed) arg0 was — this is the soundness property that
    // matters; the label metadata (`key`) is not a content channel.
    const source = prov.source;
    expect(source.kind).toBe("mux");
    if (source.kind !== "mux") throw new Error("expected mux");
    expect(source.key).toBe("v");
  });
});

// ── cadr: unary self-identity projection (see arm-containers.ts's comment) ──

describe("cadr — car-of-cdr, a unary projection; the pair's attribution flows through unconditionally", () => {
  it("projects through to the pair's own source, key stamped as the head's own identity", () => {
    const prov = extractSource(`(cadr (:v e))`);
    expect(prov.kind).toBe("mux");
    if (prov.kind !== "mux") throw new Error("expected mux");
    expect(prov.key).toBe("cadr");
    const source = prov.source;
    expect(source.kind).toBe("mux");
    if (source.kind !== "mux") throw new Error("expected mux");
    expect(source.key).toBe("v");
    expect(source.source).toEqual({ kind: "input", site: source.source.site, name: "e" });
  });
});

// ── the three predicates: fuse, every operand a potential contributor ──────

describe("zero? / null? / string-ci=? — fuse, every operand a potential contributor", () => {
  it("(zero? (:v e)) fuses over its one operand", () => {
    const prov = extractSource(`(zero? (:v e))`);
    expect(prov.kind).toBe("fused");
    if (prov.kind !== "fused") throw new Error("expected fused");
    expect(prov.sources).toHaveLength(1);
    expect(prov.sources[0]!.kind).toBe("mux");
  });

  it("(null? (:v e)) fuses over its one operand", () => {
    const prov = extractSource(`(null? (:v e))`);
    expect(prov.kind).toBe("fused");
    if (prov.kind !== "fused") throw new Error("expected fused");
    expect(prov.sources).toHaveLength(1);
  });

  it("(string-ci=? (:a e) (:b e)) fuses over both operands", () => {
    const prov = extractSource(`(string-ci=? (:a e) (:b e))`);
    expect(prov.kind).toBe("fused");
    if (prov.kind !== "fused") throw new Error("expected fused");
    expect(prov.sources).toHaveLength(2);
    expect(prov.sources[0]!.kind).toBe("mux");
    expect(prov.sources[1]!.kind).toBe("mux");
  });
});
