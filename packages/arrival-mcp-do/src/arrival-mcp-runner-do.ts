/**
 * ArrivalMcpRunnerDO — the GENERALIZED DO-per-session MCP runner shell (R4, arrival-mcp
 * rework doc §2.4: "straight to DO, no bridge"). Extracted from the two deployments that
 * built it twice (inhuman's `McpSessionDO`, here.build's `MCPSessionDO`); products extend
 * this abstract class and supply ONLY their capability plane — no product semantics here
 * (the `hono-plexus-do` posture).
 *
 * The DO's id derives from `mcp-session-id` (`idFromName` at the worker); the DO hosts:
 *
 *   • the streamable-HTTP TRANSPORT (+ its McpServer + tool registration) — LIVE state,
 *     re-derived on wake (a stored handshake meta replays a synthetic `initialize` into
 *     the fresh transport, so a session SURVIVES isolate recycling at the protocol level);
 *   • the WARM PAIR — a `DiscoveryTool`'s warm env map lives on the tool instance held
 *     here (via `buildTools`), so warm reuse works while the DO is resident and folds from
 *     storage after eviction; the describe ambient is likewise built once per wake, per
 *     session by construction (the R7 assembleAmbient idiom — one capability per DO);
 *   • the session's DURABLE TWIN — `SessionRunState` decomposed over DO storage keys
 *     (`session-run-store.ts`: meta + log chunks + one key per cache entry), injected into
 *     every call as `ToolCallCtx.store` and AWAITED before each response (the "durably
 *     confirmed" bar; the DO output gate additionally holds the response until the writes
 *     commit);
 *   • the TTL ALARM — one reaper per session; expiry disposes the warm pair and wipes
 *     storage.
 *
 * CAPABILITIES ARE NOT DATA (the ephemerality doctrine): a capability closes over live
 * resources — db pools, gateways, tokens — so the generalized form is a FACTORY HOOK
 * (`buildTools`), never a serialized value. Everything durable is data; everything live is
 * re-derivable.
 *
 * HERMETICITY: there is NO module-level session map and NO mutable current-gateway —
 * per-session state lives in the session's own DO, and authority is re-derived per call
 * from the subclass's own plane. The DO merely PINS the session's principal (fixation
 * guard — the worker verifies the credential and stamps `x-internal-sub`; the DO refuses a
 * different subject on an existing session via `sessionPrincipal`).
 *
 * CALL SERIALIZATION: tool calls on one session run ONE AT A TIME (`#enqueue`). A session
 * is one REPL — its statement log is ordered — and serializing here makes gateway
 * interleaving (call A's verbs seeing call B's plane) structurally impossible, along with
 * the fold/dispose interleave two concurrent folds would race.
 *
 * §0: this DO adds ZERO privilege — it holds no secret the worker didn't already hold, and
 * every capability still walks a user-grade door in the subclass's plane.
 */
import { type McpTool, registerTools } from "@inhuman.tools/arrival-mcp";
import type { AsyncSessionStore } from "@inhuman.tools/mcp-substrate";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DurableObject } from "cloudflare:workers";

import { createDoSessionRunStore } from "./session-run-store.js";

/** Internal header the WORKER stamps after its auth middleware (it overwrites any inbound
 *  value, so it is unspoofable from outside; the DO is unreachable except through the
 *  worker). */
export const INTERNAL_SUB_HEADER = "x-internal-sub";

/** Internal header carrying the session's leg-2 SECRET, stamped by the (privileged) worker
 *  edge on EVERY request after it get-or-extends the credential at the api's JWT-only door
 *  (the SLIDE model — `mcp-session-native-credential.md` §Credential). Like
 *  {@link INTERNAL_SUB_HEADER} it is set unconditionally at the edge (any inbound value is
 *  overwritten), so it is unspoofable. The runner holds the stamped value IN-MEMORY only —
 *  it never persists it (`#sessionSecret`), and mints/revokes nothing: the credential's
 *  lifetime is the api's, sliding with each request. Optional on the wire: a deployment that
 *  has not yet moved its edge to the stamped-secret flow simply doesn't send it, and the
 *  runner's `sessionSecret()` stays `undefined`. */
