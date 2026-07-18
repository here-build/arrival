/**
 * The prompt backends — the `.prompt → runnable module` half of the matrix. The
 * PROGRAM lowering (scheme → TS) is fixed; only the prompt library swaps, hidden
 * behind a uniform `infer<Name>(args)` the program calls.
 *
 * Stage 1 (TS-only, per the dual-runtime design doc §0): two surviving backends,
 * one per runtime strategy — `langchain-js` (a `ChatPromptTemplate` pipeline
 * reproducing the authored prompt, pre-rendering `{{#each}}` loops to a joined
 * string at call time) and `vercel-ai` (W4 — a `generateText`/`models` module, the
 * template pre-rendered straight into a JS template-literal interpolation instead
 * of LangChain's own `{name}` mustache convention, since vercel/ai has no template
 * engine of its own to hand that string to). The langchain-py twin, the ax
 * signature-DSL backend, and the two Python backends (dspy, langchain-py) were
 * deleted in the same wave the Python emitter (former `python.ts`) was deleted —
 * the runtime-axis ruling is vercel/ai | langchain, nothing else. `vercel-ai` is
 * NOT this file's former `ax` (ax's signature style is subsumed by
 * `rt/structured-output` per the design doc, not resurrected) — and it does not
 * (yet) thread a declared `input.schema` into a zod `generateObject` call the way
 * `types/schema-zod` does for scheme-side `(infer ...)`; Picoschema→zod is a
 * distinct, unimplemented conversion (honest gap, not silently guessed), so
 * `vercel-ai`'s emitted signature stays `tsFieldType`-typed, same fallback
 * langchain-js already uses.
 */
import {
  type LoopSeg,
  parsePrompt,
  pascal,
  type PromptInput,
  renderMessages,
  type Seg,
  type SimpleSeg,
  tsFieldType,
} from "./prompt-ir.js";
import { vercelRuntimeLlmModule } from "./rt-vercel-ai.js";

export interface PromptModule {
  /** Target filename, e.g. `predict.ts` — a clean rename, same as a `.scm` source
   *  gets; `compileProject` rejects a same-stem collision against another emitted
   *  file rather than silently reintroducing a defensive suffix. */
  filename: string;
  /** The generated module source. */
  code: string;
  /** The exported entry, e.g. `inferPredict`. */
  exportName: string;
  /** Inputs extracted from the template. */
  inputs: PromptInput[];
}

export interface PromptBackend {
  id: "langchain-js" | "vercel-ai";
  /** Compile one `.prompt` into its target module. `promptName` is the file stem.
   *  Async because parsing may resolve a declared `input.schema` (Picoschema) —
   *  see `parsePrompt` in prompt-ir.ts. */
  compile(source: string, promptName: string): Promise<PromptModule>;
  /** The shared client module every compiled prompt imports (`_llm.ts` for
   *  langchain-js, `runtime/llm.ts` for vercel-ai — rt/client-module). */
  client(): { filename: string; code: string };
}

// ── shared snippet helpers ───────────────────────────────────────────────────

/** A line, escaped for use INSIDE a JS template literal. */
const jsTpl = (s: string): string => s.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");

/** Render an each-loop body to a JS template-literal fragment (`it.field` interps). */
function jsLoopItem(item: LoopSeg[]): string {
  let s = "";
  for (const seg of item) s += seg.kind === "text" ? jsTpl(seg.text) : seg.path ? `\${it.${seg.path}}` : "${it}";
  return s.replaceAll(/^\n+|\n+$/g, "");
}

/** Render an `{{#if}}` branch to a JS template-literal fragment (`args.x` interps —
 *  a branch string is a plain value by the time it reaches invoke, not re-templated
 *  by LangChain, so it interpolates directly from `args` rather than using a
 *  `{name}` placeholder). */
function jsCondBranch(segs: SimpleSeg[]): string {
  let s = "";
  for (const seg of segs) s += seg.kind === "text" ? jsTpl(seg.text) : `\${args.${seg.name}}`;
  return s.replaceAll(/^\n+|\n+$/g, "");
}

