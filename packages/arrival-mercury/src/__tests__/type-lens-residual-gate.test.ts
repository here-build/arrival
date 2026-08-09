/**
 * Type-lens residual gate (plan PR0, eng-review G1/G5 resolution).
 *
 * Measures **emitTypes + List carriers** (language-service dialect), NOT
 * oracle `compileGreenfield` + stage0 unknown[] — different surfaces.
 *
 * Pattern mirrors oracle `emitted-strict-gate.test.ts` (in-memory tsc), with
 * carriers ambient instead of stage0. SUBJECTS = demand-harvest load-bearing
 * rows that must be strict-clean for List assignability today.
 *
 * Growing SUBJECTS toward full custdev excerpts IS the spine build-out.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";

import { emitTypes } from "../type-emit/emit.js";

/**
 * PRE dialect ambient (matches arrival-internals-types-prelude types.d.ts):
 * `List<T> = T[]`, empty list is `[]` (not Cons|null / null).
 */
const AMBIENT = `
type List<T> = T[];
declare function list<T>(...xs: T[]): List<T>;
declare function cons<H, T>(h: H, t: List<T>): List<H | T>;
declare function append<T>(...xs: List<T>[]): List<T>;
declare function reverse<T>(xs: List<T>): List<T>;
declare function take<T>(n: number, xs: List<T>): List<T>;
declare function drop<T>(n: number, xs: List<T>): List<T>;
declare function map<T, B>(f: (x: T) => B, xs: List<T>): List<B>;
declare function map<A, B, R>(f: (a: A, b: B) => R, as: List<A>, bs: List<B>): List<R>;
declare function last<T>(xs: List<T>): T;
declare function length(xs: List<unknown> | readonly unknown[] | string): number;
declare function null$qmark$(xs: List<unknown>): boolean;
declare function filter<T>(p: (x: T) => unknown, xs: List<T>): List<T>;
`;

function stripExports(carriersLike: string): string {
  return carriersLike.replace(/^export /gm, "");
}

function strictDiagnostics(emitted: string): readonly string[] {
  const text = `${stripExports(AMBIENT)}\n${emitted}`;
  const file = "/virtual/demand-residual.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    noImplicitAny: false, // bare formals OK; List assignability still teeth
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts"],
    types: [],
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options, true);
  const baseGet = host.getSourceFile.bind(host);
  const baseExists = host.fileExists.bind(host);
  const baseRead = host.readFile.bind(host);
  host.fileExists = (f) => f === file || baseExists(f);
  host.readFile = (f) => (f === file ? text : baseRead(f));
  host.getSourceFile = (f, lv, onError, shouldCreate) =>
    f === file
      ? ts.createSourceFile(f, text, ts.ScriptTarget.ES2022, true)
      : baseGet(f, lv, onError, shouldCreate);
  const program = ts.createProgram([file], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => {
      // Harvest-owned: assignability (2345) and property missing (2339) on List/object.
      // Ignore implicit any on intentionally bare params when noImplicitAny false — none.
      return d.code === 2345 || d.code === 2322 || d.code === 2339;
    })
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

/** Rows that must be residual-zero for demand harvest (SUBJECTS allowlist). */
const SUBJECTS: { name: string; scheme: string }[] = [
  {
    name: "frontier-list-element",
    scheme: `
(define (frontier-of history)
  (map (lambda (e) (list (:tagline e) (:reactions e))) history))
(define (child-task parent-best-entry)
  (frontier-of (list parent-best-entry)))
`,
  },
  {
    name: "multi-list-reactions",
    scheme: `
(define (reactions-summary reactions personas)
  (map (lambda (p r) (list (:id p) (:verdict r) (:concern r)))
       personas reactions))
(define (next-tagline reactions personas)
  (reactions-summary reactions personas))
`,
  },
  {
    name: "cons-history-loop",
    scheme: `
(define (frontier-of history)
  (map (lambda (e) (:tagline e)) history))
(define (loop history)
  (let* ((entry (dict :tagline "t" :reactions '()))
         (history+ (cons entry history)))
    (frontier-of history+)
    (loop history+)))
(loop '())
`,
  },
  {
    name: "empty-list-if-branch",
    // (if … '()) must be [] not null under PRE List=T[]
    scheme: `
(define (use xs) (map (lambda (e) (:k e)) xs))
(define (maybe-empty flag)
  (use (if flag (list (dict :k 1)) '())))
`,
  },
  {
    name: "append-take-reverse",
    scheme: `
(define (need h) (map (lambda (e) (:tagline e)) h))
(define (plumb xs ys n)
  (need (append xs ys))
  (need (take n xs))
  (need (reverse ys)))
`,
  },
];

describe("type-lens residual gate (emitTypes + List carriers)", () => {
  for (const { name, scheme } of SUBJECTS) {
    it(`${name} — zero List/object assignability diagnostics`, () => {
      const { ts: emitted } = emitTypes(scheme);
      expect(strictDiagnostics(emitted), emitted).toEqual([]);
    });
  }

  it("negative control: tagline-only formal under List<{tagline;reactions}> FAILS", () => {
    // Force a residual: annotate would be incomplete if we only had pure :tagline
    // and called a function needing full entry — simulate broken fuse by hand emit.
    const broken = `
const frontier = (history: List<{ tagline: any; reactions: any }>) => history;
const bad = (entry: { tagline: any }) => frontier(list(entry));
export {};
`;
    expect(strictDiagnostics(broken).length).toBeGreaterThan(0);
  });
});
