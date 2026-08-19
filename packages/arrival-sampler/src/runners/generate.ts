// generate.ts — CONTRACT + helpers for generate (used by wiring).
//
// The minimal server path uses generateWithExplain with basic options. Advanced (fcEnvelope etc) are
// research. Domain-agnostic for the server.

import type { OracleScanner } from "../oracle-types.js";

export interface GenerateOptions {
  readonly constrained: boolean;
  /** The Σ-live oracle scanner (makeOracle(grantEnv)) — required for `constrained: true`. */
  readonly scanner?: OracleScanner;
  readonly maxNewTokens?: number;
  /** Optional decoder PREFILL: seed the assistant turn with this string so the output always starts
   *  with it (e.g. `"("` forces a single s-expression and skips any markdown/prose preamble). It is
   *  counted as GENERATED — `promptLength` stays at the pre-prefill length — so the oracle prefix and
   *  the decoded output both include it. */
  readonly prefill?: string;
  /** Optional system prompt. Omitted => the backend default (the materialize harness uses its
   *  apple-intents framing; the ./server path's caller supplies its own domain prompt). */
  readonly systemPrompt?: string;
  /** Research: fc-envelope etc for native FC models. Not used by the minimal OpenAI server path
   *  (which uses render-strategies for BFCL compat). */
  readonly fcEnvelope?: boolean;
  readonly fcForceOpenParen?: boolean;
  readonly thinkBudget?: number;
}

/** A backend that turns a task prompt into a Scheme program string. */
export interface SchemeGenerator {
  readonly label: string;
  /** True if this is a real downloaded model (vs the mock). */
  readonly real: boolean;
  generate(taskPrompt: string, opts: GenerateOptions): Promise<string>;
  /** Free model/tokenizer handles (no-op for the mock). */
  dispose?(): Promise<void> | void;
}

/** Frame a task + the caller-supplied system prompt into chat messages. Domain-agnostic: the system
 *  prompt is the caller's (the materialize harness supplies the apple-intents framing; the `./server`
 *  path's caller supplies its own). No baked-in domain ⇒ the shipping build pulls no fixtures. */
export function buildMessages(taskPrompt: string, systemPrompt: string): { role: string; content: string }[] {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: `User: ${taskPrompt}\nProgram:` },
  ];
}

/**
 * Extract the first balanced top-level `(...)` scheme form from a model's decoded output. Small chat
 * models often echo the conversation (`User: … Program: (…)`) before/around the program; the
 * materialization is the scheme form, so we lift it out for scoring. Returns the trimmed full string
 * unchanged if no balanced paren run is found (so the scorer still records invalid/unparseable). This
 * is PARSING, not faking — it never invents a tool call the model didn't emit. Strings are respected
 * so a `)` inside `"…"` doesn't close early.
 */
export function extractSchemeForm(raw: string): string {
  const start = raw.indexOf("(");
  if (start === -1) return raw.trim();
  let depth = 0;
  let inStr = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (ch === "\\")
        i++; // skip escaped char
      else if (ch === '"') inStr = false;
      continue;
    }
    switch (ch) {
      case '"': {
        inStr = true;
        break;
      }
      case "(": {
        depth++;
        break;
      }
      case ")": {
        depth--;
        if (depth === 0) return raw.slice(start, i + 1);

        break;
      }
      // No default
    }
  }
  return raw.slice(start).trim(); // unbalanced — hand the partial form to the scorer (→ invalid)
}
