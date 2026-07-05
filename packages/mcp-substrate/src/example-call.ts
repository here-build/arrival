// example-call — synthesizes a complete, syntactically valid Scheme call string straight off a
// tool's JSON Schema, e.g. `(filesystem_read_text_file :path "string value")`. V's design
// (2026-07-05): this REPLACES name-only "did you mean X" teaching with a FULL WORKING CALL
// EXAMPLE — the model can copy it verbatim and only needs to fill in real values, instead of
// re-deriving the call shape from a bare symbol name or a one-line signature.
//
// This is the SCHEMA-driven half of "teach with a working call": doors.ts's renderRetryExpr/
// renderJsonLiteral already render a call from ARGS the caller actually supplied; this file
// produces the args when none were given (or none were usable), by stubbing a minimal value for
// every REQUIRED param straight off the tool's declared shape. Two consumers, both in this
// package: the unbound-in-expr door (doors.ts, a resolved-tool teaching upgrade) and the
// tool-misuse/signature-echo error transform (manifold-tool.ts). Lives alongside
// tool-signature.ts — the ONE shared `JsonSchemaProperty`/`ToolJsonSchema` representation both
// the catalog and this file read; see that file for the required-first-then-optional ordering
// rule (`orderedFields`) and the one-level object-nesting bound (`arrayToken`) this mirrors.
//
// RENDERING NOTE: the final call text uses the SAME kwargs literal grammar as doors.ts's
// `renderRetryExpr`/`renderJsonLiteral` (`:key value` pairs, `{...}` dict / `[...]` list
// literals, quoted/escaped strings, `nil` for null/undefined — see render-observation.ts for the
// same brace/bracket convention on the OBSERVATION side of this round-trip). It is MIRRORED here
// rather than imported: doors.ts calls `synthesizeExampleCall` (the unbound-in-expr door
// upgrade), so importing the renderer back FROM doors.ts would cycle. The two renderers must
// stay byte-identical — a future change to either literal grammar must be applied to both.

import { orderedFields, type JsonSchemaProperty, type ToolJsonSchema } from "./tool-schema.js";

// ─── literal rendering — mirrors doors.ts's escapeString/renderJsonLiteral/renderRetryExpr ───

const escapeString = (s: string): string =>
  s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', String.raw`\"`)
    .replaceAll("\n", String.raw`\n`)
    .replaceAll("\t", String.raw`\t`)
    .replaceAll("\r", String.raw`\r`);

const BARE_KEY = /^[a-z][\w-]*$/i;

