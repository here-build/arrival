// tool-env.ts — GENERALIZE the BFCL `bfclToGrantEnv` to arbitrary OpenAI tool JSON.
//
// An OpenAI tool is `{type:"function", function:{name, description, parameters:<JSON Schema>}}` — the SAME
// shape a BFCL function carries (`{name, description, parameters:{properties, required}}`). So the grant-Σ
// construction is identical to `bfclToGrantEnv`'s: bind each tool's NAME as a callable (so `makeOracle(env)`
// admits ONLY the offered tools at the operator slot), bind the `list`/`array` list-constructors (so a list
// argument is the no-quote `(list a b …)` form), and bind every closed-domain ENUM member as a value-symbol
// (so the model may NAME a bare symbol instead of quoting a string — the grammar admits it; typed-mode would
// narrow WHICH symbol per slot, deferred).
//
// The only generalization over BFCL: the parameter set comes from a raw JSON Schema (`parameters.properties`)
// rather than a `BfclFunction`. We extract the positional ORDER (`Object.keys(properties)`) here too — it is
// the SINGLE source the scheme→tool_calls translation uses to map `args[i]` → the i-th named parameter, so
// the env builder and the translator can never disagree about which slot is which.

import { oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";

import type { OpenAITool, JSONSchema, JSONSchemaProperty } from "./openai-types.js";
import { TERMINAL_VERBS } from "./terminal.js";

/** The no-op fn a rosetta (a tool name / `list` / `array`) carries. Generation never EXECUTES — the oracle
 *  reads only the env's Σ (the set of bound NAMES) + each binding's callability (a function head is callable). */
const inert = (): unknown => null;

/** The result of building a grant env from a tool set: the live {@link OracleEnvΣ} (the Σ surface the oracle
 *  constrains against) PLUS the per-tool positional parameter order, the single source for the scheme→named
 *  translation. */
export interface ToolGrant {
  /** The grant {@link OracleEnvΣ} — `makeOracle(env)` admits exactly its bound names (callable iff a fn value). */
  readonly env: OracleEnvΣ;
  /** Per tool NAME: its parameter names in JSON-Schema declaration order (= the positional scheme-arg order).
   *  The scheme→tool_calls translator reads this to name `args[i]`. */
  readonly paramOrderByTool: ReadonlyMap<string, readonly string[]>;
  /** Per tool NAME: the param name → its JSON Schema, for the JSON-typing of translated argument values
   *  (a "5" in a numeric-typed slot becomes the JSON number `5`, not the string "5"). */
  readonly schemaByTool: ReadonlyMap<string, Readonly<Record<string, JSONSchemaProperty>>>;
}

/** Sanitise an enum value into a Scheme-legal, TS-identifier-legal symbol (mirrors bfcl-types' sanitiser).
 *  Collisions are disambiguated by suffix so the symbol↔value map stays a bijection within one env. */
function sanitiseSymbol(value: string, used: Set<string>): string {
  let s = value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (s === "" || /^[0-9]/.test(s)) s = `v_${s}`;
  let cand = s;
  let i = 2;
  while (used.has(cand)) cand = `${s}_${i++}`;
  used.add(cand);
  return cand;
}

/** The properties record of a tool, declaration-ordered (empty if the tool has no parameters object). */
function propsOf(schema: JSONSchema | undefined): Readonly<Record<string, JSONSchemaProperty>> {
  return schema?.properties ?? {};
}

/**
 * Build the grant {@link OracleEnvΣ} for a set of OpenAI tools — the GENERALIZED `bfclToGrantEnv`. The Σ
 * surface is a flat bindings map fed to `oracleEnvFromBindings`, which reads exactly one bit per name: a
 * FUNCTION value is CALLABLE (an admissible operator at the head slot — tool names, the `list`/`array`
 * constructors, the terminal verbs), a NON-function value is a NAMEABLE value (an enum member the model may
 * name bare at an argument slot). No type strings are carried — `oracleEnvFromBindings`'s `signatureOf` is
 * null; typed-mode (Σ∩T) narrows per-slot via the async type lens built from the schemas (see real-decode's
 * `asyncTypeLens` TODO), NOT off the env.
 *
 * Returns the env PLUS the per-tool positional parameter order (`Object.keys(properties)`) and the per-tool
 * param schemas — the SINGLE source the scheme→tool_calls translation reads to map positional args to named,
 * JSON-typed arguments. The env builder and the translator share this one source so they can never disagree.
 *
 * For ZERO tools the env still binds the list-constructors (a degenerate Σ where no operator is offered — the
 * decode would have nothing to call; the prose path handles "no tools" upstream).
 */
export function toolsToGrantEnv(tools: readonly OpenAITool[]): ToolGrant {
  // The Σ surface as a flat bindings map: fn value ⇒ callable operator, non-fn value ⇒ nameable value.
  const bindings: Record<string, unknown> = {};
  const paramOrderByTool = new Map<string, readonly string[]>();
  const schemaByTool = new Map<string, Readonly<Record<string, JSONSchemaProperty>>>();
  const usedSymbols = new Set<string>();

  for (const tool of tools) {
    const fn = tool.function;
    const props = propsOf(fn.parameters);
    // The tool name — the only operator the oracle admits at the head slot (callable: bound to a fn).
    bindings[fn.name] = inert;
    paramOrderByTool.set(fn.name, Object.keys(props));
    schemaByTool.set(fn.name, props);
    // Closed-domain enum members → value-symbols, bound so Σ admits naming them bare at argument slots.
    // (Typed-mode would narrow WHICH symbol per slot; the grammar path admits the whole set. DEFERRED narrowing.)
    for (const p of Object.values(props)) {
      const scalar = p.type === "array" && p.items ? p.items : p;
      if (!scalar.enum) continue;
      for (const member of scalar.enum) {
        if (typeof member !== "string") continue; // numeric/bool enums are emitted as literals, not symbols.
        const symbol = sanitiseSymbol(member, usedSymbols);
        // Bind the enum symbol to its string VALUE — a NON-function value, so `isCallable` stays false and Σ
        // admits NAMING it at a value slot (never at the operator slot). scheme-translate reads the emitted
        // symbol's TEXT as the value, so no symbol↔value map is needed here (de-sanitisation is a typed-mode seam).
        bindings[symbol] = member;
      }
    }
  }

  // List constructors — bound callable so the constrained oracle admits `(list a b …)` / `(array a b …)` at an
  // argument slot (the no-quote path: quote is forbidden, so a list arg is a bound `list` call).
  bindings["list"] = inert;
  bindings["array"] = inert;

  // TERMINAL VERBS — bound callable so the constrained decode may emit `(respond "…")` to END the turn with a
  // natural-language ANSWER instead of a tool call. This is the abstain exit (irrelevance) AND the agentic-loop
  // final-answer exit; the handler maps a terminal-verb form to the prose path, never a tool_call. Admitting
  // them is the soundness fix for the over-mask the probe found (model wants `(display …)`).
  for (const verb of TERMINAL_VERBS) bindings[verb] = inert;

  return { env: oracleEnvFromBindings(bindings), paramOrderByTool, schemaByTool };
}
