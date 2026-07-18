/**
 * Project assembly — the end-to-end step. `compileProject` turns a flat source map
 * into a runnable TS directory for a given prompt backend. These are STRUCTURAL
 * tests (right files, right names, runnable glue); the actual execution against a
 * live endpoint is a manual/__custdev__ run, not a CI gate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileProject } from "../compile-project.js";

const fixtureDir = fileURLToPath(new URL("fixtures/sources/", import.meta.url));
const fx = (name: string): string => readFileSync(fixtureDir + name, "utf8");

const FILES: Record<string, string> = {
  "gepa.scm": fx("gepa.scm"),
  "metric.scm": fx("metric.scm"),
  "predict.prompt": fx("predict.prompt"),
  "improve.prompt": fx("improve.prompt"),
  "examples.json": '[{ "id": 1, "input": "hello", "expected": "HELLO" }]\n',
  "seed.txt": "Echo the input.\n",
};

const BRIEF: Record<string, string> = {
  "brief.scm": fx("brief.scm"),
  "summarize.prompt": fx("summarize.prompt"),
};

const TRIAGE: Record<string, string> = {
  "triage.scm": fx("triage.scm"),
  "classify.prompt": fx("classify.prompt"),
  "billing.prompt": fx("billing.prompt"),
  "general.prompt": fx("general.prompt"),
};

const pathsOf = (files: { path: string }[]): string[] => files.map((f) => f.path).sort();

describe("compileProject — js + langchain-js", () => {
  it("assembles a tsx-runnable TS project, specifiers + data imports rewritten", async () => {
    const files = await compileProject(FILES, "gepa.scm", {});
    const paths = pathsOf(files);
    expect(paths).toContain("main.ts");
    expect(paths).toContain("metric.ts");
    expect(paths).toContain("predict.ts");
    expect(paths).toContain("_llm.ts");
    expect(paths).toContain("package.json");

    const gepa = files.find((f) => f.path === "main.ts")!.content;
    expect(gepa).toContain('from "./metric.js"'); // .scm → .js
    expect(gepa).toContain('from "./predict.js"'); // .prompt → .js too, same clean swap
    expect(gepa).toContain("__readText("); // .txt import → readFileSync
    expect(gepa).toContain('with { type: "json" }'); // .json import attribute
    expect(gepa).toContain("console.log"); // entry result surfaced

    expect(files.find((f) => f.path === "metric.ts")!.content).toContain("export { metric };"); // spilled module exported
    expect(files.find((f) => f.path === "package.json")!.content).toContain("tsx");
  });
});

describe("compileProject — brief.scm (the simple end: one prompt, no loop)", () => {
  it("js + langchain-js", async () => {
    const files = await compileProject(BRIEF, "brief.scm", {});
    const paths = pathsOf(files);
    expect(paths).toContain("main.ts");
    expect(paths).toContain("summarize.ts");
    expect(paths).toContain("_llm.ts");
    expect(paths).toContain("package.json");

    const main = files.find((f) => f.path === "main.ts")!.content;
    expect(main).toContain('from "./summarize.js"');
    expect(main).toContain("console.log");
  });
});

describe("compileProject — triage.scm (branching: classify then route to one of two prompts)", () => {
  it("js + langchain-js", async () => {
    const files = await compileProject(TRIAGE, "triage.scm", {});
    const paths = pathsOf(files);
    expect(paths).toContain("main.ts");
    expect(paths).toContain("classify.ts");
    expect(paths).toContain("billing.ts");
    expect(paths).toContain("general.ts");
    expect(paths).toContain("_llm.ts");

    const main = files.find((f) => f.path === "main.ts")!.content;
    expect(main).toContain('from "./classify.js"');
    expect(main).toContain('from "./billing.js"');
    expect(main).toContain('from "./general.js"');
    // A value-producing `if` lowers to a ternary, not an if-statement — JS's `if`
    // is statement-only, and a ternary is what a person would write here too
    // (compile for humans: pick the idiom the target's own expressiveness affords,
    // not a mechanical if-statement-plus-reassignment translation).
    expect(main).toContain('"billing"');
    expect(main).toMatch(/\?[\s\S]*handleBilling[\s\S]*:[\s\S]*handleGeneral/);
    expect(main).not.toContain("if (");
  });
});

describe("compileProject — guards", () => {
  it("rejects a .scm and .prompt sharing a stem instead of silently overwriting one", async () => {
    // Both a clean rename (no defensive suffix) — the entry itself can't hit this
    // (it always renames to "main"), so the collision needs a NON-entry .scm.
    const collision: Record<string, string> = {
      "app.scm": `(require "predict.scm")\n(define ask (require "predict.prompt"))\n(ask (list "x") :x "x")`,
      "predict.scm": `(define helper 1)`,
      "predict.prompt": fx("predict.prompt"),
    };
    await expect(compileProject(collision, "app.scm", {})).rejects.toThrow(
      /"predict\.prompt" and "predict\.scm" both compile to "predict\.ts"/,
    );
  });
});
