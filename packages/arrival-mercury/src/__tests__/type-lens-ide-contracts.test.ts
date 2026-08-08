/**
 * Type-lens IDE contracts — the hard red suite.
 *
 * These are the load-bearing promises the scheme→virtual-TS type lens makes to
 * editors (arrival-lsp / codemirror). They sit BELOW the LSP package so a
 * regression in emit shape or checker behavior fails here first, with no
 * service-core / completion machinery to muddy the signal.
 *
 * Contracts (named, not vibes):
 *
 *   C1  Wrong-typed `car`/`cdr` arg bites ON THE ARG ATOM with an assignability
 *       error (TS2345 family), not on the whole form with an index error
 *       (TS7053). The type lens is "type-checked, never run" — native `[0]`
 *       sugar is allowed only when it preserves this bite.
 *
 *   C2  A pure compose/pipe pipeline define typechecks clean under PRE.
 *       Call-site: well-typed input is clean; wrong input bites on the arg.
 *
 *   C3  Span map: every C1/C2 diagnostic that has a scheme origin lifts to the
 *       scheme atom that is wrong — never the enclosing form when a tighter
 *       mapping exists.
 *
 * Emit-shape details (A extends vs conditional return, car→[0] vs car(…)) are
 * free to change as long as C1–C3 hold. Shape-only tables in type-emit.test.ts
 * follow these contracts, not the other way around.
 *
 * Per `.claude/rules/tests.md` this is a `__tests__/` verdict.
 */
import { getBundledPreludeFiles, PROGRAM_FILE } from "@inhuman.tools/arrival-internals-types-prelude/browser";
import { describe, expect, it } from "vitest";
import ts from "typescript";

import { emitTypes, type Mapping } from "../type-emit/index.js";

// ── harness: emitTypes → PRE + virtual program → semantic diags + span lift ──

interface LiftedDiag {
  code: number;
  messageText: string;
  /** Scheme span after tightest-mapping lift, or null if unmapped. */
  schemeStart: number | null;
  schemeLength: number | null;
  schemeText: string | null;
  /** Raw TS diagnostic span (for debugging reds). */
  tsStart: number;
  tsLength: number;
}

function toScheme(mappings: readonly Mapping[], tsOffset: number): { start: number; length: number } | null {
  let best: Mapping | null = null;
  for (const m of mappings) {
    if (tsOffset < m.tsStart || tsOffset >= m.tsStart + m.tsLength) continue;
    if (best === null || m.tsLength < best.tsLength) best = m;
  }
  return best === null ? null : { start: best.schemeStart, length: best.schemeLength };
}

function checkScheme(scheme: string): { ts: string; mappings: Mapping[]; diags: LiftedDiag[] } {
  const { ts: virtualTs, mappings } = emitTypes(scheme);
  const files = getBundledPreludeFiles();
  files.set(PROGRAM_FILE, virtualTs);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => {
      const mem = files.get(name);
      if (mem !== undefined) return ts.ScriptSnapshot.fromString(mem);
      const disk = ts.sys.readFile(name);
      return disk === undefined ? undefined : ts.ScriptSnapshot.fromString(disk);
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => ({
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts"],
      types: [],
      skipLibCheck: false,
    }),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (name) => files.has(name) || ts.sys.fileExists(name),
    readFile: (name) => files.get(name) ?? ts.sys.readFile(name),
  };
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  const raw = ls.getSemanticDiagnostics(PROGRAM_FILE);
  const diags: LiftedDiag[] = raw
    .filter((d) => d.file?.fileName === PROGRAM_FILE || d.file === undefined)
    .map((d) => {
      const tsStart = d.start ?? 0;
      const tsLength = d.length ?? 0;
      const span = toScheme(mappings, tsStart);
      return {
        code: d.code,
        messageText: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        schemeStart: span?.start ?? null,
        schemeLength: span?.length ?? null,
        schemeText:
          span === null ? null : scheme.slice(span.start, span.start + span.length),
        tsStart,
        tsLength,
      };
    });
  return { ts: virtualTs, mappings, diags };
}

// ── C1 — wrong-typed car/cdr arg ─────────────────────────────────────────────

