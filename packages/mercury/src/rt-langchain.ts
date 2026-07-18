/**
 * `ts-langchain` runtime-specific emission — design doc §2.3 / §5. This is the ONE
 * file that owns every langchain-shaped codegen decision (`rt/*` opinions' actual
 * realization); `lower.ts` reads `ctx.strategy.id` at the two fill-time slots that
 * need it (an infer-family call, a chat-message tuple constructor) and dispatches
 * here — the C6 discipline, same pattern `rt-vercel-ai.ts` (W4) established: ONE
 * lowering core, runtime opinions fill at read-time, no cross-product special-
 * casing bleeding into the shared walk. `ts-vercel-ai`'s own rt/* fill (W4) is a
 * sibling file, never this one.
 *
 * `rt/agentic-loop` / `rt/mcp-tools` are a documented door here too (R6), for the
 * same reason `rt-vercel-ai.ts::lowerVercelInferCall` doors them: `(mcp "name")`
 * server entities have no first-class lowering ANYWHERE in this package today —
 * no STDLIB entry, no async-analysis handling beyond the bare verb name. The
 * shapes this file WOULD emit (`agenticLoop`, `mcpClientModule`, `messageTextHelper`
 * below) are built and standalone-verified (`__tests__/rt-langchain.test.ts`,
 * `__tests__/conformance/strict-emit-langchain.test.ts`) so the wiring is a
 * one-line change the day `(mcp …)` gets real source-vocabulary lowering — not
 * fabricated against a call site that can't reach them this wave.
 *
 * API surface verified against the PINNED registry versions at implementation time
 * (`@langchain/core@^1.1.48`, `@langchain/openai@^1.4.7` — `compile-project.ts::
 * DEP_VERSIONS`), not from memory (`.claude/rules/npm-version-pinning.md` extends
 * to API surfaces): `ChatOpenAI#invoke` resolves `{ text }`; `#withStructuredOutput`
 * returns a bound object whose own `.invoke` resolves the parsed value directly
 * (no `.object` unwrap, unlike vercel-ai's `generateObject`).
 */
import { isAtom, type Node } from "./nodes.js";

/** Parenthesize an `await …` expression before a member access — same idiom as
 *  `lower.ts::recv` / `stdlib.ts::recv`. Kept as an independent copy (not an
 *  import) on purpose: this module has zero dependency on `lower.ts`, so it can be
 *  unit-tested in isolation and, eventually, imported BY `lower.ts` without a
 *  cycle — the established idiom for this exact function across the repo (see
 *  `strategy/hash.ts` / `__tests__/conformance/support/echo-infer.ts`'s own
 *  `fnv1a` copies for precedent). */
const recv = (expr: string): string => (/^await\b/.test(expr) ? `(${expr})` : expr);

/** A JS string-literal expression whose content is a valid identifier —
 *  `"fast"` → `"fast"`. Anything else (a variable, a property access, a
 *  computed expression) is not a literal identifier. */
function literalIdentifier(expr: string): string | undefined {
  const m = /^"([A-Z_$][\w$]*)"$/i.exec(expr);
  return m?.[1];
}

/**
 * `models.fast` for a literal alias, `models[expr]` for a computed one — the
 * design doc's own two call-site spellings (§5 Shape A: `models.fast`; Shape B:
 * `models[config.model]`). `models` is `rt/client-module`'s registry
 * ({@link langchainRuntimeLlmModule}) — a Proxy keyed by ANY source alias, so both
 * spellings resolve identically regardless of which one a given call site uses.
 */
export function modelRef(modelExpr: string): string {
  const id = literalIdentifier(modelExpr);
  return id ? `models.${id}` : `models[${modelExpr}]`;
}

