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
import * as z from "./scheme-zod.js";
import type { SymbolDef } from "./symbol.js";

// ─────────────────────────────────────────────────────────────────────────────
// The scheme-primitive STATIC fallback (defensive).
//
// bag.Class.name is the primary source (auto-derivable, reachable for every
// primitive). This map is the belt-and-braces fallback keyed by SCHEMA IDENTITY:
// if a future zod ever drops _zod.bag.Class, the printer still names the term.
// Each entry is exactly one z.instanceof export from scheme-zod.
// ─────────────────────────────────────────────────────────────────────────────
const SCHEME_PRIMITIVE_FALLBACK: ReadonlyMap<unknown, string> = new Map<unknown, string>([
  [z.pair, "APair"],
  [z.symbol, "ASymbol"],
  [z.svector, "AVector"],
  [z.sbytevector, "ABytevector"],
  [z.nil, "ANil"],
  [z.schemeString, "AString"],
  [z.schemeBool, "ABool"],
  [z.schemeChar, "ACharacter"],
  [z.schemeExact, "AExact"],
  [z.schemeInexact, "AInexact"],
]);

/** Read the JS class name a custom/instanceof schema was built from. Primary:
 *  `_zod.bag.Class.name` (zod stashes the class there). Fallback: the static
 *  identity map. Returns undefined for a non-instanceof schema. */
function instanceofClassName(schema: unknown): string | undefined {
  const s = schema as { _zod?: { def?: { type?: string }; bag?: { Class?: { name?: unknown } } } };
  if (s?._zod?.def?.type !== "custom") return undefined;
  const fromBag = s._zod.bag?.Class?.name;
  if (typeof fromBag === "string" && fromBag.length > 0) return fromBag;
  return SCHEME_PRIMITIVE_FALLBACK.get(schema);
}

/** The zod-to-ts override: any instanceof/custom schema → a bare type reference to
 *  its class name. Fires per-node during the walk, so a union of instanceof members
 *  prints as "A | B". Returns undefined (defer to zod-to-ts) for everything else. */
const instanceofOverride: OptionalTypeOverrideFunction = (schema, typescript) => {
  const name = instanceofClassName(schema);
  if (name === undefined) return undefined;
  return typescript.factory.createTypeReferenceNode(typescript.factory.createIdentifier(name), undefined);
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
  // door = omitted verb (not callable); keyword = special-form syntax (not a value-level
  // callable either). Neither carries an in/out codec surface, so both print as `never`
  // until the type-lens grows a dedicated syntax representation for keywords.
  if (def.kind === "door" || def.kind === "keyword") return "never";
  const params = paramList(def.in);
  const ret = returnType(def.out);
  const wrapped = def.kind === "rosetta" ? `Promise<${ret}>` : ret;
  return `${params} => ${wrapped}`;
}
