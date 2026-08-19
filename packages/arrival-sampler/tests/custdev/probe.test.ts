// probe.test.ts — the reusable DEBUG entry for "what does model M want at decode point P?". Env-configured
// so any such question (cross-model) is one command, no new script:
//   LLM_ROSTER=full LLM_ONLY=glm-4.7 PROBE_PREFILL="(call" PROBE_BRANCH=14 \
//     pnpm exec vitest run --config vitest.custdev.config.ts src/__custdev__/probe.test.ts
// Prints, per model: the greedy BRANCH from the point, then per step the picked token (+ its rank in the
// model's own preference) and the top also-valid / masked-but-wanted alternatives. Output also in __fc-output__.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { makeOracle } from "@inhuman.tools/arrival/oracle";
import { describe, it } from "vitest";

import { makeDeviceSim } from "../../src/runners/fixtures/apple-intents/sim.js";
import { buildSystemPrompt } from "../harness/generators.js";
import { activeRoster } from "../harness/gguf-models.js";
import { LlamaModelHandle } from "../../src/runners/local/llama-cpp-generate.js";
import { formatStep, probeModel } from "../../src/runners/local/probe.js";
import { resolveGguf } from "../../src/runners/gguf/lmstudio.js";

const OUT_DIR = fileURLToPath(new URL("./__fc-output__/", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = process.env.PROBE_PROMPT ?? "set a timer for 10 minutes";
const PREFILL = process.env.PROBE_PREFILL ?? "";
const BRANCH = Number(process.env.PROBE_BRANCH ?? "14");
const SYS = `${buildSystemPrompt()}\n\nRespond with a SINGLE Scheme tool call.`;

const report: string[] = [];
const ROSTER = activeRoster();
if (ROSTER.length === 0) {
  describe("probe", () => {
    it.skip("no LLM_ROSTER selected — run with LLM_ROSTER=full (+ optional LLM_ONLY)", () => undefined);
  });
}

describe.each(ROSTER)("probe — $label", (model) => {
  it(
    `distribution + branch at prefill=${JSON.stringify(PREFILL)}`,
    async () => {
      const gguf = resolveGguf(model.key);
      if (!gguf) return;
      // Σ over the apple-intents device env (the real bound symbols) unless PROBE_STRUCTURAL=1 (structural-only).
      let scanner;
      if (process.env.PROBE_STRUCTURAL === "1") {
        scanner = makeOracle();
      } else {
        const sim = await makeDeviceSim();
        scanner = makeOracle(sim.grant);
      }
      await using handle = await LlamaModelHandle.load(gguf);
      const { steps, text } = await probeModel(handle, {
        prompt: PROMPT,
        systemPrompt: SYS,
        prefill: PREFILL,
        branchSteps: BRANCH,
        scanner,
      });
      const block = [
        `### ${model.label} · prefill=${JSON.stringify(PREFILL)}  →  branch=${JSON.stringify(text)}`,
        ...steps.map(formatStep),
      ].join("\n");
      report.push(block);
      writeFileSync(`${OUT_DIR}probe.txt`, report.join("\n\n"));
      // eslint-disable-next-line no-console
      console.error(block);
    },
    300_000,
  );
});
