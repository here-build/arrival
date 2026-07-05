// schema-to-ts — the HARVEST: a scheme-zod schema (and an AEntity's normalized
// input/output) → a TypeScript type-STRING. This is what will (post-migration)
// replace the hand-written `type:` field on every symbol; for now it is a
// STANDALONE printer — nothing wires it into the type-lens yet.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW IT WORKS — three layers, each ~a handful of lines:
//
//   1. printType(schema)        — one zod schema → its TS type-string. Wraps
//                                 zod-to-ts (`zodToTs` + `printNode`) with
//                                 io:"output" (so a CODEC prints its DECODED JS
//                                 side: z.string → "string", z.number → "number",
//                                 z.bigint → "bigint") plus the instanceof override
//                                 below. Output is flattened to a single line.
//
//   2. the instanceof OVERRIDE  — the scheme-identity primitives (z.pair / z.schemeString /
//                                 z.schemeExact / z.lambda / …) are "custom" to zod and
//                                 UNREPRESENTABLE by default. `scheme-zod.ts`'s own
//                                 `lookupName(schema)` resolves one of them to its canonical
//                                 NAME (by identity — scheme-zod.ts is the one place that
//                                 actually knows every vocabulary item, having declared them),
//                                 and IMAGE_BY_NAME below maps that name to the TS image to
//                                 emit. This file no longer maintains its own class-name-string
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
import type { AEntity } from "../common/symbol.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scheme primitive → its PLAIN-TS IMAGE  (Scheme is a TS subset; see carriers.ts).
//
// The harvest re-presents each scheme primitive as the TS type the lens narrows against:
// the membrane makes a boundary value its plain JS type, and list/pair/vector project to
// the carrier vocabulary. Keyed by SCHEMA IDENTITY. `z.pair → Cons<unknown>` so the natural
// list zod `z.union([z.pair, z.nil])` composes to `Cons<unknown> | null` = `List<unknown>`
// with no special-case. An unmapped custom/instanceof scheme primitive degrades to `unknown`
// (robust default — never throw; the total-harvest contract, e.g. a future zod primitive).
// ─────────────────────────────────────────────────────────────────────────────
type Ts = typeof import("typescript");
type NodeBuilder = (ts: Ts) => import("typescript").TypeNode;

const unknownNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
const stringNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
const numberNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
const booleanNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
const bigintNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.BigIntKeyword);
const nullNode: NodeBuilder = (ts) => ts.factory.createLiteralTypeNode(ts.factory.createNull());
const consUnknownNode: NodeBuilder = (ts) => ts.factory.createTypeReferenceNode("Cons", [unknownNode(ts)]);
const readonlyUnknownArrayNode: NodeBuilder = (ts) =>
  ts.factory.createTypeOperatorNode(ts.SyntaxKind.ReadonlyKeyword, ts.factory.createArrayTypeNode(unknownNode(ts)));
const uint8ArrayNode: NodeBuilder = (ts) => ts.factory.createTypeReferenceNode("Uint8Array", undefined);
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
// schema — NOT class-name-string, NOT schema-object-identity. Both of those lived here
// as TWO SEPARATE tables before this fix, meaning every new scheme-zod primitive needed
// a second, hand-authored entry in THIS file too (exactly what happened to `z.lambda` —
// it shipped with no printer entry at all). scheme-zod.ts is the one place that actually
// knows every vocabulary item's identity; this file now only needs to know how to PRINT
// a given name, not how to RECOGNIZE one.
const IMAGE_BY_NAME: ReadonlyMap<string, NodeBuilder> = new Map<string, NodeBuilder>([
  ["pair", consUnknownNode], // `z.pair | z.nil` → `Cons<unknown> | null` = List<unknown>
  ["schemeString", stringNode],
  ["schemeExact", bigintNode],
  ["schemeInexact", numberNode],
  ["symbol", stringNode],
  ["sbytevector", uint8ArrayNode],
  ["nil", nullNode],
  ["schemeBool", booleanNode],
  ["schemeChar", stringNode],
  ["svector", readonlyUnknownArrayNode],
  ["value", unknownNode],
  ["lambda", lambdaNode],
]);

