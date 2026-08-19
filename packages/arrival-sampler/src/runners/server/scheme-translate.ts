// scheme-translate.ts — THE SUBTLE PART. Translate the decoded Scheme call(s) → OpenAI `tool_calls`.
//
// The constrained decode emits a POSITIONAL scheme call `(get_weather "Paris" celsius)`. OpenAI's FC contract
// wants a NAMED arguments object `{"location":"Paris","unit":"celsius"}`, stringified. Two mappings happen:
//
//   1. POSITIONAL → NAMED: arg[i] binds to the i-th parameter in the tool's JSON-Schema declaration order
//      (`Object.keys(parameters.properties)`, captured in `paramOrderByTool`). This is why the env builder and
//      the translator share ONE param-order source (tool-env.ts) — they can never disagree about slot i.
//
//   2. JSON-TYPING: a scheme atom is given its JSON type from the param's schema. A bare number `5` → JSON
//      number 5; `#t` → JSON true; a quoted string → JSON string; a `(list a b)` → JSON array; a bare SYMBOL
//      (an enum value-symbol like `celsius`) → its JSON string value. When the schema says the slot is a
//      string but the scheme atom is a bare number/symbol, we coerce to string (OpenAI args are schema-typed).
//
// A bare symbol carries no de-sanitisation map here (the server is schema-driven, not BFCL-ground-truth-driven):
// the symbol's TEXT is its value (e.g. `celsius` → "celsius"). The sanitiser in tool-env replaces non-alnum
// runs with `_`, so a multi-word enum (`San Francisco` → `San_Francisco`) would round-trip lossily; for the
// portable grammar path the enum members that survive intact are the common case, and a value-symbol
// de-sanitisation map is a documented seam (the typed-mode lens already tracks symbol↔value — wire it when
// typed lands). Multi-word enums are emitted as QUOTED STRINGS by the prompt guidance, which round-trips exactly.

import type { JSONSchemaProperty, ToolCall } from "./openai-types.js";
import type { ParsedArg, ParsedCall } from "./scheme-parse.js";

/** The per-tool data the translator needs: the positional parameter order + each param's JSON Schema. Both
 *  come from {@link import("./tool-env.js").toolsToGrantEnv} — ONE source shared with the env builder. */
export interface ToolShape {
  readonly paramOrderByTool: ReadonlyMap<string, readonly string[]>;
  readonly schemaByTool: ReadonlyMap<string, Readonly<Record<string, JSONSchemaProperty>>>;
}

/** A monotonic id minter for `tool_call.id` (OpenAI ids look like `call_abc123`; we use a deterministic
 *  `call_<n>` so a test can assert exact output). Pass a fresh counter per response for determinism. */
export function makeCallIdMinter(prefix = "call_"): () => string {
  let n = 0;
  return () => `${prefix}${n++}`;
}

/** Translate ONE parsed scheme call → an OpenAI `tool_call`. `nextId` mints the call id. The arguments object
 *  is built by mapping each positional arg to its named slot (from `paramOrderByTool`) and JSON-typing the
 *  value against that param's schema, then JSON-stringifying (OpenAI's `arguments` is a STRING). A call to an
 *  UNKNOWN tool (not in the shape map) still translates — its args bind positionally as `arg0, arg1, …` and
 *  no schema typing applies (best-effort; the grammar would normally forbid an unbound operator, so this is a
 *  defensive path for the unconstrained/test case). */
export function schemeCallToToolCall(call: ParsedCall, shape: ToolShape, nextId: () => string): ToolCall {
  const order = shape.paramOrderByTool.get(call.name);
  const schema = shape.schemaByTool.get(call.name);
  const argsObj: Record<string, unknown> = {};
  call.args.forEach((arg, i) => {
    const paramName = order?.[i] ?? `arg${i}`;
    const propSchema = schema?.[paramName];
    argsObj[paramName] = jsonValueOf(arg, propSchema);
  });
  return {
    id: nextId(),
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(argsObj) },
  };
}

/** Translate ALL parsed scheme calls → an array of OpenAI `tool_calls` (the parallel/multi-call shape). Ids
 *  are minted in emission order. */
export function schemeCallsToToolCalls(calls: readonly ParsedCall[], shape: ToolShape): ToolCall[] {
  const nextId = makeCallIdMinter();
  return calls.map((c) => schemeCallToToolCall(c, shape, nextId));
}

/** Map a parsed scheme arg → its JSON value, typed by the param schema when present. The schema is the source
 *  of truth for the target JSON type: a string-typed slot coerces a bare number/symbol to its string text; a
 *  number-typed slot coerces a numeric string to a JSON number; a boolean-typed slot maps `#t`/`#f`. Absent a
 *  schema, the scheme atom's own kind decides (number→number, bool→bool, string/symbol→string, list→array). */
function jsonValueOf(arg: ParsedArg, prop: JSONSchemaProperty | undefined): unknown {
  const targetType = prop?.type;

  if (arg.kind === "list") {
    // An array param: each element typed by the items schema; otherwise by the element's own kind.
    const itemSchema = prop?.items;
    return (arg.elements ?? []).map((el) => jsonValueOf(el, itemSchema));
  }

  // The scheme atom's intrinsic JS value (number for number, boolean for bool, the string text otherwise).
  const intrinsic: string | number | boolean =
    arg.kind === "number" ? Number(arg.value) : arg.kind === "bool" ? Boolean(arg.value) : String(arg.value);

  // Schema-directed coercion (OpenAI arguments are schema-typed).
  switch (normalizeType(targetType)) {
    case "number":
      return typeof intrinsic === "number" ? intrinsic : coerceNumber(intrinsic);
    case "boolean":
      return typeof intrinsic === "boolean" ? intrinsic : coerceBool(intrinsic);
    case "string":
      return String(intrinsic);
    case undefined:
    default:
      // No schema guidance — keep the atom's intrinsic type (a bare number stays a number, a symbol a string).
      return intrinsic;
  }
}

/** Collapse BFCL/JSON-Schema numeric-family types to one bucket so an `integer`/`float`/`number` slot all
 *  coerce a numeric atom to a JSON number. */
function normalizeType(t: string | undefined): "number" | "boolean" | "string" | undefined {
  if (t === "integer" || t === "number" || t === "float") return "number";
  if (t === "boolean") return "boolean";
  if (t === "string") return "string";
  return undefined; // array/object/dict/unknown — handled by the caller's intrinsic fallthrough.
}

/** Coerce a string/boolean to a JSON number when the schema says numeric; non-numeric text passes through as
 *  the string (a wrong-typed value the downstream tool will reject — we don't silently drop it). */
function coerceNumber(v: string | boolean): number | string | boolean {
  if (typeof v === "boolean") return v;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

/** Coerce a string to a JSON boolean for a boolean slot (`"true"`/`"false"`/`#t`/`#f` text); else pass through. */
function coerceBool(v: string | number): boolean | string | number {
  if (typeof v === "number") return v;
  if (v === "true" || v === "#t") return true;
  if (v === "false" || v === "#f") return false;
  return v;
}