describe("C1 — (car 5) / (cdr 5) bite on the arg atom with assignability", () => {
  it("(define z (car 5)) → one error on scheme `5`, TS2345, assignability prose", () => {
    const scheme = `(define z (car 5))`;
    const { diags, ts: emitted } = checkScheme(scheme);
    const errors = diags.filter((d) => d.code !== 2304 && d.code !== 2552);
    expect(errors, `emitted:\n${emitted}\ndiags:\n${JSON.stringify(diags, null, 2)}`).toHaveLength(1);
    const d = errors[0]!;
    // Span: the arg atom, not the whole `(car 5)`.
    expect(d.schemeText).toBe("5");
    expect(d.schemeStart).toBe(scheme.indexOf("5"));
    // Code + prose: function-arg assignability, NOT "can't index Number".
    expect(d.code).toBe(2345);
    expect(d.messageText).toMatch(/not assignable|List/i);
    expect(d.messageText).not.toMatch(/can't be used to index|implicitly has an 'any' type because expression of type '0'/i);
  });

  it("(define z (cdr 5)) → same contract on `5`", () => {
    const scheme = `(define z (cdr 5))`;
    const { diags, ts: emitted } = checkScheme(scheme);
    const errors = diags.filter((d) => d.code !== 2304 && d.code !== 2552);
    expect(errors, `emitted:\n${emitted}\ndiags:\n${JSON.stringify(diags, null, 2)}`).toHaveLength(1);
    const d = errors[0]!;
    expect(d.schemeText).toBe("5");
    expect(d.code).toBe(2345);
    expect(d.messageText).toMatch(/not assignable|List/i);
  });

  it("clean (car xs) on a real list → 0 errors", () => {
    const { diags, ts: emitted } = checkScheme(`(define xs (list 1 2 3))\n(define z (car xs))`);
    const errors = diags.filter((d) => d.code !== 2304 && d.code !== 2552);
    expect(errors, `emitted:\n${emitted}\ndiags:\n${JSON.stringify(diags, null, 2)}`).toHaveLength(0);
  });
});

// ── C2 — compose/pipe pipelines ──────────────────────────────────────────────

describe("C2 — compose/pipe pipeline defines are clean; call sites refine", () => {
  it("(define state-of (compose :state last :versions)) alone → 0 errors", () => {
    const scheme = `(define state-of (compose :state last :versions))`;
    const { diags, ts: emitted } = checkScheme(scheme);
    const errors = diags.filter((d) => d.code !== 2304 && d.code !== 2552);
    expect(errors, `emitted:\n${emitted}\ndiags:\n${JSON.stringify(diags, null, 2)}`).toHaveLength(0);
  });

  it("(define f (pipe :versions last :state)) alone → 0 errors", () => {
    const scheme = `(define f (pipe :versions last :state))`;
    const { diags, ts: emitted } = checkScheme(scheme);
    const errors = diags.filter((d) => d.code !== 2304 && d.code !== 2552);
    expect(errors, `emitted:\n${emitted}\ndiags:\n${JSON.stringify(diags, null, 2)}`).toHaveLength(0);
  });

  it("well-typed call of a compose pipeline → 0 errors", () => {
    const scheme =
      `(define state-of (compose :state last :versions))\n` +
      `(define p (dict :versions (list (dict :state "a"))))\n` +
      `(define s (state-of p))`;
    const { diags, ts: emitted } = checkScheme(scheme);
    const errors = diags.filter((d) => d.code !== 2304 && d.code !== 2552);
    expect(errors, `emitted:\n${emitted}\ndiags:\n${JSON.stringify(diags, null, 2)}`).toHaveLength(0);
  });

  it("wrong-typed call (state-of 1) → one TS2345 on scheme `1`", () => {
    const scheme =
      `(define state-of (compose :state last :versions))\n` +
      `(define s (state-of 1))`;
    const { diags, ts: emitted } = checkScheme(scheme);
    const errors = diags.filter((d) => d.code !== 2304 && d.code !== 2552);
    expect(errors, `emitted:\n${emitted}\ndiags:\n${JSON.stringify(diags, null, 2)}`).toHaveLength(1);
    const d = errors[0]!;
    expect(d.schemeText).toBe("1");
    expect(d.code).toBe(2345);
  });
});

// ── C3 — span map tightness (mapping table, independent of checker) ──────────

describe("C3 — span map records the arg atom under a car form", () => {
  it("mappings for (define z (car 5)) include a tight map of scheme `5`", () => {
    const scheme = `(define z (car 5))`;
    const { mappings, ts: emitted } = emitTypes(scheme);
    const fiveAt = scheme.indexOf("5");
    const tight = mappings.filter((m) => m.schemeStart === fiveAt && m.schemeLength === 1);
    expect(
      tight.length,
      `expected a mapping of the atom 5; emitted:\n${emitted}\nmappings:\n${JSON.stringify(mappings, null, 2)}`,
    ).toBeGreaterThan(0);
    // The TS run for that mapping must be exactly the digit (or a parenthesized
    // form that still starts at the digit after a single paren) — not the whole
    // `(5)[0]` call. If the arg is only mapped as part of a larger run, C1's
    // lift cannot land on `5`.
    const m = tight[0]!;
    const tsRun = emitted.slice(m.tsStart, m.tsStart + m.tsLength);
    expect(tsRun).toMatch(/5/);
    expect(m.tsLength).toBeLessThanOrEqual(3); // `5` or `(5)`
  });
});
