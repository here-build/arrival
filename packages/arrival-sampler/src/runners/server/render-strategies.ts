// render-strategies.ts — the interchangeable RESULT-RENDERING seam: serialize the decoded call(s) into a chosen
// surface. The model ALWAYS generates Scheme (the fixed substrate); this only varies how the result comes out.
// Shared by BOTH consumers — the endpoint's output edge (an opt-in `render` knob) and the research sweep — by
// rendering the ONE common shape `ParsedCall[]` (scheme-parse.ts, itself a port of intent-eval's bfcl parser).
//
// Four surfaces:
//   scheme     — write-mode Scheme `(name "arg" sym)`. The native surface; round-trips through parseSchemeForms.
//   json       — `[{name, arguments}]` JSON (named via the param-order ctx, else positional-indexed).
//   python-ast — `[name(param=value, …)]` — the BFCL prompt surface its `ast.parse` reads (named via ctx).
//   tool-calls — the OpenAI `tool_calls` array as a JSON string (named via ctx).
//
// NOTE: this renders the parsed CALLS, not arrival values. arrival's value `toString` is display-mode — it drops
// the string-vs-symbol distinction (SchemeString.toString ignores write-mode), which is load-bearing here, so we
// re-serialize from the faithful `ParsedArg.kind` instead of reaching for arrival's serializer.

import type { ParsedArg, ParsedCall } from "./scheme-parse.js";

/** Context for SCHEMA-AWARE renderings: the positional→named parameter order per function (the endpoint's
 *  `paramOrderByTool`). `scheme` ignores it; `json`/`python-ast`/`tool-calls` name their args by it, falling
 *  back to positional indices when a function has no entry. */
export interface RenderContext {
  readonly paramOrder?: ReadonlyMap<string, readonly string[]>;
}

/** Serialize parsed call(s) into a named surface. Pure + deterministic. */
export interface RenderStrategy {
  readonly name: string;
  readonly description: string;
  readonly render: (calls: readonly ParsedCall[], ctx?: RenderContext) => string;
}

/** One arg as a Scheme atom (write-mode): strings quoted, symbols bare, booleans `#t`/`#f`, lists `(list …)`. */
function schemeArg(a: ParsedArg): string {
  switch (a.kind) {
    case "string":
      return JSON.stringify(a.value);
    case "number":
      return String(a.value);
    case "bool":
      return a.value ? "#t" : "#f";
    case "symbol":
      return String(a.value);
    case "list":
      return `(list ${(a.elements ?? []).map(schemeArg).join(" ")})`;
  }
}

/** One arg as a Python literal: strings/symbols quoted (a bare enum symbol is the string value BFCL expects),
 *  booleans `True`/`False`, lists `[…]`. */
function pyLiteral(a: ParsedArg): string {
  switch (a.kind) {
    case "string":
    case "symbol":
      return JSON.stringify(a.value);
    case "number":
      return String(a.value);
    case "bool":
      return a.value ? "True" : "False";
    case "list":
      return `[${(a.elements ?? []).map(pyLiteral).join(", ")}]`;
  }
}

/** One arg as a plain JS value (for JSON): a symbol is its string value (matching scheme→tool_calls). */
function jsonValue(a: ParsedArg): unknown {
  switch (a.kind) {
    case "string":
    case "symbol":
      return String(a.value);
    case "number":
      return Number(a.value);
    case "bool":
      return Boolean(a.value);
    case "list":
      return (a.elements ?? []).map(jsonValue);
  }
}

/** A call's args as a named object, keyed by the ctx param-order (positional index as a string when unknown). */
function namedArguments(call: ParsedCall, ctx?: RenderContext): Record<string, unknown> {
  const order = ctx?.paramOrder?.get(call.name);
  const out: Record<string, unknown> = {};
  call.args.forEach((a, i) => {
    out[order?.[i] ?? String(i)] = jsonValue(a);
  });
  return out;
}

function renderScheme(calls: readonly ParsedCall[]): string {
  return calls.map((c) => `(${[c.name, ...c.args.map(schemeArg)].join(" ")})`).join(" ");
}

function renderPythonAst(calls: readonly ParsedCall[], ctx?: RenderContext): string {
  const one = (c: ParsedCall): string => {
    const order = ctx?.paramOrder?.get(c.name);
    const parts = c.args.map((a, i) => {
      const param = order?.[i];
      return param !== undefined ? `${param}=${pyLiteral(a)}` : pyLiteral(a);
    });
    return `${c.name}(${parts.join(", ")})`;
  };
  return `[${calls.map(one).join(", ")}]`;
}

function renderToolCalls(calls: readonly ParsedCall[], ctx?: RenderContext): string {
  return JSON.stringify(
    calls.map((c, i) => ({
      id: `call_${i}`,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(namedArguments(c, ctx)) },
    })),
  );
}

export const RENDER_STRATEGIES: readonly RenderStrategy[] = [
  {
    name: "scheme",
    description: "Write-mode Scheme — the native surface (round-trips through parseSchemeForms).",
    render: (calls) => renderScheme(calls),
  },
  {
    name: "json",
    description: "[{name, arguments}] JSON; args named by the param-order ctx (positional-indexed otherwise).",
    render: (calls, ctx) => JSON.stringify(calls.map((c) => ({ name: c.name, arguments: namedArguments(c, ctx) }))),
  },
  {
    name: "python-ast",
    description: "[name(param=value, …)] — the BFCL prompt surface its ast.parse reads.",
    render: (calls, ctx) => renderPythonAst(calls, ctx),
  },
  {
    name: "tool-calls",
    description: "The OpenAI tool_calls array as a JSON string (named args).",
    render: (calls, ctx) => renderToolCalls(calls, ctx),
  },
];

/** Look up a render strategy by name (throws on an unknown name, so a typo in a config fails loudly). */
export function renderStrategy(name: string): RenderStrategy {
  const found = RENDER_STRATEGIES.find((s) => s.name === name);
  if (found === undefined) {
    throw new Error(`unknown render strategy ${JSON.stringify(name)} (have: ${RENDER_STRATEGIES.map((s) => s.name).join(", ")})`);
  }
  return found;
}
