// schema-to-ts — the HARVEST: a scheme-zod schema (and an AEntity's normalized
// input/output) → a TypeScript type-STRING. `signatureOf` feeds the lens's ambient
// prelude (prelude.ts, one arrow per grant tool); `printType`/`sTagToTsType` are the
// standalone schema and schema-DSL-tag printers.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW IT WORKS — three layers, each ~a handful of lines:
//
//   1. printType(schema)        — one zod schema → its TS type-string. Wraps
//                                 zod-to-ts (`zodToTs` + `printNode`) with
//                                 io:"output" (so a CODEC prints its DECODED JS
//                                 side: z.string → "string", z.number → "number",
//                                 z.exact → "number" — exact is a safe-integer ratio
//                                 of `number`s, never bigint) plus the instanceof
//                                 override below. Output is flattened to a single line.
//
//   2. the instanceof OVERRIDE  — the scheme-identity primitives (z.pair / z.schemeString /
//                                 z.schemeExact / z.lambda / …) are "custom" to zod and
//                                 UNREPRESENTABLE by default. `scheme-zod.ts`'s own
//                                 `lookupName(schema)` resolves one of them to its canonical
//                                 NAME (by identity — scheme-zod.ts is the one place that
//                                 actually knows every vocabulary item, having declared them),
//                                 and IMAGE_BY_NAME below maps that name to the TS image to
//                                 emit. This file keeps no class-name-string
//                                 or schema-identity recognition tables — a new scheme-zod
//                                 primitive only needs ONE new entry, in scheme-zod.ts's own
//                                 NAMES map, plus (if it should print as something other than
//                                 the robust `unknown` default) one IMAGE_BY_NAME entry here.
//
//   3. signatureOf(def)         — the args-vector → function-signature composer.
//                                 arrival's contract normalizes to ONE schema per side
//                                 (a z.tuple for a positional list, an array-ish schema
//                                 for a variadic / multiple-values vector — see
//                                 symbol.ts normalizeVector). We read that normalized
//                                 `in`/`out` and compose:
//                                   • input  z.tuple([A,B])  → "(a: A, b: B)"
//                                            z.tuple([])      → "()"
//                                            z.array(T)       → "(...args: T[])"  (variadic)
//                                   • output z.tuple([R])     → "R"        (1-tuple = single value)
//                                            z.tuple([A,B])   → "[A, B]"   (multiple-values)
//                                            z.array(T)       → "T[]"      (variadic values)
//                                   • rosetta is implicitly ASYNC (bake awaits) → the
//                                     return is wrapped Promise<…>; native is sync.
//                                 yielding the full ".d.ts member" arrow signature.
// ─────────────────────────────────────────────────────────────────────────────

import { zodToTs, printNode, createAuxiliaryTypeStore } from "zod-to-ts";
import type { OptionalTypeOverrideFunction } from "zod-to-ts";
import * as z from "../common/scheme-zod.js";
import { tagToJsonSchema } from "../common/schema-tag.js";
import type { AEntity } from "../common/symbol.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scheme primitive → its PLAIN-TS IMAGE  (Scheme is a TS subset; see carriers.ts).
//
// The harvest re-presents each scheme primitive as the TS type the lens narrows against:
// the membrane makes a boundary value its plain JS type, and list/pair/vector project to
// the carrier vocabulary. Keyed by SCHEMA IDENTITY. `z.pair` is `cons(schemeValue, schemeValue)` (see
// scheme-zod.ts's own doc comment on `pair`) — it carries the name "cons", not "pair", so
// it prints via the named-generic pre-check below as `Pair<SchemeValue, SchemeValue>`, not through
// this table. An unmapped custom/instanceof scheme primitive degrades to `unknown`
// (robust default — never throw; the total-harvest contract, e.g. a future zod primitive).
// ─────────────────────────────────────────────────────────────────────────────
type Ts = typeof import("typescript");
type NodeBuilder = (ts: Ts) => import("typescript").TypeNode;

const unknownNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
const stringNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
const numberNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
const booleanNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
const nullNode: NodeBuilder = (ts) => ts.factory.createLiteralTypeNode(ts.factory.createNull());
const uint8ArrayNode: NodeBuilder = (ts) => ts.factory.createTypeReferenceNode("Uint8Array", undefined);
const voidNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
/** `SchemeValue` — the honest top type `z.schemeValue` prints (carriers.ts's own
 *  declaration, ambient in the lens's prelude — see prelude.ts's `carrierVocabulary`), NOT
 *  the bare `unknown` keyword: distinct from an unmapped/unregistered schema's `unknown`
 *  DEFAULT, this is a DELIBERATE unconstrained slot. */
const schemeValueNode: NodeBuilder = (ts) => ts.factory.createTypeReferenceNode("SchemeValue", undefined);
/** `(...args: unknown[]) => unknown` — z.lambda's callable image. */
const lambdaNode: NodeBuilder = (ts) => {
  const restParam = ts.factory.createParameterDeclaration(
    undefined,
    ts.factory.createToken(ts.SyntaxKind.DotDotDotToken),
    ts.factory.createIdentifier("args"),
    undefined,
    ts.factory.createArrayTypeNode(unknownNode(ts)),
    undefined,
  );
  return ts.factory.createFunctionTypeNode(undefined, [restParam], unknownNode(ts));
};

// Keyed by the canonical NAME `scheme-zod.ts`'s `lookupName()` returns for a vocabulary
// schema — NOT class-name-string, NOT schema-object-identity. Keying on either would
// need a second recognition table here, hand-synced on every new scheme-zod primitive
// — the drift that lets a primitive (as `z.lambda` once did) ship with no printer entry
// at all. scheme-zod.ts is the one place that knows every vocabulary item's identity;
// this file only needs to know how to PRINT
// a given name, not how to RECOGNIZE one.
const IMAGE_BY_NAME: ReadonlyMap<string, NodeBuilder> = new Map<string, NodeBuilder>([
  // NOTE: no "pair" entry — `z.pair` is `cons(schemeValue, schemeValue)`, named "cons", and prints via
  // the named-generic pre-check as `Pair<SchemeValue, SchemeValue>` before this table is ever consulted.
  ["string", stringNode],
  ["exact", numberNode],
  ["inexact", numberNode],
  // number/exact/bigint are UNIONS of two same-output codecs in v2; without an image
  // they'd print the duplicated `number | number`. The image is their carrier, printed
  // once. `bigint`'s face is `number` too — per
  // docs/design-history/arrival-one-number-rework.md §2.3, exact is a safe-integer
  // ratio of `number`s and z.bigint is retired; it never decodes to a real JS bigint.
  ["number", numberNode],
  ["bigint", numberNode],
  // looseNumber / looseAnyNumber are CODECs whose OUT side is a bare z.custom (so
  // NaN/±Inf stay legal). Without an image the OUT custom leaf prints as unknown —
  // floor/abs/etc. harvest as (a: unknown) => unknown even though the decoded type is known.
  // Teach the names; do NOT rewrite OUT to z.number() (rejects non-finites).
  ["looseNumber", numberNode],
  ["looseAnyNumber", numberNode],
  ["symbol", stringNode],
  // bytevector is a CODEC in v2 (out = z.instanceof(Uint8Array), a custom leaf that would print
  // `unknown`); the name-keyed image restores its Uint8Array carrier (as v1's instanceof did).
  ["bytevector", uint8ArrayNode],
  ["nil", nullNode],
  ["boolean", booleanNode],
  ["char", stringNode],
  // The Q1 split (docs/plans/stage-c-corpse-deletion.md §"z.value retirement campaign"):
  // "schemeValue" (the honest top type, native/contour contracts) prints the real
  // `SchemeValue` alias; "dynamic" (the rosetta escape hatch) and the deprecated legacy
  // "value" alias both print the bare `unknown` keyword — same runtime shape, but
  // deliberately NOT the named alias (a rosetta `z.dynamic` slot's shape is genuinely
  // unknowable, not "any scheme value" in the native/contour sense).
  ["schemeValue", schemeValueNode],
  ["dynamic", unknownNode],
  ["value", unknownNode],
  ["lambda", lambdaNode],
  ["undefinedResult", voidNode], // R7RS's "unspecified" return — the honest TS analog is void
  // "error" has NO entry here on purpose: an unmapped NAME still falls through to the
  // `unknownNode` default below (never throw) — R7RSError has no ambient carrier type to
  // reference, so "unknown" is the honest print, not a gap.
]);

