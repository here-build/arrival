// fc-fence-probe.test.ts — for the markdown-fence steer: does a model open a ``` code block, and what
// LANGUAGE TAG / continuation does it want? We force a canonical "```scheme\n" — this checks that's right
// (vs "```lisp", vs a dialect like "```scheme+r7rs"). UNCONSTRAINED (constrained:false) so we observe the
// model's NATURAL output (the fence steer is gated on constrained → off here). Run:
//   LLM_ROSTER=full pnpm exec vitest run --config vitest.custdev.config.ts src/__custdev__/fc-fence-probe.test.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import { buildSystemPrompt } from "../harness/generators.js";
import { activeQuant, activeRoster } from "../harness/gguf-models.js";
import { LlamaModelHandle, llamaCppGenerator } from "../../src/runners/local/llama-cpp-generate.js";
import { quantOf, resolveGguf } from "../../src/runners/gguf/lmstudio.js";

const OUT_DIR = fileURLToPath(new URL("./__fc-output__/", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });
const OUT_FILE = `${OUT_DIR}fence-probe.txt`;

const TASK = "set a timer for 10 minutes";
const SYS = `${buildSystemPrompt()}\n\nRespond with a SINGLE Scheme tool call, e.g. (set-timer 600).`;
// "" = the model's own opener (does it reach for a fence?). The two fence prefills check what it writes AFTER
// being given a language tag — a dialect suffix? a second fence? straight to the call?
const PREFILLS = ["", "```lisp\n", "```scheme\n"];

const report: string[] = [];
const ROSTER = activeRoster();
if (ROSTER.length === 0) {
  describe("fence probe", () => {
    it.skip("no LLM_ROSTER selected — run with LLM_ROSTER=full", () => undefined);
  });
}

describe.each(ROSTER)("fence probe — $label", (model) => {
  it(
    "what the model opens / continues after a fence tag",
    async () => {
      const gguf = resolveGguf(model.key, activeQuant());
      if (!gguf) return;
      const handle = await LlamaModelHandle.load(gguf);
      const gen = llamaCppGenerator(handle);
      const lines = [`### ${model.label} [${quantOf(gguf)}]`];
      try {
        for (const prefill of PREFILLS) {
          await gen.generate(TASK, { constrained: false, prefill, maxNewTokens: 18, systemPrompt: SYS });
          const raw = gen.telemetry.rawDecode ?? "";
          lines.push(`  prefill=${JSON.stringify(prefill).padEnd(14)} → ${JSON.stringify(raw.slice(0, 70))}`);
        }
      } finally {
        await gen.dispose?.();
      }
      report.push(lines.join("\n"));
      writeFileSync(OUT_FILE, report.join("\n\n"));
      // eslint-disable-next-line no-console
      console.error(lines.join("\n"));
    },
    300_000,
  );
});
