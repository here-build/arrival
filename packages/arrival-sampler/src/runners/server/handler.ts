// handler.ts — thin translation layer (core of minimal OpenAI wrapper for primitive 2).
//
// Takes OpenAI req + DecodeFn (which is generateWithExplain for real, canned for tests). Does tools→grant,
// render, scheme→output shape. All hard constraint is in kernel. The server is the thin surface for BFCL.
//
// The internal decode is constrained scheme in BOTH contracts (the grammar/Σ is built from the SAME tools);
// only the EDGES differ:
//   • fc     → render the verbose tool schema into the system prompt; translate the scheme call(s) to OpenAI
//              `tool_calls`; finish_reason "tool_calls".
//   • prompt → render the COMPACT tool surface; return the scheme call AS TEXT in message.content; finish_reason
//              "stop"; no tool_calls.
//
// NON-CALL / PROSE PATH: when no tools are offered, or the decode returns no parseable call, we return a plain
// assistant TEXT message (finish_reason "stop", no tool_calls). This is the seam for future abstain/irrelevance
// and agentic final-answers — a minimal but real path, so the architecture does not assume every response is a
// call. TODO(abstain): a richer prose path (the model decides to abstain) needs an UNCONSTRAINED decode branch.

import type { OracleEnvΣ } from "@inhuman.tools/arrival/oracle";

import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type OutputContract,
  type ResponseMessage,
} from "./openai-types.js";
import { renderToolPrompt } from "./prompt-render.js";
import { renderStrategy, type RenderContext } from "./render-strategies.js";
import { parseSchemeForms } from "./scheme-parse.js";
import { schemeCallsToToolCalls, type ToolShape } from "./scheme-translate.js";
import { isTerminalVerb } from "./terminal.js";
import { toolsToGrantEnv } from "./tool-env.js";

/** What the decode seam is asked to produce: the decoded program STRING (one or more top-level scheme calls).
 *  Production wraps `generateWithExplain`; tests return a canned string. `grantEnv` is the Σ surface (the
 *  oracle's input); `systemPrompt` is the rendered tool surface; `userPrompt` is the user turn. */
export interface DecodeArgs {
  /** The grant {@link OracleEnvΣ} — `makeOracle(grantEnv)` is the constraint. */
  readonly grantEnv: OracleEnvΣ;
  /** The rendered system prompt (verbose for fc, compact for prompt). */
  readonly systemPrompt: string;
  /** The user turn (the request to materialise). */
  readonly userPrompt: string;
  /** The resolved model id (production resolves it to a gguf path; the seam owns that). */
  readonly model: string;
  /** Token cap, if the request supplied one. */
  readonly maxNewTokens?: number;
  /** The output contract (a decode seam MAY frame differently per contract; the default real decode does not). */
  readonly contract: OutputContract;
  /** Abort signal, if the transport supplied one. */
  readonly signal?: AbortSignal;
}

/** The decode seam: produce the decoded scheme program string for these args. Async (the real path awaits the
 *  llama.cpp decode). MUST resolve to a string (possibly empty — the prose path handles an empty/unparseable
 *  result). */
export type DecodeFn = (args: DecodeArgs) => Promise<string>;

/** Options for {@link handleChatCompletion}. */
export interface HandleOptions {
  /** The decode seam. */
  readonly decode: DecodeFn;
  /** A clock for the `created` field + id (injectable for deterministic tests). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** A response-id minter (injectable for deterministic tests). Defaults to a timestamp-based id. */
  readonly mintId?: () => string;
  /** Abort signal forwarded to the decode. */
  readonly signal?: AbortSignal;
}

/** The last user-turn content (the request to materialise). Falls back to the last message of any role with
 *  text, then to "". */
function lastUserPrompt(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (typeof m.content === "string" && m.content !== "") return m.content;
  }
  return "";
}

/** Any system-message text the caller supplied (prepended to the rendered tool surface, so a caller's framing
 *  is preserved). Joined by blank lines. */
function callerSystemText(messages: readonly ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "system" && typeof m.content === "string" && m.content !== "")
    .map((m) => m.content as string)
    .join("\n\n");
}

/**
 * The request→response CORE. Pure given the injected `decode`. Builds the grant Σ from the offered tools,
 * renders the per-contract system prompt, runs the decode, parses the scheme call(s), and shapes the OpenAI
 * response per the selected contract. With no tools or no parseable call, returns the prose path.
 */
