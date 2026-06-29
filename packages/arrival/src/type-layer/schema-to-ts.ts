// schema-to-ts — the HARVEST: a scheme-zod schema (and a SymbolDef's normalized
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
//   2. the instanceof OVERRIDE  — z.instanceof(C) (the scheme primitives z.pair /
//                                 z.schemeString / z.schemeExact / …) is "custom" to
//                                 zod and UNREPRESENTABLE by default. But zod stashes
//                                 the class on schema._zod.bag.Class, so we read
//                                 _zod.bag.Class.name → "Pair" / "SchemeString" / …
//                                 and emit it as a bare type reference. A small STATIC
//                                 fallback (keyed by schema identity) carries the same
//                                 names should bag.Class ever be absent (defensive — it
//                                 is reachable for every scheme primitive today).
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
import type { SymbolDef } from "../common/symbol.js";

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

// Keyed by INSTANCEOF CLASS NAME (`_zod.bag.Class.name`) — robust across the fresh
// `z.instanceof` member instances a union like `z.schemeNumber` clones.
const IMAGE_BY_CLASS: ReadonlyMap<string, NodeBuilder> = new Map<string, NodeBuilder>([
  ["APair", consUnknownNode], // `z.pair | z.nil` → `Cons<unknown> | null` = List<unknown>
  ["AString", stringNode],
  ["AExact", bigintNode],
  ["AInexact", numberNode],
  ["ASymbol", stringNode],
  ["ABytevector", uint8ArrayNode],
  ["ANil", nullNode],
  ["ABool", booleanNode],
  ["ACharacter", stringNode],
  ["AVector", readonlyUnknownArrayNode],
]);
// Keyed by SCHEMA IDENTITY — the custom-without-Class primitives (`z.custom`, no `bag.Class`).
const IMAGE_BY_IDENTITY: ReadonlyMap<unknown, NodeBuilder> = new Map<unknown, NodeBuilder>([
  [z.svector, readonlyUnknownArrayNode],
  [z.value, unknownNode],
]);

/** The zod-to-ts override: a scheme primitive (instanceof/custom) → its plain-TS image, by class
 *  name then schema identity; an UNMAPPED scheme primitive → `unknown` (robust default — never
 *  throw; total-harvest). Non-custom schemas (object/array/union/literal/…) defer to zod-to-ts
 *  (return undefined). Fires per-node, so `z.pair | z.nil` prints as "Cons<unknown> | null". */
const instanceofOverride: OptionalTypeOverrideFunction = (schema, typescript) => {
  const s = schema as { _zod?: { def?: { type?: string }; bag?: { Class?: { name?: unknown } } } };
  if (s?._zod?.def?.type !== "custom") return undefined; // not a scheme primitive → zod-to-ts handles it
  const className = s._zod.bag?.Class?.name;
  const byClass = typeof className === "string" ? IMAGE_BY_CLASS.get(className) : undefined;
  if (byClass !== undefined) return byClass(typescript);
  const byIdentity = IMAGE_BY_IDENTITY.get(schema);
  if (byIdentity !== undefined) return byIdentity(typescript);
  return unknownNode(typescript); // robust default — never throw
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
// Reads the SymbolDef's NORMALIZED in/out (already one schema per side, per
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
 * Compose the full ".d.ts member" arrow signature for a baked SymbolDef.
 *
 *   native  → "(a: A, b: B) => R"            (sync; impl works on scheme values)
 *   rosetta → "(a: A, b: B) => Promise<R>"   (bake awaits → implicitly async)
 *   door    → "never"                         (an omitted verb; not callable)
 *
 * A 1-tuple output collapses to a bare return; an n-tuple becomes a
 * multiple-values "[A, B]"; a variadic input becomes "(...args: T[])".
 */
export function signatureOf(def: SymbolDef): string {
  // door = omitted verb (not callable); keyword = special-form syntax; macro = a non-evaluating
  // transformer (syntax, not a value-level callable). None carries an in/out codec surface, so all
  // print as `never` until the type-lens grows a dedicated syntax representation.
  if (def.kind === "door" || def.kind === "keyword" || def.kind === "macro") return "never";
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
