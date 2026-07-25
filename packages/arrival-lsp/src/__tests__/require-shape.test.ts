// require-shape — `(require "data.json")` resolves to its GRANULAR shape, not
// `unknown`. The editor twin of the runtime loader registry: the lens is fed a
// `resolveRequireType` seam derived from the SAME `defaultResolvers()` the
// runtime parses with (via arrival-chain's `resolveRequireType`), so a data
// file's `(require)` hovers/checks as its precise object/list type.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { resolveRequireType } from "@inhuman.tools/arrival/capabilities/loader";
import { loaderFromResolver } from "@inhuman.tools/llm-plane-arrival-chain";
import { describe, expect, it } from "vitest";

import { assembleHostPrelude } from "../host-prelude.js";
import { createSchemeLanguageService } from "../language-service.js";

// The project's data files, keyed by require path → raw source. The host
// (studio) holds these; here a tiny in-memory map stands in.
const FILES: Record<string, string> = {
  "personas.json": `[{"name":"Ada","age":36}]`,
  "config.yaml": `title: Hi\ncount: 3`,
};

// The seam studio synthesizes: route each file's source through the loader
// registry — the SAME registry the runtime resolves with — to a TS type string.
const loader = loaderFromResolver((p) => FILES[p] ?? null);
// `require` must be a HOST MEMBER for the emitter to lower `(require …)` →
// `require(…)` (a bare `require` would resolve to Node's global → any).
// In studio this comes from `rosettaTypesOf(env)`; here a one-entry roster.
const host = assembleHostPrelude([["require", "(specifier: SStr): unknown"]]);
const ls = createSchemeLanguageService({
  compilerOptions: { noImplicitAny: false },
  host,
  resolveModule: (p) => FILES[p] ?? null,
  resolveRequireType: (p) => (FILES[p] === undefined ? null : resolveRequireType(loader, p, FILES[p]!)),
});

describe("(require data-file) → granular shape", () => {
  it("a required .json hovers as its precise list-of-object shape", () => {
    const scheme = `(define personas (require "personas.json"))\n(car personas)`;
    const at = scheme.lastIndexOf("personas") + 1; // body occurrence (token-mapped)
    const info = ls.getQuickInfoAtPosition(scheme, at);
    expect(info).not.toBeNull();
    expect(info!.displayText).toContain("name");
    expect(info!.displayText).toContain("age");
  });

  it("a required .yaml resolves its object shape too", () => {
    const scheme = `(define cfg (require "config.yaml"))\n(car (list cfg))`;
    const at = scheme.lastIndexOf("cfg") + 1;
    const info = ls.getQuickInfoAtPosition(scheme, at);
    expect(info).not.toBeNull();
    expect(info!.displayText).toContain("title");
    expect(info!.displayText).toContain("count");
  });

  it("misusing a field's type bites — the shape is real, not unknown", () => {
    // `age` is number; passing it where a list is expected (`car`) must error,
    // proving the field type flows (an `unknown` require would NOT bite).
    const scheme = `(define personas (require "personas.json"))\n(car (@ (car personas) "age"))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags.length).toBeGreaterThan(0);
  });

  it("an unmapped require stays unknown — no overload, no false shape", () => {
    const scheme = `(define x (require "mystery.bin"))\n(car (list x))`;
    const at = scheme.lastIndexOf("x") + 1;
    const info = ls.getQuickInfoAtPosition(scheme, at);
    // No shape pushed for .bin → require stays `unknown`; no crash, no overload.
    expect(info?.displayText ?? "").not.toContain("name");
  });
});