/** The zod-to-ts override: a scheme-zod vocabulary schema → its plain-TS image, resolved by
 *  `lookupName` (identity-based, owned by scheme-zod.ts itself); an UNMAPPED name (a vocabulary
 *  item this file hasn't been taught to print yet — should not happen for anything registered
 *  in scheme-zod.ts's own NAMES map, but kept as a robust default) → `unknown`, never throw
 *  (total-harvest). Non-vocabulary schemas (object/array/union/literal/… and the codecs, which
 *  print via zod-to-ts's native `io:"output"` handling) defer to zod-to-ts (return undefined).
 *
 *  A registered vocabulary name WITH an image prints that image directly (fires for CODECS too —
 *  v2 made most primitives codecs/pipes, not leaf customs). A registered name WITHOUT an image
 *  (`schemeNumber`/`vector`/`dict`/`list`/`cons`, and the number/exact/bigint UNIONs whose members
 *  carry their own image) returns undefined so zod-to-ts composes it per-member — so `z.schemeNumber`
 *  prints "number | number" (exact/inexact fire per-member, both `number`; z.bigint is
 *  retired), undeduped — the same known gap as `z.vector` below — never short-circuited. An
 *  UNregistered leaf custom degrades to `unknown` (never throw); an unregistered compound defers. */
const instanceofOverride: OptionalTypeOverrideFunction = (schema, typescript) => {
  // Named-generic pre-check — MUST fire before the leaf guard below: `list`/`cons` are CODECS
  // (`_zod.def.type === "pipe"`), so that guard would early-return them to zod-to-ts, which
  // decomposes structurally (`list` → `Cons<T> | null`, `cons` → `[A, B]`) and loses the name.
  // Scoped to EXACTLY the two registered collection names via COLLECTION_ELEMENT — a homogeneous
  // `list`/`cons` registers an element, nothing else does, so this fires for nothing but these
  // two (a `schemeNumber`-style union of custom leaves has no element registration → skips this,
  // reaching the per-member composition path below untouched).
  const element = z.lookupCollectionElement(schema);
  if (element !== undefined) {
    const name = z.lookupName(schema);
    if (name === "list" && !Array.isArray(element)) {
      return typescript.factory.createTypeReferenceNode("List", [harvestNode(element as z.ZodTypeAny)]);
    }
    if (name === "cons" && Array.isArray(element)) {
      const [carE, cdrE] = element as readonly [z.ZodTypeAny, z.ZodTypeAny];
      return typescript.factory.createTypeReferenceNode("Pair", [harvestNode(carE), harvestNode(cdrE)]);
    }
  }
  // Registered vocabulary name → its image. MUST run before the leaf guard: v2 primitives are
  // CODECS (pipe), so the guard would defer them to zod-to-ts and print the raw OUT schema
  // (undefinedResult→undefined, bytevector→unknown, number→number|number) instead of the carrier
  // image (void / Uint8Array / number). A registered name with NO image → undefined → composed
  // per-member by zod-to-ts (schemeNumber → number | number; vector/dict/list/cons → structural).
  const name = z.lookupName(schema);
  if (name !== undefined) {
    const builder = IMAGE_BY_NAME.get(name);
    return builder ? builder(typescript) : undefined;
  }
  // Unregistered: a leaf custom degrades to unknown (never throw); a compound defers to zod-to-ts.
  const s = schema as { _zod?: { def?: { type?: string } } };
  if (s?._zod?.def?.type !== "custom") return undefined;
  return unknownNode(typescript);
};

/** Collapse zod-to-ts's pretty-printed (multi-line, indented) output to a single
 *  readable line: runs of whitespace → one space, no space before ; } ] , and a
 *  trailing-member-separator tidy so an object reads "{ k: T; n: U }" (no dangling
 *  semicolon before the close brace). */
