/**
 * `ts-vercel-ai` runtime-specific emission — design doc §2.2 / §5. This is the ONE
 * file that owns every vercel/ai-shaped codegen decision (`rt/*` opinions' actual
 * realization); `lower.ts` reads `ctx.strategy.id` at the two fill-time slots that
 * need it (an infer-family call, a chat-message tuple constructor) and dispatches
 * here — the C6 discipline (design doc §1 table row 4): ONE lowering core, runtime
 * opinions fill at read-time, no cross-product special-casing bleeding into the
 * shared walk. `ts-langchain`'s own rt/* fill (W5) is a sibling file, never this one.
 *
 * API surface verified against the PINNED registry versions at implementation time
 * (`ai@^6.0.201`, `@ai-sdk/openai-compatible@^2.0.48` — `compile-project.ts::
 * DEP_VERSIONS`), not from memory (`.claude/rules/npm-version-pinning.md` extends to
 * API surfaces): `generateText`/`generateObject` return `{ text }` / `{ object }`;
 * `createOpenAICompatible(...)` is CALLABLE (`(modelId) => LanguageModelV3`). One
 * correction against the design doc's draft text: `rt/mcp-tools`'s
 * `experimental_createMCPClient` no longer exists in `ai@6` — MCP client support
 * moved to the separate `@ai-sdk/mcp` package as `createMCPClient` (see that
 * package's `docs/07-reference/01-ai-sdk-core/23-create-mcp-client.mdx`); noted here
 * because `rt/mcp-tools` is NOT landed this wave (see {@link lowerVercelInferCall}'s
 * agentic door) — a future wave should re-verify again before wiring it, not trust
 * this comment either.
 */
import { isAtom, type Node } from "./nodes.js";

// ── rt/plain-infer · rt/chat-messages · rt/structured-output ────────────────

const VALID_IDENT = /^[A-Za-z_$][\w$]*$/;

/** `models.fast` for a literal, identifier-safe alias (the common case — string
 *  literals from source, matching design doc Shape A); `models[<expr>]` for
 *  anything else (a computed alias like `config/model`, Shape B, or a literal
 *  that isn't identifier-safe, e.g. `"echo-model"`'s hyphen) — both are the SAME
 *  `models` registry (`rt/client-module`), just the reader-facing spelling
 *  `rt/plain-infer`'s "OCD register" prefers when it can. */
function modelRef(modelArg: Node, lower: (n: Node) => string): string {
  if (isAtom(modelArg) && modelArg.str && VALID_IDENT.test(modelArg.atom)) return `models.${modelArg.atom}`;
  return `models[${lower(modelArg)}]`;
}

const isFalseAtom = (n: Node | undefined): boolean => isAtom(n) && !n.str && n.atom === "#f";

export interface VercelInferCtx {
  lower(n: Node): string;
  /** The emitted zod-schema constant name for a quoted `s/*` schema node
   *  (`types/schema-zod`), when the schema argument materialized one. */
  schemaConstOf(n: Node): string | undefined;
}

export interface VercelInferLowering {
  /** The scalar-folded expression — `(await generateText(...)).text` or
   *  `(await generateObject(...)).object`, never the raw result object (that's
   *  framework plumbing, not a source concept — same reasoning as the
   *  interpreter's own list-wrap `infer/scalar-fold` dissolves). */
  code: string;
  usesGenerateObject: boolean;
}

/**
 * `rt/plain-infer` (`(infer model prompt)` → `generateText({model,prompt})`),
 * `rt/chat-messages` (`(infer/chat model msgs)` → `generateText({model,messages})`),
 * `rt/structured-output` (a schema-carrying call of either → `generateObject({...,
 * schema})`) — one function because the three differ only in the `prompt`/
 * `messages` key and whether a schema argument is present, exactly the design
 * doc's own framing ("the runtime axis is ONE axis... read at the infer-lowering
 * slot"). Called from `lower.ts::lowerInferCall` ALREADY inside `infer/scalar-
 * fold`'s fold — this function's job is only the runtime shape, not the fold.
 *
 * `infer/agentic/end-to-end` is a documented door, not a silent miss (R6): `(mcp
 * "name")` server entities have no first-class lowering ANYWHERE in this package
 * today — no STDLIB entry (`stdlib.ts`), no dedicated async-analysis handling
 * beyond the bare verb name. Landing `rt/agentic-loop`/`rt/mcp-tools` for real
 * needs that lowering to exist first (real design work, design doc §2.4's own
 * "middleware-entity algebra... deferred" honesty applies here too); it is
 * unreachable from stage 1's source vocabulary this wave, so — per the design
 * doc's instruction — no corpus row exercises it and no shape is fabricated.
 */
