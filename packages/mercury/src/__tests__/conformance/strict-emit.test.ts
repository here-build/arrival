/**
 * The strict gate (design doc R7, corpus mechanics): EVERY emitted corpus
 * artifact typechecks under `tsc --strict`, STANDALONE, with zero errors — "an
 * artifact that needs a human touch-up before `tsc` passes is a compiler bug,
 * definitionally." Runs the real TypeScript compiler in-process over each
 * compiled program, per strategy (the W4 axis), plus its runtime contract:
 *
 *  - `ts-vercel-ai` (W4, real imports): the artifact's `import { generateText,
 *    generateObject, type ModelMessage } from "ai"` resolves against the REAL
 *    pinned package (`ai` is a devDependency of this package at the same version
 *    `DEP_VERSIONS` pins into emitted manifests), and `./runtime/llm.js` resolves
 *    against the REAL emitted `rt/client-module` module
 *    (`vercelRuntimeLlmModule()`, written into the scratch dir).
 *  - `ts-langchain` (W5, real imports): the same move — `import { HumanMessage,
 *    ... } from "@langchain/core/messages"` resolves against the REAL pinned
 *    `@langchain/core` devDependency, and `./runtime/llm.js` resolves against
 *    `langchainRuntimeLlmModule()`'s real emitted module (itself importing the
 *    real `@langchain/openai` devDependency).
 *
 * Both are strictly stronger than an ambient d.ts stand-in: the gate proves each
 * strategy's emission against the actual API surface it will meet at install
 * time. No AMBIENT bare-global block remains — the pre-registry placeholder
 * (`infer`/`inferChat`/... as bare globals) is fully retired now that every
 * strategy emits real runtime imports.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import { projectToJs } from "../../project.js";
import { langchainRuntimeLlmModule } from "../../rt-langchain.js";
import { vercelRuntimeLlmModule } from "../../rt-vercel-ai.js";
import { STRATEGIES } from "../../strategy/index.js";
import { ROWS, STRATEGY_IDS } from "./support/rows.js";

const corpusDir = fileURLToPath(new URL("corpus/", import.meta.url));
const read = (name: string): string => readFileSync(`${corpusDir}${name}`, "utf8");

const tmpDir = fileURLToPath(new URL(".tmp-strict/", import.meta.url));

/** Node's `process.env` for the scratch `runtime/llm.ts` (both strategies' client
 *  modules read it) — a plain ambient SCRIPT (no import/export, so the
 *  declaration is global; see `strict-emit-langchain.test.ts`'s doc comment for
 *  why a `declare module`/`declare const` block must stay import/export-free to
 *  behave as a GLOBAL ambient declaration rather than a local augmentation
 *  attempt — confirmed empirically against this package's pinned
 *  `typescript@6.0.2`): the strict gate's `ts.createProgram` resolves
 *  `@types/node` auto-inclusion from the process cwd, which under a vitest
 *  worker isn't reliably this package's root — a 1-line ambient beats a
 *  cwd-sensitive typeRoots dance for one identifier. */
const NODE_AMBIENT = `declare const process: { env: Record<string, string | undefined> };
`;

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  // A corpus artifact with no imports is still a MODULE (in a real emitted
  // project it always has import/export context by construction) — force module
  // detection so top-level await checks under the module rules.
  moduleDetection: ts.ModuleDetectionKind.Force,
  // zod's / ai's own dist types are the library's concern, not the artifact's.
  skipLibCheck: true,
};

/** All pre-emit diagnostics of the given root files, rendered `line:col message`. */
function strictDiagnostics(rootFiles: string[]): string[] {
  const program = ts.createProgram(rootFiles, OPTIONS);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start !== undefined) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      return `${path.basename(d.file.fileName)}:${line + 1}:${character + 1} ${msg}`;
    }
    return msg;
  });
}

describe("mercury conformance — every emitted artifact is tsc-strict clean (R7)", () => {
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe.each(STRATEGY_IDS)("strategy: %s", (strategyId) => {
    const strategy = STRATEGIES[strategyId];
    // Per-strategy scratch subdir: the two strategies' artifacts for the same row
    // must not overwrite each other, and ts-vercel-ai's runtime/ module must not
    // leak into ts-langchain's resolution space.
    const strategyDir = `${tmpDir}${strategyId}/`;

    it.each(ROWS)("$name", async ({ file }) => {
      mkdirSync(`${strategyDir}runtime/`, { recursive: true });
      const artifact = await projectToJs(read(file), { target: "run", strategy });
      const artifactPath = `${strategyDir}${file.replace(/\.scm$/, "")}.strict.ts`;
      writeFileSync(artifactPath, artifact, "utf8");
      const roots = [artifactPath];
      // The REAL rt/client-module the artifact's `./runtime/llm.js` resolves to,
      // plus the 1-line `process` ambient it needs (see NODE_AMBIENT's doc) —
      // one per strategy, same move, different real package underneath.
      const llm = strategyId === "ts-vercel-ai" ? vercelRuntimeLlmModule() : langchainRuntimeLlmModule();
      const llmPath = `${strategyDir}${llm.filename}`;
      const nodeAmbientPath = `${strategyDir}ambient-node.d.ts`;
      writeFileSync(llmPath, llm.code, "utf8");
      writeFileSync(nodeAmbientPath, NODE_AMBIENT, "utf8");
      roots.push(llmPath, nodeAmbientPath);
      expect(strictDiagnostics(roots), `--- artifact ---\n${artifact}`).toEqual([]);
    });
  });
});
