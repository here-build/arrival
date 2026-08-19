// abstain-prefill-probe.ts — Phase-B empirical probe for the prefill abstain-unlock.
//
// NOT a CI test (no `.test.ts`): a standalone tsx script. Drives `generateWithExplain` DIRECTLY (no HTTP)
// over ONE loaded 1.5b model, A/B-ing the top-level decoder prefill:
//   • BEFORE = prefill "("  (the old real-decode seed — forces a call from token 0)
//   • AFTER  = prefill ""   (the change under review — model freely chooses call-vs-abstain)
// Everything else mirrors handler.ts: tools→grant Σ (toolsToGrantEnv), verbose system prompt
// (renderToolPrompt "fc"), parse (parseSchemeForms), classify abstain = (no parseable call) OR a
// terminal verb `(respond …)`. Tally per category:
//   • irrelevance (ground_truth []): CORRECT = ABSTAIN  → measures the unlock
//   • simple      (ground_truth [..]): CORRECT = a tool CALL fires → the safety check
//
// Run from the package root:  npx tsx src/__custdev__/abstain-prefill-probe.ts
// Env: PROBE_MODEL (gguf path or roster id, default the local Arch-Agent-1.5B q4),
//      PROBE_IRRELEVANCE (default 10), PROBE_SIMPLE (default 5), PROBE_MAXTOK (default 96).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateWithExplain, LlamaModelHandle } from "../../src/runners/local/server-generate.js";
import { parseSchemeForms } from "../../src/runners/server/scheme-parse.js";
import { isTerminalVerb } from "../../src/runners/server/terminal.js";
import { toolsToGrantEnv } from "../../src/runners/server/tool-env.js";
import { renderToolPrompt } from "../../src/runners/server/prompt-render.js";

const PKG = resolve(import.meta.dirname, "../../src/..");
const DATASET = (name: string): string => resolve(PKG, "scripts/.bfcl-cache/dataset", `${name}.joined.json`);

// Default model: the local roster symlink (Arch-Agent-1.5B q4) — the canonical fast probe. Override via
// PROBE_MODEL with any absolute .gguf (e.g. ~/.lmstudio/models/mradermacher/Hammer2.1-1.5b-GGUF/...Q8_0.gguf).
const MODEL = process.env.PROBE_MODEL ?? resolve(PKG, "models/roster/Arch-Agent-1.5B.Q4_K_M.gguf");
const N_IRREL = Number(process.env.PROBE_IRRELEVANCE ?? 10);
const N_SIMPLE = Number(process.env.PROBE_SIMPLE ?? 5);
const MAXTOK = Number(process.env.PROBE_MAXTOK ?? 96);

interface BfclEntry {
  id: string;
  question: { role: string; content: string }[][];
  function: { name: string; description?: string; parameters?: unknown }[];
  ground_truth: unknown[];
}

function load(name: string, n: number): BfclEntry[] {
  return (JSON.parse(readFileSync(DATASET(name), "utf8")) as BfclEntry[]).slice(0, n);
}

function userPromptOf(e: BfclEntry): string {
  const turn = e.question[0] ?? [];
  for (let i = turn.length - 1; i >= 0; i--) if (turn[i]!.role === "user") return turn[i]!.content;
  return turn.at(-1)?.content ?? "";
}

// Mirror handler.ts: a result is an ABSTAIN iff there is no parseable call, or the first call is a terminal verb.
function classify(program: string): { abstain: boolean; head: string | null; raw: string } {
  const calls = parseSchemeForms(program);
  if (calls.length === 0) return { abstain: true, head: null, raw: program.trim() };
  const head = calls[0]!.name;
  return { abstain: isTerminalVerb(head), head, raw: program.trim() };
}

async function main(): Promise<void> {
  const irrel = load("irrelevance", N_IRREL);
  const simple = load("simple", N_SIMPLE);
  // eslint-disable-next-line no-console
  console.log(`MODEL=${MODEL}\nirrelevance=${irrel.length} simple=${simple.length} maxNewTokens=${MAXTOK}\n`);

  const handle = await LlamaModelHandle.load(MODEL);
  const PREFILLS = [
    { label: "BEFORE prefill='('", prefill: "(" },
    { label: "AFTER  prefill=''", prefill: "" },
  ];

  // tally[catLabel][prefillLabel] = { correct, total, samples }
  const tally: Record<string, Record<string, { correct: number; total: number; lines: string[] }>> = {};

  try {
    for (const [cat, entries, correctIsAbstain] of [
      ["irrelevance", irrel, true],
      ["simple", simple, false],
    ] as const) {
      tally[cat] = {};
      for (const pf of PREFILLS) tally[cat][pf.label] = { correct: 0, total: 0, lines: [] };
      for (const e of entries) {
        const tools = e.function.map((f) => ({ type: "function" as const, function: f as never }));
        const grant = toolsToGrantEnv(tools);
        const systemPrompt = renderToolPrompt(tools, "fc");
        const prompt = userPromptOf(e);
        for (const pf of PREFILLS) {
          let program = "";
          try {
            program = await generateWithExplain({
              prompt,
              grantEnv: grant.env,
              ggufPath: MODEL,
              systemPrompt,
              prefill: pf.prefill,
              maxNewTokens: MAXTOK,
              handle,
            });
          } catch (err) {
            program = `<<ERROR: ${err instanceof Error ? err.message : String(err)}>>`;
          }
          const { abstain, head, raw } = classify(program);
          const correct = abstain === correctIsAbstain;
          const slot = tally[cat][pf.label]!;
          slot.total++;
          if (correct) slot.correct++;
          const verdict = abstain ? "ABSTAIN" : `CALL ${head}`;
          slot.lines.push(`  ${e.id} [${pf.prefill === "(" ? "B" : "A"}] ${correct ? "ok " : "XX "} ${verdict}  ::  ${raw.replace(/\n/g, " ").slice(0, 90)}`);
        }
      }
    }
  } finally {
    await handle[Symbol.asyncDispose]();
  }

  // ── report ──
  // eslint-disable-next-line no-console
  const log = (s: string): void => console.log(s);
  for (const cat of ["irrelevance", "simple"] as const) {
    const metric = cat === "irrelevance" ? "ABSTAIN-rate (correct = abstain)" : "FIRE-rate (correct = a tool call)";
    log(`\n=== ${cat.toUpperCase()} — ${metric} ===`);
    for (const pf of PREFILLS) {
      const s = tally[cat][pf.label]!;
      const pct = s.total ? ((100 * s.correct) / s.total).toFixed(0) : "—";
      log(`  ${pf.label.padEnd(20)} ${s.correct}/${s.total}  (${pct}%)`);
    }
    log("  detail:");
    for (const pf of PREFILLS) for (const ln of tally[cat][pf.label]!.lines) log(ln);
  }
  log("");
}

await main();
