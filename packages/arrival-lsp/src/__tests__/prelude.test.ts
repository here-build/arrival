// ─────────────────────────────────────────────────────────────────────────────
// Bite + merge proof for the PRE prelude.
//
// Proves the whole leaf → merge → bite chain works BEFORE the 34-way fan-out:
//   1. The empty `interface ArrShape` in PRE + the `car` member declared in a
//      SEPARATE leaf file (builtins/car.d.ts) merge into one `__arr` shape.
//   2. A well-typed call (`__arr.car([1,2,3])`) is clean (0 diagnostics) and its
//      type resolves to `number`.
//   3. An ill-typed call (`__arr.car(5)`) BITES — exactly one diagnostic.
//   4. `car` is resolved via interface declaration-merging from the LEAF file,
//      not from PRE (PRE declares it empty) — proving the merge contract the 34
//      agents rely on.
//
// We run the REAL prelude `.d.ts` files from disk through a bare
// `ts.LanguageService` over an in-memory host (the same shape the lens's MCP
// typecheck path will use). Per `.claude/rules/tests.md` this is a `__tests__/`
// verdict (boolean pass/fail).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const preludeDir = path.join(here, "..", "prelude");

const PRE = readFileSync(path.join(preludeDir, "types.d.ts"), "utf8");
const CAR_LEAF = readFileSync(path.join(preludeDir, "builtins", "car.d.ts"), "utf8");

/** Build a one-shot language service over PRE + the car leaf + one program file. */
function check(programSource: string): { diagnostics: ts.Diagnostic[] } {
  const files = new Map<string, string>([
    ["__pre.d.ts", PRE],
    ["__car.d.ts", CAR_LEAF],
    ["__program.ts", programSource],
  ]);

  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: [],
    skipLibCheck: false,
  };

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (fn) => {
      const inMem = files.get(fn);
      if (inMem !== undefined) return ts.ScriptSnapshot.fromString(inMem);
      try {
        return ts.ScriptSnapshot.fromString(readFileSync(fn, "utf8"));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => here,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (fn) => files.has(fn) || ts.sys.fileExists(fn),
    readFile: (fn) => (files.has(fn) ? files.get(fn) : ts.sys.readFile(fn)),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return { diagnostics: [...service.getSemanticDiagnostics("__program.ts")] };
}

describe("PRE prelude — bite + merge contract", () => {
  it("a well-typed (car (list …)) call is clean", () => {
    const { diagnostics } = check(`export {};\n__arr.car([1, 2, 3]);`);
    expect(diagnostics).toHaveLength(0);
  });

  it("(car (list of numbers)) resolves to number — the merged leaf signature is precise, not any", () => {
    // If car had merged as `any` (the regression we guard against), the explicit
    // `: number` annotation below would still pass; so instead we force a type
    // CONFLICT that only a precise `number` return can produce.
    const { diagnostics } = check(`export {};\nconst s: string = __arr.car([1, 2, 3]);`);
    // number is not assignable to string → exactly the bite proving precision.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe(2322);
  });

  it("an ill-typed (car 5) call BITES — exactly one diagnostic", () => {
    const { diagnostics } = check(`export {};\n__arr.car(5);`);
    expect(diagnostics).toHaveLength(1);
    // 2345: Argument of type 'number' is not assignable to parameter 'List<…>'.
    expect(diagnostics[0]!.code).toBe(2345);
    const msg = ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, "\n");
    expect(msg).toContain("not assignable");
  });

  it("car resolves via interface-merge from the LEAF file (PRE alone leaves __arr empty)", () => {
    // Without the leaf, `__arr.car` does not exist → property-access bite (2339).
    const files = new Map<string, string>([
      ["__pre.d.ts", PRE],
      ["__program.ts", `export {};\n__arr.car([1, 2, 3]);`],
    ]);
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts"],
      types: [],
    };
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...files.keys()],
      getScriptVersion: () => "1",
      getScriptSnapshot: (fn) => {
        const inMem = files.get(fn);
        if (inMem !== undefined) return ts.ScriptSnapshot.fromString(inMem);
        try {
          return ts.ScriptSnapshot.fromString(readFileSync(fn, "utf8"));
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => here,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (fn) => files.has(fn) || ts.sys.fileExists(fn),
      readFile: (fn) => (files.has(fn) ? files.get(fn) : ts.sys.readFile(fn)),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    const diags = service.getSemanticDiagnostics("__program.ts");
    // PRE alone: `car` is NOT a member of the empty ArrShape → property bite.
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe(2339);
  });

  it("the Dict mapped type + field accessor bite on a mis-keyed read", () => {
    // Exercises PRE's Dict + Field directly (no leaf needed): a precise object
    // built from entry-tuples, then a wrong-key access.
    const { diagnostics } = check(
      `export {};
type Row = Dict<[["name", string], ["age", number]]>;
declare const row: Row;
const nm: string = row.name;
const ag: number = row.age;
// @ts-expect-error — "naem" is not a key of Row
const bad = row.naem;`,
    );
    // The @ts-expect-error consumes the mis-key bite; no other diagnostics.
    expect(diagnostics).toHaveLength(0);
  });
});
