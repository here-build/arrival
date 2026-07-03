// schema-tag — the schema DSL's ONE canonical lowering: a tagged-list type tag (the shape
// `s/object`/`s/array`/`s/enum`/`s/optional`/`s/field*` build — see `env/schema.ts`) → JSON
// Schema. Hoisted here from `arrival-inference`'s `backends/_shared.ts` (2026-07-03 — the
// "hoist-down trigger"): the `arrival/overridable` capability (`env/overridable.ts`) needed this
// exact lowering to validate a `define/overridable` type tag, and a CORE capability cannot
// depend on `@here.build/arrival-inference` without inverting the package DAG (core is
// upstream of inference, never the reverse). So the lowering moves to the one place both core
// AND inference can reach it; `arrival-inference`'s `_shared.ts` now imports it from here and
// re-exports it (byte-identical surface for its existing importers), and
// `@here.build/arrival-chain`'s `schemaToZod` imports it directly. Three consumers — the
// OpenAI/Anthropic wire schema, the HTTP validator, and the `define/overridable` runtime
// validator — now share exactly one recursion over the tag, so none of them can drift from
// either of the others.
//
// This is not incidental plumbing: per `env/schema.ts`'s header, s/* is the language's
// explicit-type syntax, and this file is one of its two projections (the runtime/operational
// one — the static projection is the type-layer/tsc bridge). A schema tag is a PROPOSITION;
// this is how it discharges as a validator.

import invariant from "tiny-invariant";

export type JsonSchema = Record<string, unknown>;

/**
 * The `/optional` compositor suffix (V's design: "use it as compositor —
 * s/string and s/string/optional"). An EXPLICIT, bounded suffix on a tag's
 * HEAD — not Ruby-style metaprogramming: exactly this one recognised suffix,
 * checked by a literal string comparison, no generic split-on-"/"-and-dispatch
 * chain. A second named suffix (if one is ever needed) gets its own literal
 * check beside this one, not a parser.
 *
 * Only meaningful on an object FIELD's tag (see the `"object"` case below,
 * the only place that reads it via {@link isOptionalTag}) — a bare/nested tag
 * has no "required" slot to drop out of. `tagToJsonSchema` strips the suffix
 * unconditionally at entry so a non-field position (a bare top-level tag, an
 * array's element tag) still lowers to a valid schema: the base type, with
 * the suffix silently ignored rather than thrown. That matches this file's
 * existing lenient posture for shape the lowering doesn't recognise (e.g. an
 * unrecognised `kind` falls through to `{}` rather than throwing); the strict
 * posture (`invariant`) stays reserved for structurally malformed input
 * (wrong-length field tuples), not for a suffix parked somewhere inert.
 */
const OPTIONAL_SUFFIX = "/optional";

/** True if this tag's head carries the `/optional` compositor suffix. */
export function isOptionalTag(tag: unknown): boolean {
  if (typeof tag === "string") return tag.endsWith(OPTIONAL_SUFFIX);
  if (Array.isArray(tag) && tag.length > 0 && typeof tag[0] === "string") return tag[0].endsWith(OPTIONAL_SUFFIX);
  return false;
}

/** Strip the `/optional` compositor suffix from a tag's head, if present. Idempotent. */
export function stripOptionalSuffix(tag: unknown): unknown {
  if (typeof tag === "string") {
    return tag.endsWith(OPTIONAL_SUFFIX) ? tag.slice(0, -OPTIONAL_SUFFIX.length) : tag;
  }
  if (Array.isArray(tag) && tag.length > 0 && typeof tag[0] === "string" && tag[0].endsWith(OPTIONAL_SUFFIX)) {
    return [tag[0].slice(0, -OPTIONAL_SUFFIX.length), ...tag.slice(1)];
  }
  return tag;
}

/**
 * The SINGLE lowering from the schema DSL's tagged-list form to JSON Schema.
 * Everything that needs a schema — OpenAI/Anthropic structured outputs, the zod validator
 * (arrival-chain's `schemaToZod`), AND `arrival/overridable`'s runtime validation — routes
 * through this one recursion, so none of them can ever drift from each other.
 *
 * Exported (not private) precisely so every consumer is a thin wrapper over this
 * output rather than a second recursion over the tag.
 */
export function tagToJsonSchema(tag: unknown): JsonSchema {
  // `/optional` is only meaningful at an object-field position (handled below,
  // in the "object" case, BEFORE recursing here) — everywhere else it's inert:
  // strip it and lower the base type.
  tag = stripOptionalSuffix(tag);
  if (typeof tag === "string") return { type: tag };
  if (!Array.isArray(tag) || tag.length === 0) return {};
  const [kind, ...rest] = tag as [string, ...unknown[]];
  switch (kind) {
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const field of rest) {
        invariant(
          Array.isArray(field) && (field.length === 2 || field.length === 3),
          "schema/object: field must be (name type) or (name type description)",
        );
        const [name, type, description] = field as [string, unknown, string?];
        const schema = tagToJsonSchema(type); // strips the field's own `/optional` suffix internally
        if (description) schema.description = description;
        properties[name] = schema;
        if (!isOptionalTag(type)) required.push(name);
      }
      return { type: "object", properties, required, additionalProperties: false };
    }
    case "array":
      return { type: "array", items: tagToJsonSchema(rest[0]) };
    case "enum": {
      // Derive the JSON Schema `type` from the values rather than hardcoding
      // "string": a numeric enum with `type:"string"` is internally inconsistent
      // (the wire schema OpenAI/Anthropic receive contradicts itself, and a
      // spec-conformant validator rejects it). All-strings ⇒ "string" (the common
      // case, unchanged); all-integers ⇒ "integer"; any non-integer number ⇒
      // "number"; a mixed-kind enum drops `type` entirely (no single JSON Schema
      // type describes it — the `enum` constraint alone carries the meaning).
      const type = enumValuesType(rest);
      return type === undefined ? { enum: rest } : { type, enum: rest };
    }
    default:
      return {};
  }
}

/** JSON Schema `type` for an enum's literal values, or undefined when mixed. */
function enumValuesType(values: readonly unknown[]): "string" | "number" | "integer" | undefined {
  if (values.length > 0 && values.every((v) => typeof v === "string")) return "string";
  if (values.length > 0 && values.every((v) => typeof v === "number")) {
    return values.every((v) => Number.isInteger(v)) ? "integer" : "number";
  }
  return undefined; // empty or mixed: let `enum` alone constrain (no contradictory `type`)
}
