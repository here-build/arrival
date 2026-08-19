// fc-roster-smoke.test.ts — "does EVERY model in the roster somewhat work through the FC envelope?" A
// smoke sweep (NOT a benchmark, NOT a gate): load each roster model in turn, drive a handful of tasks
// through the execute-scheme tool-call FSM, and record per model whether it produced a valid-JSON call
// with a proper Scheme expr. The zimmerframe FORCES the JSON/tool-call structure uniformly, so this
// isolates the one model-dependent thing: when held in the frame, does each family fill `intent` + `expr`
// sensibly? It also surfaces the deferred hazards (a multi-step task probes the bare-newline case).
//
// Run the full roster (writes an incremental report — vitest workers swallow console.*):
//   LLM_ROSTER=full pnpm exec vitest run --config vitest.custdev.config.ts src/__custdev__/fc-roster-smoke.test.ts
// Default (no LLM_ROSTER) => activeRoster() is empty => zero cases => instant no-op.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { makeOracle } from "@inhuman.tools/arrival/oracle";
import { describe, it } from "vitest";

import { makeDeviceSim } from "../../src/runners/fixtures/apple-intents/sim.js";
import { buildSystemPrompt } from "../harness/generators.js";
import { activeQuant, activeRoster } from "../harness/gguf-models.js";
import { EXECUTE_SCHEME_TOOL, exprHazards } from "../../src/runners/local/fc-envelope.js";
import { LlamaModelHandle, llamaCppGenerator } from "../../src/runners/local/llama-cpp-generate.js";
import { quantOf, resolveGguf } from "../../src/runners/gguf/lmstudio.js";

// FC_MODE selects the task set + whether `(` is forced at expr-start. Default = the call-smoke. "irrelevance"
// = irrelevant prompts with forceOpenParen OFF — the abstention probe: does the model decline by leaving expr
// empty, or railroad a hallucinated call once the execute-scheme envelope is forced around it?
const IRRELEVANCE = process.env.FC_MODE === "irrelevance";
const TAG = IRRELEVANCE ? "irrelevance" : "smoke";
// Reports go to a sibling __fc-output__/ dir (gitignored, per .claude/rules/tests.md — a custdev test writes
// to a sibling __*-output__/). Portable: created at import, no session-specific path.
const OUT_DIR = fileURLToPath(new URL("./__fc-output__/", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });
// The OVERWRITE-per-flush full report (always the complete current state — `cat` it).
const OUT_FILE = `${OUT_DIR}fc-roster-${TAG}.txt`;
// The APPEND-only progress log — one line per event, designed for `tail -f` (and echoed to the console).
const PROGRESS_FILE = `${OUT_DIR}fc-roster-${TAG}.log`;

/** Emit one progress event: append a line to the tail-able log AND echo to the console (vitest's
 *  disableConsoleIntercept makes it reach the terminal live). The whole reason a sweep over slow models
 *  needs this — without it you cannot tell "loading a 14B" from "hung". */
function progress(line: string): void {
  // eslint-disable-next-line no-console
  console.error(line);
  try {
    appendFileSync(PROGRESS_FILE, `${line}\n`);
  } catch {
    /* progress logging is best-effort — never fail the sweep over it */
  }
}

// Call-smoke: real device tools (set-timer / send-message / navigate-home) + one multi-step (newline hazard).
const SMOKE_TASKS = [
  "set a timer for 10 minutes",
  "text mom that I will be 10 minutes late",
  "navigate home",
  "set a timer for 5 minutes and text dad that dinner is ready", // multi-step ⇒ probes the newline hazard
] as const;
// Irrelevance: NO device tool applies — the correct answer is to decline. The probe (forceOpenParen OFF):
// does the model leave `expr` empty (abstain), or hallucinate a call because the envelope is forced anyway?
const IRRELEVANT_TASKS = [
  "what is the airspeed velocity of an unladen swallow",
  "explain the theory of relativity in one sentence",
  "who won the world cup in 1998",
  "what is a good recipe for spaghetti carbonara",
] as const;
const TASKS: readonly string[] = IRRELEVANCE ? IRRELEVANT_TASKS : SMOKE_TASKS;

// REASONING-BUDGET sweep: each model runs once PER budget in THINK_BUDGETS (default just "0" = no-think, so
// behaviour is unchanged). e.g. THINK_BUDGETS=0,1000,2000 runs every model at no-think + 1000 + 2000 think
// tokens — a per-model experiment axis (does thinking help the tool call, and how much budget). The model is
// loaded ONCE per model (with a context sized for the largest budget) and reused across budgets.
const BUDGETS: readonly number[] = (process.env.THINK_BUDGETS ?? "0")
  .split(",")
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));
const MAX_BUDGET = Math.max(0, ...BUDGETS);
// Context must hold the ~1.3k system prompt + the largest think budget + the envelope. Default 2048 when no
// budget; otherwise size up so a long reasoning block doesn't overflow n_ctx (the load warning we saw).
const CONTEXT_SIZE = MAX_BUDGET > 0 ? Math.max(2048, 1300 + MAX_BUDGET + 320) : 2048;