export const INTERNAL_SESSION_SECRET_HEADER = "x-internal-session-secret";

/** Session idle TTL before the alarm reaps (ms), absent an env override. */
const DEFAULT_TTL_MS = 30 * 60_000;

/** Cap on how long `#close` waits for a live-state dispose before proceeding, so a hung
 *  teardown (a stuck WS close) can't hold the input gate open indefinitely. */
const DISPOSE_TIMEOUT_MS = 5_000;

/** The env slice the shell itself reads — a product Env extends this. */
export interface ArrivalMcpRunnerEnv {
  /** Session idle TTL override (ms) for the reaper alarm. Absent ⇒ 30 minutes. */
  MCP_SESSION_TTL_MS?: string;
}

/** The durable handshake record — everything needed to re-derive the LIVE transport state
 *  on wake (the synthetic `initialize` replay).
 *
 *  `userSub` is written on every NEW session; a deployment whose pre-extraction metas lack
 *  it must override `sessionPrincipal` with its own identity source (here.build's
 *  token-exchange state does exactly that). */
export interface SessionMeta {
  sessionId: string;
  userSub: string;
  protocolVersion: string;
  clientInfo: Record<string, unknown>;
  createdAt: number;
  lastCallAt: number;
}

/** What one session's tool tier looks like to the DO shell — `buildTools`' product. */
export interface SessionTools {
  tools: McpTool[];
  /** Warm-pair teardown (session close / TTL reap). */
  dispose(): Promise<void>;
}

interface LiveState {
  transport: WebStandardStreamableHTTPServerTransport;
  built: SessionTools;
  /** Aborted on session close / TTL reap — the capability plane's run-abort scope. */
  lifetime: AbortController;
}

const JSONRPC_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

export abstract class ArrivalMcpRunnerDO<Env extends ArrivalMcpRunnerEnv> extends DurableObject<Env> {
  // ── The hooks a deployment supplies (the diff between the two R4 instances) ────────────

  /** MCP `serverInfo` for this deployment's McpServer. */
  protected abstract readonly serverInfo: { name: string; version: string };

  /** Storage key of the durable handshake meta. Per-deployment (live sessions persist
   *  under the key their deployment always used — inhuman `session:meta`, here.build
   *  `mcp:meta`); never change it on a deployed product. */
  protected abstract readonly metaKey: string;

  /** The capability plane — THE factory hook. Closures over live resources (gateways,
   *  tokens, pools), built once per wake, disposed on close/reap. `lifetime` aborts on
   *  session teardown (the run-abort scope for long capabilities). */
  protected abstract buildTools(sessionId: string, sub: string, lifetime: AbortController): SessionTools;

  /** Fixation guard source: the principal this session is pinned to, or undefined when the
   *  session has no owner yet. Default pins the subject the handshake meta was initialized
   *  under; a deployment with its own durable identity (e.g. a token-exchange state)
   *  overrides. */
  protected async sessionPrincipal(meta: SessionMeta | undefined): Promise<string | undefined> {
    return meta?.userSub;
  }

  /** Extra teardown on session close / TTL reap (runs after live disposal, before the
   *  storage wipe) — e.g. resetting a subclass's in-memory auth state. */
  protected async onClose(): Promise<void> {
    // default: the shell's own teardown is complete
  }

