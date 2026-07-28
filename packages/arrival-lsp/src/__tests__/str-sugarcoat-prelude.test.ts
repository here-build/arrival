import { alignSugarcoatClassic, schemeToSugarcoat } from "@inhuman.tools/arrival-sugarcoat";
import { describe, expect, it } from "vitest";

import { createSchemeLanguageService } from "../language-service.js";

const PRELUDE = `(define str (lambda args (apply string-append (map (lambda (x) (if (string? x) x (number->string x))) args))))`;

const ls = createSchemeLanguageService({
  compilerOptions: { noImplicitAny: false },
  schemePrelude: PRELUDE,
});

describe("str resolves with schemePrelude on classic and sugarcoat-aligned classic", () => {
  it("classic", () => {
    const diags = ls.getSemanticDiagnostics(`(define x (str "a" "b"))`);
    const bad = diags.filter((d) => String(d.messageText).includes("'str'") || String(d.messageText).includes("str"));
    expect(bad.map((d) => d.messageText)).toEqual([]);
  });

  it("aligned classic from sugarcoat of string-append modernize", () => {
    // User may type string-append; sugarcoat modernizes to str on round-trip.
    // Headless @{a b} becomes (str a b) in classic reprint.
    const sugar = "@{hello world}";
    const a = alignSugarcoatClassic(sugar);
    expect(a).not.toBeNull();
    expect(a!.classic).toMatch(/str/);
    const diags = ls.getSemanticDiagnostics(a!.classic);
    const bad = diags.filter((d) => String(d.messageText).includes("str") && (d.code === 2304 || d.code === 2552));
    expect(bad.map((d) => d.messageText)).toEqual([]);
  });

  it("without prelude, str is unresolved (control)", () => {
    const bare = createSchemeLanguageService({ compilerOptions: { noImplicitAny: false } });
    const diags = bare.getSemanticDiagnostics(`(define x (str "a"))`);
    const bad = diags.filter((d) => d.code === 2304 || d.code === 2552);
    expect(bad.length).toBeGreaterThan(0);
  });
});
