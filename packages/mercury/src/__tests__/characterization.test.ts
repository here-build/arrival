/**
 * Characterization harness for the mode-fold unification
 * (docs/package-specific/arrival-chain-view/chain-view-mode-fold-unification-2026-06-17.md).
 *
 * Two jobs:
 *  1. BASELINE — snapshot the CURRENT output of all three live emitter configs
 *     (projectToJs read, projectToJs run, emitTypes) across a construct corpus, so
 *     the upcoming `Rendered`-fold refactor can be proven output-preserving by diff.
 *  2. THE PROOF — the whole "pure de-dup, zero output change" claim rests on ONE
 *     fact: the span lift-back is ORDER-INDEPENDENT, so the fold may emit `mappings`
 *     in any order. The consumer (`SpanMap.toScheme`/`toTs`, span-map.ts:54-85) picks
 *     the TIGHTEST mapping by `tsLength` among those containing an offset, breaking an
 *     exact-`tsLength` tie by ARRAY ORDER (strict `<`). So the only way a reorder could
 *     change a lift-back is if some offset is covered by ≥2 minimal-`tsLength` mappings
 *     with DIFFERENT scheme spans. This harness sweeps every offset of every corpus
 *     program and asserts no such tie exists — if it passes, the reorder is provably
 *     invisible and the migration is output-preserving by construction.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { projectToJs } from "../project.js";
import { emitTypes, type Mapping } from "../types-emit.js";

const fixtureDir = fileURLToPath(new URL("fixtures/sources/", import.meta.url));
const readFixture = (name: string) => readFileSync(fixtureDir + name, "utf8");
const requireSource = (path: string): string | undefined => {
  try {
    return readFixture(path);
  } catch {
    return undefined;
  }
};

// Representative corpus: one program per catalog construct (read/run/typecheck differ
// per the audit), plus the two real fixtures. Kept small + legible — this is a spec.
const CASES: { name: string; src: string }[] = [
  { name: "atom-define", src: `(define x 5)\n(define s "hi")\n(define b #t)` },
  { name: "lambda-if", src: `(define (f x) (if (> x 0) x (- x)))` },
  { name: "let", src: `(define r (let ((x 1) (y 2)) (+ x y)))` },
  { name: "let*", src: `(define q (let* ((a 1) (b (+ a 1))) b))` },
  { name: "begin", src: `(define z (begin (+ 1 2) (* 3 4)))` },
  { name: "named-let", src: `(define (sum n) (let go ((i 0) (acc 0)) (if (< i n) (go (+ i 1) (+ acc i)) acc)))` },
  { name: "dict-accessor", src: `(define row (dict :name "alice" :age 30))\n(:name row)` },
  { name: "cxr", src: `(define (g r) (cadr r))` },
  { name: "map-filter", src: `(define (h xs) (map (lambda (n) (+ n n)) (filter odd? xs)))` },
  { name: "logic", src: `(define (k a b) (and (< a b) (= a 0)))` },
  { name: "set-bang", src: `(define (m) (let ((x 0)) (set! x 5) x))` },
  { name: "quote-cons-list", src: `(define p (cons 1 (list 2 3)))\n(define qq (quote (a b c)))` },
  { name: "require-dropped", src: `(define runX (require "x.prompt"))` },
  { name: "kwargs", src: `(define (mk name) (dict :name name :active #t))` },
  { name: "nested-call", src: `(define (deep xs) (car (map (lambda (p) (cdr p)) xs)))` },
  // Law T truthiness (Phase 0 conservative forms) — pins all three planes:
  // read/run carry the `!== false` guard + the or-temp/`=== false` spellings,
  // ts carries the `__scmTruth(…)` wrap.
  { name: "truthiness-if", src: `(define (pick c a b) (if c a b))` },
  { name: "truthiness-or-not", src: `(define (f a b) (or a (not b)))` },
];

/** Run an emitter config, capturing a thrown door as a stable "THROW: <msg>" string
 *  so the corpus records read-view doors as data instead of crashing the harness. */
async function safeJs(src: string, run: boolean): Promise<string> {
  try {
    return await projectToJs(src, run ? { target: "run", requireSource } : { requireSource });
  } catch (e) {
    return `THROW: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Does the TS range [tsStart, tsStart+tsLength) contain `o`? */
const contains = (m: Mapping, o: number) => o >= m.tsStart && o < m.tsStart + m.tsLength;
const sameSchemeSpan = (a: Mapping, b: Mapping) => a.schemeStart === b.schemeStart && a.schemeLength === b.schemeLength;

/** Order-sensitive ties: offsets where ≥2 minimal-`tsLength` mappings cover the offset
 *  with DIFFERENT scheme spans — the only case where array order changes a lift-back. */
function orderSensitiveTies(mappings: readonly Mapping[], tsLen: number): { offset: number; spans: Mapping[] }[] {
  const ties: { offset: number; spans: Mapping[] }[] = [];
  for (let o = 0; o < tsLen; o++) {
    const covering = mappings.filter((m) => contains(m, o));
    if (covering.length < 2) continue;
    const minLen = Math.min(...covering.map((m) => m.tsLength));
    const winners = covering.filter((m) => m.tsLength === minLen);
    // Distinct scheme spans among the equal-shortest winners → resolution depends on order.
    const distinct = winners.filter((w, i) => winners.findIndex((x) => sameSchemeSpan(x, w)) === i);
    if (distinct.length > 1) ties.push({ offset: o, spans: distinct });
  }
  return ties;
}

const corpus = (): { name: string; src: string }[] => [
  ...CASES,
  { name: "fixture-metric", src: readFixture("metric.scm") },
  { name: "fixture-gepa", src: readFixture("gepa.scm") },
];

describe("characterization: span lift-back is order-independent (the pure-de-dup proof)", () => {
  it("NO order-sensitive span ties anywhere in the corpus → a mappings reorder is invisible", () => {
    const offenders: string[] = [];
    for (const { name, src } of corpus()) {
      const { ts, mappings } = emitTypes(src);
      const ties = orderSensitiveTies(mappings, ts.length);
      if (ties.length > 0) {
        offenders.push(
          `${name}: ${ties.length} tie(s), e.g. offset ${ties[0]!.offset} → ${ties[0]!.spans
            .map((m) => `scheme[${m.schemeStart},+${m.schemeLength}]`)
            .join(" vs ")}`,
        );
      }
    }
    // If this fails, the refactor's `cat` reorder COULD change a diagnostic position;
    // recovery is local (pin emit order at the tied construct) — see proposal §9.
    expect(offenders, `order-sensitive ties found:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("characterization: baseline snapshot (the post-refactor diff target)", () => {
  it("matches fixtures/characterization.baseline.json", async () => {
    const snapshot: Record<string, unknown> = {};
    for (const { name, src } of corpus()) {
      const { ts, mappings, droppedForms } = emitTypes(src);
      snapshot[name] = {
        read: await safeJs(src, false),
        run: await safeJs(src, true),
        ts,
        droppedForms,
        // The mapping SET (sorted, order-normalized) — the post-refactor gate is set
        // equality, NOT array order (proven invisible by the tie test above).
        mappings: [...mappings]
          .map((m) => `ts[${m.tsStart},+${m.tsLength}]→scm[${m.schemeStart},+${m.schemeLength}]`)
          .sort(),
      };
    }
    const actual = JSON.stringify(snapshot, null, 2) + "\n";
    await expect(actual).toMatchFileSnapshot("fixtures/compiled/characterization.baseline.json");
  });
});
