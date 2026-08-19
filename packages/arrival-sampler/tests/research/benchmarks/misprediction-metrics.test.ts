// misprediction-metrics.test.ts — wire the constrained decoder to a real model and record per-token
// mispredictions (what the model's argmax WANTED before the oracle vetoed it). Per .claude/rules/tests.md
// this is __research__: a knowledge artifact (JSON + markdown in __research-output__/), opt-in via
// `pnpm research`.
//
// MODES (env METRICS_MODE):
//   • "mock"  (DEFAULT, CI-safe) — pure fixtures: the classifier, the arity analyzer, the aggregator, and
//             ONE toy-vocab recordStepMetric exercise (driven through the shared kernel, no model). No
//             download, validates the whole metric-collection logic.
//   • "smoke" — the Q4_K_M GGUF (llama.cpp/Metal) on the first 3 tasks (proves the tap fires against a real
//             generate loop).
//   • "real"  — the GGUF over all tasks. The overnight run.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolved to arrival-scheme SOURCE via the vitest alias (see vitest.research.config.ts) — the REAL oracle.

import { makeOracle } from "@inhuman.tools/arrival/oracle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeDeviceSim } from "../../../src/runners/fixtures/apple-intents/sim.js";
import { TASKS } from "../../../src/runners/fixtures/apple-intents/tasks.js";
import { resolveGguf } from "../../../src/runners/gguf/lmstudio.js";
import { classifyCandidate, trailingAtom } from "../../../src/mask-compiler.js";
import type { OracleScanner } from "../../../src/oracle-types.js";
import { selectConstrainedStep } from "../../../src/select-constrained-step.js";
import { buildNamespacedApplePrompt, makeNamespacedAppleEnv, namespacedAppleTools } from "../../../src/runners/apple-namespaced.js";
import { arityTableFrom, makeArityAnalyzer, type ArityAnalyzer } from "../arity-analyzer.js";
import {
  aggregate,
  firstTopLevelFormClosed,
  recordStepMetric,
  renderSummary,
  type StepMetric,
} from "./misprediction-metrics.js";
import { buildSiftPrompt, makeSiftEnv, SIFT_TASKS, SIFT_TOOLS } from "../sift-surface.js";
import { LlamaModelHandle, llamaCppGenerator } from "../../../src/runners/local/llama-cpp-generate.js";
import type { SchemeGenerator } from "../../../src/runners/generate.js";

const MODE = (process.env.METRICS_MODE ?? "mock") as "mock" | "smoke" | "real";
// Which tool surface the model materializes into. Apple variants re-namespace the SAME verbs:
//   apple (flat) · apple-dei (domain/entity/intent) · apple-die (domain/intent/entity) ·
//   apple-eq (effect|query/verb) · apple-bang (!effect|!query/verb) · apple-env (env/effect|query/verb).
// Plus sift's real forensic surface.
const SURFACE = (process.env.METRICS_SURFACE ?? "apple") as
  | "apple"
  | "apple-dei"
  | "apple-die"
  | "apple-eq"
  | "apple-bang"
  | "apple-env"
  | "apple-bdei"
  | "apple-bdie"
  | "sift";
const OUT_DIR = fileURLToPath(new URL("../../../src/../../../src/src/__research-output__/", import.meta.url));

function writeArtifacts(steps: readonly StepMetric[], meta: Record<string, string | number>): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const report = aggregate(steps);
  // Surface-prefixed filenames so the apple/sift runs don't clobber each other.
  const stem = `misprediction-${SURFACE}-llama`;
  writeFileSync(`${OUT_DIR}${stem}-metrics.json`, JSON.stringify({ meta, report, steps }, null, 2));
  writeFileSync(`${OUT_DIR}${stem}-summary.md`, renderSummary(report, { ...meta, steps: steps.length }));
}

// ── MOCK MODE: pure fixtures (no model) ──────────────────────────────────────────────────────────────

