// server.ts — thin HTTP shell (ZERO deps) for the OpenAI compat surface (primitive 2).
//
// POST /v1/chat/completions + GET /v1/models. Delegates to handle + injected decode (generateWithExplain).
// This is the minimal wrapper so official BFCL harness can drive the sampler by pointing OPENAI_BASE_URL here.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { handleChatCompletion, type DecodeFn } from "./handler.js";
import { listModelIds, type Source } from "./model-resolve.js";
import type { ChatCompletionRequest, ModelsResponse } from "./openai-types.js";

/** Options to build the server. */
export interface ServerOptions {
  /** The decode seam (default: the real one — call {@link import("./real-decode.js").makeRealDecode}). */
  readonly decode: DecodeFn;
  /** Model sources for `/v1/models` (the CLI's discovered roster + LM Studio / Ollama / `--models-dir`). When
   *  supplied, `/v1/models` lists the union across them; otherwise it falls back to `rosterDir` (roster-only). */
  readonly sources?: readonly Source[];
  /** Roster directory for `/v1/models` (defaults to the sampler's models/roster). Ignored when `sources` is set. */
  readonly rosterDir?: string;
  /** A `model` fallback when a request omits one (e.g. the CLI `--model`). */
  readonly defaultModel?: string;
  /** Optional: the currently-RESIDENT model ids (the real decode's `makeRealDecode().residentIds`). When
   *  supplied, each `/v1/models` card is annotated with a non-standard `resident` boolean — handy for seeing
   *  which gguf is loaded right now (clients ignore the extra field). */
  readonly residentIds?: () => string[];
}

/** Read a request body fully into a string (JSON). Rejects on a transport error. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Write a JSON response with a status code. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** An OpenAI-shaped error body (a client / BFCL handler reads `error.message`). */
function errorBody(message: string, type = "invalid_request_error"): { error: { message: string; type: string } } {
  return { error: { message, type } };
}

/**
 * Build (but do not start) the HTTP server. Returns the node `Server` — the caller calls `.listen(port)`.
 * Routes the two endpoints; every other path is 404. Decode errors become a 500 with an OpenAI error body.
 */
export function createOpenAIServer(opts: ServerOptions): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, opts).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) sendJson(res, 500, errorBody(message, "internal_error"));
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: ServerOptions): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && (url === "/v1/models" || url.startsWith("/v1/models?"))) {
    const created = Math.floor(Date.now() / 1000);
    const resident = new Set(opts.residentIds ? opts.residentIds() : []);
    const data = listModelIds(opts.sources ?? opts.rosterDir).map((id) => ({
      id,
      object: "model" as const,
      created,
      owned_by: "here.build",
      // Non-standard annotation (omitted entirely when no residentIds provider is wired) — which gguf is
      // loaded in memory right now. Clients ignore the extra field.
      ...(opts.residentIds ? { resident: resident.has(id) } : {}),
    }));
    const body: ModelsResponse = { object: "list", data };
    sendJson(res, 200, body);
    return;
  }

  if (method === "POST" && (url === "/v1/chat/completions" || url.startsWith("/v1/chat/completions?"))) {
    const raw = await readBody(req);
    let parsed: ChatCompletionRequest;
    try {
      parsed = JSON.parse(raw) as ChatCompletionRequest;
    } catch {
      sendJson(res, 400, errorBody("request body is not valid JSON"));
      return;
    }
    // Apply the CLI default model when the request omits one.
    const reqWithModel: ChatCompletionRequest =
      parsed.model || opts.defaultModel === undefined ? parsed : { ...parsed, model: opts.defaultModel };
    if (!reqWithModel.model) {
      sendJson(res, 400, errorBody("missing required field: model (and no server --model default set)"));
      return;
    }
    const response = await handleChatCompletion(reqWithModel, { decode: opts.decode });
    sendJson(res, 200, response);
    return;
  }

  if ((method === "GET" || method === "HEAD") && (url === "/" || url === "/health")) {
    sendJson(res, 200, { status: "ok", endpoints: ["POST /v1/chat/completions", "GET /v1/models"] });
    return;
  }

  sendJson(res, 404, errorBody(`no route for ${method} ${url}`, "not_found"));
}
