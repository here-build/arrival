// args-misuse-door — render the LOCALIZED args-misuse teaching (design doc
// second-foundation/arrival-manifold/docs/args-error-reporting-v2.md §2.3, §2.6).
//
// args-misuse.ts answers "WHICH param failed" (localization, pure); this file answers
// "WHAT to say about it" (rendering, pure); the tracker answers "HOW MUCH to say"
// (escalation level); DoorSession.appendArgsTeaching carries the telemetry. The caller
// (runner.ts's misuse branch) composes all four and appends the result below the
// preserved verbatim first line — H-4's pass-through is never touched here.
//
// Frozen line HEADS (design doc §4 — heads only; the interpolated content is
// schema-derived and follows the schema):
//   `\n  Failing argument: :<param> — `   (L1 fact)
//   `\n  Retry shape: `                   (L1 script)
//   `\n  Parameter :<param> in full — `   (L2 head; closed-world clause frozen when present)
//   `\n  This is rejected shape #<n> for :<param> on this tool.`  (L3 head)
//   `the key you want is :<key>.`         (case-B explicit-fact clause)

import type { ArgsClue, Localized } from "./args-misuse.js";
import { isTightKeyMatch, nonBareKwargKeys } from "./doors.js";
import { renderExampleLiteral, synthesizeParamValue, typeHole } from "./example-call.js";
import { orderedFields, type JsonSchemaProperty, type ToolJsonSchema } from "./tool-schema.js";

/** Same 60-char truncation convention as arrival-manifold bind.ts's `previewOf` and arrival's
 *  kwargs-rejection.ts (design doc §2.3/§2.5 — one preview convention across the family). */
const PREVIEW_MAX = 60;

function previewOf(v: unknown): string {
  const rendered = JSON.stringify(v) ?? String(v);
  return rendered.length > PREVIEW_MAX ? `${rendered.slice(0, PREVIEW_MAX)}...` : rendered;
}

/** L2 dump size cap (design doc open question 4's proposed bound): a pathological sub-schema
 *  must not turn the "earned by a repeat failure" dump into its own token hazard. */
const MAX_DUMP_KEY_LINES = 24;

/** The type word for one dump line — a deliberately MINIMAL local token (scalars, enums,
 *  one-level arrays, `{…}` for nested objects). The full recursive shape renderer lives
 *  binder-side (arrival-manifold's tool-signature.ts — the package boundary points the wrong
 *  way to share it), and the dump's job is the KEY LIST + descriptions; the signature line the
 *  model already holds carries the deep shapes. */
function dumpToken(prop: JsonSchemaProperty, depth = 0): string {
  if (prop.enum && prop.enum.length > 0) return prop.enum.map((v) => JSON.stringify(v)).join("|");
  const t = prop.type;
  if (Array.isArray(t)) return t.map((x) => (x === "null" ? "nil" : x === "integer" ? "number" : x)).join("|");
  if (t === "array") return `[${prop.items ? dumpToken(prop.items, depth) : "value"}]`;
  if (t === "object" || prop.properties) {
    if (depth >= 1 || !prop.properties) return "{…}";
    const inner = orderedFields(prop)
      .map(({ name, optional, prop: p }) => `${name}:${dumpToken(p, depth + 1)}${optional ? "?" : ""}`)
      .join(", ");
    return `{${inner}}`;
  }
  if (t === "integer") return "number";
  return typeof t === "string" ? t : "value";
}

/** The first sentence of a schema description — the menu's per-key gloss (design doc §2.3
 *  Case A: "key + first-clause-of-description makes the semantic pick explicit"). */
function firstClause(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const clause = description.split(/(?<=\.)\s/, 1)[0]!.trim();
  return clause.length > 0 ? clause : undefined;
}

/** `{k1, k2, …}` — the lean L1 key list (keys only, no descriptions: L1 is the lean rung). */
function keyListOf(subSchema: JsonSchemaProperty): string {
  return `{${Object.keys(subSchema.properties ?? {}).join(", ")}}`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The scheme-face type word for a sent JS value (fact-line vocabulary). */
function sentKindOf(v: unknown): string {
  if (v === null || v === undefined) return "nil";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

interface RetryShape {
  /** The composed retry expr — parseable by construction (holes are reader block comments). */
  expr: string;
  /** Optional trailing menu clause, appended after ` — `. */
  menu?: string;
}

/** The case-B rename: exactly ONE bad key, tight-matching exactly ONE declared sub-schema
 *  key, on a sent plain-object param — the copy-paste-correct fix rendered from the model's
 *  OWN data (their data is never "our invention", so no holes needed). Returns the renamed
 *  key too (the explicit-fact clause names it). */
function tightKeyRename(localized: Localized): { renamed: Record<string, unknown>; from: string; to: string } | undefined {
  const { clue, subSchema, sentValue } = localized;
  if (clue.kind !== "unexpected-keys" || clue.tokens.length !== 1) return undefined;
  if (!isPlainObject(sentValue)) return undefined;
  const bad = clue.tokens[0]!;
  const declared = Object.keys(subSchema.properties ?? {});
  const matches = declared.filter((k) => isTightKeyMatch(bad, k));
  if (matches.length !== 1) return undefined;
  const to = matches[0]!;
  const renamed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sentValue)) renamed[k === bad ? to : k] = v;
  return { renamed, from: bad, to };
}

