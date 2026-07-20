// tool-signature — turns a remote tool's JSON Schema into an ordered kwarg param list
// (required first, optional second, each in declared order) plus a one-line catalog
// signature. `(server/tool :prop1 value1 :prop2 value2)` — arrival's kwargs runtime
// (bakeRosetta) folds `:key value` pairs into an object before decode (bind.ts).
//
// The JSON-Schema shapes and `orderedFields` reuse mcp-substrate's `tool-schema.ts`.
// The kwargs-catalog RENDERER stays here, binder-side: a positional consumer would
// render signatures differently.

import {
  orderedFields,
  type JsonSchemaProperty,
  type ToolJsonSchema,
  type KwargParam,
  type ToolSignature,
} from "@inhuman.tools/mcp-substrate";

export {
  orderedFields,
  type JsonSchemaProperty,
  type ToolJsonSchema,
  type KwargParam,
  type ToolSignature,
} from "@inhuman.tools/mcp-substrate";

/** Recursion ceiling for nested shape rendering. Deep enough for every real MCP schema
 *  seen in the wild; a pathological deeper schema degrades to "value"/"[value]" rather
 *  than exploding the catalog line. */
const MAX_SHAPE_DEPTH = 6;

/** A nested field's description rides as an inline scheme block comment — but only when
 *  it says something the field NAME doesn't already say (case-insensitive; a trailing
 *  period doesn't count as saying more). `#|…|#` is the reader's own comment syntax, so
 *  a signature shape pasted into a program stays parseable. */
function fieldComment(name: string, prop: JsonSchemaProperty): string {
  const desc = prop.description?.trim();
  if (!desc) return "";
  if (desc.replace(/\.$/, "").toLowerCase() === name.toLowerCase()) return "";
  return ` #|${desc.replaceAll("|#", "|\u0023")}|#`;
}

/** Render an object schema's fields as `{field:type #|desc|#, ...}`, recursively. */
function objectToken(prop: JsonSchemaProperty, depth: number): string {
  if (depth >= MAX_SHAPE_DEPTH) return "value";
  const fields = orderedFields(prop).map(
    ({ name, optional, prop: field }) =>
      `${name}:${typeToken(field, depth + 1)}${optional ? "?" : ""}${fieldComment(name, field)}`,
  );
  return fields.length > 0 ? `{${fields.join(", ")}}` : "object";
}

/** Render array `items` as `[<elem>]` — `[string]`, `[{field:type, ...}]`, `[value]`
 *  when the element type is undeclared. */
function arrayToken(items: JsonSchemaProperty | undefined, depth: number): string {
  if (depth >= MAX_SHAPE_DEPTH) return "[value]";
  if (!items) return "[value]";
  return `[${typeToken(items, depth)}]`;
}

/** One property's catalog type token — enum wins regardless of declared `type`;
 *  scalars map to their Scheme-ish reading; arrays and objects render their SHAPE
 *  recursively (the nested keys are exactly what a caller must author — hiding them
 *  behind "value" cost 1.9pp on MCP-Atlas, the clinicaltrials 34-blind-guesses task);
 *  everything else is "value". */
function typeToken(prop: JsonSchemaProperty, depth = 0): string {
  if (prop.enum && prop.enum.length > 0) return prop.enum.map((v) => JSON.stringify(v)).join("|");
  // Unions: anyOf/oneOf members render as pipe alternatives (the same convention enum
  // already established); a type ARRAY (["string","null"]) is the scalar-union spelling.
  const members = prop.anyOf ?? prop.oneOf;
  if (members && members.length > 0) {
    const tokens = [...new Set(members.map((m) => typeToken(m, depth)))];
    return tokens.join("|");
  }
  if (Array.isArray(prop.type)) {
    const tokens = [...new Set(prop.type.map((t) => typeToken({ ...prop, type: t }, depth)))];
    return tokens.join("|");
  }
  if (prop.type === "object" || (prop.type === undefined && prop.properties)) {
    return objectToken(prop, depth);
  }
  switch (prop.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "nil";
    case "array":
      return arrayToken(prop.items, depth);
    default:
      return "value";
  }
}

/** Required first, optional second, each group in declaration order (the same
 *  ordering governs both input kwargs and the descriptive return shape). */
function orderedParams(schema: ToolJsonSchema | undefined): KwargParam[] {
  return orderedFields(schema).map(({ name, optional, prop }) => ({
    name,
    optional,
    typeToken: typeToken(prop),
    schema: prop,
  }));
}

/** The `-> {field:type, ...}` suffix for a tool's declared return shape (no `:` prefix
 *  — these are descriptive, never typed). `undefined` when the shape is empty or
 *  absent; the preamble explains the default once per crate. */
function renderOutputShape(outputSchema: ToolJsonSchema | undefined): string | undefined {
  const params = orderedParams(outputSchema);
  if (params.length === 0) return undefined;
  const fields = params.map((p) => {
    const optionalMark = p.optional ? "?" : "";
    const descSuffix = p.schema.description ? ` (${p.schema.description})` : "";
    return `${p.name}:${p.typeToken}${optionalMark}${descSuffix}`;
  });
  return `{${fields.join(", ")}}`;
}

export function toolSignature(
  qualifiedName: string,
  description: string | undefined,
  schema: ToolJsonSchema | undefined,
  outputSchema?: ToolJsonSchema,
): ToolSignature {
  const params = orderedParams(schema);

  const paramTokens = params.map((p) => {
    const optionalMark = p.optional ? "?" : "";
    const descSuffix = p.schema.description ? ` (${p.schema.description})` : "";
    return `:${p.name} ${p.typeToken}${optionalMark}${descSuffix}`;
  });
  const head = paramTokens.length > 0 ? `${qualifiedName} ${paramTokens.join(" ")}` : qualifiedName;
  const outputShape = renderOutputShape(outputSchema);
  const outputSuffix = outputShape ? ` -> ${outputShape}` : "";
  const signatureText = description ? `(${head})${outputSuffix} - ${description}` : `(${head})${outputSuffix}`;

  return { params, signatureText };
}
