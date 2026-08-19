// fc-envelope-run.test.ts — a LIVE "see what breaks" run of the FC envelope: drive a real model through
// the execute-scheme tool-call FSM on a few apple-intents tasks and log the generated envelope + the
// observe-first breakage report (escape hazards / forced-literal round-trip misses / stop reason).
//
// NOT a pass/fail gate — it exists to surface what the first real run does. Run it directly:
//   pnpm exec vitest run --config vitest.custdev.config.ts src/__custdev__/fc-envelope-run.test.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { makeOracle } from "@inhuman.tools/arrival/oracle";
import { describe, it } from "vitest";

import { makeDeviceSim } from "../../src/runners/fixtures/apple-intents/sim.js";
import { buildSystemPrompt } from "../harness/generators.js";
import { EXECUTE_SCHEME_TOOL, exprHazards } from "../../src/runners/local/fc-envelope.js";
import { LlamaModelHandle, llamaCppGenerator } from "../../src/runners/local/llama-cpp-generate.js";
import { resolveGguf } from "../../src/runners/gguf/lmstudio.js";

// vitest's worker pool swallows console.*; write the run report to a sibling __fc-output__/ dir (gitignored,
// per .claude/rules/tests.md) so it can be read after — portable, no session-specific path.
const OUT_DIR = fileURLToPath(new URL("./__fc-output__/", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });
const OUT_FILE = `${OUT_DIR}fc-run-output.txt`;

const TASKS = [
  "set a timer for 10 minutes",
  "text mom that I will be 10 minutes late",
  "navigate home",
  "what is the airspeed velocity of an unladen swallow", // no matching tool — does the model abstain/flail?
];

describe("fc-envelope LIVE run — see what breaks", () => {
  it(
    "generates execute-scheme FC calls for sample tasks",
    async () => {
      const gguf =
        resolveGguf("Mungert/Arch-Agent-1.5B-GGUF") ?? resolveGguf("essentialai/rnj-1") ?? resolveGguf("qwen/qwen3-8b");
      if (!gguf) {
        console.error("[fc-run] no model available in LM Studio — skipping"); // eslint-disable-line no-console
        return;
      }
      console.error(`[fc-run] model: ${gguf}`); // eslint-disable-line no-console
      const handle = await LlamaModelHandle.load(gguf);
      const sim = await makeDeviceSim();
      const scanner = makeOracle(sim.grant);
      const gen = llamaCppGenerator(handle);
      const systemPrompt =
        `${buildSystemPrompt()}\n\n` +
        `Respond with a SINGLE tool call to the "${EXECUTE_SCHEME_TOOL}" tool. Its arguments are ` +
        `{ "intent": <what you are doing>, "expr": <a Scheme program using the device functions> }.`;
      const report: string[] = [`model: ${gguf}\n`];
      try {
        for (const task of TASKS) {
          const out = await gen.generate(task, {
            fcEnvelope: true,
            scanner,
            constrained: true,
            maxNewTokens: 160,
            systemPrompt,
          });
          // Analyse: is the envelope valid JSON? what's expr? what escape hazards does it carry?
          const inner = out.replace(/^<tool_call>\n?/, "").replace(/\n?<\/tool_call>\s*$/, "");
          let parsed: unknown = null;
          let parseErr = "";
          try {
            parsed = JSON.parse(inner);
          } catch (e) {
            parseErr = e instanceof Error ? e.message : String(e);
          }
          const expr = (parsed as { arguments?: { expr?: string } } | null)?.arguments?.expr;
          const haz = typeof expr === "string" ? exprHazards(expr) : [];
          report.push(
            `=== TASK: ${task} ===`,
            `RAW: ${JSON.stringify(out)}`,
            `valid-json: ${parseErr ? `NO (${parseErr})` : "yes"}`,
            `expr: ${JSON.stringify(expr ?? null)}`,
            `expr-hazards: ${haz.length} ${JSON.stringify(haz.slice(0, 10))}`,
            "",
          );
        }
      } finally {
        await gen.dispose?.();
        writeFileSync(OUT_FILE, report.join("\n"));
      }
    },
    900_000,
  );
});