/** Compose the L1 `Retry shape:` value for the failing param (design doc §2.6's priority
 *  order): (1) tight-match key rename of the model's own sent object; (2) a first-key hole
 *  skeleton with the pick-a-key menu when the sub-schema declares keys; (3) a synthesized
 *  minimal stub. Never the model's sent SCALAR relocated under an arbitrarily picked key
 *  (§2.3: a relocated value under OUR pick becomes the model's next call — silent guessing),
 *  and never invented concrete data outside a declared enum member (holes instead). */
function retryParamValue(localized: Localized): { rendered: string; menu?: string } {
  const rename = tightKeyRename(localized);
  if (rename) return { rendered: renderExampleLiteral(rename.renamed) };

  const { subSchema } = localized;
  const fields = orderedFields(subSchema);
  if ((subSchema.type === "object" || subSchema.properties) && fields.length > 0) {
    const first = fields[0]!;
    const skeleton = { [first.name]: typeHole(holeTokenOf(first.prop)) };
    const menuEntries = fields
      .map(({ name, prop }) => {
        const gloss = firstClause(prop.description);
        return gloss ? `${name} (${gloss})` : name;
      })
      .join(", ");
    return {
      rendered: renderExampleLiteral(skeleton),
      menu:
        `:${first.name} is one example key; pick the key matching your intent: ${menuEntries}` +
        (fields.some(({ prop }) => prop.description) ? "" : " (see each key's description in the signature)"),
    };
  }
  return { rendered: synthesizeParamValue(subSchema) };
}

/** The hole token for one property — the signature renderer's own type vocabulary. */
function holeTokenOf(prop: JsonSchemaProperty): string {
  const t = prop.type;
  if (t === "number" || t === "integer") return "number";
  if (t === "boolean") return "boolean";
  if (t === "array") return "array";
  if (t === "object" || prop.properties) return "object";
  return "string";
}

/** Compose the whole `Retry shape:` expr — the model's OWN call with ONLY the failing param
 *  rewritten (design doc §2.3). `undefined` when no faithful expr exists: a nested failing
 *  path (rewriting the container would drop its healthy siblings), absent sent args (nothing
 *  of the model's to echo), or a top-level key outside the `:keyword` grammar (the
 *  bareToolCallDoor precedent — degrade to the fact line + signature, never broken syntax). */
export function buildRetryShape(
  qualifiedName: string,
  sentArgs: Record<string, unknown> | undefined,
  localized: Localized,
): RetryShape | undefined {
  if (localized.path.length !== 1) return undefined;
  if (sentArgs === undefined) return undefined;
  const param = localized.path[0]!;
  const withParam = param in sentArgs ? sentArgs : { ...sentArgs, [param]: undefined };
  if (nonBareKwargKeys(withParam).length > 0) return undefined;
  const { rendered, menu } = retryParamValue(localized);
  const kwargs = Object.entries(withParam)
    .map(([k, v]) => `:${k} ${k === param ? rendered : renderExampleLiteral(v)}`)
    .join(" ");
  return { expr: `(${qualifiedName} ${kwargs})`, ...(menu ? { menu } : {}) };
}

/** The L1 fact clause after `Failing argument: :<param> — `, per clue family. Every clause is
 *  built from held facts only (the sent value, the schema, the upstream's own quoted tokens) —
 *  never a guess phrased as one (doors.ts's central discipline). */
function factClauseOf(localized: Localized, paramHead: string): string {
  const { clue, subSchema, sentValue } = localized;
  const shape = subSchema.properties
    ? `an object with keys ${keyListOf(subSchema)}`
    : `a value of type ${dumpToken(subSchema)}`;
  switch (clue.kind) {
    case "value-mismatch":
      return `you sent the ${sentKindOf(sentValue)} ${previewOf(sentValue)}; :${paramHead} takes ${shape}.`;
    case "unexpected-keys": {
      const bad = clue.tokens.map((k) => `:${k}`).join(", ");
      const rename = tightKeyRename(localized);
      if (rename) return `it has no key :${rename.from}; the key you want is :${rename.to}.`;
      return `it has no key${clue.tokens.length > 1 ? "s" : ""} ${bad}; its keys are ${keyListOf(subSchema)}.`;
    }
    case "required-key":
      return clue.tokens[0] === paramHead
        ? `it is required and was not sent; it takes ${shape}.`
        : `it is missing the required key :${clue.tokens[0]}.`;
    case "own-decode":
    case "zod-path":
      return `the tool's schema rejected it; :${paramHead} takes ${shape}.`;
  }
}

