// openai-types.ts — the OpenAI `POST /v1/chat/completions` wire shapes we accept + emit, plus our ONE
// non-standard extension (`contract`). A real OpenAI client / BFCL's OpenAI handler must accept the
// responses byte-for-byte: the response objects below are the exact subset those clients read.
//
// We model only what the constrained-scheme sampler needs. Fields a client may send that we ignore
// (temperature, top_p, n, stream, …) are accepted structurally (the request type is permissive) and
// simply not threaded — adding them is a seam, not a rewrite.

/** An OpenAI tool — the standard `{type:"function", function:{name, description, parameters}}` envelope.
 *  `parameters` is a JSON Schema object (the same shape a BFCL function's `parameters` carries), which is
 *  what {@link toolsToGrantEnv} reads to build the grant Σ + the positional→named argument mapping. */
export interface OpenAITool {
  readonly type: "function";
  readonly function: OpenAIFunctionDef;
}

/** The function half of an OpenAI tool — name, optional description, and a JSON Schema for the arguments. */
export interface OpenAIFunctionDef {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema for the call arguments. `properties` declaration order IS the positional argument order
   *  the scheme decode uses, so the scheme→tool_calls translation maps `args[i]` → the i-th property. */
  readonly parameters?: JSONSchema;
}

/** The slice of JSON Schema we read: an object schema with `properties` (declaration-ordered) and an
 *  optional `required` list. Each property is itself a {@link JSONSchemaProperty} (type + enum + items). */
export interface JSONSchema {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, JSONSchemaProperty>>;
  readonly required?: readonly string[];
}

/** One JSON Schema property — its scalar `type`, an optional closed-domain `enum`, an optional `items`
 *  element schema (for `array` params), and an optional `description` (rendered in the verbose surface). */
export interface JSONSchemaProperty {
  readonly type?: string;
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly items?: JSONSchemaProperty;
}

/** A chat message in the request (`role` + textual `content`). We read the user/system turns to frame the
 *  prompt; `tool`/`assistant` turns are tolerated structurally (future agentic loop). */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content?: string | null;
  /** Tolerated on assistant turns (we never read it on input; present for shape-compat). */
  readonly tool_calls?: readonly ToolCall[];
  /** Tolerated on `tool` turns. */
  readonly tool_call_id?: string;
  readonly name?: string;
}

/** Our ONE non-standard request extension: which OUTPUT CONTRACT to use. OpenAI clients ignore the unknown
 *  field; our custom BFCL handler sets it. `"fc"` (default) → translate the scheme call to OpenAI
 *  `tool_calls`; `"prompt"` → return the call AS TEXT in `message.content`, no `tool_calls`. */
export type OutputContract = "fc" | "prompt";

/** Our extension: the output RENDERING — how the decoded call(s) are serialized on the wire. Names mirror the
 *  render-strategies registry. When unset, behaviour follows the contract (fc → structured `tool_calls`; prompt →
 *  raw scheme content). When set, it overrides the serialization: `"tool-calls"` keeps the structured FC
 *  response; `"scheme"`/`"json"`/`"python-ast"` return the rendered call(s) as `message.content`. */
export type RenderFormat = "tool-calls" | "scheme" | "json" | "python-ast";

/** The `POST /v1/chat/completions` request body. Standard OpenAI fields + our `contract` extension. Fields
 *  we don't thread (temperature, stream, …) are accepted but ignored — a documented seam, not an error. */
export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  /** The offered tools — the grant Σ source in BOTH contracts (always structural, even in prompt mode). */
  readonly tools?: readonly OpenAITool[];
  /** Our extension: output contract selector. Default `"fc"`. */
  readonly contract?: OutputContract;
  /** Our extension: output RENDERING override (see {@link RenderFormat}). Default: follow the contract. */
  readonly render?: RenderFormat;
  /** Standard OpenAI knobs we accept but do NOT thread (seam): temperature, top_p, n, stream, stop, … */
  readonly temperature?: number;
  readonly top_p?: number;
  readonly n?: number;
  readonly stream?: boolean;
  readonly max_tokens?: number;
  /** Our extension passthrough: cap on generated tokens (maps to the sampler's `maxNewTokens`). When both
   *  this and `max_tokens` are set, this wins. */
  readonly max_new_tokens?: number;
  /** Tolerate any other fields a client may send (tool_choice, response_format, seed, …). */
  readonly [extra: string]: unknown;
}

/** An OpenAI `tool_call` in the response (the FC contract's output shape). `arguments` is a JSON STRING
 *  (OpenAI's quirk — arguments are stringified JSON, not a nested object). */
export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    /** A JSON STRING of the named arguments (e.g. `'{"location":"Paris","unit":"celsius"}'`). */
    readonly arguments: string;
  };
}

/** The assistant message in a response choice. In the FC contract it carries `tool_calls` (and null
 *  content); in the prompt contract it carries `content` (the call text) and no `tool_calls`. */
export interface ResponseMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly tool_calls?: readonly ToolCall[];
}

/** One choice in the response. `finish_reason` is `"tool_calls"` for the FC contract (a call was made),
 *  `"stop"` for the prompt contract or a plain-prose answer. */
export interface ChatCompletionChoice {
  readonly index: number;
  readonly message: ResponseMessage;
  readonly finish_reason: "tool_calls" | "stop";
  readonly logprobs: null;
}

/** Token-usage block. We don't meter precisely (the sampler doesn't surface token counts through the
 *  server-generate entry yet) — zeros are valid OpenAI shape; a real count is a seam. */
export interface Usage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

/** The `POST /v1/chat/completions` response body — the OpenAI shape a client / BFCL handler reads. */
export interface ChatCompletionResponse {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChatCompletionChoice[];
  readonly usage: Usage;
}

/** One entry in `GET /v1/models`. */
export interface ModelCard {
  readonly id: string;
  readonly object: "model";
  readonly created: number;
  readonly owned_by: string;
  /** NON-STANDARD: present only when the server has a resident-model provider wired — whether this model's
   *  gguf is loaded in memory right now. Clients ignore unknown fields. */
  readonly resident?: boolean;
}

/** The `GET /v1/models` response body. */
export interface ModelsResponse {
  readonly object: "list";
  readonly data: readonly ModelCard[];
}
