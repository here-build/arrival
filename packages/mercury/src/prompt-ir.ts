/**
 * The shared front-end for every prompt backend: parse a `.prompt` (real Dotprompt
 * format — YAML frontmatter + Handlebars body, https://google.github.io/dotprompt/)
 * into a language-neutral IR, once. Stage 1 has one surviving backend
 * (`langchain-js`, template-first); the ax signature-DSL backend and the two
 * Python backends (dspy, langchain-py) were deleted in the same wave the Python
 * emitter died — `ts-vercel-ai` (also template/schema-first, TS) is future work.
 *
 * Frontmatter parsing goes through the real `dotprompt` package (`.parse()`, sync,
 * no runtime data needed) instead of a hand-rolled flat-YAML scanner — real nested
 * frontmatter, and a genuine `input.schema` (Picoschema or JSON Schema) when the
 * author declares one. `dotprompt` is a build-time-only dependency: nothing it
 * exports reaches the generated output, which stays hand-rolled target code (see
 * each backend's `compile*` function) — nobody importing a compiled module needs
 * dotprompt installed.
 *
 * The IR carries BOTH shapes so a backend can pick:
 *   - `inputs` + `description`  → a future signature-style backend builds a typed
 *                                 signature (`rt/structured-output` territory).
 *   - `messages`               → template backends (langchain-js today) reproduce
 *                                 the authored prompt, with `{{#each}}` loops
 *                                 surfaced as a structured `loop` segment.
 */
import { Dotprompt, picoschema, type JSONSchema } from "dotprompt";

import { cleanName } from "./names.js";

const dotprompt = new Dotprompt();

export type FieldType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface PromptInput {
  /** Cleaned to a JS identifier (camelCase). Python backends re-clean via `pyName`. */
  name: string;
  /** The original template head, e.g. `failures` — the backend-agnostic source of truth. */
  raw: string;
  type: FieldType;
}

/** One chat message: a role and a flat list of literal/var/loop segments. */
export interface Message {
  role: string;
  segs: Seg[];
}

export type Seg =
  | { kind: "text"; text: string }
  | { kind: "var"; name: string; raw: string }
  | { kind: "loop"; list: string; raw: string; item: LoopSeg[] }
  | { kind: "if"; condVar: string; condRaw: string; then: SimpleSeg[]; else: SimpleSeg[] };

/** Segments inside a `{{#each}}` body — `{{this.field}}` becomes a `field` with its path. */
export type LoopSeg = { kind: "text"; text: string } | { kind: "field"; path: string };

/** Segments inside an `{{#if}}`/`{{else}}` branch — plain text and top-level `{{var}}`
 *  refs only, same as the message level (no nested `{{#each}}`/`{{#if}}` — a further
 *  generalization YAGNI until a real prompt needs it, same minimalism as LoopSeg). */
export type SimpleSeg = { kind: "text"; text: string } | { kind: "var"; name: string; raw: string };

export interface PromptDoc {
  model: string;
  inputs: PromptInput[];
  messages: Message[];
  /** Explicit frontmatter `description`, else the first prose line of the body — the
   *  task description for signature backends. */
  description: string;
  /** The raw body (frontmatter removed, trimmed) — preserved verbatim as a comment. */
  body: string;
}

/** Handlebars block helpers / context refs that are NOT input variables. */
const HELPERS = new Set(["role", "each", "if", "unless", "with", "this", "else", "lookup", "log"]);

/**
 * Fallback input inference: top-level `{{var}}` (string) + `{{#each xs}}`
 * collections (array) — used only when the frontmatter declares no `input.schema`.
 * A schema-less `.prompt` is a valid, simpler Dotprompt style (Mercury's original
 * behavior); scanning template usage is the best available signal without one.
 */
