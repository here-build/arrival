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

  it("fuses pure-chain + local compose domain (not incomplete { id } alone)", () => {
    // (:id persona) ⊔ (state-of persona) → { id; versions: List<{ state }> }
    const { ts } = emitTypes(`
(define state-of (compose :state last :versions))
(define (triage-one persona reaction tagline)
  (str (:id persona) (state-of persona) tagline reaction))
`);
    expect(ts).toMatch(/persona:\s*\{[^}]*id:\s*any/);
    expect(ts).toMatch(/persona:\s*\{[^}]*versions:\s*List<\s*\{\s*state:\s*any\s*\}\s*>/);
    // Collapsed single annotation (both keys), not bare and not id-only.
    expect(ts).toMatch(/\(persona:\s*\{[^)]*id:\s*any[^)]*versions:/);
  });

  it("fuses multi list demands on one param (field chains + car)", () => {
    // (map :field value) not in pure chain on value as list root the same way —
    // (:field (car value)) + (:test (car value)) + (cdr value)
    const { ts } = emitTypes(`
(define (probe value)
  (list (:field (car value)) (:test (car value)) (cdr value)))
`);
    // List of objects with both field and test
    expect(ts).toMatch(/value:\s*List<\s*\{[^}]*field:\s*any/);
    expect(ts).toMatch(/value:\s*List<\s*\{[^}]*test:\s*any/);
  });

  it("callee formal List domain pushes through (list x) onto x (frontier-of / child-task-of)", () => {
    // frontier-of's history is List<{ tagline; reactions }> from its map lambda.
    // (frontier-of (list parent-best-entry) …) must fuse that element shape onto
    // parent-best-entry — not leave it as { tagline } from the pure :tagline read alone.
    const { ts } = emitTypes(`
(define (frontier-of history personas inherited)
  (append inherited
    (map (lambda (e) (list (:tagline e) (:reactions e)))
         history)))
(define (child-task-of parent-task parent-best-entry parent-node-id unsatisfied)
  (let ((personas (:personas parent-task))
        (hints    (:hints parent-task)))
    (list (map :persona unsatisfied)
          (:tagline parent-best-entry)
          parent-node-id
          (frontier-of (list parent-best-entry) personas hints))))
`);
    // Callee formal harvest
    expect(ts).toMatch(/history:\s*List<\s*\{\s*tagline:\s*any;\s*reactions:\s*any\s*\}/);
    // Call-site list-element push ⊔ pure :tagline chain
    expect(
      ts,
      "parent-best-entry must pick up reactions via (list ·) under frontier-of's history domain",
    ).toMatch(
      /parent\$dash\$best\$dash\$entry:\s*\{\s*tagline:\s*any;\s*reactions:\s*any\s*\}/,
    );
  });

  it("multi-list map zips each lambda param onto its list (reactions-summary)", () => {
    // (map (lambda (p r) (:id p) (:verdict r) (:concern r)) personas reactions)
    // must demand reactions : List<{ verdict; concern }>, not only personas.
    const { ts } = emitTypes(`
(define (reactions-summary reactions personas)
  (map (lambda (p r)
         (dict :persona (:id p) :verdict (:verdict r) :concern (:concern r)))
       personas reactions))
(define (next-tagline current reactions personas)
  (reactions-summary reactions personas))
`);
    expect(ts).toMatch(/reactions\$dash\$summary = \(reactions:\s*List<\s*\{[^)]*verdict:\s*any/);
    expect(ts).toMatch(/reactions\$dash\$summary = \(reactions:\s*List<\s*\{[^)]*concern:\s*any/);
    // Callee formal domain fuse onto next-tagline's reactions
    expect(ts).toMatch(
      /next\$dash\$tagline = \(current,\s*reactions:\s*List<\s*\{[^)]*verdict:\s*any/,
    );
  });

  it("cons reverse + let* one-hop: history formal gets List from frontier-of via history+", () => {
    // (history+ (cons entry history)) (frontier-of history+) must annotate
    // loop's history as List<{ tagline; reactions }>, not leave it bare → List<unknown>.
    const { ts } = emitTypes(`
(define (frontier-of history)
  (map (lambda (e) (list (:tagline e) (:reactions e))) history))
(define (gepa)
  (define (loop history)
    (let* ((entry (dict :tagline "t" :score 1 :reactions '()))
           (history+ (cons entry history))
           (fr (frontier-of history+)))
      (loop history+)))
  (loop '()))
`);
    expect(
      ts,
      "loop history must pick up List domain through (cons entry history) under frontier-of",
    ).toMatch(/loop = \(history:\s*List<\s*\{\s*tagline:\s*any;\s*reactions:\s*any\s*\}/);
    // Empty quote is List null brand, not unknown[]
    expect(ts).toContain("loop(null)");
    expect(ts).not.toMatch(/loop\(\[\]\)/);
  });
});