function flatten(printed: string): string {
  return printed
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .replace(/\{\s+/g, "{ ")
    .replace(/\s+\}/g, " }")
    .replace(/\s+;/g, ";")
    .replace(/\s+,/g, ",")
    .replace(/;\s*\}/g, " }") // drop the trailing member separator: "; }" → " }"
    .replace(/\{\s+\}/g, "{}")
    .replace(/\[\s*\]/g, "[]")
    .trim();
}

/**
 * Print one scheme-zod schema as a single-line TypeScript type-string.
 *
 * Codecs print their DECODED (output) side (io:"output"): z.string → "string",
 * z.number → "number", z.exact → "number" (a safe-integer ratio of `number`s —
 * z.bigint is retired, never a real bigint). instanceof primitives print their
 * class name via the override (z.pair → "Pair"). Compounds compose
 * (z.object → "{ k: T; … }", z.array → "T[]", z.tuple → "[A, B]", z.union → "A | B").
 */
// The raw zod-to-ts TypeNode for one schema (before flatten/print). Split out so the
// named-generic pre-check can nest an element's node as a type argument (`List<…>`) — a string
// can't be a TypeReferenceNode's type arg, so `printType(element)` won't do; we need the node.
function harvestNode(schema: z.ZodTypeAny): import("typescript").TypeNode {
  const { node } = zodToTs(schema as never, {
    auxiliaryTypeStore: createAuxiliaryTypeStore(),
    overrideFunction: instanceofOverride,
    io: "output",
    unrepresentable: "throw",
  });
  return node as import("typescript").TypeNode;
}

export function printType(schema: z.ZodTypeAny): string {
  return flatten(printNode(harvestNode(schema)));
}

/**
 * Print an s/* schema-DSL TAG (`tagToJsonSchema`'s own input shape — e.g.
 * `["object", ["summary", "string", "a one-line summary"]]`) as a TS type string —
 * the STATIC projection `env/schema/schema.ts`'s header promises alongside the runtime one
 * (`tagToJsonSchema` → `z.fromJSONSchema`, the validator). Routes through the SAME
 * JSON Schema lowering and the SAME zod reconstruction the runtime validator uses, so
 * this can never disagree with what a tag actually validates as. Never throws — a
 * malformed or unrepresentable tag degrades to "unknown" (the harvest's total-coverage
 * posture, matching `signatureOf`'s own catch-all).
 */
