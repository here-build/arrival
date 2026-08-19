// materialize.test.ts — THE experiment, on the gguf (llama.cpp/Metal) backend.
//
// A `describe.each([mock, ...activeRoster()]) × describe.each(TASKS) × {constrained, unconstrained}`
// matrix. Per cell:
//   1. generate a Scheme program for the task (the canned mock OR a real gguf model),
//   2. run it EAGERLY through the arrival-scheme runner against the SIMULATED device,
//   3. read the recorded trace and score whether it materialized the expected action.
//
// Output: a materialize-rate table (per model, constrained vs unconstrained) — the headline number — plus
// per-task traces, written to src/__custdev-output__/.
//
// MODELS come from LM STUDIO (V's source of truth) via the roster; env `LLM_ROSTER` selects:
//   • unset (DEFAULT, CI-safe) — only the canned MOCK runs (proves the WHOLE pipeline, NO model load).
//   • "fast"     — GGUF_MODELS_FAST over a small task subset (<10 min/model), for in-motion dynamics.
//   • "full"     — GGUF_MODELS_FULL (the research-worthy set) over every task. The overnight run.
//   • "extended" — GGUF_MODELS_EXTENDED (the wildcards — can't-Q8 / curiosity) over every task.
//   • "all"      — FULL + EXTENDED.
// A roster model whose GGUF isn't downloaded in LM Studio yet LOUD-SKIPS (resolveGguf → null), never fails.
//
// Real loads/generates are wrapped in try/catch with per-cell timeouts; a failed cell → recorded as a
// skip/error, the matrix continues. A model that won't load → the whole row is skipped with a note.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolved to arrival-scheme SOURCE via the vitest alias (see vitest.custdev.config.ts) — the REAL oracle.

import { makeOracle } from "@inhuman.tools/arrival/oracle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeDeviceSim, type DeviceSim } from "../../src/runners/fixtures/apple-intents/sim.js";
import { TASKS, type Task } from "../../src/runners/fixtures/apple-intents/tasks.js";
import { buildSystemPrompt, mockGenerator } from "../harness/generators.js";
import {
  activeQuant,
  activeRoster,
  GGUF_MODELS_EXTENDED,
  GGUF_MODELS_FAST,
  GGUF_MODELS_FULL,
} from "../harness/gguf-models.js";
import { matchesQuant, quantOf, resolveGguf } from "../../src/runners/gguf/lmstudio.js";
import {
  emptyTally,
  record,
  renderTable,
  renderTraces,
  type Condition,
  type ModelReport,
} from "../harness/report.js";
import { runAndScore, validateIntendedTools, type CellResult } from "../harness/score.js";
import { LlamaModelHandle, llamaCppGenerator } from "../../src/runners/local/llama-cpp-generate.js";
import type { OracleScanner } from "../../src/oracle-types.js";
import type { SchemeGenerator } from "../../src/runners/generate.js";

const OUT_DIR = fileURLToPath(new URL("../../src/__custdev-output__/", import.meta.url));

// FAST mode caps the task matrix so each model finishes in <10 min; FULL runs every task. A const so the
// fast subset is easy to retune. The mock always runs the full set (it is instant).
const FAST_TASK_COUNT = 5;
const TASK_SET: readonly Task[] = process.env.LLM_ROSTER === "fast" ? TASKS.slice(0, FAST_TASK_COUNT) : TASKS;

// Canned scheme for the mock — one correct program per task (proves the scoring path end-to-end).
const CANNED: Record<string, string> = {
  "set a timer for 10 minutes": "(set-timer (* 10 60))",
  "text mom": '(send-message "Mom" "I will be 10 minutes late")',
  "remind me to call the dentist": '(create-reminder "call the dentist" "tomorrow 9am")',
  "do not disturb": "(set-do-not-disturb #t)",
  "play some music": "(play-music)",
  "navigate home": "(navigate-home)",
  "15% tip on 80": '(web-search "15% tip on 80")',
  "add milk to my shopping": '(add-to-list "Shopping" "milk")',
  "call dad": '(call-contact "Dad")',
  "alarm for 7am": '(set-alarm "7am")',
  flashlight: "(set-flashlight #t)",
  "running workout": '(start-workout "run")',
  "email bob": '(send-email "Bob" "Meeting" "The meeting is moved to Friday")',
  "take a photo": "(take-photo)",
};

/** The matrix rows: the canned MOCK (always — the model-free pipeline proof) + each active roster model,
 *  each resolved to its LM Studio GGUF path (undefined ⇒ not downloaded yet ⇒ the row LOUD-SKIPS). */
interface Row {
  readonly id: string;
  readonly gguf?: string;
  /** The resolved quant tag (e.g. "Q8_0"), recorded into the report so the cross-model table shows it.
   *  V runs every model at Q8; a non-Q8 resolve is flagged loudly at load (the quantization confound). */
  readonly quant?: string;
}
const ROWS: readonly Row[] = [
  { id: "mock" },
  ...activeRoster().map((m): Row => {
    const gguf = resolveGguf(m.key, activeQuant()) ?? undefined;
    return { id: m.label, gguf, quant: gguf ? quantOf(gguf) : undefined };
  }),
];

