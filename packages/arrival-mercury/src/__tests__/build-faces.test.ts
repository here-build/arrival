/**
 * `inhuman build` face-contract tests — the build path's OWN gate (the 2026-07
 * audit found `buildProject`/`compileScmModule` had zero direct coverage while
 * every oracle-covered subsystem stayed clean; this file closes that gap).
 *
 * Pins the export contract per reference-program-face-always-function:
 *  - a module face's trailing expression emits `export default function Main()`
 *    — never the pre-ruling eager `export default <value>`;
 *  - a pipeline face emits `export default function run(…)` — never a
 *    post-render `export default run;` text suffix;
 *  - a requiring sibling of a `"function"`-faced default imports the function
 *    and mints ONE run-once access const (`const x = xProgram();`) — the
 *    interpreter's `require` yields the program's VALUE, so the compiled site
 *    must too (the audit's function-vs-value pipeline-require miscompile);
 *  - a `"value"`-faced default (data file) is imported and read directly;
 *  - a bound-require name RE-EXPORTS under its allocated JS identifier, never
 *    the raw scheme spelling (`export { parsed-config }` is not TS).
 *
 * Behavioral rows execute the emitted project for real: files written to a
 * scratch dir, entry imported through a namespaced tsx loader (the same
 * mechanism `oracle/harness.ts` uses, same one-registration discipline),
 * `.default()` called per the ruling.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { register } from "tsx/esm/api";
import { afterAll, describe, expect, it } from "vitest";

import { buildProject } from "../build/project.js";
import type { BuildResult } from "../build/types.js";

const SCRATCH = path.join(tmpdir(), `mercury-build-faces-${process.pid}-${randomBytes(4).toString("hex")}`);
const loader = register({ namespace: `mercury-build-faces-${process.pid}` });
let caseCounter = 0;

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function fileOf(result: BuildResult, relPath: string): string {
  const hit = result.files.find((f) => f.path === relPath);
  expect(hit, `expected build output "${relPath}" among ${result.files.map((f) => f.path).join(", ")}`).toBeDefined();
  return hit!.content;
}

/** Write the whole build output to a fresh scratch project and import one
 *  compiled entry through the tsx loader. Returns the module namespace. */
async function importBuilt(result: BuildResult, entryRelPath: string): Promise<{ default?: unknown }> {
  const dir = path.join(SCRATCH, `case-${caseCounter++}`);
  mkdirSync(dir, { recursive: true });
  // The emitted project is ESM (`import`/`export` with `.js` specifiers) — the
  // scratch dir needs the module flag or tsx resolves the files as CJS.
  writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n', "utf8");
  for (const f of result.files) {
    const target = path.join(dir, f.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.content, "utf8");
  }
  return (await loader.import(pathToFileURL(path.join(dir, entryRelPath)).href, import.meta.url)) as { default?: unknown };
}

describe("build faces (program-face-always-function)", () => {
  it("module face: trailing expression emits `export default function Main()`, callable, correct value", async () => {
    // Forced module classification: the default classifier calls a DAG-root
    // with a program face a pipeline; the module-face trailing-expression
    // shape needs an explicit classifier (as `build.classifier` configs do).
    const result = await buildProject({ "mod.scm": "(define (double x) (* x 2))\n(double 21)\n" }, { classifyFile: () => "module" });
    const code = fileOf(result, "mod.ts");
    expect(code).toContain("export default function Main()");
    expect(code).not.toMatch(/export default \w+;/); // the pre-ruling eager-binding suffix
    const ns = await importBuilt(result, "mod.ts");
    expect(typeof ns.default).toBe("function");
    expect((ns.default as () => unknown)()).toBe(42);
  });

  it("pipeline face: exports `export default function run(…)`, no post-render suffix", async () => {
    const result = await buildProject({
      "lib.scm": "(define (helper x) (+ x 1))\n",
      "main.scm": '(require "lib.scm")\n(helper 41)\n',
    });
    const code = fileOf(result, "main.ts");
    expect(code).toMatch(/export default function run\(/);
    expect(code).not.toContain("export default run;");
    const ns = await importBuilt(result, "main.ts");
    expect((ns.default as (p?: object) => unknown)()).toBe(42);
  });

  it("bound require of a function-faced sibling binds its VALUE via a run-once access const", async () => {
    // lib2 is required (non-root) => module face with a program face; main2 is
    // the DAG root with a program face => pipeline. The audit's miscompile
    // bound the sibling's FUNCTION where the interpreter yields its VALUE.
    const result = await buildProject({
      "lib2.scm": "(define base 2)\n(* base 21)\n",
      "main2.scm": '(define result (require "lib2.scm"))\n(+ result 1)\n',
    });
    const lib = fileOf(result, "lib2.ts");
    expect(lib).toContain("export default function Main()");
    const main = fileOf(result, "main2.ts");
    expect(main).toContain('import { default as resultProgram } from "./lib2.js"');
    expect(main).toContain("const result = resultProgram()");
    const ns = await importBuilt(result, "main2.ts");
    expect((ns.default as (p?: object) => unknown)()).toBe(43);
  });

  it("bound require of a data file (value face) reads the import directly and re-exports its allocated JS name", async () => {
    const result = await buildProject({
      "config.json": '{ "x": 7 }\n',
      "lib3.scm": '(define parsed-config (require "config.json"))\n(define (config-x) parsed-config)\n',
      "main3.scm": '(require "lib3.scm")\n(config-x)\n',
    });
    const lib = fileOf(result, "lib3.ts");
    // Value face: direct import binding, never called.
    expect(lib).toContain('import { default as parsedConfig } from "./config.js"');
    expect(lib).not.toContain("parsedConfig()");
    // The audit's kebab bug: the bound name must re-export as its allocated JS
    // identifier — `export { parsed-config }` is not compilable TypeScript.
    expect(lib).not.toContain("parsed-config }");
    expect(lib).toMatch(/export \{[^}]*\bparsedConfig\b[^}]*\}/);
    const ns = await importBuilt(result, "main3.ts");
    expect((ns.default as (p?: object) => unknown)()).toEqual({ x: 7 });
  });

  it("ExportShape carries the face kind: scm defaults are functions, data defaults are values", async () => {
    // Structural pin of the contract bit itself (consumed by the require
    // machinery): rebuilding the same projects, the emitted CONSUMPTION shapes
    // are the observable — a call for a program face, a bare read for data.
    const result = await buildProject({
      "data.json": "[1, 2, 3]\n",
      "prog.scm": "(list 1 2 3)\n",
      "entry.scm": '(define d (require "data.json"))\n(define p (require "prog.scm"))\n(list d p)\n',
    });
    const entry = fileOf(result, "entry.ts");
    expect(entry).toContain("const p = pProgram()");
    expect(entry).not.toContain("const d = dProgram");
    const ns = await importBuilt(result, "entry.ts");
    expect((ns.default as (p?: object) => unknown)()).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
  });
});