export function lowerVercelInferCall(verb: string, args: readonly Node[], ctx: VercelInferCtx): VercelInferLowering {
  if (verb === "infer/agentic/end-to-end") {
    throw new Error(
      "rt/agentic-loop (ts-vercel-ai): `infer/agentic/end-to-end` is not yet lowered — `(mcp \"name\")` " +
        "server entities have no first-class source-vocabulary lowering in this package (design doc §2.4 / " +
        "§5 Shape C) — the MCP/tools wiring is future work, not a silent miss.",
    );
  }
  const [modelArg, contentArg, schemaArg] = args;
  if (modelArg === undefined || contentArg === undefined) {
    throw new Error(`${verb}: expected (model content [schema]), got ${args.length} argument(s)`);
  }
  const model = modelRef(modelArg, ctx.lower);
  const contentKey = verb === "infer/chat" ? "messages" : "prompt";
  const content = ctx.lower(contentArg);
  const hasSchema = schemaArg !== undefined && !isFalseAtom(schemaArg);
  if (hasSchema) {
    const schema = ctx.schemaConstOf(schemaArg) ?? ctx.lower(schemaArg);
    return {
      code: `(await generateObject({ model: ${model}, ${contentKey}: ${content}, schema: ${schema} })).object`,
      usesGenerateObject: true,
    };
  }
  return {
    code: `(await generateText({ model: ${model}, ${contentKey}: ${content} })).text`,
    usesGenerateObject: false,
  };
}

// ── rt/chat-messages: the tuple constructors ─────────────────────────────────

export const VERCEL_MESSAGE_ROLES: Readonly<Record<string, "system" | "user" | "assistant">> = {
  "infer/chat/system": "system",
  "infer/chat/user": "user",
  "infer/chat/assistant": "assistant",
};

/**
 * `(infer/chat/system|user|assistant content)` → a typed message literal
 * `{ role: "…", content } satisfies ModelMessage` — the tuple encoding
 * (`(list "system" content)`) is interpreter wire format; the object encoding is
 * vercel/ai's own (`ModelMessage`, from the `ai` package).
 */
export function lowerVercelMessageTuple(hName: string, args: readonly Node[], ctx: { lower(n: Node): string }): string {
  const role = VERCEL_MESSAGE_ROLES[hName];
  if (role === undefined) throw new Error(`lowerVercelMessageTuple: not a message-tuple constructor: ${hName}`);
  const content = args[0];
  if (content === undefined) throw new Error(`${hName}: missing content argument`);
  return `{ role: ${JSON.stringify(role)}, content: ${ctx.lower(content)} } satisfies ModelMessage`;
}

// ── rt/client-module ──────────────────────────────────────────────────────────

/**
 * `rt/client-module`: the shared model registry every emitted vercel-ai module
 * imports as `import { models } from "./runtime/llm.js"`. ONE OpenAI-compatible
 * provider (env-driven `OPENAI_BASE_URL`/`OPENAI_API_KEY` — LM Studio / OpenRouter
 * / any /v1 host), source model aliases resolved lazily and cached behind a
 * `Proxy` — `models.fast` (Shape A, a literal alias) and `models[configModel]`
 * (Shape B, a computed one) both just work against the SAME registry. The
 * strategy names ONE provider binding, a passthrough, never a per-alias provider
 * table switching on the model string — keeping the register this simple IS the
 * opinion (design doc §5 item 5: "the strategy names the provider binding... keep
 * it an OPINION value"), not an omission.
 */
export function vercelRuntimeLlmModule(): { filename: string; code: string } {
  const code = `// The shared vercel/ai model registry. Point OPENAI_BASE_URL at your endpoint
// (LM Studio, OpenRouter, any OpenAI-compatible /v1 host).
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

const provider = createOpenAICompatible({
  name: "inhuman",
  baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1",
  ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
});

function makeModels(): Record<string, LanguageModel> {
  const cache = new Map<string, LanguageModel>();
  const handler: ProxyHandler<Record<string, LanguageModel>> = {
    get(_target, prop): LanguageModel {
      const key = String(prop);
      let model = cache.get(key);
      if (model === undefined) {
        model = provider(key);
        cache.set(key, model);
      }
      return model;
    },
  };
  return new Proxy<Record<string, LanguageModel>>({}, handler);
}

/** Source model alias ("fast", a config/model value, …) → a lazily-constructed provider model. */
export const models: Record<string, LanguageModel> = makeModels();
`;
  return { filename: "runtime/llm.ts", code };
}
