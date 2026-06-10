// completion-vocabulary — the editor's completion list speaks SCHEME.
//
// Against the REAL language service: builtins under their scheme names, the
// special forms (plugin-owned — syntax never reaches the type lens), program
// locals — and NONE of the virtual-TS substrate (JS globals, lens infra).
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { createSchemeLanguageService } from "@here.build/arrival-type-lens";
import { describe, expect, it } from "vitest";

import { schemeCompletionSource } from "../ide.js";

const source = schemeCompletionSource(createSchemeLanguageService());

const labelsAt = async (doc: string, pos: number): Promise<Set<string>> => {
  const result = await source(new CompletionContext(EditorState.create({ doc }), pos, false));
  return new Set((result?.options ?? []).map((o) => o.label));
};

describe("completion vocabulary — scheme, not the JS substrate", () => {
  it("offers builtins (real scheme names), special forms, and locals", async () => {
    const doc = `(define total 3)\n(de`;
    const labels = await labelsAt(doc, doc.length);
    for (const expected of ["define", "lambda", "cond", "car", "string-append", "odd?", "total"]) {
      expect(labels.has(expected), expected).toBe(true);
    }
  });

  it("leaks neither JS globals nor lens infrastructure", async () => {
    const doc = `(define total 3)\n(de`;
    const labels = await labelsAt(doc, doc.length);
    for (const leak of ["console", "Array", "Math", "__arr", "sexpr", "typeof", "Dict"]) {
      expect(labels.has(leak), leak).toBe(false);
    }
  });
});