/** The L2 full-parameter dump: head + one line per declared key (`name:type?` + the FULL
 *  schema description — the one place full descriptions ride an error, earned by a repeat
 *  failure), capped at {@link MAX_DUMP_KEY_LINES} with a loud `+N more` marker (never a silent
 *  truncation). The closed-world clause renders ONLY when it is a fact (design doc T10):
 *  `additionalProperties: false` on the sub-schema, or the current clue is itself an
 *  unexpected-keys rejection (the upstream just demonstrated closed-world behavior). */
function parameterDump(paramHead: string, subSchema: JsonSchemaProperty, clue: ArgsClue): string {
  const closedWorld =
    (subSchema as { additionalProperties?: boolean }).additionalProperties === false ||
    clue.kind === "unexpected-keys";
  const fields = orderedFields(subSchema);
  if (fields.length === 0) {
    const desc = subSchema.description ? ` — ${subSchema.description}` : "";
    return `\n  Parameter :${paramHead} in full — ${dumpToken(subSchema)}${desc}`;
  }
  const head = closedWorld
    ? `\n  Parameter :${paramHead} in full — an object; only these keys exist (any other key is rejected):`
    : `\n  Parameter :${paramHead} in full — an object with keys:`;
  const shown = fields.slice(0, MAX_DUMP_KEY_LINES);
  const lines = shown.map(({ name, optional, prop }) => {
    const desc = prop.description ? ` — ${prop.description}` : "";
    return `\n    ${name}:${dumpToken(prop)}${optional ? "?" : ""}${desc}`;
  });
  const overflow =
    fields.length > shown.length
      ? `\n    … +${fields.length - shown.length} more keys — narrow with the signature above`
      : "";
  return head + lines.join("") + overflow;
}

/** The L3 anti-guess script (futility voice). `#<n>` is the tracker's escalation rung —
 *  capped at 3 by the tracker's own contract, so a 4th-and-later failure re-reads `#3`
 *  ("third-or-later", the floor we actually hold, never a fabricated higher count). The
 *  key-list clause stays factual: "COMPLETE" only under a closed world, otherwise the
 *  schema-declared framing. */
function antiGuessScript(paramHead: string, level: number, subSchema: JsonSchemaProperty, clue: ArgsClue): string {
  const closedWorld =
    (subSchema as { additionalProperties?: boolean }).additionalProperties === false ||
    clue.kind === "unexpected-keys";
  const listClause = closedWorld
    ? "The key list above is COMPLETE — do not invent further key names or syntaxes."
    : "The key list above is everything the schema declares — do not invent further key names or syntaxes.";
  return (
    `\n  This is rejected shape #${level} for :${paramHead} on this tool. ${listClause} ` +
    `If none of these keys expresses your intent, this tool cannot express it: pick a ` +
    `different tool, or work from the evidence you already have.`
  );
}

/** Render the full localized teaching body for one misuse failure at escalation `level` —
 *  the suffix appended below the verbatim first line (before the `Signature:` echo). L1
 *  always re-renders (the model may not have the first door in a compacted context, design
 *  doc §2.3 L2); L2 appends the dump at level ≥ 2; L3 appends the anti-guess script at
 *  level ≥ 3. */
export function renderArgsMisuseTeaching(input: {
  qualifiedName: string;
  sentArgs: Record<string, unknown> | undefined;
  localized: Localized;
  level: 1 | 2 | 3;
}): string {
  const { qualifiedName, sentArgs, localized, level } = input;
  const paramHead = localized.path.join(".");
  let body = `\n  Failing argument: :${paramHead} — ${factClauseOf(localized, paramHead)}`;
  const retry = buildRetryShape(qualifiedName, sentArgs, localized);
  if (retry) body += `\n  Retry shape: ${retry.expr}${retry.menu ? ` — ${retry.menu}` : ""}`;
  if (level >= 2) body += parameterDump(paramHead, localized.subSchema, localized.clue);
  if (level >= 3) body += antiGuessScript(paramHead, level, localized.subSchema, localized.clue);
  return body;
}

/** The Level-⊥ backstop (design doc §2.3): a repeatedly-UNLOCALIZABLE misuse on one tool
 *  escalates at L2+ to the full input-schema dump — all params, all keys, all descriptions;
 *  deliberately expensive and deliberately late ("when in doubt, eventually show
 *  everything"). Rendered below the ordinary Signature + Example fallback. */
export function renderFullSchemaTeaching(qualifiedName: string, schema: ToolJsonSchema | undefined): string {
  const fields = orderedFields(schema);
  if (fields.length === 0) return "";
  const lines = fields.map(({ name, optional, prop }) => {
    const desc = prop.description ? ` — ${prop.description}` : "";
    return `\n    :${name} ${dumpToken(prop)}${optional ? "?" : ""}${desc}`;
  });
  return `\n  Full input schema for ${qualifiedName} (every parameter):${lines.join("")}`;
}
