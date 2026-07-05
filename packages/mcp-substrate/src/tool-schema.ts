// Runner-owned half of manifold's tool-signature.ts split (Opus Round 3 finding): the JSON-Schema
// shape types and the `orderedFields` traversal are needed by runner-bound files (doors.ts,
// example-call.ts) — only the kwargs-specific `toolSignature()` catalog-text RENDERER stays
// binder-side (arrival-manifold/src/tool-signature.ts), since a positional consumer renders a
// signature differently. Kept byte-identical to the pre-split shapes/logic — a pure relocation.

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: readonly unknown[];
  items?: JsonSchemaProperty;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  minimum?: number;
  maximum?: number;
  examples?: readonly unknown[];
  default?: unknown;
  const?: unknown;
}

export interface ToolJsonSchema {
  type?: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
}

export interface KwargParam {
  name: string;
  optional: boolean;
  typeToken: string;
  schema: JsonSchemaProperty;
}

export interface ToolSignature {
  params: readonly KwargParam[];
  signatureText: string;
}

/** Required fields first, then optional, each group in its declared order — shared ordering rule
 *  for a tool's top-level param list and any nested object shape. */
export function orderedFields(
  schema: { properties?: Record<string, JsonSchemaProperty>; required?: readonly string[] } | undefined,
): Array<{ name: string; optional: boolean; prop: JsonSchemaProperty }> {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required);
  const entries = Object.entries(properties);

  const requiredFields = entries.filter(([name]) => required.has(name));
  const optionalFields = entries.filter(([name]) => !required.has(name));

  return [...requiredFields, ...optionalFields].map(([name, prop]) => ({
    name,
    optional: !required.has(name),
    prop,
  }));
}