/** A multi-line template → a readable joined string literal (single line stays inline). */
function jsTemplateLiteral(template: string): string {
  const lines = template.split("\n");
  if (lines.length <= 1) return JSON.stringify(template);
  return `[\n${lines.map((l) => `    ${JSON.stringify(l)}`).join(",\n")}\n  ].join("\\n")`;
}

/** Frontmatter model → factory call argument: `"model"` or empty (factory env-defaults). */
const modelArg = (model: string): string => (model ? JSON.stringify(model) : "");

// ── langchain-js (JS, template) ──────────────────────────────────────────────

async function compileLangchainJs(source: string, name: string): Promise<PromptModule> {
  const doc = await parsePrompt(source);
  const exportName = `infer${pascal(name)}`;
  const rendered = renderMessages(doc.messages);
  const loops = rendered.flatMap((m) => m.loops);
  const loopVars = new Set(loops.map((l) => l.var));
  const conds = rendered.flatMap((m) => m.conds);
  const msgs = rendered.map((m) => `  [${JSON.stringify(m.role)}, ${jsTemplateLiteral(m.template)}]`).join(",\n");
  const argType = `{ ${doc.inputs
    .map((f) => `${f.name}: ${loopVars.has(f.name) ? "Array<Record<string, unknown>>" : tsFieldType(f.type)}`)
    .join("; ")} }`;
  const loopPre = loops.map(
    (l) => `  const ${l.var} = args.${l.var}.map((it) => \`${jsLoopItem(l.item)}\`).join("\\n");`,
  );
  // A ternary, same reasoning as scheme's own `if` in value position (see the CLI
  // design thread): `#if` only ever produces a STRING here, and JS's `if` can't,
  // so the target's own conditional-EXPRESSION form is the idiom, not a statement.
  const condPre = conds.map(
    (c) => `  const ${c.blockVar} = args.${c.condVar} ? \`${jsCondBranch(c.then)}\` : \`${jsCondBranch(c.else)}\`;`,
  );
  const pre = [...loopPre, ...condPre].join("\n");
  const merged = [...loopVars, ...conds.map((c) => c.blockVar)];
  const invoke = merged.length > 0 ? `{ ...args, ${merged.join(", ")} }` : "args";
  const code = `// Generated from ${name}.prompt by @inhuman.tools/mercury — do not edit.
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";

import { chatModel } from "./_llm.js";

const prompt = ChatPromptTemplate.fromMessages([
${msgs},
]);
const chain = prompt.pipe(chatModel(${modelArg(doc.model)})).pipe(new StringOutputParser());

export default async function ${exportName}(args: ${argType}): Promise<string> {
${pre ? `${pre}\n` : ""}  return chain.invoke(${invoke});
}
`;
  return { filename: `${name}.ts`, code, exportName, inputs: doc.inputs };
}

function langchainJsClient(): string {
  return `// The shared LangChain chat model factory. Point it at your endpoint.
import { ChatOpenAI } from "@langchain/openai";

export function chatModel(model?: string) {
  return new ChatOpenAI({
    model: model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY ?? "not-needed",
    configuration: { baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1" },
  });
}
`;
}

// ── vercel-ai (JS, template) ──────────────────────────────────────────────────
//
// The one real difference from langchain-js: vercel/ai has no template engine of
// its own (unlike LangChain's `ChatPromptTemplate`, which re-interprets `{name}`
// mustache placeholders at invoke time) — so a message's segments render straight
// to a JS template-literal WITH `${args.x}` interpolation, not `renderMessages`'s
// LangChain-flavored `{name}` flattening (reusing that would double-escape literal
// braces for no reason, since there's no downstream template engine to protect
// them from). `jsLoopItem`/`jsCondBranch`/`jsTpl` above stay shared (backend-
// agnostic — they already just build JS template-literal fragments).

const VALID_MODEL_IDENT = /^[A-Za-z_$][\w$]*$/;

/** Frontmatter model → a `models` registry reference (rt/client-module), mirroring
 *  rt-vercel-ai.ts's scheme-side `modelRef`: `models.gpt4o` for an identifier-safe
 *  alias, `models["gpt-4o-mini"]` otherwise; no frontmatter model → `models.default`. */
