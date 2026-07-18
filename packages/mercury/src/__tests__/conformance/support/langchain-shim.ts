/**
 * The langchain execution-time test double for the W2 conformance corpus — the
 * `ts-langchain` analogue of `vercel-shim.ts` (see that file's doc comment for
 * the pattern's rationale: the REAL emitted artifact imports the real
 * `@langchain/core/messages` classes and a real `runtime/llm.ts`
 * (`ChatOpenAI`) — that's what `strict-emit.test.ts` typechecks — but EXECUTING
 * that for real would dial out over the network, which the agreement law must
 * never depend on. `run-compiled.ts` rewrites BOTH import specifiers
 * (`"@langchain/core/messages"` and `"./runtime/llm.js"`) to this file, in the
 * scratch copy only).
 *
 * Never type-checked (same reasoning as `vercel-shim.ts` / `run-compiled.ts`'s
 * `SHIM_PREAMBLE`: the scratch dir runs through tsx's type-ERASING loader only),
 * so the message classes and `models` stay deliberately loose — just enough
 * shape to satisfy what `rt-langchain.ts`'s emission actually calls.
 */
import { canonicalizeMessages, echoInferValue, normalizeSchema } from "./echo-infer.js";

/** A shim message carries its OWN role (langchain's real classes encode role via
 *  the class itself / `getType()`, not a public field — this shim's role field is
 *  bookkeeping for {@link promptKey}, not a claim about the real API shape). */
class ShimMessage {
  constructor(
    public role: string,
    public content: unknown,
  ) {}
}

export class SystemMessage extends ShimMessage {
  constructor(content: unknown) {
    super("system", content);
  }
}
export class HumanMessage extends ShimMessage {
  constructor(content: unknown) {
    super("user", content);
  }
}
export class AIMessage extends ShimMessage {
  constructor(content: unknown) {
    super("assistant", content);
  }
}

/** Fold `string` | `ShimMessage[]` (`ChatOpenAI#invoke`'s own input union) to the
 *  ONE wire string the shared oracle keys on — a plain prompt string as-is, a
 *  message array through the SAME `canonicalizeMessages` the interpreter side's
 *  `infer/chat` uses, so a chat row's digest agrees with the interpreter
 *  regardless of which runtime produced it (mirrors `vercel-shim.ts::promptKey`
 *  exactly, over the langchain-shaped input instead of vercel's `{prompt|messages}`). */
function promptKey(input: string | readonly ShimMessage[]): string {
  if (typeof input === "string") return input;
  return canonicalizeMessages(input.map((m) => [m.role, m.content]));
}

interface ShimModel {
  invoke(input: string | readonly ShimMessage[]): Promise<{ text: string }>;
  withStructuredOutput(schema: unknown): { invoke(input: string | readonly ShimMessage[]): Promise<unknown> };
}

/** `models.fast` / `models["echo-model"]` / `models[configModel]` — every alias
 *  resolves to a fresh shim model over the shared oracle; no caching needed (the
 *  REAL `runtime/llm.ts`'s memoized Proxy is production-only machinery, out of
 *  scope for a network-free harness — same posture as `vercel-shim.ts::models`). */
export const models: Record<string, ShimModel> = new Proxy(
  {},
  {
    get: (_target: object, prop: string | symbol): ShimModel => ({
      invoke: async (input) => {
        const value = echoInferValue(String(prop), promptKey(input), null);
        return { text: typeof value === "string" ? value : JSON.stringify(value) };
      },
      withStructuredOutput: (schema: unknown) => ({
        invoke: async (input) => echoInferValue(String(prop), promptKey(input), normalizeSchema(schema)),
      }),
    }),
  },
);