function renderLiteral(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return `"${escapeString(value)}"`;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((v) => renderLiteral(v)).join(" ")}]`;
  if (typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      const key = BARE_KEY.test(k) ? `:${k}` : `"${escapeString(k)}"`;
      return `${key} ${renderLiteral(v)}`;
    });
    return `{${pairs.join(" ")}}`;
  }
  return `"${escapeString(String(value))}"`;
}

function renderCall(qualifiedName: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return `(${qualifiedName})`;
  // A required property whose name isn't a bare scheme identifier cannot be expressed as a
  // `:key value` kwargs pair at all — verified empirically: `:"weird key"` does not parse as a
  // quoted-keyword atom (the reader splits it into a bare `:` and a stray string, producing an
  // unrelated "Unbound variable" error, never a working call — quoting only exists as a DICT
  // LITERAL key, a different grammar slot `renderLiteral` already handles, not a kwargs-call
  // key). Rather than emit syntax that silently fails to parse as intended, degrade to the SAME
  // safe bare-call fallback this file already uses for "no schema"/"all-optional" — never a
  // crash, never a fabricated-looking but broken argument.
  if (entries.some(([k]) => !BARE_KEY.test(k))) return `(${qualifiedName})`;
  const kwargs = entries.map(([k, v]) => `:${k} ${renderLiteral(v)}`).join(" ");
  return `(${qualifiedName} ${kwargs})`;
}

// ─── stub synthesis ───

/** A private sentinel distinguishing "no real value was authored" from a legitimately-authored
 *  `null`/`0`/`false` (any of `const`/`examples[0]`/`default` CAN genuinely be one of those) — a
 *  plain `undefined` return can't carry that distinction since `undefined` is also JS's "absent
 *  key" value. */
const NO_REAL_VALUE = Symbol("no-real-value");

/** A schema-authored REAL value, in priority order: `const` (the schema pins EXACTLY one legal
 *  value — the strongest possible hint) > the first of `examples` (an author-curated realistic
 *  sample) > `default` (what the tool assumes when the caller omits the field — the weakest of
 *  the three: it describes absence, not a demonstration of a good value to pass). Only
 *  `NO_REAL_VALUE` when none of the three is present — the caller then falls through to
 *  type-based synthesis (which itself still prefers `enum` over the bare declared `type`). */
function realValueOf(prop: JsonSchemaProperty): unknown {
  if (prop.const !== undefined) return prop.const;
  if (prop.examples && prop.examples.length > 0) return prop.examples[0];
  if (prop.default !== undefined) return prop.default;
  return NO_REAL_VALUE;
}

/** `0` if it satisfies both `minimum`/`maximum` (when declared); otherwise the nearest bound
 *  that does — e.g. `minimum: 5` synthesizes `5`; `maximum: -3` synthesizes `-3`. Order of the
 *  two clamps doesn't matter for a well-formed schema (`minimum <= maximum`). */
function numericStub(prop: JsonSchemaProperty): number {
  let v = 0;
  if (prop.minimum !== undefined && v < prop.minimum) v = prop.minimum;
  if (prop.maximum !== undefined && v > prop.maximum) v = prop.maximum;
  return v;
}

/** How many items an array stub needs to stay SCHEMA-VALID (found+fixed 2026-07-05: neither
 *  `minItems` nor `maxItems` was ever read here — confirmed empirically that a declared
 *  `minItems: 3` still synthesized a single-item array, a call that fails the tool's own
 *  schema). `1` is the floor absent a declared `minItems` — it exists to demonstrate the
 *  element shape at all, same rationale as always stubbing a required param instead of
 *  omitting it; `minItems` only ever raises that floor, never lowers it below what a
 *  DECLARED `minItems` demands. `maxItems` clamps LAST (mirrors `numericStub`'s own
 *  minimum-then-maximum order), so a self-contradictory schema (`minItems > maxItems`) lands
 *  on the maximum — some bound honored, never a crash — the exact same defensible-not-crash
 *  precedent `numericStub` documents for contradictory `minimum`/`maximum`. A `maxItems: 0`
 *  (an array that must stay empty) correctly synthesizes zero items, not one. */
function arrayItemCount(prop: JsonSchemaProperty): number {
  let count = Math.max(1, prop.minItems ?? 0);
  if (prop.maxItems !== undefined) count = Math.min(count, prop.maxItems);
  return Math.max(0, count);
}

/** One level of object-property expansion, mirroring `tool-signature.ts`'s `arrayToken` bound —
 *  UNLIKE that function (which only ever expands an ARRAY's object items; a bare nested object
 *  param renders as the generic "value" token in the catalog, since `typeToken` has no "object"
 *  case at all), stub synthesis needs an ACTUAL value for a bare nested-object property too, so
 *  it recurses on any object-shaped property — bounded the SAME one-level-deep way. Beyond that
 *  bound, further nesting collapses to an empty object rather than recursing again (the value-
 *  synthesis analogue of `arrayToken`'s own collapse to the bare `"list"` token at the same
 *  depth) — a `depth` counter shared between "entered via an array's object items" and "entered
 *  via a bare object-typed property" increments ONLY on this step, never merely for crossing an
 *  array (matching `arrayToken`'s own `typeToken(prop, depth + 1)` call, which increments when
 *  expanding an object's OWN field types, not when descending into the array itself). */
const MAX_OBJECT_DEPTH = 1;

function stubObject(
  schema: { properties?: Record<string, JsonSchemaProperty>; required?: readonly string[] },
  depth: number,
): Record<string, unknown> {
  if (depth >= MAX_OBJECT_DEPTH) return {};
  return requiredStubs(schema, depth + 1);
}

/** One property's stub value at the given object-nesting `depth` (see `stubObject`'s doc for
 *  the depth convention — an array does NOT itself consume a depth level; only entering an
 *  object's own required fields does, whether reached directly or through an array's items).
 *
 *  Exported: a positional-tuple consumer (arrival-mcp) reuses this same stub-synthesis logic
 *  per tuple element (via `z.toJSONSchema()`, which re-emits the same `JsonSchemaProperty`
 *  shape), rather than re-deriving a second stub synthesizer for a different call grammar. */
export function stubValue(prop: JsonSchemaProperty, depth: number): unknown {
  const real = realValueOf(prop);
  if (real !== NO_REAL_VALUE) return real;
  // enum wins over the declared `type`, mirroring `typeToken`'s own treatment — but only once
  // no const/examples/default was authored (those are stronger, more specific hints than an
  // arbitrary first-listed enum member).
  if (prop.enum && prop.enum.length > 0) return prop.enum[0];
  switch (prop.type) {
    case "string":
      return "string value";
    case "number":
    case "integer":
      return numericStub(prop);
    case "boolean":
      // Either true or false is defensible (the spec has no universal convention); false
      // mirrors the numeric stub's own "zero value" choice (0) — the same neutral, additive-
      // identity-flavored default across both scalar kinds, rather than an arbitrary pick.
      return false;
    case "array": {
      // `arrayItemCount(prop)` recursively-synthesized items (usually 1 — enough to
      // demonstrate the element shape — but raised to satisfy a declared `minItems` and
      // clamped to a declared `maxItems`, found+fixed 2026-07-05), wrapped in the `[...]`
      // list-literal grammar — the SAME bracket convention render-observation.ts/doors.ts
      // already use for a JS array (never the `#(...)` reader vector-literal form, which this
      // codebase reserves for a genuine Scheme vector value, not a JSON-array-shaped tool
      // argument). No declared `items` schema degrades to an empty JsonSchemaProperty, which
      // itself falls through to the "unknown type" fallback below — the same "string value"
      // safest-fallback a required-but-untyped property gets. Every item is the SAME
      // recursively-synthesized stub (this dialect has no "vary the Nth element" concept to
      // synthesize against) — repeating it is what makes a `minItems`-driven count valid.
      const count = arrayItemCount(prop);
      return Array.from({ length: count }, () => stubValue(prop.items ?? {}, depth));
    }
    case "object":
      return stubObject(prop, depth);
    default:
      // No declared `type` (or one this dialect doesn't recognize) — `properties` alone is
      // still shorthand for an object schema, mirroring `arrayToken`'s own `isObjectItems`
      // check (`items.type === "object" || !!items.properties`).
      if (prop.properties) return stubObject(prop, depth);
      // Truly unknown/missing type with no real value and no shape to recurse into — the
      // safest generic fallback: a quoted string is valid input to nearly every param shape
      // (a string-typed param takes it verbatim; most other upstream handlers can at least
      // parse or report on a string better than an arbitrarily-typed placeholder).
      return "string value";
  }
}

