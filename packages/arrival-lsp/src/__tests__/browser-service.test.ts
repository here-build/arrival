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

import { describe, expect, it } from "vitest";

import { createBrowserSchemeLanguageService, getBundledPreludeFiles } from "../browser.js";
import { getPreludeFiles } from "../prelude.js";

describe("prelude bundle — drift guard", () => {
  it("matches the on-disk prelude byte-for-byte (fix: pnpm generate:bundles)", () => {
    expect(Object.fromEntries(getBundledPreludeFiles())).toEqual(Object.fromEntries(getPreludeFiles()));
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
