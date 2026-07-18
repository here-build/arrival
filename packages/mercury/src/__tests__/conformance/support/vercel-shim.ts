/**
 * The vercel/ai execution-time test double for the W2 conformance corpus (the
 * `ts-vercel-ai` analogue of `echo-infer.ts`'s existing `globalThis.infer` shim,
 * generalized to real imports instead of bare globals — see `run-compiled.ts`'s
 * `substituteVercelAiShim`).
 *
 * The REAL emitted artifact (this package's own `compile-project.ts` /
 * `rt-vercel-ai.ts`) imports `generateText`/`generateObject` from the real `ai`
 * package and `models` from a real `runtime/llm.ts` (`createOpenAICompatible`) —
 * that's what `strict-emit.test.ts` typechecks. But EXECUTING that for real would
 * dial out to `OPENAI_BASE_URL` over the network, which the agreement law must
 * never depend on (no network, no clock — same discipline as `echo-infer.ts`'s own
 * doc comment). So `run-compiled.ts` rewrites the two import specifiers (`"ai"` →
 * this file, `"./runtime/llm.js"` → this file) ONLY in the scratch copy it hands to
 * `tsx` — the compiler's own output contract (real imports) is never touched. This
 * file is never type-checked (same reasoning as `run-compiled.ts`'s `SHIM_PREAMBLE`:
 * the scratch dir runs through tsx's type-ERASING loader only), so `models` and the
 * two functions stay deliberately loose — just enough shape to satisfy what
 * `rt-vercel-ai.ts`'s emission actually calls.
 */
import { canonicalizeMessages, echoInferValue, normalizeSchema } from "./echo-infer.js";

/** `models.fast` / `models["echo-model"]` / `models[configModel]` — every alias
 *  resolves to itself (a bare string is all the shimmed generateText/generateObject
 *  below need to feed the oracle; the REAL runtime/llm.ts's `LanguageModel` object
 *  is production-only machinery, out of scope for a network-free harness). */
export const models = new Proxy(
  {},
  {
    get: (_target: object, prop: string | symbol): string => String(prop),
  },
);

/** `stepCountIs` — inert here: no corpus row reaches `rt/agentic-loop` (it's a
 *  documented door, `rt-vercel-ai.ts::lowerVercelInferCall`), but the shim ships it
 *  anyway so an import-substituted `"ai"` specifier never silently misses an export
 *  a future row might use. */
export function stepCountIs(stepCount: number): { type: "step-count"; stepCount: number } {
  return { type: "step-count", stepCount };
}

interface ShimMessage {
  role: unknown;
  content: unknown;
}

/** Fold `{prompt}` | `{messages}` (vercel/ai's own `Prompt` union) to the ONE wire
 *  string the shared oracle keys on — a plain prompt string as-is, a messages array
 *  through the SAME `canonicalizeMessages` the interpreter side's `infer/chat` uses,
 *  so a chat row's digest agrees with the interpreter regardless of which runtime
 *  produced it. */
function promptKey(args: { prompt?: string; messages?: readonly ShimMessage[] }): string {
  if (args.prompt !== undefined) return args.prompt;
  return canonicalizeMessages((args.messages ?? []).map((m) => [m.role, m.content]));
}

/** rt/plain-infer · rt/chat-messages: `generateText({model,prompt|messages})` →
 *  `{ text }`, over the shared echo oracle (no schema — the non-schema half of
 *  `echoInferValue`'s digest branch). */
export async function generateText(args: {
  model: unknown;
  prompt?: string;
  messages?: readonly ShimMessage[];
}): Promise<{ text: string }> {
  const value = echoInferValue(String(args.model), promptKey(args), null);
  return { text: typeof value === "string" ? value : JSON.stringify(value) };
}

/** rt/structured-output: `generateObject({model,prompt|messages,schema})` →
 *  `{ object }`, over the SAME oracle — `normalizeSchema` mirrors the emitted named
 *  zod schema constant back onto the source's `s/*` wire string exactly like the
 *  scheme-side (`echo-infer.ts`'s own doc), so a triage-style row agrees with the
 *  interpreter regardless of runtime. */
export async function generateObject(args: {
  model: unknown;
  prompt?: string;
  messages?: readonly ShimMessage[];
  schema: unknown;
}): Promise<{ object: unknown }> {
  const object = echoInferValue(String(args.model), promptKey(args), normalizeSchema(args.schema));
  return { object };
}