  /** The alarm fired but no handshake meta exists. Default wipes storage (MCP re-init
   *  orphans included); a deployment whose storage holds durable state OUTSIDE the MCP
   *  session lifecycle (here.build's auth state) overrides with a no-op. */
  protected async onAlarmWithoutMeta(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  // ── The shell (identical across deployments) ───────────────────────────────────────────

  #live?: Promise<LiveState>;
  /** initialize params captured from the FIRST request's body (meta absent), consumed by
   *  `onsessioninitialized` to write the durable handshake meta. */
  #pendingInit?: { protocolVersion: string; clientInfo: Record<string, unknown> };
  /** One-at-a-time tool-call queue (see the module header's CALL SERIALIZATION). */
  #chain: Promise<unknown> = Promise.resolve();
  /** Teardown generation. `#close` bumps it; `fetch`/`#buildLive` capture it at entry and
   *  no-op their meta WRITES on mismatch. `blockConcurrencyWhile` gates DELIVERY of new
   *  events but NOT the continuations of an already-in-flight `fetch` — so a fetch that read
   *  meta before a sweep must not re-persist it, or the swept session resurrects over a
   *  revoked credential. In-memory suffices: a recycled isolate has no in-flight fetch. */
  #gen = 0;

  /** The session's leg-2 secret, as stamped on the CURRENT request's
   *  {@link INTERNAL_SESSION_SECRET_HEADER} by the worker edge. IN-MEMORY ONLY — never
   *  persisted (the credential is re-derivable per request: the edge slides + re-stamps it
   *  every time), so a `getSessionToken`-style storage read can't leak it and a swept
   *  session carries none. `undefined` until the first request stamps one (or forever, for a
   *  deployment whose edge doesn't stamp yet). Read by the subclass via `sessionSecret()` to
   *  arm its capability plane. */
  #sessionSecret?: string;
  /** In-memory subject pin, set by the FIRST request of this wake AFTER the fixation guard
   *  passes. Covers the window before the handshake meta exists (`meta.userSub` is written
   *  only by `onsessioninitialized`): without it, two interleaved pre-init requests from
   *  different principals would both pass `sessionPrincipal(undefined) === undefined` and the
   *  second could overwrite the first's in-memory secret. With it, request 2's subject must
   *  match request 1's or it 401s (store-after-guard, A3). Redundant once meta is written
   *  (the durable pin subsumes it); harmless to keep. */
  #pinnedSub?: string;

  /** The session's current leg-2 secret (the stamped credential), or `undefined` if the edge
   *  hasn't stamped one. The subclass's `buildTools` reads this — through a live closure, not
   *  a captured value — so its api client always presents the freshest stamp (under SLIDE the
   *  string is stable for the session's life, but the closure keeps it correct regardless). */
  protected sessionSecret(): string | undefined {
    return this.#sessionSecret;
  }

  #ttlMs(): number {
    const raw = Number(this.env.MCP_SESSION_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
  }

  /** A fresh, EMPTY handshake meta for lazy re-init (sweep recovery). Drives `#buildLive`'s
   *  handshake replay so a swept session's non-initialize request is accepted (instead of a
   *  transport 400) and lands on empty state; `onsessioninitialized` persists the real meta. */
  #syntheticMeta(sessionId: string, sub: string): SessionMeta {
    const now = Date.now();
    return {
      sessionId,
      userSub: sub,
      protocolVersion: this.#pendingInit?.protocolVersion ?? "2025-06-18",
      clientInfo: this.#pendingInit?.clientInfo ?? {},
      createdAt: now,
      lastCallAt: now,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const sub = request.headers.get(INTERNAL_SUB_HEADER);
    const sessionId = request.headers.get("mcp-session-id");
    if (!sub || !sessionId) {
      return Response.json(
        { error: `${this.constructor.name} must be reached through the worker's auth membrane` },
        { status: 500 },
      );
    }

    // Capture the teardown generation BEFORE any await: if a sweep runs while this fetch is
    // in flight, our meta writes below must no-op (the resurrection guard — see `#gen`).
    const gen = this.#gen;
    const meta = await this.ctx.storage.get<SessionMeta>(this.metaKey);

    // Fixation guard: a valid credential for user A never rides user B's session id. The
    // worker verified the token; the DO pins the subject the session belongs to — from the
    // durable handshake meta (`sessionPrincipal`) OR, before that exists, from the in-memory
    // pin the first request of this wake set (`#pinnedSub`), closing the pre-init window.
    const durablePrincipal = await this.sessionPrincipal(meta);
    const pinned = durablePrincipal ?? this.#pinnedSub;
    if (pinned !== undefined && pinned !== sub) {
      return Response.json({ error: "session does not belong to this principal" }, { status: 401 });
    }

    // Store-after-guard (A3): only now that this request's subject is authorized do we retain
    // its stamped leg-2 secret and pin the session's subject in memory. Retaining BEFORE the
    // guard would let user B's 401'd request poison user A's session with B's credential.
    const stampedSecret = request.headers.get(INTERNAL_SESSION_SECRET_HEADER);
    if (stampedSecret) this.#sessionSecret = stampedSecret;
    this.#pinnedSub ??= sub;

    // First request of a fresh session: capture the initialize params for the durable
    // handshake meta (consumed by onsessioninitialized; undefined on a non-init body).
    let initParams: Awaited<ReturnType<typeof extractInitParams>>;
    if (meta === undefined && request.method === "POST") {
      initParams = await extractInitParams(request);
      if (initParams !== undefined && this.#pendingInit === undefined) this.#pendingInit = initParams;
    }

    // Lazy re-init (sweep recovery): a non-initialize POST with no meta means the client
    // believes it holds a session we GC'd. Rather than let the transport 400 "Server not
    // initialized" (real MCP clients brick on that — they spin the dead id forever), drive an
    // EMPTY re-init: a synthetic meta makes #buildLive replay the handshake so the transport
    // accepts the call, and onsessioninitialized persists fresh meta + arms the reaper. The
    // call runs on empty state; the natural "undefined symbol" error tells the model its
    // prior session was reset.
    const swept = meta === undefined && request.method === "POST" && initParams === undefined;
    const effectiveMeta = swept ? this.#syntheticMeta(sessionId, sub) : meta;

    const live = await this.#ensureLive(sessionId, sub, effectiveMeta);

    // Bump the idle TTL on every authenticated touch of an initialized session — UNLESS a
    // sweep raced this fetch (`#gen` bumped): re-persisting `meta` here would resurrect a
    // just-closed session over a revoked credential.
    if (meta !== undefined && this.#gen === gen) {
      meta.lastCallAt = Date.now();
      await this.ctx.storage.put(this.metaKey, meta);
      await this.ctx.storage.setAlarm(meta.lastCallAt + this.#ttlMs());
    }

    return live.transport.handleRequest(request);
  }

  /** TTL reaper: expired ⇒ dispose the warm pair, wipe the session's storage (durable twin
   *  included), no re-arm. Not yet expired (a touch re-armed later than this alarm fired,
   *  or clock skew) ⇒ re-arm for the remainder. */
  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<SessionMeta>(this.metaKey);
    if (meta === undefined) {
      await this.onAlarmWithoutMeta();
      return;
    }
    const expiresAt = meta.lastCallAt + this.#ttlMs();
    await (Date.now() >= expiresAt ? this.#close() : this.ctx.storage.setAlarm(expiresAt));
  }

  /** Session teardown — DELETE (`onsessionclosed`) and the TTL reaper share it. Bumps `#gen`
   *  (so an in-flight fetch's meta write no-ops — the resurrection guard) and runs the whole
   *  teardown under `blockConcurrencyWhile` so no NEW event interleaves dispose→revoke→wipe. */
  async #close(): Promise<void> {
    this.#gen++;
    await this.ctx.blockConcurrencyWhile(async () => {
      const live = this.#live;
      this.#live = undefined;
      if (live !== undefined) {
        const state = await live.catch(() => undefined);
        state?.lifetime.abort();
        // Race a timeout so a hung dispose (e.g. a stuck WS close) can't wedge the input gate.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          (state?.built.dispose() ?? Promise.resolve()).catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
      }
      await this.onClose();
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      // Session fully gone: drop the in-memory credential + subject pin too, so nothing
      // survives the wipe in this isolate (a recycle would lose them regardless).
      this.#sessionSecret = undefined;
      this.#pinnedSub = undefined;
    });
  }

  /** The live wiring (transport + server + tools), built once per wake. With a stored
   *  handshake meta, a synthetic `initialize` replays into the fresh transport FIRST —
   *  "everything durable is data; everything live is re-derivable". */
  #ensureLive(sessionId: string, sub: string, meta: SessionMeta | undefined): Promise<LiveState> {
    this.#live ??= this.#buildLive(sessionId, sub, meta);
    return this.#live;
  }

  async #buildLive(sessionId: string, sub: string, meta: SessionMeta | undefined): Promise<LiveState> {
    // Generation at build time — `onsessioninitialized` (below) refuses to write meta if a
    // sweep raced this build, so a rebuild off stale meta can't resurrect the session.
    const gen = this.#gen;
    const lifetime = new AbortController();
    const store: AsyncSessionStore = createDoSessionRunStore(this.ctx.storage);
    // The in-memory half of ToolCallCtx.session — the id + a scratch bag (the durable twin
    // rides `store`; the bag only seeds v1 `__repl__` history, always empty here).
    const sessionBag = { id: sessionId, state: {} as Record<string, unknown> };

    const built = this.buildTools(sessionId, sub, lifetime);

    const server = new McpServer(this.serverInfo, { capabilities: { tools: {} } });
    registerTools(
      server,
      built.tools.map((t) => this.#serialized(t)),
      () => ({ session: sessionBag, store, user: { sub } }),
    );

    const transport = new WebStandardStreamableHTTPServerTransport({
      // The worker minted the id and addressed this DO by it — the generator ECHOES it, so
      // transport identity ≡ DO identity (one session, one object).
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: async (id) => {
        // A rehydration replay re-fires this callback — never clobber the original meta.
        const existing = await this.ctx.storage.get<SessionMeta>(this.metaKey);
        if (existing !== undefined) return;
        // A sweep raced this build (generation bumped) — do not resurrect a swept session.
        if (this.#gen !== gen) return;
        const now = Date.now();
        const fresh: SessionMeta = {
          sessionId: id,
          userSub: sub,
          protocolVersion: this.#pendingInit?.protocolVersion ?? "2025-06-18",
          clientInfo: this.#pendingInit?.clientInfo ?? {},
          createdAt: now,
          lastCallAt: now,
        };
        await this.ctx.storage.put(this.metaKey, fresh);
        await this.ctx.storage.setAlarm(now + this.#ttlMs());
      },
      onsessionclosed: async () => {
        await this.#close();
      },
    });

    await server.connect(transport);

    // Isolate-recycling survival: the durable handshake replays into the fresh transport
    // (the same fold-not-restore philosophy the run cache applies to the REPL scope).
    if (meta !== undefined) await replayHandshake(transport, meta);

    return { transport, built, lifetime };
  }

  /** Serialize tool calls per session (one REPL, ordered log — see module header). */
  #serialized(tool: McpTool): McpTool {
    return {
      name: tool.name,
      describe: (clientInfo) => tool.describe(clientInfo),
      call: (args, ctx) => this.#enqueue(() => tool.call(args, ctx)),
    };
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(() => fn());
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Pull `{protocolVersion, clientInfo}` out of a (possibly batched) JSON-RPC POST body.
 *  Returns undefined for anything that isn't an initialize request — honest no-op. */
async function extractInitParams(
  request: Request,
): Promise<{ protocolVersion: string; clientInfo: Record<string, unknown> } | undefined> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return undefined;
  }
  for (const msg of Array.isArray(body) ? body : [body]) {
    const m = msg as { method?: unknown; params?: { protocolVersion?: unknown; clientInfo?: unknown } } | null;
    if (m?.method === "initialize" && typeof m.params?.protocolVersion === "string") {
      return {
        protocolVersion: m.params.protocolVersion,
        clientInfo: (m.params.clientInfo as Record<string, unknown> | undefined) ?? {},
      };
    }
  }
  return undefined;
}

/** Re-derive the transport's live handshake state from the durable meta: a synthetic
 *  `initialize` + `notifications/initialized`, drained and discarded. After this, the fresh
 *  transport carries the SAME session id and accepts the client's next request as if the
 *  isolate had never recycled. */
async function replayHandshake(transport: WebStandardStreamableHTTPServerTransport, meta: SessionMeta): Promise<void> {
  const url = "https://mcp-session.internal/"; // synthetic origin — never leaves the process
  const init = await transport.handleRequest(
    new Request(url, {
      method: "POST",
      headers: JSONRPC_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "__rehydrate__",
        method: "initialize",
        params: { protocolVersion: meta.protocolVersion, capabilities: {}, clientInfo: meta.clientInfo },
      }),
    }),
  );
  await init.text(); // drain — the server's initialize result rides this response stream
  const initialized = await transport.handleRequest(
    new Request(url, {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, "mcp-session-id": meta.sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }),
  );
  await initialized.body?.cancel();
}
