// report.ts — aggregate cell results into the headline materialize-rate table + per-task traces.
//
// The output (written to src/__custdev-output__/) is the artifact: a markdown table of
// materialize-rate per (model × {constrained, unconstrained}) with the failure-category breakdown,
// and the constrained-vs-unconstrained DELTA — the money comparison.

import type { Category, CellResult } from "./score.js";

export type Condition = "constrained" | "unconstrained";

interface ConditionTally {
  total: number;
  ok: number;
  byCategory: Record<Category, number>;
}

export interface ModelReport {
  readonly model: string;
  /** Set when the model failed to load — recorded as a skip, not a crash. */
  readonly skipped?: string;
  readonly conditions: Record<Condition, ConditionTally>;
}

const CATEGORIES: Category[] = ["ok", "wrong-tool", "mis-slotted", "empty", "unbound-tool", "invalid"];

export function emptyTally(): ConditionTally {
  return {
    total: 0,
    ok: 0,
    byCategory: { ok: 0, "wrong-tool": 0, "mis-slotted": 0, empty: 0, "unbound-tool": 0, invalid: 0 },
  };
}

export function record(tally: ConditionTally, result: CellResult): void {
  tally.total++;
  tally.byCategory[result.category]++;
  if (result.category === "ok") tally.ok++;
}

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((100 * n) / d).toFixed(0)}%`);

/** The headline markdown table + the delta line per model. */
export function renderTable(reports: readonly ModelReport[]): string {
  const lines: string[] = [
    "# Materialize-rate — constrained sub-1B device-intent decoding\n",
    "Can a constrained sub-1B model materialize explicit device intents into correct, valid, " +
      "eager-executed Scheme tool calls? **materialize-rate** = fraction of tasks whose recorded trace " +
      "matched the expected action.\n",
    "| Model | Condition | Materialize | ok | mis-slot | wrong-tool | empty | unbound | invalid |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of reports) {
    if (r.skipped) {
      lines.push(`| ${r.model} | — | _skipped_ | | | | | | |  `, `| | | _${r.skipped}_ | | | | | | |`);
      continue;
    }
    for (const cond of ["unconstrained", "constrained"] as const) {
      const t = r.conditions[cond];
      const c = t.byCategory;
      lines.push(
        `| ${r.model} | ${cond} | **${pct(t.ok, t.total)}** | ${c.ok} | ${c["mis-slotted"]} | ` +
          `${c["wrong-tool"]} | ${c.empty} | ${c["unbound-tool"]} | ${c.invalid} |`,
      );
    }
  }
  lines.push("", "## Constraint delta (the money comparison)\n");
  for (const r of reports) {
    if (r.skipped) continue;
    const u = r.conditions.unconstrained;
    const c = r.conditions.constrained;
    const uInvalid = u.byCategory.invalid + u.byCategory["unbound-tool"];
    const cInvalid = c.byCategory.invalid + c.byCategory["unbound-tool"];
    lines.push(
      `- **${r.model}**: materialize ${pct(u.ok, u.total)} → ${pct(c.ok, c.total)} ` +
        `(Δ ${((100 * c.ok) / Math.max(1, c.total) - (100 * u.ok) / Math.max(1, u.total)).toFixed(0)}pp); ` +
        `invalid+unbound ${uInvalid} → ${cInvalid} (constraint should drive this toward 0).`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Per-task trace dump (one block per model × condition). */
export function renderTraces(
  blocks: readonly { model: string; condition: Condition; taskId: string; prompt: string; result: CellResult }[],
): string {
  const lines: string[] = ["# Per-task traces\n"];
  let lastKey = "";
  for (const b of blocks) {
    const key = `${b.model} · ${b.condition}`;
    if (key !== lastKey) {
      lines.push(`\n## ${key}\n`);
      lastKey = key;
    }
    const traceStr = b.result.trace
      .map((t) => `${t.tool}(${t.args.map((a) => JSON.stringify(a)).join(", ")})`)
      .join("; ");
    lines.push(
      `- **${b.taskId}** [${b.result.category}] — _${b.prompt}_`,
      `  - program: \`${b.result.program.replaceAll("\n", " ")}\``,
    );
    if (traceStr) lines.push(`  - trace: \`${traceStr}\``);
    if (b.result.error) lines.push(`  - error: \`${b.result.error}\``);
  }
  return `${lines.join("\n")}\n`;
}