/**
 * rt/plain-infer, no schema: `(infer model prompt)` →
 * `(await models.m.invoke(prompt)).text` — a BARE string, not
 * `[new HumanMessage(prompt)]`. This is a deliberate, verified correction against
 * the design doc's illustrative prose (§5 Shape A wraps in a HumanMessage array;
 * the doc's own honesty ledger names itself "expected to be wrong somewhere until
 * it meets real programs" — same posture as `rt-vercel-ai.ts`'s documented
 * `experimental_createMCPClient` correction): `ChatOpenAI#invoke`'s real input
 * type is `BaseLanguageModelInput = string | BaseMessageLike[] | ...`
 * (`@langchain/core`'s own `language_models/base`) — a bare string IS a valid,
 * idiomatic call, langchain coerces it to a single human message internally. Two
 * independent reasons this is the better register, not just a shorter one: (1) a
 * plain-infer-only module needs no `HumanMessage` import at all; (2) it keeps the
 * wire-level distinction `infer` vs `infer/chat` carries on the interpreter side
 * (a bare prompt string vs a canonicalized message array are DIFFERENT content
 * keys there) — wrapping in an array here would silently make plain-`infer` and a
 * single-user-message `infer/chat` indistinguishable at the call site, which the
 * interpreter's own oracle never conflates. The single-EXPRESSION form is
 * embeddable anywhere a scheme expression can appear, matching the general
 * `(car (infer …))` contract (`infer/scalar-fold`).
 */
export function plainInfer(modelExpr: string, promptExpr: string): string {
  const invoke = `await ${modelRef(modelExpr)}.invoke(${promptExpr})`;
  return `${recv(invoke)}.text`;
}

/**
 * rt/chat-messages, no schema: `(infer/chat model messages)` →
 * `(await models.m.invoke(messages)).text`. `messagesExpr` is an already-lowered
 * JS array of message-constructor expressions (see {@link chatMessageCtor}).
 */
export function chatMessages(modelExpr: string, messagesExpr: string): string {
  const invoke = `await ${modelRef(modelExpr)}.invoke(${messagesExpr})`;
  return `${recv(invoke)}.text`;
}

/**
 * rt/structured-output: a schema-carrying `infer`/`infer/chat` →
 * `models.m.withStructuredOutput(Schema).invoke(promptOrMessages)` — same shared
 * `z.infer` schema constant `types/schema-zod` already materializes (W3).
 * `inputExpr` is the already-lowered prompt (plain `infer`) or messages array
 * (`infer/chat`) — the two verbs share this one shape, per the design doc.
 */
export function structuredOutput(modelExpr: string, inputExpr: string, schemaExpr: string): string {
  return `await ${modelRef(modelExpr)}.withStructuredOutput(${schemaExpr}).invoke(${inputExpr})`;
}

/**
 * rt/chat-messages' tuple constructors: `(infer/chat/system|user|assistant
 * content)` → `new SystemMessage(content)` / `new HumanMessage(content)` /
 * `new AIMessage(content)` — the interpreter's `(list "system" content)`-shaped
 * tuple wire format re-presented as the framework's own message classes (the
 * design doc's "tuple encoding is interpreter wire format, the object encoding is
 * the framework's").
 */
const MESSAGE_CTORS: Record<string, string> = {
  "infer/chat/system": "SystemMessage",
  "infer/chat/user": "HumanMessage",
  "infer/chat/assistant": "AIMessage",
};

/** The verbs {@link chatMessageCtor} handles — for the shared lowering core to
 *  recognize a chat-message-constructor call before falling through to a plain
 *  function call. */
export const CHAT_MESSAGE_CTOR_VERBS: ReadonlySet<string> = new Set(Object.keys(MESSAGE_CTORS));

/** The `@langchain/core/messages` class names {@link chatMessageCtor} can emit —
 *  the import list a module using it must carry. */
export const CHAT_MESSAGE_CTOR_IMPORTS = ["SystemMessage", "HumanMessage", "AIMessage"] as const;

export function chatMessageCtor(verb: string, contentExpr: string): string | undefined {
  const cls = MESSAGE_CTORS[verb];
  return cls ? `new ${cls}(${contentExpr})` : undefined;
}

/** Which `@langchain/core/messages` class {@link chatMessageCtor} would emit for
 *  `verb`, without lowering any content — the shared lowering core's import-usage
 *  census reads this (`lower.ts`'s `usedLangchainRuntime()`), never a fresh copy
 *  of {@link MESSAGE_CTORS}. */
export function chatMessageClassOf(verb: string): string | undefined {
  return MESSAGE_CTORS[verb];
}

// ── the wiring-shaped API — mirrors rt-vercel-ai.ts's own shape exactly ─────