if (MODE === "mock") {
  // A toy vocabulary: each id decodes to a whole scheme fragment, so we can drive one decode step directly.
  const TOY = ["(", ")", " ", "send-message", '"Mom"', "do_the_thing", "set-timer", "5", "6", "<eos>"];
  const EOS = TOY.indexOf("<eos>");
  const toyDecode = (ids: readonly number[]): string => ids.map((id) => TOY[id] ?? "").join("");
  // id→string for the recorder (EOS excluded, exactly like the tokenizer's entries cache).
  const idToStr = new Map(TOY.map((str, id) => [id, str] as const).filter(([id]) => id !== EOS));

  /**
   * Drive ONE constrained decode step through the SHARED kernel over the toy vocab, then classify it with
   * recordStepMetric — the model-free migration of the old `MetricsProcessor._call`. `high` lists the ids
   * the model ranks highest (descending), the rest finite-low; the kernel picks the constrained argmax
   * (keepN:1) so `iterationsUntilFeasible` reflects the real rank of the first feasible token.
   */
  async function drive(generated: number[], high: number[]): Promise<StepMetric[]> {
    const sim = await makeDeviceSim();
    const scanner = makeOracle(sim.grant) as OracleScanner;
    const prefix = toyDecode(generated);
    // The logit row: finite-low (1) everywhere, each high[i] set to 100-i (descending) — the old fakeLogits.
    const data = new Float32Array(TOY.length).fill(1);
    for (const [i, id] of high.entries()) data[id] = 100 - i;
    // The model's preference-ranked ids by logit (descending) — the rankedIds the kernel walks.
    const ranked = Array.from({ length: TOY.length }, (_, id) => id).toSorted((a, b) => data[b] - data[a]);
    const prefixState = scanner.analyze(prefix);
    const slotState =
      prefixState.midToken && (prefixState.position === "argument" || prefixState.position === "operator")
        ? scanner.analyze(`${prefix} `)
        : prefixState;
    const { kept, widened, fallback } = selectConstrainedStep({
      scanner,
      prefix,
      rankedIds: (limit) => ranked.slice(0, limit),
      idToString: (id) => idToStr.get(id),
      allIds: () => ranked,
      slotState,
      closeable: prefixState.closeable,
      keepN: 1,
      topK: 256,
      wideK: 1024,
      eos: { addId: EOS },
    });
    const topIds = ranked.slice(0, widened ? 1024 : 256);
    const metric = recordStepMetric(
      { prefix, topIds, kept, data, vocab: TOY.length, canEnd: prefixState.closeable, widened, fallback },
      { scanner, idToStr, eosId: EOS, analyzer: makeArityAnalyzer(), taskId: "fixture", stepIndex: 0 },
    );
    return metric ? [metric] : [];
  }

  describe("classifier fixtures", () => {
    let scanner: OracleScanner;
    beforeAll(async () => {
      const sim = await makeDeviceSim();
      scanner = makeOracle(sim.grant) as OracleScanner;
    });
    it("classifies a balanced close as feasible", () => {
      expect(classifyCandidate(scanner, '(send-message "Mom" "hi"', ")")).toBe("feasible");
    });
    it("classifies an extra close as structural", () => {
      expect(classifyCandidate(scanner, '(send-message "Mom" "hi")', ")")).toBe("structural");
    });
    it("classifies an unbound operator as sigma + names the atom", () => {
      expect(classifyCandidate(scanner, "(", "do_the_thing")).toBe("sigma");
      expect(trailingAtom("(do_the_thing")).toBe("do_the_thing");
    });
    it("exempts `#`-literals from Σ (boolean args are feasible, not sigma)", () => {
      expect(classifyCandidate(scanner, "(set-flashlight ", "#t")).toBe("feasible");
      expect(classifyCandidate(scanner, "(set-flashlight ", "#f")).toBe("feasible");
    });
    it("exempts `:`-keyword accessors from Σ ((:Field row) is feasible, not sigma)", () => {
      expect(classifyCandidate(scanner, "(", ":PID")).toBe("feasible");
      expect(classifyCandidate(scanner, "(", ":recipient")).toBe("feasible");
    });
    it("literals are values, not callables: exempt as ARGS but rejected at OPERATOR position", () => {
      // argument slot — a number/#-literal is a fine value:
      expect(classifyCandidate(scanner, "(set-timer ", "9")).toBe("feasible");
      expect(classifyCandidate(scanner, "(set-flashlight ", "#t")).toBe("feasible");
      // operator slot — a literal value is not callable, so Σ-rejected when no callable shares its prefix:
      expect(classifyCandidate(scanner, "(", "9")).toBe("sigma");
      expect(classifyCandidate(scanner, "(", "#t")).toBe("sigma");
      // (note: `(1` stays feasible — `1+`/`1-` are real callables, so `1` is a live prefix toward
      //  `(1+ …)`; only abandoning it at `1)` yields a bad head, which needs an at-close callable check.)
    });
  });

  describe("arity analyzer fixtures", () => {
    const an = makeArityAnalyzer();
    it("too-few-close: closing send-message with one arg", () => {
      expect(an.observe('(send-message "Mom" ', ")")?.kind).toBe("too-few-close");
    });
    it("overfull-open: a second arg to a 1-arity tool", () => {
      expect(an.observe("(set-timer 5 ", "6")?.kind).toBe("overfull-open");
    });
    it("ok: first arg to send-message", () => {
      expect(an.observe("(send-message ", '"Mom"')?.kind).toBe("ok");
    });
    it("null on arithmetic / unknown head", () => {
      expect(an.observe("(* 5 ", "60")).toBeNull();
    });
    it("type-coarse-mismatch: a number where a string body is expected", () => {
      expect(an.observe('(send-message "Mom" 42 ', ")")?.kind).toBe("type-coarse-mismatch");
    });
  });

  describe("recordStepMetric wiring", () => {
    it("records a too-few-close arity misprediction (oracle allows the close)", async () => {
      const steps = await drive([0, 3, 2, 4, 2], [1]); // "(send-message \"Mom\" " , prefer ")"
      expect(steps).toHaveLength(1);
      expect(steps[0].preferStr).toBe(")");
      expect(steps[0].preferKind).toBe("feasible");
      expect(steps[0].arity?.kind).toBe("too-few-close");
    });
    it("records a sigma misprediction + the attempted atom + the feasible rank", async () => {
      const steps = await drive([0], [5, 3]); // "(" , prefer "do_the_thing" (id5), feasible "send-message" (id3)
      expect(steps[0].preferKind).toBe("sigma");
      expect(steps[0].attemptedAtom).toBe("do_the_thing");
      expect(steps[0].iterationsUntilFeasible).toBe(2); // do_the_thing rejected, send-message at rank 2
    });
    it("records an overfull-open arity misprediction", async () => {
      const steps = await drive([0, 6, 2, 7, 2], [8]); // "(set-timer 5 " , prefer "6"
      expect(steps[0].preferKind).toBe("feasible");
      expect(steps[0].arity?.kind).toBe("overfull-open");
    });
  });

  describe("aggregate + render", () => {
    it("rolls up kinds, symbols, arity and the iteration histogram", async () => {
      const steps: StepMetric[] = [
        ...(await drive([0], [5, 3])),
        ...(await drive([0, 3, 2, 4, 2], [1])),
        ...(await drive([0, 6, 2, 7, 2], [8])),
      ].map((s, i) => ({ ...s, stepIndex: i, taskId: "agg" }));
      const report = aggregate(steps);
      expect(report.totalSteps).toBe(3);
      expect(report.kindFreq.sigma).toBe(1);
      expect(report.attemptedSymbolTally.do_the_thing).toBe(1);
      expect(report.arityByHead["send-message"]?.tooFewClose).toBe(1);
      expect(report.arityByHead["set-timer"]?.overfullOpen).toBe(1);
      const md = renderSummary(report, { mode: "mock", model: "toy" });
      expect(md).toContain("misprediction metrics");
      expect(md).toContain("do_the_thing");
    });
  });
}

