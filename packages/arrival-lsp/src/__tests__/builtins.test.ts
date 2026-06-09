// Consolidated bite guard for the whole builtin set.
//
// Every leaf's `<slug>.cases.ts` ships `good` snippets (must type-check clean)
// and `bad` snippets (must each produce a diagnostic). This runner compiles each
// snippet against PRE + ALL builtin leaves merged into `ArrShape`, so it proves
// two things at once across the entire fan-out:
//   1. all leaves merge with no cross-leaf conflict (the program builds), and
//   2. no signature regressed to `any` — every `bad` snippet still BITES, every
//      `good` snippet stays clean.
// A loose `(...args:any[])=>any` leaf is caught here: its `bad` snippet stops biting.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const preludeDir = path.join(here, "..", "prelude");
const builtinsDir = path.join(preludeDir, "builtins");

const PRE = readFileSync(path.join(preludeDir, "types.d.ts"), "utf8");
const leafFiles = readdirSync(builtinsDir).filter((f) => f.endsWith(".d.ts") && !f.startsWith("_"));
const LEAVES = leafFiles.map((f) => readFileSync(path.join(builtinsDir, f), "utf8"));

/** Compile one snippet against PRE + every merged leaf; return semantic diagnostics. */
function check(programSource: string): ts.Diagnostic[] {
  const files = new Map<string, string>([["__pre.d.ts", PRE]]);
  LEAVES.forEach((src, i) => files.set(`__leaf${i}.d.ts`, src));
  files.set("__program.ts", programSource);

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
  return [...service.getSemanticDiagnostics("__program.ts")];
}

const msg = (d: ts.Diagnostic[]): string =>
  d.map((x) => ts.flattenDiagnosticMessageText(x.messageText, "\n")).join(" | ");

const caseFiles = readdirSync(builtinsDir).filter((f) => f.endsWith(".cases.ts"));

describe("builtins — every leaf bites (good clean / bad errors) across the merged set", () => {
  it("found the full fan-out", () => {
    expect(leafFiles.length).toBeGreaterThanOrEqual(34);
    expect(caseFiles.length).toBeGreaterThanOrEqual(33);
  });

  for (const cf of caseFiles) {
    const slug = cf.replace(".cases.ts", "");
    it(`${slug}: good snippets clean, bad snippets bite`, async () => {
      const mod = (await import(pathToFileURL(path.join(builtinsDir, cf)).href)) as {
        cases?: { good: string[]; bad: string[] };
        default?: { good: string[]; bad: string[] };
      };
      const cases = mod.cases ?? mod.default;
      expect(cases, `${cf} must export \`cases\``).toBeDefined();

      for (const good of cases!.good) {
        const d = check(good);
        expect(d, `GOOD must be clean: ${good}\n  → ${msg(d)}`).toHaveLength(0);
      }
      for (const bad of cases!.bad) {
        const d = check(bad);
        expect(d.length, `BAD must bite (regressed to any?): ${bad}`).toBeGreaterThan(0);
      }
    });
  }
});