export interface LangchainInferCtx {
  lower(n: Node): string;
  /** The emitted zod-schema constant name for a quoted `s/*` schema node
   *  (`types/schema-zod`), when the schema argument materialized one. */
  schemaConstOf(n: Node): string | undefined;
}

export interface LangchainInferLowering {
  /** The final expression — `(await models.m.invoke(...)).text` or
   *  `await models.m.withStructuredOutput(Schema).invoke(...)`. */
  code: string;
  usesStructuredOutput: boolean;
}

const isFalseAtom = (n: Node | undefined): boolean => isAtom(n) && !n.str && n.atom === "#f";

/**
 * `rt/plain-infer` (`(infer model prompt)` → `models.m.invoke(prompt)` — a BARE
 * string, see {@link plainInfer}'s doc for why NOT a `HumanMessage` wrap),
 * `rt/chat-messages` (`(infer/chat model msgs)` → `models.m.invoke(msgs)`),
 * `rt/structured-output` (a schema-carrying call of either →
 * `models.m.withStructuredOutput(schema).invoke(...)`) — one function because
 * the three differ only in how the input is shaped and whether a schema argument
 * is present, exactly the design doc's own framing ("the runtime axis is ONE
 * axis... read at the infer-lowering slot"). Called from
 * `lower.ts::lowerInferCall` ALREADY inside `infer/scalar-fold`'s fold — this
 * function's job is only the runtime shape, not the fold.
 *
 * `infer/agentic/end-to-end` is a documented door (R6) — see the file doc.
 */
export function lowerLangchainInferCall(
  verb: string,
  args: readonly Node[],
  ctx: LangchainInferCtx,
): LangchainInferLowering {
  if (verb === "infer/agentic/end-to-end") {
    throw new Error(
      'rt/agentic-loop (ts-langchain): `infer/agentic/end-to-end` is not yet lowered — `(mcp "name")` ' +
        "server entities have no first-class source-vocabulary lowering in this package (design doc §2.4 / " +
        "§5 Shape C) — the MCP/tools wiring is future work, not a silent miss.",
    );
  }
  const [modelArg, contentArg, schemaArg] = args;
  if (modelArg === undefined || contentArg === undefined) {
    throw new Error(`${verb}: expected (model content [schema]), got ${args.length} argument(s)`);
  }
  const modelExpr = ctx.lower(modelArg);
  const contentExpr = ctx.lower(contentArg);
  const hasSchema = schemaArg !== undefined && !isFalseAtom(schemaArg);
  if (hasSchema) {
    const schema = ctx.schemaConstOf(schemaArg) ?? ctx.lower(schemaArg);
    return { code: structuredOutput(modelExpr, contentExpr, schema), usesStructuredOutput: true };
  }
  if (verb === "infer/chat") {
    return { code: chatMessages(modelExpr, contentExpr), usesStructuredOutput: false };
  }
  return { code: plainInfer(modelExpr, contentExpr), usesStructuredOutput: false };
}

/**
 * `(infer/chat/system|user|assistant content)` → `new SystemMessage(content)` /
 * `new HumanMessage(content)` / `new AIMessage(content)` — the tuple encoding
 * (`(list "system" content)`) is interpreter wire format; the class encoding is
 * langchain's own (`@langchain/core/messages`).
 */
export function lowerLangchainMessageTuple(
  hName: string,
  args: readonly Node[],
  ctx: { lower(n: Node): string },
): string {
  const content = args[0];
  if (content === undefined) throw new Error(`${hName}: missing content argument`);
  const result = chatMessageCtor(hName, ctx.lower(content));
  if (result === undefined) throw new Error(`lowerLangchainMessageTuple: not a message-tuple constructor: ${hName}`);
  return result;
}

/**
 * rt/agentic-loop: `(infer/agentic/end-to-end model messages servers)` →
 * `createReactAgent({ llm, tools }).invoke({ messages })`, then peel the final
 * message's text. LangGraph's prebuilt agent is a GRAPH OBJECT + `.invoke` —
 * structurally unlike vercel-ai's single declarative call (the design doc's named
 * asymmetry: same source concept, two shapes, both named). `toolsExpr` is the
 * already-resolved tools value (`rt/mcp-tools`'s `mcpTools`, {@link mcpClientModule}).
 */
