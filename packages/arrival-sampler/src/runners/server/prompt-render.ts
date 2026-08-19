// prompt-render.ts — render the offered tools into the model's SYSTEM PROMPT, two ways:
//
//   • VERBOSE (FC contract)  — the full tool schema: name, description, each parameter with type/enum/required
//     and its description. The context-rich surface a large-context FC client expects.
//   • COMPACT (prompt contract) — a terse tool surface: name + a one-line positional signature (param names +
//     scalar types, enums abbreviated). NO descriptions, NO per-param doc. The context-efficiency win for
//     small-context models — the grammar still enforces validity, so the prompt only has to TEACH the surface,
//     not exhaustively document it.
//
// BOTH instruct ONE positional Scheme call. The decode is constrained-scheme in both contracts; only the
// rendered surface (and the response edge) differ. The grammar (Σ) — built from the SAME tools — is the actual
// validity guarantee; the prompt is guidance.

import type { OpenAITool, JSONSchema, JSONSchemaProperty } from "./openai-types.js";
import { CANONICAL_TERMINAL_VERB } from "./terminal.js";

/** A terse scalar type label for a param (enum → `enum{a|b|c}`, array → `T[]`). */
function compactType(p: JSONSchemaProperty): string {
  const scalar = p.type === "array" && p.items ? p.items : p;
  const base = scalar.enum && scalar.enum.length > 0 ? `enum{${scalar.enum.map(String).join("|")}}` : scalar.type ?? "any";
  return p.type === "array" ? `${base}[]` : base;
}

/** The positional signature line for a tool: `name(p1:type, p2:type, …)`. Shared by both renderers (the
 *  compact surface is JUST these lines; the verbose surface adds descriptions + required flags around them). */
function signatureLine(name: string, schema: JSONSchema | undefined): string {
  const props = schema?.properties ?? {};
  const params = Object.entries(props).map(([pn, p]) => `${pn}:${compactType(p)}`);
  return `${name}(${params.join(", ")})`;
}

/** The shared call-shape instructions (the rules the decode is constrained to anyway — restating them teaches
 *  the model the surface). Identical in both contracts. */
const CALL_RULES = [
  "Emit ONE Scheme function call over the tools — and nothing else.",
  `To reply in plain text instead — when NO tool fits the request, or once you have the final answer — write \`(${CANONICAL_TERMINAL_VERB} "your answer here")\`.`,
  "Arguments are POSITIONAL, in the parameter's declared order.",
  "Strings in double-quotes, numbers bare, booleans #t/#f.",
  "For a list argument, write (list a b c).",
  "For a parameter with listed choices, write the bare symbol of the choice.",
];

/**
 * VERBOSE system prompt (FC contract): the full schema for every tool. Each tool gets its description, a
 * positional signature, and a per-parameter block (type, enum, required flag, description). The rich surface.
 */
export function renderVerboseToolPrompt(tools: readonly OpenAITool[]): string {
  const blocks = tools.map((tool) => {
    const fn = tool.function;
    const props = fn.parameters?.properties ?? {};
    const required = new Set(fn.parameters?.required ?? []);
    const paramLines = Object.entries(props).map(([pn, p]) => {
      const scalar = p.type === "array" && p.items ? p.items : p;
      const enumStr = scalar.enum ? ` (one of: ${scalar.enum.map(String).join(", ")})` : "";
      const arr = p.type === "array" ? "[]" : "";
      const req = required.has(pn) ? "required" : "optional";
      return `    - ${pn}: ${scalar.type ?? "any"}${arr}${enumStr} [${req}]${p.description ? ` — ${p.description}` : ""}`;
    });
    return [
      `FUNCTION ${signatureLine(fn.name, fn.parameters)}`,
      fn.description ? `  ${fn.description}` : "",
      paramLines.length > 0 ? "  PARAMETERS:" : "  (no parameters)",
      ...paramLines,
    ]
      .filter((l) => l !== "")
      .join("\n");
  });
  return [
    "You translate the user's request into ONE Scheme function call over the tools below.",
    ...CALL_RULES,
    "",
    "TOOLS:",
    blocks.join("\n\n"),
  ].join("\n");
}

/**
 * COMPACT system prompt (prompt contract): a terse tool surface — one signature line per tool, no descriptions.
 * The context-efficiency surface for small-context models: the grammar enforces validity, so the prompt only
 * lists names + positional signatures + the call rules.
 */
export function renderCompactToolPrompt(tools: readonly OpenAITool[]): string {
  const sigs = tools.map((tool) => `  ${signatureLine(tool.function.name, tool.function.parameters)}`);
  return [
    "You translate the user's request into ONE Scheme function call over these tools.",
    ...CALL_RULES,
    "",
    "TOOLS:",
    ...sigs,
  ].join("\n");
}

/** Select the system prompt renderer by output contract: FC → verbose, prompt → compact. */
export function renderToolPrompt(tools: readonly OpenAITool[], contract: "fc" | "prompt"): string {
  return contract === "prompt" ? renderCompactToolPrompt(tools) : renderVerboseToolPrompt(tools);
}
