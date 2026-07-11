// kwargs-rejection — the kwargs zod-decode humanizer + strict decode door
// (arrival-manifold docs/args-error-reporting-v2.md §2.5, §7.3 Phase 1).
//
// This file OWNS the frozen rejection strings (H-4-adjacent — the manifold's
// error-contract freezes line HEADS against them; mcp-substrate's own-decode clue
// family parses `:<param> —` line heads off them). Change them only with the
// design doc + the manifold re-freeze in the same motion.
//
// Grammar:
//   <qualified>: arguments rejected — <n> problem(s):
//     :<path> — <humanized issue>
//
// Two silent-strip hazards close here (both verified against zod 4.3.6):
//   - key level: `z.object`'s default strip mode drops a misspelled OPTIONAL key with
//     no rejection at all → `z.strictObject` (design doc Open Question 1);
//   - value level: `z.object` accepts ANY typeof-object input — a boxed AValue sent
//     where a field declares a plain-JS shape "passes" by stripping to `{}` → the
//     scheme-face guard below rejects it (an AValue can only be consumed by a schema
//     with a scheme face, i.e. one registered in scheme-zod's name registry — every
//     codec and `z.value` are; plain `z.object`/`z.record` are not).

import { ZodError, ZodType, type ZodRawShape } from "zod";
import * as z from "./scheme-zod.js";
import { AValue } from "../values/primitives/AValue.js";

/** Same convention as arrival-manifold bind.ts's `previewOf` (design doc §2.5). */
const PREVIEW_MAX = 60;

function previewOf(v: unknown): string {
  const rendered = JSON.stringify(v) ?? String(v);
  return rendered.length > PREVIEW_MAX ? `${rendered.slice(0, PREVIEW_MAX)}...` : rendered;
}

/** The scheme-visible type word: an AValue names its own `kind` ("string", "number",
 *  "dict", …); raw JS falls back to typeof (+ array/null splits). */
function kindOf(v: unknown): string {
  if (v instanceof AValue) return v.kind;
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/** The JS face of a value for previewing — an AValue projects through its own
 *  `arrival/toJS` protocol (never throws into the door path). */
function faceOf(v: unknown): unknown {
  if (v instanceof AValue) {
    try {
      return v["arrival/toJS"]();
    } catch {
      return String(v);
    }
  }
  return v;
}

function valueAtPath(sent: unknown, path: readonly PropertyKey[]): unknown {
  let v: unknown = sent;
  for (const seg of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<PropertyKey, unknown>)[seg];
  }
  return v;
}

/** One rendered problem line: `  :<path> — <detail>`. */
type ProblemLine = string;

/** The declared-type word for a field: a scheme-face codec answers its registry name
 *  ("number", "string", "dict", …); a plain zod schema answers its `def.type`. */
function declaredTypeOf(fieldSchema: unknown): string {
  return (
    z.lookupName(fieldSchema) ?? (fieldSchema as { def?: { type?: string } })?.def?.type ?? "the declared type"
  );
}

function issueLines(
  issue: ZodError["issues"][number],
  sent: Record<string, unknown>,
  shape: ZodRawShape,
): ProblemLine[] {
  const path = issue.path.map(String).join(".");
  // unrecognized_keys carries an EMPTY path and its own key list — render one line PER
  // key so every line keeps the `:<param> —` head the own-decode clue family parses.
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((k) => `  :${k} — unknown key`);
  }
  const sentVal = valueAtPath(sent, issue.path);
  // Absent input reads as "missing (required)" whatever shape the schema takes —
  // a codec UNION (z.number = exact|inexact) reports absence as `invalid_union`,
  // a plain schema as `invalid_type`; the model's mistake is the same one.
  if (issue.path.length > 0 && sentVal === undefined) {
    return [`  :${path} — missing (required)`];
  }
  if (issue.code === "invalid_type") {
    return [`  :${path} — expected ${issue.expected}, got ${kindOf(sentVal)}: ${previewOf(faceOf(sentVal))}`];
  }
  // A codec-union miss ("Invalid input", no expected field) — name the declared type
  // from the field's own schema (§2.5's `:pageSize — expected number, got string: "50"`).
  if (issue.code === "invalid_union" && issue.path.length > 0) {
    const declared = declaredTypeOf(shape[String(issue.path[0])]);
    return [`  :${path} — expected ${declared}, got ${kindOf(sentVal)}: ${previewOf(faceOf(sentVal))}`];
  }
  // Anything else: zod's own per-issue message — never the whole dump.
  return [`  :${path} — ${issue.message}`];
}

/** Format a kwargs decode rejection into the frozen shape. Exported for the
 *  substrate/manifold layers that assert against (or parse) the grammar.
 *
 *  An ANONYMOUS def (empty name — the manifold binds tool rosettas through
 *  `NAME_DOC_TEMPLATE`, whose parseNameDoc split yields `""`; the real qualified
 *  name arrives as error METADATA in the design's Phase 3) drops the name segment
 *  rather than rendering the broken `: arguments rejected` head. */
export function formatKwargsRejection(
  qualifiedName: string,
  problems: readonly ProblemLine[],
): string {
  const head = qualifiedName === "" ? "arguments rejected" : `${qualifiedName}: arguments rejected`;
  return `${head} — ${problems.length} problem(s):\n${problems.join("\n")}`;
}

/** A field schema with no scheme face cannot consume a boxed scheme value: codecs and
 *  `z.value` are registered in scheme-zod's name registry (resolved through optional/
 *  pipe wrappers by `lookupName`); a plain `z.object`/`z.record`/`z.enum` is not — an
 *  AValue reaching one would be silently mangled (strip-to-`{}`) or rejected with a
 *  JS-face message that misnames the value. Door it here with the scheme-face words. */
function schemaFaceProblems(shape: ZodRawShape, sent: Record<string, unknown>): ProblemLine[] {
  const problems: ProblemLine[] = [];
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const sentVal = sent[key];
    if (!(sentVal instanceof AValue)) continue;
    if (z.lookupName(fieldSchema) !== undefined) continue;
    const declared =
      (fieldSchema as { def?: { type?: string } }).def?.type ?? "the declared shape";
    problems.push(`  :${key} — expected ${declared}, got ${kindOf(sentVal)}: ${previewOf(faceOf(sentVal))}`);
  }
  return problems;
}

/**
 * The kwargs decode chokepoint (rosetta.ts's record-shaped `inputRest` path): STRICT
 * (unknown keys reject — never silently strip) + the scheme-face guard + the §2.5
 * humanizer. Throws a plain `Error` carrying the frozen grammar; non-Zod errors from
 * the decode propagate untouched.
 */
export function decodeKwargsStrict(
  qualifiedName: string,
  shape: ZodRawShape,
  sent: Record<string, unknown>,
): unknown {
  const faceProblems = schemaFaceProblems(shape, sent);
  if (faceProblems.length > 0) {
    throw new Error(formatKwargsRejection(qualifiedName, faceProblems));
  }
  try {
    return z.decode(z.strictObject(shape) as unknown as ZodType, sent);
  } catch (e) {
    if (e instanceof ZodError) {
      const problems = e.issues.flatMap((issue) => issueLines(issue, sent, shape));
      throw new Error(formatKwargsRejection(qualifiedName, problems));
    }
    throw e;
  }
}