interface TaskResult {
  readonly task: string;
  readonly parsed: boolean; // the envelope parsed as a well-formed call in its family's format (JSON | GLM-XML)
  readonly properCall: boolean; // parsed + expr is a non-empty `(`-led form
  readonly expr: string | null;
  readonly hazards: number;
  readonly error?: string;
  readonly raw: string;
}

/** Pull `(ok, expr)` from a generated tool call — FORMAT-AGNOSTIC: Hermes JSON OR GLM `<arg_key>/<arg_value>`
 *  XML (the two confirmed frames). A JSON-only parse would false-negative every GLM call. */
function extractCall(raw: string): { ok: boolean; expr: string | null } {
  // The tool call may be PRECEDED by a <think>…</think> reasoning block (budget>0) — find the envelope
  // anywhere, not anchored to the start.
  const tc = /<tool_call>([\s\S]*?)<\/tool_call>/.exec(raw);
  const inner = tc ? (tc[1] ?? "") : raw.replace(/^<tool_call>\n?/, "").replace(/\n?<\/tool_call>\s*$/, "");
  try {
    const p = JSON.parse(inner) as { arguments?: { expr?: string } };
    return { ok: true, expr: p?.arguments?.expr ?? null }; // Hermes
  } catch {
    /* not JSON — try GLM XML below */
  }
  const m = /<arg_key>expr<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/.exec(inner); // GLM
  if (m) return { ok: true, expr: m[1] ?? null };
  return { ok: false, expr: null };
}
interface ModelReport {
  readonly label: string;
  readonly key: string;
  readonly budget: number; // the reasoning budget this cell ran at (0 = no-think)
  readonly status: "missing" | "load-error" | "ran";
  readonly quant?: string;
  readonly gguf?: string;
  readonly error?: string;
  readonly tasks: TaskResult[];
}

// Module-level accumulator: persists across the describe.each rows in this single (fileParallelism:false)
// file, so each completed model is flushed to disk immediately — a sleep/kill mid-sweep keeps every model
// that already finished (the BFCL incremental-flush lesson).
const report: ModelReport[] = [];
writeFileSync(PROGRESS_FILE, `FC roster smoke — progress (tail -f this file)\n`); // fresh per run
const deviceSim = await makeDeviceSim();
const scanner = makeOracle(deviceSim.grant);
const systemPrompt =
  `${buildSystemPrompt()}\n\n` +
  `Respond with a SINGLE tool call to the "${EXECUTE_SCHEME_TOOL}" tool. Its arguments are ` +
  `{ "intent": <what you are doing>, "expr": <a Scheme program using the device functions> }.`;

/** A model's cell label, including the reasoning budget when sweeping (omitted in the plain no-think run). */
function cellLabel(m: { label: string; budget: number }): string {
  return BUDGETS.length > 1 || m.budget > 0 ? `${m.label} @think=${m.budget}` : m.label;
}

function summarize(m: ModelReport): string {
  if (m.status === "missing") return `${cellLabel(m)} [${m.key}]: MISSING (not downloaded in LM Studio)`;
  if (m.status === "load-error") return `${cellLabel(m)} [${m.quant ?? "?"}]: LOAD-ERROR — ${m.error ?? ""}`;
  const valid = m.tasks.filter((t) => t.parsed).length;
  const proper = m.tasks.filter((t) => t.properCall).length;
  const haz = m.tasks.reduce((s, t) => s + t.hazards, 0);
  const thoughtN = m.tasks.filter((t) => t.raw.includes("<think")).length; // tasks where the budget took effect
  const thought = m.budget > 0 ? `, thought ${thoughtN}/${m.tasks.length}` : "";
  return `${cellLabel(m)} [${m.quant ?? "?"}]: ${valid}/${m.tasks.length} parsed, ${proper}/${m.tasks.length} proper-call, ${haz} hazard(s)${thought}`;
}