export function sTagToTsType(tag: unknown): string {
  try {
    return printType(z.fromJSONSchema(tagToJsonSchema(tag) as Parameters<typeof z.fromJSONSchema>[0]));
  } catch {
    return "unknown";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// signatureOf — the vector → function-signature composer.
//
// Reads the AEntity's NORMALIZED in/out (already one schema per side, per
// symbol.ts normalizeVector): a z.tuple for a positional list, an array-ish schema
// for a variadic / multiple-values vector. We branch on the schema's _zod.def.
// ─────────────────────────────────────────────────────────────────────────────

interface TupleDef {
  type: "tuple";
  items: readonly z.ZodTypeAny[];
  rest?: z.ZodTypeAny | null;
}
interface ArrayDef {
  type: "array";
  element: z.ZodTypeAny;
}

function zodDef(schema: z.ZodTypeAny): { type?: string } & Partial<TupleDef> & Partial<ArrayDef> {
  return (schema as { _zod?: { def?: unknown } })._zod?.def as never;
}

/** Spreadsheet-style positional parameter names: a, b, … z, a1, b1, … */
function paramName(i: number): string {
  const letter = String.fromCharCode(97 + (i % 26));
  const wrap = Math.floor(i / 26);
  return wrap === 0 ? letter : letter + String(wrap);
}

/** The PARAMETER LIST from a normalized input schema. A z.tuple → "(a: A, b: B)"
 *  (its items, named positionally; empty → "()"); an array-ish schema → a variadic
 *  rest param "(...args: T[])". */
function paramList(input: z.ZodTypeAny): string {
  const def = zodDef(input);
  if (def.type === "tuple") {
    const items = def.items ?? [];
    const params = items.map((item, i) => `${paramName(i)}: ${printType(item)}`);
    // A variadic tail (z.tuple([...], rest)) → a trailing rest param. A ZERO-item tuple+rest
    // (e.g. `{input: [], inputRest: z.value}`) has no fixed prefix at all — structurally the
    // same "purely variadic" shape as the array-ish branch below, so it gets the same "args"
    // name; only a genuine fixed-head-plus-tail earns the "rest" name.
    if (def.rest != null) params.push(`...${items.length === 0 ? "args" : "rest"}: ${printType(def.rest)}[]`);
    return `(${params.join(", ")})`;
  }
  // array-ish (z.array) input → variadic rest of the element type.
  if (def.type === "array" && def.element != null) {
    return `(...args: ${printType(def.element)}[])`;
  }
  // Any other single schema as the whole input vector: one positional arg.
  return `(a: ${printType(input)})`;
}

/** The RETURN TYPE from a normalized output schema. A 1-tuple → bare "R" (single
 *  value); an n-tuple → "[A, B]" (multiple-values); an array-ish schema → "T[]"
 *  (variadic values). */
function returnType(output: z.ZodTypeAny): string {
  const def = zodDef(output);
  if (def.type === "tuple") {
    const items = def.items ?? [];
    if (def.rest == null && items.length === 1) {
      // 1-tuple output = the impl returns a SINGLE value (symbol.ts isSingleOutput).
      return printType(items[0]);
    }
    // n-tuple (or variadic tuple) = the multiple-values vector.
    return printType(output);
  }
  // array-ish output (z.array) prints as "T[]" directly.
  return printType(output);
}

/**
 * Compose the full ".d.ts member" arrow signature for a baked AEntity.
 *
 *   native  → "(a: A, b: B) => R"            (sync; impl works on scheme values)
 *   rosetta → "(a: A, b: B) => Promise<R>"   (bake awaits → implicitly async)
 *   door    → "never"                         (an omitted verb; not callable)
 *
 * A 1-tuple output collapses to a bare return; an n-tuple becomes a
 * multiple-values "[A, B]"; a variadic input becomes "(...args: T[])".
 */
export function signatureOf(def: AEntity): string {
  // door = omitted verb (not callable); keyword = special-form syntax; macro / define-syntax
  // = a non-evaluating transformer (syntax, not a value-level callable — a `symbol.defineSyntax`
  // body's "free variables" name the EXPANSION env, a categorically different story from a
  // value-level callable's argument list). None carries an in/out codec surface, so all print
  // as `never` until the type-lens grows a dedicated syntax representation.
  if (def.kind === "door" || def.kind === "keyword" || def.kind === "macro" || def.kind === "define-syntax") {
    return "never";
  }
  // A `symbol.value` raw DATA binding carries no contract at all — nothing to derive a
  // signature from (the value is host-supplied, its shape undeclared). Loose by design.
  if (def.kind === "value") return "unknown";
  // Author-asserted `type` override (Contract.type on native/rosetta/sequence/define, or
  // TaglessGuardSymbolDef.type on type-predicate guards). Present ⇒ final for the harvest;
  // absent ⇒ derive from in/out. `"type" in def` so pure-tagless (no field) falls through.
  if ("type" in def && def.type !== undefined) return def.type;
  try {
    // A `symbol.define` CONSTANT (`callable: false`) is a plain VALUE, not a call
    // boundary — harvests as its bare return type (`declare const x: T;`), never an
    // arrow (`in`/`out` still normalize to the 0-ary-procedure convention, so
    // `paramList(def.in)` would print a spurious `()` param list for it).
    if (def.kind === "define" && !def.callable) return returnType(def.out);
    const params = paramList(def.in);
    const ret = returnType(def.out);
    // Only "rosetta" is a genuine JS-membrane crossing (async by construction); every
    // other kind — including "define", a scheme-face contour like "native"/"sequence"/
    // "tagless" (its JS impl happens to await internally, but that's an implementation
    // detail of the validating wrapper, not a membrane crossing) — harvests SYNC.
    const wrapped = def.kind === "rosetta" ? `Promise<${ret}>` : ret;
    return `${params} => ${wrapped}`;
  } catch {
    // TOTAL HARVEST: an unrepresentable schema must NEVER collapse typed mode — degrade this
    // ONE symbol to a loose arrow (it just isn't narrowed; its slots stay Σ-only), never throw.
    return "(...args: unknown[]) => unknown";
  }
}
