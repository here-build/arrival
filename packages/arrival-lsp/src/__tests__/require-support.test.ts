// require-support — `(require "path")` resolution through the lens.
//
// The seam: `resolveModule(path) => source | null` keeps the lens filesystem-
// blind; the require closure is emitted AHEAD of the program in one virtual
// module (scheme's load-into-scope semantics). What this suite pins:
//   • required defines RESOLVE (no more unknown-name suggestion) and TYPE-FLOW
//     (a misuse of a required value bites in THIS buffer);
//   • completions surface required names; hover renders their types;
//   • goto-def crosses files ({file, span-in-that-file});
//   • problems INSIDE a required file roll up into ONE summary on the require
//     form — never mis-spanned squiggles in this buffer;
//   • scheme-legal redefinition (in-file and program-shadows-required) never
//     errors; cycles and unresolvable paths degrade softly.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { describe, expect, it } from "vitest";

import { createSchemeLanguageService } from "../language-service.js";
import { scanRequires } from "../service-core.js";

const FILES: Record<string, string> = {
  "lib/util.scm": `(define greeting "hello")\n(define (shout s) (string-append s "!"))\n(define base-port 8080)\n(define ports (list 80 443))`,
  "lib/nested.scm": `(require "lib/util.scm")\n(define (greet-loud name) (shout (string-append greeting " " name)))`,
  "lib/broken.scm": `(define bad (car 5))\n(define worse (car 6))`,
  "lib/cycle-a.scm": `(require "lib/cycle-b.scm")\n(define from-a 1)`,
  "lib/cycle-b.scm": `(require "lib/cycle-a.scm")\n(define from-b 2)`,
};

const ls = createSchemeLanguageService({
  compilerOptions: { noImplicitAny: false },
  resolveModule: (path) => FILES[path] ?? null,
});

describe("scanRequires — the reader-true require scanner", () => {
  it("finds top-level requires with spans; ignores strings/comments/non-top", () => {
    const src = `; (require "commented.scm")\n(require "a.scm")\n(define s "(require \\"fake.scm\\")")\n(require "b.scm")`;
    const refs = scanRequires(src);
    expect(refs.map((r) => r.path)).toEqual(["a.scm", "b.scm"]);
    expect(src.slice(refs[0]!.span.start, refs[0]!.span.start + refs[0]!.span.length)).toBe(`(require "a.scm")`);
  });
});

describe("required defines in scope", () => {
  it("a required name resolves — no unknown-name suggestion, and types FLOW", () => {
    const scheme = `(require "lib/util.scm")\n(define loud (shout greeting))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  it("misusing a required value bites IN THIS BUFFER with the right span", () => {
    // NB through a BUILTIN slot: a required FUNCTION's params are `any` (the
    // same param-inference limitation as local functions — noImplicitAny off),
    // so the proof rides required VALUE types, which DO flow.
    const scheme = `(require "lib/util.scm")\n(define bad (car greeting))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    expect(scheme.slice(diags[0]!.start, diags[0]!.start + diags[0]!.length)).toBe("greeting");
    expect(diags[0]!.severity).toBe("error");
  });

  it("transitive requires resolve (nested file's own require chain)", () => {
    const scheme = `(require "lib/nested.scm")\n(define x (greet-loud "ada"))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  it("hover on a required name renders its (literal-precise) type", () => {
    const scheme = `(require "lib/util.scm")\n(define loud (shout greeting))`;
    const info = ls.getQuickInfoAtPosition(scheme, scheme.lastIndexOf("greeting") + 1);
    expect(info?.displayText).toBe(`const greeting: "hello"`);
  });

  it("required names surface in completions", () => {
    const scheme = `(require "lib/util.scm")\n(sho`;
    const names = ls.getCompletionsAtPosition(scheme, scheme.length).map((e) => e.name);
    expect(names).toContain("shout");
    expect(names).toContain("greeting");
  });
});

describe("cross-file goto-def", () => {
  it("a required name's definition carries {file, span in THAT file}", () => {
    const scheme = `(require "lib/util.scm")\n(define loud (shout greeting))`;
    const defs = ls.getDefinitionAtPosition(scheme, scheme.lastIndexOf("greeting") + 1);
    const cross = defs.find((d) => d.file !== undefined);
    expect(cross?.file).toBe("lib/util.scm");
    const target = FILES["lib/util.scm"]!;
    const text = target.slice(cross!.span!.start, cross!.span!.start + cross!.span!.length);
    expect(text).toContain("greeting"); // the define form (or its token) in util.scm
  });

  it("an in-buffer definition stays file-less", () => {
    const scheme = `(require "lib/util.scm")\n(define mine 1)\n(define two mine)`;
    const defs = ls.getDefinitionAtPosition(scheme, scheme.lastIndexOf("mine") + 1);
    expect(defs.some((d) => d.span !== null && d.file === undefined)).toBe(true);
  });
});

describe("dep problems roll up; never mis-span", () => {
  it("a broken required file → ONE summary warning ON the require form", () => {
    const scheme = `(require "lib/broken.scm")\n(define ok 1)`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.severity).toBe("warning");
    expect(scheme.slice(d.start, d.start + d.length)).toBe(`(require "lib/broken.scm")`);
    expect(d.messageText).toContain("2 type errors");
  });
});

describe("scheme-legal shapes stay legal", () => {
  it("program redefining a required name is NOT an error (shadowing)", () => {
    const scheme = `(require "lib/util.scm")\n(define greeting "hi")\n(define x (shout greeting))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  it("in-file redefinition is NOT an error", () => {
    const scheme = `(define x 1)\n(define x 2)`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  it("require cycles terminate and both sides resolve", () => {
    const scheme = `(require "lib/cycle-a.scm")\n(define s (+ from-a from-b))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  it("an unresolvable path degrades softly (names stay suggestions)", () => {
    const scheme = `(require "lib/nope.scm")\n(define x (ghost-fn 1))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("suggestion");
    expect(diags[0]!.messageText).toContain("'ghost-fn'");
    expect(diags[0]!.messageText).toContain("its `require`s");
  });
});

describe("the loop stays closed through requires", () => {
  it("Σ∩T verdicts cover REQUIRED candidates (the probe rides the closure)", () => {
    // (car •) wants a List: the required `ports` fits; the required `greeting`
    // (a string) is proven out. (A required FUNCTION'S own slots stay
    // unjudged — its params are `any`, the param-inference limitation.)
    const scheme = `(require "lib/util.scm")\n(car `;
    const ctx = ls.getCompletionContext(scheme, scheme.length);
    expect(ctx.position).toBe("argument");
    const byName = new Map(ctx.entries.map((e) => [e.name, e]));
    expect(byName.get("ports")?.fits).toBe(true);
    expect(byName.get("greeting")?.fits).toBe(false);
  });
});
