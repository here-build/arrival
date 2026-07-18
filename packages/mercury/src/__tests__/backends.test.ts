/**
 * The prompt-backend matrix: one `.prompt` → its runnable module. The committed
 * golden FILE (`improve.langchain.ts`) IS the spec — readable, diffable,
 * regenerated with `pnpm test -u` (vitest's own snapshot-update flag).
 * `improve.prompt` is the rich case (frontmatter model + `{{role}}` + a
 * `{{#each}}` loop); `predict.prompt` the simple var-only case for the focused
 * units. Stage 1 has one surviving backend (`langchain-js`) — ax/dspy/
 * langchain-py were deleted alongside the Python emitter.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getPromptBackend } from "../prompt.js";

const fixtureDir = fileURLToPath(new URL("fixtures/sources/", import.meta.url));
const read = (name: string) => readFileSync(fixtureDir + name, "utf8");

const improve = read("improve.prompt");
const predict = read("predict.prompt");

describe("prompt matrix — improve.prompt (model + role + each-loop) golden", () => {
  it("langchain-js → improve.langchain.ts", async () => {
    const m = await getPromptBackend("langchain-js").compile(improve, "improve");
    await expect(m.code).toMatchFileSnapshot("fixtures/compiled/improve.langchain.ts");
  });
});

describe("prompt matrix — module filenames are a clean stem rename, same as a .scm source gets", () => {
  it("<stem>.ts — no defensive suffix in the common case", async () => {
    expect((await getPromptBackend("langchain-js").compile(improve, "improve")).filename).toBe("improve.ts");
  });
  it("export names: inferImprove", async () => {
    expect((await getPromptBackend("langchain-js").compile(improve, "improve")).exportName).toBe("inferImprove");
  });
});

describe("prompt matrix — client modules", () => {
  it("each backend ships its endpoint module", () => {
    expect(getPromptBackend("langchain-js").client()).toMatchObject({ filename: "_llm.ts" });
  });
});

describe("prompt matrix — predict.prompt (var-only, no loop)", () => {
  it("langchain-js skips the loop pre-render when there's no each", async () => {
    const js = (await getPromptBackend("langchain-js").compile(predict, "predict")).code;
    expect(js).toContain("return chain.invoke(args);");
    expect(js).not.toContain(".map((it)");
  });
});

describe("prompt matrix — each-loop becomes a call-time pre-render", () => {
  it("langchain-js maps the array into a joined block, passes it through invoke", async () => {
    const code = (await getPromptBackend("langchain-js").compile(improve, "improve")).code;
    expect(code).toContain(
      'const failures = args.failures.map((it) => `  - ${it.input}  → expected: ${it.expected}`).join("\\n");',
    );
    expect(code).toContain("return chain.invoke({ ...args, failures });");
  });
});

describe("prompt matrix — rate.prompt (explicit input.schema: string/number/boolean)", () => {
  // The gap this whole file's other fixtures never exercised: without a declared
  // schema, every field defaults to "string" (extractInputs can't see a type in
  // `{{var}}` usage alone). A real `input.schema` — parsed via the real `dotprompt`
  // package's Picoschema support, not guessed — should thread real types all the
  // way to each backend's own idiom, not just Mercury's internal IR.
  const rate = read("rate.prompt");

  // rate.prompt's `{{#if verified}} (verified purchase){{else}} (unverified){{/if}}`
  // — a value-producing conditional, same reasoning as scheme's own `if` compiling
  // to a ternary in the CLI design thread: it only ever produces a STRING, so the
  // target's own conditional-EXPRESSION idiom is correct, not an if-statement.
  it("langchain-js reduces #if/else to a ternary, merged into invoke", async () => {
    const code = (await getPromptBackend("langchain-js").compile(rate, "rate")).code;
    expect(code).toContain("{rating} stars.{verifiedBlock}");
    expect(code).toContain("const verifiedBlock = args.verified ? ` (verified purchase)` : ` (unverified)`;");
    expect(code).toContain("chain.invoke({ ...args, verifiedBlock })");
    expect(code).not.toContain("if (");
  });
});