function flush(): void {
  const lines: string[] = ["FC envelope roster smoke — per-model verification", "=".repeat(60), ""];
  for (const m of report) {
    lines.push(summarize(m));
    for (const t of m.tasks) {
      lines.push(
        `   • ${t.task}`,
        `     parsed: ${t.parsed ? "yes" : "NO"}  proper-call: ${t.properCall ? "yes" : "no"}  hazards: ${t.hazards}${t.error ? `  ERROR: ${t.error}` : ""}`,
        `     expr: ${JSON.stringify(t.expr)}`,
      );
      // On a non-proper call, show the RAW envelope — without it a "FAIL" is undiagnosable (truncation at
      // maxNewTokens vs a bare control char in intent/expr vs a malformed structure look identical otherwise).
      if (!t.properCall) lines.push(`     RAW: ${JSON.stringify(t.raw).slice(0, 600)}`);
    }
    lines.push("");
  }
  lines.push("— SUMMARY —", ...report.map(summarize));
  writeFileSync(OUT_FILE, lines.join("\n"));
}

// Optional single-model focus: `LLM_ONLY=<substr>` runs only matching labels (diagnose one model without
// re-running the roster — case-insensitive substring on the label).
const ONLY = process.env.LLM_ONLY?.toLowerCase();
const ROSTER = activeRoster().filter((m) => !ONLY || m.label.toLowerCase().includes(ONLY));

// Default (no LLM_ROSTER) ⇒ empty roster. Register a skipped placeholder so a bare `pnpm custdev` stays
// green (an empty describe.each registers zero tests, which vitest reports as a failed suite).
if (ROSTER.length === 0) {
  describe("FC roster smoke", () => {
    it.skip("no LLM_ROSTER selected — run with LLM_ROSTER=full", () => undefined);
  });
}

describe.each(ROSTER)("FC roster smoke — $label", (model) => {
  it(
    "produces somewhat-working execute-scheme calls",
    async () => {
      const gguf = resolveGguf(model.key, activeQuant());
      if (!gguf) {
        report.push({ label: model.label, key: model.key, budget: 0, status: "missing", tasks: [] });
        progress(`✗ ${model.label}: MISSING (not downloaded in LM Studio)`);
        flush();
        return;
      }
      const quant = quantOf(gguf);
      progress(`▶ ${model.label} [${quant}] — loading (ctx ${CONTEXT_SIZE})…`);
      let handle: LlamaModelHandle | undefined;
      let gen: ReturnType<typeof llamaCppGenerator> | undefined;
      try {
        handle = await LlamaModelHandle.load(gguf, CONTEXT_SIZE);
        gen = llamaCppGenerator(handle);
        progress(`  loaded ${model.label} — ${BUDGETS.length} budget(s) × ${TASKS.length} tasks`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        report.push({ label: model.label, key: model.key, budget: 0, status: "load-error", quant, gguf, error: msg, tasks: [] });
        progress(`✗ ${model.label}: LOAD-ERROR — ${msg}`);
        flush();
        return;
      }
      try {
        // Load once, sweep budgets — each (model × budget) is its own report row.
        for (const budget of BUDGETS) {
          const entry: ModelReport = { label: model.label, key: model.key, budget, status: "ran", quant, gguf, tasks: [] };
          report.push(entry); // push first so per-task flushes show this cell's growing tasks
          const lbl = cellLabel({ label: model.label, budget });
          for (const task of TASKS) {
            try {
              const raw = await gen.generate(task, {
                fcEnvelope: true,
                scanner,
                constrained: true,
                maxNewTokens: 160,
                systemPrompt,
                fcForceOpenParen: IRRELEVANCE ? false : undefined, // abstention probe leaves the first expr token free
                thinkBudget: budget,
              });
              const { ok: parsed, expr } = extractCall(raw);
              const properCall = parsed && typeof expr === "string" && expr.trim().startsWith("(");
              const hazards = typeof expr === "string" ? exprHazards(expr).length : 0;
              entry.tasks.push({ task, parsed, properCall, expr, hazards, raw });
              progress(`  · ${lbl} · ${task.slice(0, 34)}… → ${properCall ? "ok" : "FAIL"}${hazards ? ` (${hazards} haz)` : ""}`);
              flush();
            } catch (e) {
              entry.tasks.push({
                task,
                parsed: false,
                properCall: false,
                expr: null,
                hazards: 0,
                error: e instanceof Error ? e.message : String(e),
                raw: "",
              });
              progress(`  · ${lbl} · ${task.slice(0, 34)}… → ERROR`);
              flush();
            }
          }
          progress(`✓ ${summarize(entry)}`);
          flush();
        }
      } finally {
        await gen.dispose?.();
        flush();
      }
    },
    // One model, all budgets × tasks. A 2000-token think block runs ~minutes; size the cap to the sweep.
    Math.max(900_000, BUDGETS.length * TASKS.length * (MAX_BUDGET + 200) * 120),
  );
});
