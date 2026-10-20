// Membrane warning — residual host value re-stamps to #void. Per-run: lines go to the run's
// NoteSink (`runCtx.notes`; absent ⇒ dropped — core has no console), counts live per RunContext.
// Fresh js→scheme: undefined is a lens, unique symbol doors (NoLensError), bare host
// fn is reverse-membrane callable (docs/membrane.md §CALLABLE-LENS). Sole caller:
// deep-restamp of a bare-fn already in a scheme spine (not a fresh crossing).

import type { RunContext } from "../run/RunContext.js";

/**
 * Each distinct warning text, and how many times it has been emitted — PER RUN.
 *
 * This warning TEACHES — a fact ABOUT the crossing belongs to the RUN, not to each
 * value that crosses it. First WARN_LIMIT of each distinct text, then one suppression
 * line, then silence. Bounded by the number of distinct warning shapes (a handful),
 * not by the size of the data crossing — otherwise a large payload whose values all
 * trip the same warning can emit hundreds of thousands of identical lines and OOM.
 *
 * Run-keyed residency (docs/execution.md §1): the table dies with the RunContext; two
 * concurrent runs each get their own budget and their own lines.
 */
const emittedByRun = new WeakMap<RunContext, Map<string, number>>();
const WARN_LIMIT = 3;

/** `outcome` (optional) overrides the default "materialized to #void" clause for a
 *  caller whose crossing lands somewhere else. Live callers (deep-restamp residual
 *  arms) genuinely materialize to #void; kept general rather than hardcoding that one
 *  shape. Lines land on `runCtx.notes`; a run without a note sink drops them. */
export function warnMembrane(runCtx: RunContext, what: string, outcome?: string): void {
  const notes = runCtx.notes;
  if (notes === undefined) return;

  const text = `[arrival membrane] ${what} crossed into Scheme and ${
    outcome ??
    "materialized to #void — it has no portable representation (the interpreter is " +
      "host-agnostic; a residual bare-fn already in a scheme spine has no re-stamp target)"
  }.`;

  let emitted = emittedByRun.get(runCtx);
  if (emitted === undefined) {
    emitted = new Map();
    emittedByRun.set(runCtx, emitted);
  }
  const seen = emitted.get(text) ?? 0;
  if (seen >= WARN_LIMIT) return;
  emitted.set(text, seen + 1);

  notes.push(text);
  if (seen + 1 === WARN_LIMIT) {
    notes.push(
      `[arrival membrane] (further identical crossings will not be reported — the fact is about the crossing, not about each value that makes it)`,
    );
  }
}
