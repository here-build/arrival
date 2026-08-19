// prompt-strategies.ts — different ways to render the offered tools (Σ) into the system prompt.
//
// Experiments with how the formal substrate is described to the LLM. One axis for studying
// strategy quality under the oracle. 

import type { OpenAITool } from "../../../src/runners/server/openai-types.js";
import { renderCompactToolPrompt, renderVerboseToolPrompt } from "../../../src/runners/server/prompt-render.js";
import { CANONICAL_TERMINAL_VERB } from "../../../src/runners/server/terminal.js";

/** A named prelude strategy: render the offered tools into the model's system prompt. Pure + deterministic. */
export interface PromptStrategy {
  readonly name: string;
  readonly description: string;
  readonly render: (tools: readonly OpenAITool[]) => string;
}

const SCHEME_CALL_RULES = [
  "Emit ONE Scheme function call and nothing else. Arguments are POSITIONAL, in declared order.",
  "Strings in double-quotes, numbers bare, booleans #t/#f. For a list argument write (list a b c).",
  `To reply in plain text instead — when no tool fits — write (${CANONICAL_TERMINAL_VERB} "your answer").`,
];

/** SYMBOLS: the barest surface — just the callable symbol names + the call rules. Leans entirely on the grammar
 *  for validity; tests whether a model needs the schema at all, or just the names. */
function renderSymbolsPrompt(tools: readonly OpenAITool[]): string {
  const names = tools.map((t) => t.function.name);
  return [
    "You translate the user's request into ONE Scheme call over these tool symbols:",
    `  ${names.join("  ")}`,
    "",
    ...SCHEME_CALL_RULES,
  ].join("\n");
}

/** SCHEME-DECL: declare each tool as a Scheme procedure header — the surface expressed in the model's OWN output
 *  language. Hypothesis: a model emitting Scheme decodes a Scheme declaration more faithfully than JSON schema. */
function renderSchemeDeclPrompt(tools: readonly OpenAITool[]): string {
  const decls = tools.map((t) => {
    const params = Object.keys(t.function.parameters?.properties ?? {});
    const head = `(define (${[t.function.name, ...params].join(" ")}) …)`;
    return t.function.description ? `  ${head}   ; ${t.function.description}` : `  ${head}`;
  });
  return [
    "These Scheme procedures are available; call ONE of them:",
    ...decls,
    "",
    ...SCHEME_CALL_RULES,
  ].join("\n");
}

/** The prelude strategies under experiment. `verbose`/`compact` reuse the production renderers (full schema vs
 *  positional signatures); `symbols`/`scheme-decl` are the leaner shapes worth measuring against them. */
export const PROMPT_STRATEGIES: readonly PromptStrategy[] = [
  {
    name: "verbose",
    description: "Full schema per tool: name, description, typed params, required flags.",
    render: (tools) => renderVerboseToolPrompt(tools),
  },
  {
    name: "compact",
    description: "One positional signature line per tool, no descriptions.",
    render: (tools) => renderCompactToolPrompt(tools),
  },
  {
    name: "symbols",
    description: "Bare callable-symbol list + call rules — leans on the grammar for validity.",
    render: renderSymbolsPrompt,
  },
  {
    name: "scheme-decl",
    description: "Scheme (define (name args…)) declarations — the surface in the model's own output language.",
    render: renderSchemeDeclPrompt,
  },
];

/** Look up a strategy by name (throws on an unknown name, so a typo in an experiment config fails loudly). */
export function promptStrategy(name: string): PromptStrategy {
  const found = PROMPT_STRATEGIES.find((s) => s.name === name);
  if (found === undefined) {
    throw new Error(`unknown prompt strategy ${JSON.stringify(name)} (have: ${PROMPT_STRATEGIES.map((s) => s.name).join(", ")})`);
  }
  return found;
}