/** Stub every REQUIRED field of `schema` (dropping optional ones ENTIRELY, at every nesting
 *  level — not just the top-level call) into a plain args object, in `orderedFields`'s declared
 *  order. V's design: the synthesized example is the MINIMAL schema-valid call, so a nested
 *  object's optional fields are omitted the same way a top-level optional param is — the
 *  smallest call that still type-checks, never the maximal one. */
function requiredStubs(
  schema: { properties?: Record<string, JsonSchemaProperty>; required?: readonly string[] } | undefined,
  depth: number,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const { name, optional, prop } of orderedFields(schema)) {
    if (optional) continue;
    args[name] = stubValue(prop, depth);
  }
  return args;
}

/** Synthesize a complete, syntactically valid example call for `qualifiedName` off its declared
 *  input `schema` — every REQUIRED top-level param gets a minimal stub value (a real
 *  const/examples/default when the schema authors one, else a type-appropriate placeholder);
 *  every optional param is omitted. `schema` absent (no tool schema known), an empty object
 *  schema, or an all-optional schema all degrade gracefully to a bare `(qualifiedName)` call —
 *  never a crash, never a fabricated required-looking argument. */
export function synthesizeExampleCall(qualifiedName: string, schema: ToolJsonSchema | undefined): string {
  return renderCall(qualifiedName, requiredStubs(schema, 0));
}