/** The zod-to-ts override: a scheme-zod vocabulary schema → its plain-TS image, resolved by
 *  `lookupName` (identity-based, owned by scheme-zod.ts itself); an UNMAPPED name (a vocabulary
 *  item this file hasn't been taught to print yet — should not happen for anything registered
 *  in scheme-zod.ts's own NAMES map, but kept as a robust default) → `unknown`, never throw
 *  (total-harvest). Non-vocabulary schemas (object/array/union/literal/… and the codecs, which
 *  print via zod-to-ts's native `io:"output"` handling) defer to zod-to-ts (return undefined).
 *
 *  CRUCIAL guard: only fires for a LEAF `z.custom`-kind schema (`_zod.def.type === "custom"`),
 *  never a COMPOUND one — `lookupName` happily resolves a compound vocabulary export too
 *  (e.g. `schemeNumber`, a union), but intercepting it here would short-circuit zod-to-ts's
 *  own per-member union composition (the override must fire on EACH member — AExact/AInexact
 *  — not once on the union as a whole). Fires per-node, so `z.pair | z.nil` prints as
 *  "Cons<unknown> | null" and `z.schemeNumber` (a union of two customs) prints as
 *  "bigint | number", never short-circuited to "unknown". */
const instanceofOverride: OptionalTypeOverrideFunction = (schema, typescript) => {
  const s = schema as { _zod?: { def?: { type?: string } } };
  if (s?._zod?.def?.type !== "custom") return undefined; // a compound (union/array/tuple/…) → recurse via zod-to-ts
  const name = z.lookupName(schema);
  if (name === undefined) return undefined; // not a scheme-zod vocabulary item → zod-to-ts handles it
  const builder = IMAGE_BY_NAME.get(name);
  return builder ? builder(typescript) : unknownNode(typescript); // robust default — never throw
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
 * z.number → "number", z.bigint → "bigint". instanceof primitives print their
 * class name via the override (z.pair → "Pair"). Compounds compose
 * (z.object → "{ k: T; … }", z.array → "T[]", z.tuple → "[A, B]", z.union → "A | B").
 */
export function printType(schema: z.ZodTypeAny): string {
  const { node } = zodToTs(schema as never, {
    auxiliaryTypeStore: createAuxiliaryTypeStore(),
    overrideFunction: instanceofOverride,
    io: "output",
    unrepresentable: "throw",
  });
  return flatten(printNode(node));
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
    // A variadic tail (z.tuple([...], rest)) → a trailing rest param.
    if (def.rest != null) params.push(`...rest: ${printType(def.rest)}[]`);
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
  // door = omitted verb (not callable); keyword = special-form syntax; macro = a non-evaluating
  // transformer (syntax, not a value-level callable). None carries an in/out codec surface, so all
  // print as `never` until the type-lens grows a dedicated syntax representation.
  if (def.kind === "door" || def.kind === "keyword" || def.kind === "macro") return "never";
  // `Contract.type` — an author-asserted override, decoupled from the zod-derived computation
  // below (see its doc comment). Present ⇒ the author's word is final; absent (the common case,
  // and the ONLY option for tagless/tagless-guard, which carry no Contract) ⇒ fall through to
  // computing from the contract's own `in`/`out`, unchanged. `"type" in def` (not `def.type`)
  // because tagless/tagless-guard don't have the field at all, not even as `undefined`.
  if ("type" in def && def.type !== undefined) return def.type;
  try {
    const params = paramList(def.in);
    const ret = returnType(def.out);
    const wrapped = def.kind === "rosetta" ? `Promise<${ret}>` : ret;
    return `${params} => ${wrapped}`;
  } catch {
    // TOTAL HARVEST: an unrepresentable schema must NEVER collapse typed mode — degrade this
    // ONE symbol to a loose arrow (it just isn't narrowed; its slots stay Σ-only), never throw.
    return "(...args: unknown[]) => unknown";
  }
}
