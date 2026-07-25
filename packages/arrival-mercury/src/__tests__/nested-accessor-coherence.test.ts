/**
 * Nested accessor coherence — framework reds (step 0) then greens.
 *
 * Demand from pure field/elem consumers propagates UP to binders (named let /
 * define formals). Native index emit stays; params get structural annotations.
 *
 * @see inhuman/docs/working-proposals/nested-accessor-coherence-DRAFT.md
 */
import { describe, expect, it } from "vitest";

import { emitTypes } from "../type-emit/emit.js";

/** Load-bearing shape from the design (framework-level, not an inhuman demo). */
const TRIAGE_BUFFER = `
(define (triage-of-persona-in-node pid node)
  (let loop ((ts (:triaged node)))
    (cond ((null? ts) #f)
          ((equal? (:id (:persona (car ts))) pid) (car ts))
          (else (loop (cdr ts))))))
`;

describe("nested accessor coherence — binder demand harvest", () => {
  it("named-let loop param ts gets List<{ persona: { id: any } }> from nested consumers", () => {
    const { ts } = emitTypes(TRIAGE_BUFFER);
    // Not there yet until demand harvest lands — must annotate the loop formal.
    expect(
      ts,
      "we're not there yet: loop param ts must be annotated from (:id (:persona (car ts))) + list uses",
    ).toMatch(/\(ts:\s*List<\s*\{\s*persona:\s*\{\s*id:\s*any\s*\}\s*\}\s*>/);
  });

  it("outer formal node gets { triaged: List<…> } via one-hop init (:triaged node)", () => {
    const { ts } = emitTypes(TRIAGE_BUFFER);
    expect(
      ts,
      "we're not there yet: node must pick up one-hop demand from loop init (:triaged node)",
    ).toMatch(/node:\s*\{\s*triaged:\s*List</);
  });

  it("native index chain remains (no IIFE cast rewrite)", () => {
    const { ts } = emitTypes(TRIAGE_BUFFER);
    // Keep native path under the annotation — not (…as C) IIFE per design.
    expect(ts).toMatch(/\(ts\)\[0\]/);
    expect(ts).toContain('["persona"]');
    expect(ts).toContain('["id"]');
    expect(ts).not.toMatch(/as List</);
  });

  it("cdr alone contributes List demand on the param", () => {
    const { ts } = emitTypes(`
(define (walk xs)
  (if (null? xs) #f (walk (cdr xs))))
`);
    expect(
      ts,
      "we're not there yet: (cdr xs) must demand List on xs",
    ).toMatch(/\(xs:\s*List</);
  });

  it("list vs object constructor conflict → no false annotation", () => {
    // Same param used as list (car) and as object (:k p) — skip, don't invent.
    const { ts } = emitTypes(`
(define (bad p)
  (list (car p) (:name p)))
`);
    // Must not annotate p with a lying combined type.
    expect(ts).not.toMatch(/\(p:\s*List</);
    expect(ts).not.toMatch(/\(p:\s*\{\s*name:/);
  });

  it("compose lambda generics still special-case (no regress)", () => {
    const { ts } = emitTypes("(define state-of (compose :state last :versions))");
    expect(ts).toContain("<A extends { versions: List<{ state: any }> }>");
  });

  it("keyword-as-fn HOF eta still unconstrained (no regress)", () => {
    const { ts } = emitTypes("(map :score xs)");
    expect(ts).toContain("<A,>(x: A): A extends { score: infer S } ? S : unknown");
  });
});