function extractInputs(body: string): PromptInput[] {
  const arrays = new Set<string>();
  for (const m of body.matchAll(/\{\{#each\s+([\w.]+)/g)) arrays.add(m[1]!.split(".")[0]!);
  const bools = new Set<string>();
  for (const m of body.matchAll(/\{\{#if\s+([\w.]+)/g)) bools.add(m[1]!.split(".")[0]!);
  const fields = new Map<string, FieldType>();
  for (const m of body.matchAll(/\{\{\{?\s*([\w.]+)/g)) {
    const head = m[1]!.split(".")[0]!;
    if (HELPERS.has(head)) continue;
    if (!fields.has(head)) fields.set(head, "string");
  }
  for (const a of arrays) fields.set(a, "array"); // a collection, overriding the string default
  for (const b of bools) fields.set(b, "boolean"); // an #if condition, likewise overriding
  return [...fields].map(([raw, type]) => ({ name: cleanName(raw), raw, type }));
}

/** Real declared inputs from a resolved (post-Picoschema) JSON Schema's top-level
 *  object properties — actual authored types, not guessed from template usage. */
function inputsFromSchema(schema: JSONSchema): PromptInput[] {
  const properties = (schema?.properties ?? {}) as Record<string, JSONSchema>;
  return Object.entries(properties).map(([raw, prop]) => ({
    name: cleanName(raw),
    raw,
    type: (prop?.type as FieldType | undefined) ?? "string",
  }));
}

/** First body line with letters once `{{…}}` markers are stripped — the natural task description. */
function firstProse(body: string): string {
  for (const line of body.split("\n")) {
    const stripped = line.replaceAll(/\{\{[\s\S]*?\}\}/g, "").trim();
    if (stripped && /[a-z]/i.test(stripped)) return stripped;
  }
  return "";
}

/** Parse a `.prompt` source into the shared IR. */
export async function parsePrompt(source: string): Promise<PromptDoc> {
  const parsed = dotprompt.parse(source);
  const template = parsed.template;

  const inputs = parsed.input?.schema ? inputsFromSchema(await picoschema(parsed.input.schema)) : extractInputs(template);

  const messages: Message[] = [];
  let cur: Message | null = null;
  let loop: { list: string; raw: string; item: LoopSeg[] } | null = null;
  // Single-level, like `loop` above — an #if nested inside another #if/#each is a
  // further generalization YAGNI until a real prompt needs it.
  let cond: { condVar: string; condRaw: string; then: SimpleSeg[]; else: SimpleSeg[]; branch: "then" | "else" } | null =
    null;
  const ensure = (): Message => (cur ??= { role: "user", segs: [] });
  const pushText = (text: string): void => {
    if (!text) return;
    if (loop) loop.item.push({ kind: "text", text });
    else if (cond) cond[cond.branch].push({ kind: "text", text });
    else ensure().segs.push({ kind: "text", text });
  };

  const re = /\{\{(\{?)\s*([\s\S]*?)\s*\}?\}\}/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(template)); ) {
    pushText(template.slice(last, m.index));
    last = m.index + m[0].length;
    const inner = m[2]!.trim();

    if (/^role\b/.test(inner)) {
      if (cur) messages.push(cur);
      cur = { role: /["']([^"']+)["']/.exec(inner)?.[1] ?? "user", segs: [] };
    } else if (/^#each\b/.test(inner)) {
      const list = inner
        .replace(/^#each\s+/, "")
        .split(/\s+/)[0]!
        .split(".")[0]!;
      loop = { list: cleanName(list), raw: list, item: [] };
    } else if (/^\/each\b/.test(inner)) {
      if (loop) ensure().segs.push({ kind: "loop", ...loop });
      loop = null;
    } else if (loop && /^this\b/.test(inner)) {
      loop.item.push({ kind: "field", path: inner.replace(/^this\.?/, "") });
    } else if (/^#if\b/.test(inner)) {
      const raw = inner
        .replace(/^#if\s+/, "")
        .split(/\s+/)[0]!
        .split(".")[0]!;
      cond = { condVar: cleanName(raw), condRaw: raw, then: [], else: [], branch: "then" };
    } else if (/^else\b/.test(inner) && cond) {
      cond.branch = "else";
    } else if (/^\/if\b/.test(inner)) {
      if (cond) ensure().segs.push({ kind: "if", ...cond });
      cond = null;
    } else if (!HELPERS.has(inner.split(/[.\s]/)[0]!)) {
      const name = inner.split(/[.\s]/)[0]!;
      if (loop) loop.item.push({ kind: "field", path: name });
      else if (cond) cond[cond.branch].push({ kind: "var", name: cleanName(name), raw: name });
      else ensure().segs.push({ kind: "var", name: cleanName(name), raw: name });
    }
  }
  pushText(template.slice(last));
  if (cur) messages.push(cur);

  return {
    model: parsed.model ?? "",
    inputs,
    messages,
    description: parsed.description ?? firstProse(template),
    body: template.trim(),
  };
}

// ── per-language field-type mapping, one source of truth per target ─────────

/** TypeScript type for a generated module's argument object. No per-item/property
 *  shape is tracked for array/object, so both fall back to `unknown`. */
export function tsFieldType(type: FieldType): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "unknown"; // array | object
  }
}

// ── rendering helpers, shared by the template (LangChain) backends ───────────

/** An `{{#if}}` reduced to a ternary: `condVar ? then : else`. `then`/`else` stay
 *  RAW `SimpleSeg[]` — same reason `LoopSeg[]` isn't pre-flattened here either:
 *  each backend renders embedded `{{var}}` refs in ITS OWN call-time syntax
 *  (`${args.x}` for JS, an f-string `{x}` for Python), not LangChain's `{name}`
 *  placeholder convention — that convention is for the OUTER template only,
 *  substituted once by LangChain itself; a branch's computed string is a plain
 *  language value by the time it reaches the invoke args, not re-templated.
 *  The block's placeholder name (`${condVar}Block`) is what appears in the
 *  outer `template`; each backend computes it once, call time, and merges it
 *  into the invoke args — exactly the pattern already used for a loop's
 *  pre-joined string. */
export interface RenderedCond {
  condVar: string;
  condRaw: string;
  blockVar: string;
  then: SimpleSeg[];
  else: SimpleSeg[];
}

/** A message flattened to an f-string-ready template + the loops/conds it references. */
export interface RenderedMessage {
  role: string;
  /** Literal text (braces escaped for f-string) with `{name}` / `{loopVar}` / `{blockVar}` placeholders. */
  template: string;
  loops: { var: string; raw: string; item: LoopSeg[] }[];
  conds: RenderedCond[];
}

const escapeBraces = (s: string): string => s.replaceAll("{", "{{").replaceAll("}", "}}");

/** Flatten messages to f-string templates; loops collapse to a single `{loopVar}`
 *  placeholder, `{{#if}}` blocks to a single `{condVarBlock}` placeholder. */
export function renderMessages(messages: Message[]): RenderedMessage[] {
  return messages.map((msg) => {
    const loops: RenderedMessage["loops"] = [];
    const conds: RenderedMessage["conds"] = [];
    let template = "";
    for (const seg of msg.segs) {
      if (seg.kind === "text") template += escapeBraces(seg.text);
      else if (seg.kind === "var") template += `{${seg.name}}`;
      else if (seg.kind === "loop") {
        loops.push({ var: seg.list, raw: seg.raw, item: seg.item });
        template += `{${seg.list}}`;
      } else {
        const blockVar = `${seg.condVar}Block`;
        conds.push({ condVar: seg.condVar, condRaw: seg.condRaw, blockVar, then: seg.then, else: seg.else });
        template += `{${blockVar}}`;
      }
    }
    return { role: msg.role, template: template.replaceAll(/^\n+|\n+$/g, ""), loops, conds };
  });
}

export const pascal = (s: string): string => cleanName(s).replace(/^[a-z]/, (c) => c.toUpperCase());