export function agenticLoop(modelExpr: string, messagesExpr: string, toolsExpr: string): string {
  const agent = `createReactAgent({ llm: ${modelRef(modelExpr)}, tools: ${toolsExpr} })`;
  const invoke = `await ${agent}.invoke({ messages: ${messagesExpr} })`;
  return `messageText(${recv(invoke)}.messages.at(-1))`;
}

/** The `messageText` helper {@link agenticLoop} calls — LangGraph's `messages`
 *  array holds framework message objects, not plain strings; a tiny named helper
 *  beats an inline structural cast at every call site. Emitted once per module
 *  that uses `infer/agentic/end-to-end` (mirrors `assemble.ts`'s `INVARIANT_DECL`
 *  inlining pattern for R3 — emit-on-demand, not unconditionally). Accepts
 *  `undefined` and throws a NAMED invariant rather than a bare `!` non-null
 *  assertion or an `unknown`/`any` cast (`.messages.at(-1)` is `T | undefined`
 *  under `strict`; an empty agent-loop result is exactly the kind of
 *  semantics-implied precondition `invariants/preconditions` (R3) already
 *  materializes elsewhere in this register — confirmed by `tsc --strict` against
 *  the real `Array.prototype.at` signature, not assumed). */
export function messageTextHelper(): string {
  return `function messageText(message: { content: unknown } | undefined): string {
  invariant(message, "infer/agentic/end-to-end: the agent loop produced no messages");
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}`;
}

/**
 * `runtime/mcp.ts` (rt/mcp-tools): one `MultiServerMCPClient` configured per
 * `(mcp "name")` entity the program references, `mcpTools` the merged
 * `await client.getTools()` result. `serverNames` is the program-wide census of
 * distinct MCP server names — an assembly-level concern (which `.scm` module
 * collects `(mcp …)` entities program-wide) this file does not itself perform;
 * it only renders the module given the names.
 *
 * NOT YET MODELED (declared honestly, matching the design doc's §2.4 posture on
 * unsupported tiers): mercury's `(mcp "name")` entity carries no transport-config
 * fields today, so each server's client config is an empty object — a real
 * transport (stdio command, URL, headers) is future work when the source syntax
 * grows one.
 */
export function mcpClientModule(serverNames: readonly string[]): { filename: string; code: string } {
  const entries = serverNames.map((n) => `  ${JSON.stringify(n)}: {}`).join(",\n");
  const code = `// The shared MCP client — one connection per server the program references.
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

export const mcpClient = new MultiServerMCPClient({
${entries}
});

export const mcpTools = await mcpClient.getTools();
`;
  return { filename: "runtime/mcp.ts", code };
}

/**
 * `runtime/llm.ts` (rt/client-module): a lazily-memoized model registry keyed by
 * ANY source alias — `models.fast`, `models["echo-model"]`, `models[config.model]`
 * all resolve through the same Proxy, matching both call-site spellings
 * {@link modelRef} emits. Generalizes today's `.prompt`-plane `_llm.ts`
 * (`prompt.ts::langchainJsClient`, a `chatModel(model?)` FACTORY FUNCTION) into a
 * property-access REGISTRY, because the design doc's in-`.scm` call sites are
 * `models.fast.invoke(...)`, not `chatModel("fast")`. `prompt.ts`'s `.prompt`
 * plane keeps its own `_llm.ts` for now — reconciling the two into ONE shared
 * client module (`layout/module-map`'s `runtime/` grouping) is a follow-up, not
 * silently resolved here (matching `rt-vercel-ai.ts::vercelRuntimeLlmModule`'s
 * `runtime/llm.ts`, which the `.prompt` plane's `vercel-ai` backend already
 * shares via `PROMPT_BACKENDS["vercel-ai"].client`).
 */
export function langchainRuntimeLlmModule(): { filename: string; code: string } {
  const code = `// The shared LangChain chat-model registry. Point it at your endpoint.
import { ChatOpenAI } from "@langchain/openai";

const cache: Record<string, ChatOpenAI> = {};

export const models: Record<string, ChatOpenAI> = new Proxy(cache, {
  get(target, model: string) {
    return (target[model] ??= new ChatOpenAI({
      model,
      apiKey: process.env.OPENAI_API_KEY ?? "not-needed",
      configuration: { baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1" },
    }));
  },
});
`;
  return { filename: "runtime/llm.ts", code };
}