// ── SMOKE / REAL MODE: the GGUF model over the apple-intent tasks (llama.cpp / Metal) ──────────────────

if (MODE === "smoke" || MODE === "real") {
  const MODEL_ID = "EssentialAI/rnj-1-instruct (Q4_K_M GGUF, llama.cpp/Metal)";
  // Surface selects the grant env (the Σ surface), the system prompt, the tasks, and the arity table.
  // The `apple-*` variants reuse the apple TASKS but re-namespace the tools under a scheme.
  const SCHEME_OF: Record<string, "dei" | "die" | "eq" | "bang" | "env" | "bdei" | "bdie"> = {
    "apple-dei": "dei",
    "apple-die": "die",
    "apple-eq": "eq",
    "apple-bang": "bang",
    "apple-env": "env",
    "apple-bdei": "bdei",
    "apple-bdie": "bdie",
  };
  const naming = SCHEME_OF[SURFACE] ?? null;
  const SURFACE_TASKS = SURFACE === "sift" ? SIFT_TASKS : TASKS;
  // Every grant-surface factory returns Stage-C `{ capabilities, scope, grant }`.
  const makeGrantEnv = () => (SURFACE === "sift" ? makeSiftEnv() : naming ? makeNamespacedAppleEnv(naming) : makeDeviceSim());
  const SYSTEM_PROMPT =
    SURFACE === "sift" ? buildSiftPrompt() : naming ? buildNamespacedApplePrompt(naming) : undefined;
  const makeAnalyzer = (): ArityAnalyzer => {
    if (SURFACE === "sift") return makeArityAnalyzer(arityTableFrom([...SIFT_TOOLS]));
    if (naming) return makeArityAnalyzer(arityTableFrom(namespacedAppleTools(naming)));
    return makeArityAnalyzer();
  };
  // METRICS_MAX_TASKS caps the matrix (a fast 1-task load verify before the full overnight run).
  const MAX_TASKS = Number(process.env.METRICS_MAX_TASKS ?? "0");
  const BASE_TASKS = MODE === "smoke" ? SURFACE_TASKS.slice(0, 3) : [...SURFACE_TASKS];
  const TASK_SET = MAX_TASKS > 0 ? BASE_TASKS.slice(0, MAX_TASKS) : BASE_TASKS;
  const GGUF_PATH = resolveGguf("essentialai/rnj-1"); // LM Studio source of truth (null ⇒ not downloaded yet)

  describe(`misprediction metrics — ${MODE} / ${SURFACE} (${MODEL_ID})`, () => {
    let gen: SchemeGenerator | undefined;
    let loadError: string | undefined;
    let scanner: OracleScanner;
    const collected: StepMetric[] = [];
    const programs: { taskId: string; prompt: string; program: string }[] = [];
    let currentTaskId = "";
    let llamaStep = 0; // per-task step counter for the llama.cpp backend.
    const analyzer = makeAnalyzer();

    beforeAll(async () => {
      const { grant } = await makeGrantEnv();
      scanner = makeOracle(grant) as OracleScanner;
      try {
        // Metal GPU path (Node-only native addon). The generator drives its own decode loop and taps each
        // step; we rebuild the full StepMetric from its `prefix` using the SAME oracle predicates the
        // recorder uses (3-way classify, attempted-atom, arity) so the metric shape is backend-identical.
        if (GGUF_PATH === null) throw new Error("rnj-1 GGUF not present in LM Studio — download it there");
        const handle = await LlamaModelHandle.load(GGUF_PATH);
        gen = llamaCppGenerator(handle, {
          onStep: (m) => {
            const kind = classifyCandidate(scanner, m.prefix, m.preferStr);
            collected.push({
              taskId: currentTaskId,
              stepIndex: llamaStep++,
              preferTokenId: -1,
              preferStr: m.preferStr,
              preferLogit: Number.NaN,
              preferProb: m.preferProb,
              top2Margin: m.top2Margin,
              preferKind: kind,
              attemptedAtom: kind === "sigma" ? trailingAtom(m.prefix + m.preferStr) : null,
              iterationsUntilFeasible: m.iterationsUntilFeasible,
              widened: false,
              fallback: false,
              closeable: m.closeable,
              postForm: firstTopLevelFormClosed(m.prefix),
              arity: analyzer.observe(m.prefix, m.preferStr),
            });
          },
        });
      } catch (error) {
        loadError = error instanceof Error ? error.message : String(error);
        // Loud, single-line abort signal — do not silently burn the night on a model that won't load.
        console.error(`[misprediction-metrics] MODEL FAILED TO LOAD (${MODEL_ID}): ${loadError}`);
      }
    }, 600_000);

    it.each(TASK_SET)("collects metrics for task $id", async (task) => {
      if (gen === undefined) {
        expect(loadError, "model failed to load — see console").toBeDefined();
        return;
      }
      currentTaskId = task.id;
      llamaStep = 0; // reset per-task step index.
      const before = collected.length;
      const program = await gen.generate(task.prompt, {
        constrained: true,
        scanner,
        maxNewTokens: 96,
        prefill: "(", // force the answer to start with "(" — a single s-expression, no markdown/prose preamble
        systemPrompt: SYSTEM_PROMPT,
      });
      programs.push({ taskId: task.id, prompt: task.prompt, program });
      // Flush incrementally so a mid-run crash preserves partial data.
      writeArtifacts(collected, { mode: MODE, surface: SURFACE, model: MODEL_ID, tasksSoFar: task.id });
      writeFileSync(
        `${OUT_DIR}misprediction-${SURFACE}-llama-programs.md`,
        [
          `# Rnj-1 generated programs — ${SURFACE}`,
          "",
          ...programs.flatMap((p) => [
            `### ${p.taskId}`,
            `**Ask:** ${p.prompt}`,
            "",
            "```scheme",
            p.program,
            "```",
            "",
          ]),
        ].join("\n"),
      );
      expect(collected.length).toBeGreaterThanOrEqual(before);
    });

    afterAll(async () => {
      await gen?.dispose?.();
      if (collected.length > 0) {
        writeArtifacts(collected, { mode: MODE, surface: SURFACE, model: MODEL_ID, tasks: TASK_SET.length });
        console.log(`\n${renderSummary(aggregate(collected), { mode: MODE, surface: SURFACE, model: MODEL_ID })}`);
      }
    });
  });
}