// Shared: build the Σ-live oracle ONCE per process from a representative grant env. The scanner only reads
// the env's bound-name SET + callability, identical for every fresh sim env, so one scanner serves all cells.
let SHARED_SCANNER: OracleScanner;
const SYSTEM_PROMPT = buildSystemPrompt();

beforeAll(async () => {
  const bad = validateIntendedTools();
  expect(bad, `intended-tool hint names not in registry: ${bad.join(", ")}`).toHaveLength(0);
  const sim = await makeDeviceSim();
  SHARED_SCANNER = makeOracle(sim.grant);
});

// Accumulators shared across the matrix (filled per cell, rendered in afterAll).
const reports: ModelReport[] = [];
const traceBlocks: { model: string; condition: Condition; taskId: string; prompt: string; result: CellResult }[] = [];

describe.each(ROWS)("model $id", ({ id, gguf, quant }) => {
  const real = id !== "mock";
  let gen: SchemeGenerator | undefined;
  let loadError: string | undefined;
  const report: ModelReport = {
    // Record the resolved quant alongside the model in the cross-model table (V's all-Q8 audit).
    model: quant ? `${id} (${quant})` : id,
    conditions: { constrained: emptyTally(), unconstrained: emptyTally() },
  };

  beforeAll(async () => {
    if (!real) {
      gen = mockGenerator({ canned: CANNED });
      reports.push(report);
      return;
    }
    if (gguf === undefined) {
      loadError = "GGUF not present in LM Studio — download it there to include this model";

      console.warn(`[materialize] SKIP ${id}: ${loadError}`);
      reports.push({ ...report, skipped: loadError });
      return;
    }
    if (quant !== undefined && !matchesQuant(quant, activeQuant())) {
      console.warn(
        `[materialize] ${id} resolved to ${quant}, NOT ${activeQuant()} — the requested quant isn't downloaded, ` +
          `so it fell back. Quantization will confound its cross-model comparison; download a ${activeQuant()} ` +
          `build in LM Studio to include it fairly.`,
      );
    }
    try {
      const handle = await LlamaModelHandle.load(gguf);
      gen = llamaCppGenerator(handle);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
    reports.push(loadError ? { ...report, skipped: loadError } : report);
  }, 600_000);

  describe.each(TASK_SET)("task $id", (task) => {
    for (const constrained of [false, true] as const) {
      const condition: Condition = constrained ? "constrained" : "unconstrained";

      it(`${condition}`, async () => {
        if (gen === undefined) {
          // Model failed to load / not present — record nothing per-cell; the row is already marked skipped.
          expect(loadError, "model skipped").toBeDefined();
          return;
        }

        const sim: DeviceSim = await makeDeviceSim();
        let result: CellResult;
        try {
          const program = await gen.generate(task.prompt, {
            constrained,
            scanner: constrained ? SHARED_SCANNER : undefined,
            maxNewTokens: 96,
            prefill: "(", // force a single s-expression — no markdown/prose preamble
            systemPrompt: SYSTEM_PROMPT,
          });
          result = await runAndScore(program, task, sim);
        } catch (error) {
          result = {
            program: "",
            category: "invalid",
            trace: [],
            ran: false,
            error: `cell error: ${error instanceof Error ? error.message : String(error)}`,
          };
        }

        record(report.conditions[condition], result);
        traceBlocks.push({ model: id, condition, taskId: task.id, prompt: task.prompt, result });

        // The cell itself doesn't fail on a non-materialized task (that's DATA, not a test failure) — it
        // only asserts the harness produced a categorized result. The headline is the TABLE.
        expect(result.category).toBeDefined();
      }, 120_000);
    }
  });

  afterAll(async () => {
    await gen?.dispose?.();
  });
});

afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  // Stable order: mock first, then real models alphabetically.
  const ordered = reports.toSorted((a, b) => a.model.localeCompare(b.model));
  writeFileSync(`${OUT_DIR}materialize-rate.md`, renderTable(ordered));
  writeFileSync(`${OUT_DIR}traces.md`, renderTraces(traceBlocks));
  // Echo the headline to stdout so a bare `pnpm custdev` shows the number.

  console.log(`\n${renderTable(ordered)}`);
});

// ── Model-free roster sanity (always runs, even with an empty active roster) ─────────────────────────
describe("gguf roster", () => {
  it("the full roster is well-formed (unique labels + owner/repo keys)", () => {
    const labels = GGUF_MODELS_FULL.map((m) => m.label);
    expect(new Set(labels).size, "labels are unique").toBe(labels.length);
    for (const m of GGUF_MODELS_FULL) expect(m.key, `${m.label} key is owner/repo`).toContain("/");
  });
  it("the fast roster is a subset of the full roster", () => {
    const fullKeys = new Set(GGUF_MODELS_FULL.map((m) => m.key));
    for (const m of GGUF_MODELS_FAST) expect(fullKeys.has(m.key), `${m.label} is in the full roster`).toBe(true);
  });
  it("the extended roster is well-formed + DISJOINT from full (wildcards, not research-worthy)", () => {
    const fullKeys = new Set(GGUF_MODELS_FULL.map((m) => m.key));
    for (const m of GGUF_MODELS_EXTENDED) {
      expect(m.key, `${m.label} key is owner/repo`).toContain("/");
      expect(fullKeys.has(m.key), `${m.label} is a wildcard, NOT in the full roster`).toBe(false);
    }
  });
});