function vercelModelRef(model: string): string {
  const alias = model || "default";
  return VALID_MODEL_IDENT.test(alias) ? `models.${alias}` : `models[${JSON.stringify(alias)}]`;
}

/** One message's segments → a JS template-literal body (`${args.x}` interpolation)
 *  plus the loop/cond pre-renders it references — the vercel-ai analogue of
 *  `renderMessages`, but interpolating for real instead of flattening to `{name}`. */
function jsMessageBody(segs: Seg[]): {
  text: string;
  loops: { var: string; item: LoopSeg[] }[];
  conds: { condVar: string; blockVar: string; then: SimpleSeg[]; else: SimpleSeg[] }[];
} {
  let text = "";
  const loops: { var: string; item: LoopSeg[] }[] = [];
  const conds: { condVar: string; blockVar: string; then: SimpleSeg[]; else: SimpleSeg[] }[] = [];
  for (const seg of segs) {
    if (seg.kind === "text") text += jsTpl(seg.text);
    else if (seg.kind === "var") text += `\${args.${seg.name}}`;
    else if (seg.kind === "loop") {
      loops.push({ var: seg.list, item: seg.item });
      text += `\${${seg.list}}`;
    } else {
      const blockVar = `${seg.condVar}Block`;
      conds.push({ condVar: seg.condVar, blockVar, then: seg.then, else: seg.else });
      text += `\${${blockVar}}`;
    }
  }
  return { text: text.replaceAll(/^\n+|\n+$/g, ""), loops, conds };
}

async function compileVercelPrompt(source: string, name: string): Promise<PromptModule> {
  const doc = await parsePrompt(source);
  const exportName = `infer${pascal(name)}`;
  const bodies = doc.messages.map((m) => ({ role: m.role, ...jsMessageBody(m.segs) }));
  const loops = bodies.flatMap((b) => b.loops);
  const loopVars = new Set(loops.map((l) => l.var));
  const conds = bodies.flatMap((b) => b.conds);
  const msgs = bodies.map((b) => `    { role: ${JSON.stringify(b.role)}, content: \`${b.text}\` }`).join(",\n");
  const argType = `{ ${doc.inputs
    .map((f) => `${f.name}: ${loopVars.has(f.name) ? "Array<Record<string, unknown>>" : tsFieldType(f.type)}`)
    .join("; ")} }`;
  const loopPre = loops.map(
    (l) => `  const ${l.var} = args.${l.var}.map((it) => \`${jsLoopItem(l.item)}\`).join("\\n");`,
  );
  const condPre = conds.map(
    (c) => `  const ${c.blockVar} = args.${c.condVar} ? \`${jsCondBranch(c.then)}\` : \`${jsCondBranch(c.else)}\`;`,
  );
  const pre = [...loopPre, ...condPre].join("\n");
  const code = `// Generated from ${name}.prompt by @inhuman.tools/mercury — do not edit.
import { generateText } from "ai";

import { models } from "./runtime/llm.js";

export default async function ${exportName}(args: ${argType}): Promise<string> {
${pre ? `${pre}\n` : ""}  const { text } = await generateText({
    model: ${vercelModelRef(doc.model)},
    messages: [
${msgs},
    ],
  });
  return text;
}
`;
  return { filename: `${name}.ts`, code, exportName, inputs: doc.inputs };
}

// ── registry ─────────────────────────────────────────────────────────────────

export const PROMPT_BACKENDS: Record<PromptBackend["id"], PromptBackend> = {
  "langchain-js": {
    id: "langchain-js",
    compile: compileLangchainJs,
    client: () => ({ filename: "_llm.ts", code: langchainJsClient() }),
  },
  "vercel-ai": {
    id: "vercel-ai",
    compile: compileVercelPrompt,
    client: () => vercelRuntimeLlmModule(),
  },
};

export function getPromptBackend(id: PromptBackend["id"]): PromptBackend {
  return PROMPT_BACKENDS[id];
}
