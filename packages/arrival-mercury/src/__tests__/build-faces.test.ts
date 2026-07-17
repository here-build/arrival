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
 *
 * Each case's source project is a REAL fixture directory under
 * `fixtures/build-faces/<case-name>/` (mirrors gate3's fs-based fixtures) —
 * `readProject` reads it recursively into the `Record<string,string>` shape
 * `buildProject` takes. No inline scheme/JSON strings in this file.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { register } from "tsx/esm/api";
import { afterAll, describe, expect, it } from "vitest";

import { buildProject } from "../build/project.js";
import type { BuildResult } from "../build/types.js";

const SCRATCH = path.join(tmpdir(), `mercury-build-faces-${process.pid}-${randomBytes(4).toString("hex")}`);
const loader = register({ namespace: `mercury-build-faces-${process.pid}` });
let caseCounter = 0;

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/build-faces", import.meta.url));

/** Read a fixture project directory recursively into the
 *  `{ relPath: content }` shape `buildProject` takes — posix-style relative
 *  paths regardless of host OS. */
function readProject(caseName: string): Record<string, string> {
  const root = path.join(FIXTURES_DIR, caseName);
  const files: Record<string, string> = {};
  const walk = (relDir: string) => {
    for (const entry of readdirSync(path.join(root, relDir), { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
      } else {
        files[relPath] = readFileSync(path.join(root, relPath), "utf8");
      }
    }
  };
  walk("");
  return files;
}

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
    const result = await buildProject(readProject("module-face-trailing-expression"), { classifyFile: () => "module" });
    const code = fileOf(result, "mod.ts");
    expect(code).toContain("export default function Main()");
    expect(code).not.toMatch(/export default \w+;/); // the pre-ruling eager-binding suffix
    const ns = await importBuilt(result, "mod.ts");
    expect(typeof ns.default).toBe("function");
    expect((ns.default as () => unknown)()).toBe(42);
  });

  it("pipeline face: exports `export default function run(…)`, no post-render suffix", async () => {
    const result = await buildProject(readProject("pipeline-face-no-suffix"));
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
    const result = await buildProject(readProject("bound-require-function-face"));
    const lib = fileOf(result, "lib2.ts");
    expect(lib).toContain("export default function Main()");
    const main = fileOf(result, "main2.ts");
    expect(main).toContain('import { default as resultProgram } from "./lib2.js"');
    expect(main).toContain("const result = resultProgram()");
    const ns = await importBuilt(result, "main2.ts");
    expect((ns.default as (p?: object) => unknown)()).toBe(43);
  });

  it("bound require of a data file (value face) reads the import directly and re-exports its allocated JS name", async () => {
    const result = await buildProject(readProject("bound-require-value-face"));
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

  it("flow-up knobs from same-basename modules stay DISTINCT (path-qualified on double collision)", async () => {
    // `a/metric.scm` and `b/metric.scm` both alias `metric` (basename-only),
    // so with the entry's own local `threshold` taking the bare name, both
    // used to flow up as ONE `metric.threshold` — a caller param setting two
    // distinct upstream knobs at once. The second collision must escalate to
    // the path-qualified key.
    const result = await buildProject(readProject("flow-up-knobs-distinct"));
    const main = fileOf(result, "main.ts");
    const keys = [...main.matchAll(/inhumanParams\["([^"]+)"\]/g)].map((m) => m[1]);
    const uniqueNamespaced = new Set(keys.filter((k) => k !== "threshold"));
    expect(uniqueNamespaced.size).toBe(2); // two distinct exposed keys, never one shared
    expect(uniqueNamespaced).toEqual(new Set(["metric.threshold", "b.metric.threshold"]));
    const ns = await importBuilt(result, "main.ts");
    expect((ns.default as (p?: object) => unknown)()).toEqual([0, 1, 2]);
  });

  it("ExportShape carries the face kind: scm defaults are functions, data defaults are values", async () => {
    // Structural pin of the contract bit itself (consumed by the require
    // machinery): rebuilding the same projects, the emitted CONSUMPTION shapes
    // are the observable — a call for a program face, a bare read for data.
    const result = await buildProject(readProject("export-shape-face-kind"));
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
