// score.ts — run a generated Scheme program eagerly against the sim and CATEGORIZE the outcome.
//
// Categories (the failure taxonomy that makes the constrained-vs-unconstrained delta legible):
//   • "ok"            — the program ran AND the task's expect(trace) matched → MATERIALIZED.
//   • "wrong-tool"    — ran, recorded a tool call, but the WRONG tool (or right tool wrong intent).
//   • "mis-slotted"   — ran, called the RIGHT tool, but the slots failed expect (catchable by a
//                        write-confirm). Distinguished from wrong-tool by checking the expected tool
//                        was among the recorded calls.
//   • "empty"         — ran cleanly but recorded NO tool call.
//   • "unbound-tool"  — exec threw because the program referenced an unbound symbol (the classic
//                        unconstrained-tiny-model failure — a hallucinated tool name).
//   • "invalid"       — exec threw for any other reason (parse error, arity, type) — unparseable /
//                        malformed program.
//
// Constrained decoding should ELIMINATE invalid + unbound-tool by construction, leaving only
// mis-slotted / wrong-tool / empty — the residual capability questions.

// Resolved to arrival-scheme SOURCE via the vitest alias.
import { exec } from "@inhuman.tools/arrival";

import { TOOL_BY_NAME } from "../../src/runners/fixtures/apple-intents/registry.js";
import type { DeviceSim, Trace } from "../../src/runners/fixtures/apple-intents/sim.js";
import type { Task } from "../../src/runners/fixtures/apple-intents/tasks.js";

export type Category = "ok" | "wrong-tool" | "mis-slotted" | "empty" | "unbound-tool" | "invalid";

export interface CellResult {
  readonly program: string;
  readonly category: Category;
  readonly trace: Trace;
  readonly error?: string;
  /** True iff exec ran without throwing. */
  readonly ran: boolean;
}

/** Heuristic: did this thrown error come from an UNBOUND symbol (a hallucinated tool)? */
function isUnboundError(msg: string): boolean {
  return /unbound|not defined|is not a function|undefined variable|no binding|cannot find/i.test(msg);
}

/**
 * Run `program` eagerly against the sim's `{ capabilities, scope }`, then categorize against `task`.
 * Resets the sim trace first. A wall-clock budget bounds a runaway program (the sandbox
 * `(let loop () (loop))` guard).
 */
export async function runAndScore(program: string, task: Task, sim: DeviceSim): Promise<CellResult> {
  sim.reset();
  let ran = false;
  let error: string | undefined;

  if (program.trim() === "") {
    return { program, category: "invalid", trace: [], ran: false, error: "empty output" };
  }

  try {
    await exec(program, { capabilities: sim.capabilities, scope: sim.scope, budgetMs: 2000 });
    ran = true;
  } catch (error_) {
    error = error_ instanceof Error ? error_.message : String(error_);
  }

  const trace = [...sim.trace];

  if (!ran) {
    return {
      program,
      category: isUnboundError(error ?? "") ? "unbound-tool" : "invalid",
      trace,
      error,
      ran,
    };
  }

  if (task.expect(trace)) {
    return { program, category: "ok", trace, ran };
  }

  if (trace.length === 0) {
    return { program, category: "empty", trace, ran };
  }

  // Right tool, wrong slots? Find the tool the task is about by probing expect against a synthetic
  // perfect trace is hard; instead: if any recorded tool is the "intended" one (inferred below) treat
  // as mis-slot, else wrong-tool. We infer intent by the tools the task's expect references is not
  // available structurally, so we approximate: if the recorded tools are all REAL device tools (bound)
  // but expect failed, it's a slotting/tool mismatch. Distinguish mis-slot (a known-relevant tool ran)
  // from wrong-tool by a per-task hint table.
  const recordedTools = new Set(trace.map((t) => t.tool));
  const intended = INTENDED_TOOLS[task.id] ?? [];
  const hitIntendedTool = intended.some((tool) => recordedTools.has(tool));
  return { program, category: hitIntendedTool ? "mis-slotted" : "wrong-tool", trace, ran };
}

/** Per-task hint: which tool(s) materialize the intent. Used ONLY to split mis-slot vs wrong-tool in
 *  scoring (the `expect` predicates are the real verdict for `ok`). Kept here, beside the scorer, so
 *  tasks.ts stays a clean prompt+expect surface. */
const INTENDED_TOOLS: Record<string, readonly string[]> = {
  "timer-10min": ["set-timer"],
  "text-mom-late": ["send-message"],
  "remind-call-dentist": ["create-reminder"],
  "dnd-on": ["set-do-not-disturb"],
  "play-music": ["play-music", "play-song", "play-artist", "play-playlist"],
  "navigate-home": ["navigate-home", "navigate-to"],
  "tip-15-on-80": ["web-search", "wiki-lookup"],
  "add-milk-shopping": ["add-to-list"],
  "call-dad": ["call-contact", "facetime-contact"],
  "set-alarm-7am": ["set-alarm"],
  "flashlight-on": ["set-flashlight"],
  "start-run": ["start-workout"],
  "send-email-bob": ["send-email"],
  "take-photo": ["take-photo", "open-camera"],
};

/** Sanity: every intended-tool name is a real registry tool (catches a typo in the hint table). */
export function validateIntendedTools(): string[] {
  const bad: string[] = [];
  for (const tools of Object.values(INTENDED_TOOLS)) {
    for (const t of tools) if (!TOOL_BY_NAME.has(t)) bad.push(t);
  }
  return bad;
}
