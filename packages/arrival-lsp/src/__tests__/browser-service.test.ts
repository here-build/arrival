// browser-service — the fs-less entry proof.
//
// `createBrowserSchemeLanguageService` must answer the same queries as the Node
// service while touching NEITHER `node:fs` NOR `ts.sys`: prelude + TS default
// libs come from the build-time-generated bundles. Running it under vitest (Node)
// is exactly the point — the service itself cannot tell; the environment object
// is the only difference. Plus the drift guard: the generated prelude bundle must
// stay byte-identical to what `getPreludeFiles()` reads off disk.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { createBrowserSchemeLanguageService, getBundledPreludeFiles } from "../browser.js";
import { getPreludeFiles, PROGRAM_FILE } from "../prelude.js";
import { TS_DEFAULT_LIB, TS_LIB_FILES } from "../ts-libs.generated.js";

describe("prelude bundle — drift guard", () => {
  it("matches the on-disk prelude byte-for-byte (fix: pnpm generate:bundles)", () => {
    expect(Object.fromEntries(getBundledPreludeFiles())).toEqual(Object.fromEntries(getPreludeFiles()));
  });
});

describe("stripped-lib world — internal coherence guard", () => {
  // The value-strip must leave the lib chain SELF-CONSISTENT. The audit
  // (2026-06-10) found 93 internal errors when `Symbol`'s value was dropped
  // (computed properties like `[Symbol.iterator]()` resolve through it) — all
  // invisible through the program-file-only public API while silently degrading
  // type relations. This walks EVERY file of the world and demands zero.
  it("the prelude + stripped libs compile with zero internal diagnostics", () => {
    const files = getPreludeFiles();
    const libs = new Map(TS_LIB_FILES);
    files.set(PROGRAM_FILE, "export {};\n");
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...files.keys()],
      getScriptVersion: () => "1",
      getScriptSnapshot: (fn) => {
        const t = files.get(fn) ?? libs.get(fn);
        return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
      },
      getCurrentDirectory: () => "/",
      getCompilationSettings: () => ({
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
        lib: ["lib.es2022.d.ts"],
        types: [],
        skipLibCheck: false,
      }),
      getDefaultLibFileName: () => TS_DEFAULT_LIB,
      fileExists: (fn) => files.has(fn) || libs.has(fn),
      readFile: (fn) => files.get(fn) ?? libs.get(fn),
    };
    const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
    const program = svc.getProgram()!;
    const offenders: string[] = [];
    for (const sf of program.getSourceFiles()) {
      const ds = [...program.getSemanticDiagnostics(sf), ...program.getSyntacticDiagnostics(sf)];
      if (ds.length > 0)
        offenders.push(`${sf.fileName}: ${ts.flattenDiagnosticMessageText(ds[0]!.messageText, " ").slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
    expect(program.getGlobalDiagnostics()).toEqual([]);
  });
});

describe("browser language service — same answers, no fs", () => {
  const ls = createBrowserSchemeLanguageService();

  it("(car 5) → the same 2345 bite on the `5`, in Scheme coordinates", () => {
    const scheme = `(define z (car 5))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(scheme.slice(d.start, d.start + d.length)).toBe("5");
    expect(d.severity).toBe("error");
    expect(d.code).toBe(2345);
  });

  it("a clean program → 0 diagnostics (the bundled lib chain resolves)", () => {
    // A global error (e.g. an unresolvable `lib.es2022.d.ts`) would surface here.
    expect(ls.getSemanticDiagnostics(`(define xs (list 1 2 3))\n(car xs)`)).toHaveLength(0);
  });

  it("hover answers with the inferred type", () => {
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const info = ls.getQuickInfoAtPosition(scheme, scheme.lastIndexOf("xs") + 1);
    expect(info).not.toBeNull();
    expect(info!.displayText).toContain("List<number>");
  });

  it("completions surface in-scope bindings", () => {
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const names = new Set(ls.getCompletionsAtPosition(scheme, scheme.lastIndexOf("car") + 1).map((e) => e.name));
    expect(names.has("xs")).toBe(true);
  });
});
