// positional-rejection — the POSITIONAL sibling of kwargs-rejection.ts's humanizer
// (benchmark-defect-register.md B4).
//
// `common/symbols/rosetta.ts`'s decode gate (`z.decode(inSchema, args)`, the ELSE arm
// of the kwargs/positional split) would otherwise let a raw `ZodError` propagate. zod v4's
// `ZodError.message` IS the pretty-printed JSON of `.issues` — a 25-line nested-union
// dump that names no verb and no argument. One model in the 89x2 benchmark corpus
// misread that dump as a `:limit max 500` schema constraint that did not exist, and
// voluntarily shrank its dataset 388 → 80, losing the task — the failure this humanizer
// exists to prevent.
//
// `kwargs-rejection.ts` (`issueLines`) already solves this for the KWARGS shape, keyed
// on a param NAME. This file solves the same problem for the POSITIONAL/variadic shape,
// keyed on an ARG INDEX (1-indexed in the rendered message — "the first argument", the
// way a model reads its own call, not JS's 0-based array). Deliberately NOT importing
// `kwargs-rejection.ts`'s file-private helpers (previewOf/kindOf/faceOf/declaredTypeOf
// aren't exported — that file's header names it as another agent's owned file); the
// small duplication here is cheaper than widening that file's export surface for a
// sibling that isn't kwargs-shaped at all.
import { ZodError, type ZodType } from "zod";
import * as z from "../scheme-zod.js";
import { AValue } from "../../values/primitives/AValue.js";

const PREVIEW_MAX = 60;

/** Same convention as kwargs-rejection.ts's own `previewOf` / arrival-manifold
 *  bind.ts's `previewOf` (design doc §2.5) — one shared truncation rule, three
 *  independent implementations (each file owns its own rejection-string contract). */
function previewOf(v: unknown): string {
  const rendered = JSON.stringify(v) ?? String(v);
  return rendered.length > PREVIEW_MAX ? `${rendered.slice(0, PREVIEW_MAX)}...` : rendered;
}

/** The scheme-visible type word: an AValue names its own `kind`; raw JS falls back to
 *  typeof (+ array/null splits). Mirrors kwargs-rejection.ts's `kindOf`. */
function kindOf(v: unknown): string {
  if (v instanceof AValue) return v.kind;
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/** The JS face of a value for previewing — an AValue projects through its own
 *  `arrival/toJS` protocol (never throws into the door path). Mirrors
 *  kwargs-rejection.ts's `faceOf`. */
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

/** Zod's internal `_zod.def` — the same introspection `type-layer/schema-to-ts.ts`'s
 *  `zodDef` already uses to print a tuple's positional items (`def.items`) + its
 *  variadic tail (`def.rest`). Verified against zod 4.3.6, same as that file's note. */
function zodDef(schema: unknown): { type?: string; items?: readonly ZodType[]; rest?: ZodType } {
  return (schema as { _zod?: { def?: unknown } })?._zod?.def as never;
}

/** The declared schema for positional slot `argIndex` of a normalized input schema —
 *  a fixed tuple item when in range, else the tuple's variadic rest (if any). `undefined`
 *  for a non-tuple input schema (a single array-ish/union schema covering the whole
 *  call) — declaredTypeAt falls back to "the declared type" in that case, same as
 *  kwargs-rejection.ts's `declaredTypeOf` does for an unresolvable field schema. */
function schemaAt(inSchema: unknown, argIndex: number): unknown {
  const def = zodDef(inSchema);
  if (def?.type !== "tuple") return undefined;
  const items = def.items ?? [];
  return argIndex < items.length ? items[argIndex] : def.rest;
}

/** The declared-type word for a positional slot: a scheme-face codec answers its
 *  registry name ("number", "string", "list", …); a plain zod schema answers its
 *  `def.type`; an unresolvable slot (no tuple, or index past a non-variadic tuple)
 *  answers the generic fallback. Mirrors kwargs-rejection.ts's `declaredTypeOf`. */
function declaredTypeAt(inSchema: unknown, argIndex: number): string {
  const fieldSchema = schemaAt(inSchema, argIndex);
  if (fieldSchema === undefined) return "the declared type";
  return (
    z.lookupName(fieldSchema as never) ?? (fieldSchema as { def?: { type?: string } })?.def?.type ?? "the declared type"
  );
}

/** One rendered positional-arg problem line: `  arg N — <detail>` (1-indexed). A path
 *  deeper than the top-level arg index (a nested field inside that arg's own shape,
 *  e.g. a kwargs-object slot's own key) renders as `arg N.<rest>` — the same
 *  dotted-path convention kwargs-rejection.ts uses, just rooted at an arg label
 *  instead of a bare key. */
function positionalIssueLine(issue: ZodError["issues"][number], args: readonly unknown[], inSchema: unknown): string {
  const argIndex = typeof issue.path[0] === "number" ? issue.path[0] : undefined;
  const label = argIndex === undefined ? "args" : `arg ${argIndex + 1}`;
  const restPath = issue.path.slice(1).map(String).join(".");
  const full = restPath ? `${label}.${restPath}` : label;
  const sentVal = argIndex === undefined ? undefined : args[argIndex];

  // Absent input reads as "missing (required)" whatever shape the schema takes — same
  // rule as kwargs-rejection.ts's own absence branch.
  if (argIndex !== undefined && issue.path.length === 1 && sentVal === undefined) {
    return `  ${full} — missing (required)`;
  }
  if (issue.code === "invalid_type") {
    return `  ${full} — expected ${issue.expected}, got ${kindOf(sentVal)}: ${previewOf(faceOf(sentVal))}`;
  }
  // A codec-union miss OR a custom-predicate miss — both surface as a bare "Invalid input" with
  // no `expected` field, so name the declared type from the slot's OWN schema (via the `named()`
  // registry) and show the value that was actually sent.
  //
  // The `custom` arm is not a nicety. The predicate primitives in this vocabulary are `z.custom`
  // — `z.lambda` above all, and now `z.listAlike` too — so WITHOUT it every "you passed a vector
  // where a predicate goes" degrades to the single least useful string in the language:
  //
  //   (count parsed)   =>   count: arguments rejected — 1 problem(s):
  //                           arg 1 — Invalid input
  //
  // which names the slot but not the fault, and leaves the model to guess. `count` is
  // `(count pred . lists)`; the model wrote `(count <vector>)`. That is an ordinary, teachable
  // mistake and the error should say so:
  //
  //   arg 1 — expected lambda, got vector: [{:name "Alice" …} …]
  if (issue.code === "invalid_union" || issue.code === "custom") {
    const declared = argIndex === undefined ? "the declared type" : declaredTypeAt(inSchema, argIndex);
    return `  ${full} — expected ${declared}, got ${kindOf(sentVal)}: ${previewOf(faceOf(sentVal))}`;
  }
  // Anything else: zod's own per-issue message — never the whole dump.
  return `  ${full} — ${issue.message}`;
}

/** Format a positional/variadic decode rejection into the same head grammar
 *  kwargs-rejection.ts's `formatKwargsRejection` uses, so a caller (human, model, or
 *  the mcp-substrate own-decode clue family) sees ONE consistent shape regardless of
 *  which arm of the kwargs/positional split rejected. */
export function formatPositionalRejection(qualifiedName: string, error: ZodError, args: readonly unknown[], inSchema: unknown): string {
  const lines = error.issues.map((issue) => positionalIssueLine(issue, args, inSchema));
  const head = qualifiedName === "" ? "arguments rejected" : `${qualifiedName}: arguments rejected`;
  return `${head} — ${lines.length} problem(s):\n${lines.join("\n")}`;
}