export async function handleChatCompletion(
  req: ChatCompletionRequest,
  opts: HandleOptions,
): Promise<ChatCompletionResponse> {
  const contract: OutputContract = req.contract ?? "fc";
  const now = opts.now ?? Date.now;
  const mintId = opts.mintId ?? (() => `chatcmpl-${now()}`);
  const tools = req.tools ?? [];
  const maxNewTokens = req.max_new_tokens ?? req.max_tokens;

  // PROSE PATH (seam): no tools offered → nothing to constrain. Return an empty-stub assistant message. A
  // future abstain/agentic path runs an unconstrained decode here; for now this is the minimal honest stub.
  if (tools.length === 0) {
    return proseResponse("", req.model, contract, now, mintId);
  }

  // Build the grant Σ + the shared param-order/schema source (ONE source for env + translation).
  const grant = toolsToGrantEnv(tools);
  const shape: ToolShape = { paramOrderByTool: grant.paramOrderByTool, schemaByTool: grant.schemaByTool };

  // Render the per-contract system prompt (verbose for fc, compact for prompt), prefixed with any caller system.
  const callerSys = callerSystemText(req.messages);
  const toolSurface = renderToolPrompt(tools, contract);
  const systemPrompt = callerSys ? `${callerSys}\n\n${toolSurface}` : toolSurface;
  const userPrompt = lastUserPrompt(req.messages);

  // The constrained scheme decode (injected). Same Σ in both contracts.
  const program = await opts.decode({
    grantEnv: grant.env,
    systemPrompt,
    userPrompt,
    model: req.model,
    contract,
    ...(maxNewTokens === undefined ? {} : { maxNewTokens }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  const calls = parseSchemeForms(program);

  // PROSE PATH (seam): decode produced no parseable call (empty/garbled) → return it as prose text. Lets a
  // future abstain show up as content, and keeps a malformed decode from crashing the response. A terminal form
  // TRUNCATED mid-answer (`(respond "partial…`) lands here too — strip its scheme opener so only the answer text
  // surfaces, not the `(respond "` syntax.
  if (calls.length === 0) {
    return proseResponse(stripTruncatedTerminal(program).trim(), req.model, contract, now, mintId);
  }

  // TERMINAL-VERB PATH (the abstain / agentic final-answer exit): the decode chose a terminal verb
  // `(respond "…")` instead of a tool call. Return its message as a plain assistant ANSWER — content,
  // finish_reason "stop", NO tool_calls. This is how the oracle ABSTAINS on an irrelevant request and how it
  // ENDS an agentic loop (BFCL reads a non-call response as the final answer to grade). Contract-agnostic — a
  // final answer is content in both fc and prompt. See terminal.ts.
  if (isTerminalVerb(calls[0]!.name)) {
    const answer = calls[0]!.args
      .filter((a) => a.kind === "string")
      .map((a) => String(a.value))
      .join(" ");
    return proseResponse(answer, req.model, contract, now, mintId);
  }

  // RENDER OVERRIDE (the interchangeable serialization seam): if the request pins a content rendering, serialize
  // the call(s) via that strategy and return them AS CONTENT. `tool-calls` (and unset) fall through to the
  // structured FC path below — byte-identical to before. See render-strategies.ts.
  if (req.render !== undefined && req.render !== "tool-calls") {
    const ctx: RenderContext = { paramOrder: grant.paramOrderByTool };
    return proseResponse(renderStrategy(req.render).render(calls, ctx), req.model, contract, now, mintId);
  }

  if (contract === "prompt") {
    // PROMPT contract: return the call(s) AS TEXT in content, finish_reason "stop", NO tool_calls.
    return {
      id: mintId(),
      object: "chat.completion",
      created: now(),
      model: req.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: program.trim() },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: zeroUsage(),
    };
  }

  // FC contract: translate scheme call(s) → OpenAI tool_calls, finish_reason "tool_calls".
  const toolCalls = schemeCallsToToolCalls(calls, shape);
  const message: ResponseMessage = { role: "assistant", content: null, tool_calls: toolCalls };
  return {
    id: mintId(),
    object: "chat.completion",
    created: now(),
    model: req.model,
    choices: [{ index: 0, message, finish_reason: "tool_calls", logprobs: null }],
    usage: zeroUsage(),
  };
}

/** A plain assistant-text response (the prose / no-call path). `finish_reason` "stop", no tool_calls. */
function proseResponse(
  content: string,
  model: string,
  _contract: OutputContract,
  now: () => number,
  mintId: () => string,
): ChatCompletionResponse {
  return {
    id: mintId(),
    object: "chat.completion",
    created: now(),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: zeroUsage(),
  };
}

/** A terminal form truncated mid-answer — `(respond "partial…` — fails to parse, so without this it would land
 *  in the prose fallback with its scheme opener leaking into content. Strip the `(<verb> "` opener (and any
 *  trailing close-quote/paren) so only the partial answer text surfaces. Non-terminal/parseable input is
 *  returned unchanged. */
function stripTruncatedTerminal(program: string): string {
  const m = /^\s*\(\s*([A-Za-z][\w-]*)\s+"([\s\S]*)$/.exec(program);
  if (m && isTerminalVerb(m[1]!)) {
    return m[2]!.replace(/"\s*\)?\s*$/, "");
  }
  return program;
}

/** Zero usage block — the server-generate entry doesn't surface token counts yet (a seam). Valid OpenAI shape. */
function zeroUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}
