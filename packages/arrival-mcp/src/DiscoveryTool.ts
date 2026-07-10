// DiscoveryTool — a discovery tool as a VALUE, not a subclass.
//
// `new DiscoveryTool(name, capability, { description })`. Everything the old
// `DiscoveryToolInteraction` subclass hand-declared now derives from the one
// aggregating `McpEnvCapability` (`env`):
//   • input schema = { expr, intent } ∪ the capability's `configuration` (the actor's typed args)
//   • catalog      = `capability.allAnnotations()` (verbs, descriptions, dynamicDescription, aliases)
//   • eval         = assembleEnv(base, [capability.lower({ config })]) then execSerialized
//
// The three host concerns enter at three membrane TIMES, never co-mingled:
//   • eval-time  → the capability's `resources` (provider reads the per-call config; verbs read
//                  `this.resources.x.live`). Authorization = a resource that won't spawn.
//   • dispatch-time → the `ToolCallCtx` (session, user, abort signal, record sink). It lives ABOVE
//                  the eval membrane — a run can't reach it, so session/other-call state stays out.
//   • describe-time → infra closed over when the host built the capability (the welcome).

import {
  type RunCache,
  type RunCacheEntry,
  type SchemeEnv,
  type SchemeValue,
  APair,
  exec,
  parse,
  sandboxedEnv,
} from "@here.build/arrival";
import type { EnvCapability } from "@here.build/arrival/capability";
import { assembleEnv } from "@here.build/arrival/env";
import { toSExprString } from "@here.build/arrival-serializer";
import type { AsyncSessionStore } from "@here.build/mcp-substrate";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { format } from "date-fns";
import dedent from "dedent";
import * as z from "zod";

import type { McpAnnotation, McpCapabilitySpec, McpEnvCapability } from "./McpEnvCapability.js";
import {
  type LogStatement,
  type SessionRunIdentity,
  type SessionRunState,
  SESSION_SEMANTICS_EPOCH,
  SessionRunCache,
  cacheValidFor,
  decodeSessionRunState,
  encodeSessionRunState,
  freshSessionRunState,
  isSessionRunState,
  sessionConfigDigest,
} from "./session-run-state.js";

// ── execSerialized: run scheme, serialize each top-level form's value (inlined from the
// former @here.build/arrival umbrella — its only consumer was this tool). ──

// Total serialized-output budget for one MCP tool result (~10k tokens). Motivated by the
// 158k-char "exceeds maximum allowed tokens" drop: the serializer streams per-element caps
// and shrinks them to fit this budget rather than emitting an oversized payload the client
// rejects. Split across the result elements so the SUM stays bounded.
const MCP_OUTPUT_BUDGET = 40_000;
const perElementBudget = (count: number): number => Math.max(2_000, Math.floor(MCP_OUTPUT_BUDGET / Math.max(1, count)));

interface ExecSerializedOptions {
  /** A real, already-armed env — used directly. A plain bindings object (no `__env__` marker,
   *  i.e. not a real `Environment`) is instead seeded into a fresh sandboxed child env. */
  env?: SchemeEnv;
  budgetMs?: number;
  /** Per-run allocation bound — see {@link defaultHeapBudget}. Undefined ⇒ unbounded (the `exec`
   *  primitive's own default; callers of this function always pass one, see `call` below). */
  heapBudget?: number;
  signal?: AbortSignal;
  /** THE RUN CACHE (R2, `ExecOptions.cache`) — record mode on live input, replay mode on fold.
   *  Undefined ⇒ no interception (sessionless calls — byte-identical fast path). */
  cache?: RunCache;
}

/**
 * Execute scheme source (or an already-parsed form) and serialize each top-level form's value
 * under the MCP output budget. `exec` already returns one `SchemeValue` per top-level form, and
 * the caller's REPL split (one already-parsed form per call) means there's nothing to coalesce:
 * serialize the results directly. No `(list …)` wrap-and-unwrap — that round-trip predated the
 * REPL split.
 */
async function execSerialized(expr: string | SchemeValue, options: ExecSerializedOptions = {}): Promise<string[]> {
  const env =
    options.env !== undefined && "__env__" in options.env
      ? options.env
      : sandboxedEnv.inherit("sandbox", options.env as never);
  const results = await exec(expr, {
    env: env as never,
    budgetMs: options.budgetMs,
    heapBudget: options.heapBudget,
    signal: options.signal,
    cache: options.cache,
  });
  const per = perElementBudget(results.length);
  return results.map((element) => toSExprString(element, { maxTotalChars: per }));
}

/** One positional zod arg rendered as a Scheme-doc type token for the catalog. */
function argTypeName(item: z.ZodType): string {
  const opt = (() => {
    try {
      return item.safeParse(undefined).success ? "?" : "";
    } catch {
      return "";
    }
  })();
  const desc = item.description ? ` (${item.description})` : "";
  if (item instanceof z.ZodString) return `string${opt}${desc}`;
  if (item instanceof z.ZodNumber) return `number${opt}${desc}`;
  if (item instanceof z.ZodBoolean) return `boolean${opt}${desc}`;
  if (item instanceof z.ZodArray) return `list${opt}${desc}`;
  if (item instanceof z.ZodEnum) return item.options.map((v) => `"${v}"`).join("|");
  return `value${opt}${desc}`;
}

// ── REPL sessions: statement log + first-class run cache (R3, §2.2/§2.4) ───────────────────────
// A session's durable twin is `(log, cache)`. Live, the warm `(env)` pair is memoized on the
// call's config digest — same digest ⇒ reuse (zero fold cost); changed ⇒ dispose the old env,
// assemble fresh, drop the cache (configDigest is part of the cache-validity identity), and FOLD:
// re-run the log over the cache in replay mode, where every declared `view` penetration is
// answered from the cache instead of re-fired, every `sink` tombstone skips, and `pure`/undeclared
// statements re-run under their stable-behavior promise. The old statement-level `__cache__`
// overlay (`jsonRoundTrippable` + `env.set` restore) is DISSOLVED (D3): a wire-safe define replays
// as re-execution over cached penetrations, arriving at the same value through the honest path.

const DEFINE_NAME = /^\(define\s+(?:\(\s*)?([^\s()]+)/;

/** The bound name of a `(define x …)` / `(define (f …) …)`, or undefined for a bare expression. */
function defineName(canonicalSrc: string): string | undefined {
  return DEFINE_NAME.exec(canonicalSrc.trim())?.[1];
}

// Splitting is done by the real reader (`parse`), not a hand-rolled lexer scan — a lexer-level
// depth counter can misalign with the actual forms (e.g. a `#;` datum comment is consumed by the
// real parser but still shows up as a token to a scanner), which would silently corrupt both the
// execution unit and the cache key below. `parse` is the single source of truth for boundaries;
// each form is then executed directly as a parsed AST via `execSerialized`'s low-level `exec`
// path (never re-stringified-and-reparsed).

/** The next form (from `fromIndex` onward) that carries `[LOCATION]` metadata, or `undefined` if
 *  none of the remaining forms have one. Looking ahead past location-less forms guarantees a
 *  form's source slice never crosses into a LATER form's own located text. */
function nextLocatedOffset(forms: readonly SchemeValue[], fromIndex: number): number | undefined {
  for (let i = fromIndex; i < forms.length; i++) {
    const f = forms[i];
    if (f instanceof APair) {
      const loc = f.getLocation();
      if (loc !== undefined) return loc.offset;
    }
  }
  return undefined;
}

/** The EXACT original source for one parsed form — the structural cache key + the text stored in
 *  session history. Prefers a location-anchored slice into the original `source` (preserving exact
 *  formatting, so a list stays `(a b)`, never re-rendered as constructor-call `(list a b)`); falls
 *  back to `toSExprString` for a form with no location metadata (e.g. a macro-expanded form). */
function sourceTextFor(form: SchemeValue, index: number, forms: readonly SchemeValue[], source: string): string {
  if (form instanceof APair) {
    const loc = form.getLocation();
    if (loc !== undefined) {
      const end = nextLocatedOffset(forms, index + 1) ?? source.length;
      return source.slice(loc.offset, end).trim();
    }
  }
  return toSExprString(form);
}

/** The dispatch-time context the host threads per call — ABOVE the eval membrane, so a run can't
 *  reach session identity or another call's state (the invariant the run isolation rests on). */
export interface ToolCallCtx {
  /** The MCP session: its id + state bag. With no injected `store`, the session's durable twin
   *  (`SessionRunState`) lives at `state.__run__` as ONE in-memory object (stdio mode — today's
   *  zero-config behavior); a legacy `state.__repl__` history seeds the v2 log on first touch. */
  session?: { id: string; state: Record<string, unknown> };
  /** Injected session persistence ("map but async"). When present, `SessionRunState` is
   *  encoded/decoded through it (keyed by the session id) and every write is AWAITED before the
   *  call responds — the "durably confirmed, not merely applied" bar. Absent ⇒ in-memory default
   *  (the session bag), zero-config. The mcp-worker DO wiring over DO storage is R4's. */
  store?: AsyncSessionStore;
  /** The authenticated principal (verified claims, never the request body) — stamped on the record. */
  user?: { sub: string; teamIds?: readonly string[] };
  /** Caller cancellation, fanned into the eval (TICK-checked) + any host requests it spawns. */
  signal?: AbortSignal;
  /** Fire-and-forget interaction sink — never blocks the response. */
  record?: (interaction: InteractionLog) => void;
}

/** What a single tool call records (a structural subset of the store's InteractionRecord). */
export interface InteractionLog {
  sessionId: string;
  userSub?: string;
  tool: string;
  intent?: string;
  arguments: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
}

export interface DiscoveryToolOptions {
  /** The tool's stable identity prose (the MCP `description`). Per-session/personalized text is the
   *  verbs' `dynamicDescription` (it rides the catalog), so this is static. */
  description: string;
  /** Wall-clock eval budget (the interpreter TICK-checks it). Defaults to {@link DEFAULT_BUDGET_MS}. */
  budgetMs?: number;

  /** Per-run allocation bound (the memory analogue of `budgetMs` — catches the native-collection-op
   *  runaway the TICK-cadence wall-clock can't preempt). Defaults to {@link defaultHeapBudget}. */
  heapBudget?: number;

  /** Per-session statement-count cap (Part III LIMIT — rehydration is O(n) in log size, bounded
   *  honestly). Hitting it is a TEACHING error directing the client to a fresh session, never a
   *  silent truncation. Defaults to {@link defaultStatementCap}. */
  statementCap?: number;

  /**
   * Host-supplied configuration values for the capability's `configuration` schema.
   * These are merged (host wins) with values extracted from the actor-provided `args` when
   * lowering the capability for execution. Use for injecting host services (functions,
   * per-request resources, etc.) that are declared in the capability configuration but are
   * not supplied by the actor and should not appear in the exposed tool schema.
   *
   * Can be a static partial or a function receiving the actor args for this invocation.
   */
  hostConfig?: Record<string, unknown> | ((actorArgs: DiscoveryArgs) => Record<string, unknown> | Promise<Record<string, unknown>>);

  /**
   * Which keys from the capability's `configuration` should be treated as exposable to the
   * actor: they will be included in the generated input schema for the tool and will be
   * pulled from the incoming call `args`.
   *
   * If omitted, *all* declared configuration keys are exposed.
   * Specify a subset to hide host-only configuration (e.g. `getGateway`) from the client.
   */
  exposableConfiguration?: readonly string[];
}

type DiscoveryArgs = { expr: string; intent?: string } & Record<string, unknown>;

/** Default wall-clock eval budget — the interpreter TICK-checks it (the SDK gives the SERVER no
 *  handler timeout; this is the server-side bound). */
export const DEFAULT_BUDGET_MS = 5000;

/** Per-run allocation-bound default (arrival-promises completion plan, gap 1). The
 *  `discovery-run.ts` precedent (`ARRIVAL_HEAP_MAX ?? 100_000_000`) — a FUNCTION, not a frozen
 *  constant, so it's read LIVE at every call and a test can flip the env var per case.
 *  `DiscoveryToolOptions.heapBudget` / a per-call option always wins over this default. */
export function defaultHeapBudget(): number {
  const raw = Number(process.env.ARRIVAL_HEAP_MAX);
  return Number.isFinite(raw) && raw > 0 ? raw : 100_000_000;
}

/** Per-session statement-count cap default (Part III LIMIT). A FUNCTION (like
 *  {@link defaultHeapBudget}) so it reads the env var live and tests can flip it per case. */
export function defaultStatementCap(): number {
  const raw = Number(process.env.MCP_SESSION_STATEMENT_CAP);
  return Number.isFinite(raw) && raw > 0 ? raw : 512;
}

/** A discovery tool bound to one aggregating capability. Construct once per CONNECTION (the host
 *  builds `capability` with its infra armed into the resources); `call` runs once per request. */
export class DiscoveryTool {
  /** Warm pairs, memoized on the call's config digest (§2.4's one warm-reuse rule): same digest
   *  ⇒ reuse the live env (zero fold cost); changed ⇒ dispose the old, assemble fresh, fold.
   *  Keyed by session id — per-session state lives with the session, never module-level. */
  private readonly warm = new Map<string, { digest: string; env: SchemeEnv; dispose: () => Promise<void> }>();

  constructor(
    readonly name: string,
    private readonly capability: McpEnvCapability,
    private readonly options: DiscoveryToolOptions,
  ) {}

  /** The MCP `Tool` definition — name, description, input schema. Read-only hint by construction. */
  async describe(clientInfo?: Record<string, unknown>): Promise<Tool> {
    return {
      name: this.name,
      description: this.options.description,
      inputSchema: await this.inputSchema(clientInfo),
      annotations: { readOnlyHint: true },
    };
  }

  /** Evaluate `args.expr` under the dispatch-time ctx — §2.1's per-call walk. Warm scope for
   *  this call's config digest? use it. Otherwise fold = re-run the session's statement log over
   *  its run cache (replay mode — a declared `view` penetration answers from the cache, a `sink`
   *  tombstone skips, everything else re-runs). New input then executes statement-by-statement in
   *  record mode over the SAME cache — REPL-style, so earlier statements' values stand even if a
   *  later one crashes — and the session's durable twin (log + cache + counters) is persisted
   *  (awaited) before the response. A cancellation propagates; a runtime crash is surfaced as an
   *  `(error …)` form and stops the rest of the input. */
  async call(args: DiscoveryArgs, ctx: ToolCallCtx = {}): Promise<string[]> {
    const startTime = Date.now();
    const budgetMs = this.options.budgetMs ?? DEFAULT_BUDGET_MS;
    const heapBudget = this.options.heapBudget ?? defaultHeapBudget();
    const { signal, session } = ctx;
    const cfg = await this.config(args);

    // ── sessionless: per-call env, disposed in `finally` (§2.8's interim dispose row) — no log,
    // no cache, nothing durable. The exec path carries no cache: byte-identical fast path.
    if (session === undefined) {
      const assembled = await this.assemble(cfg);
      try {
        const run = await this.runForms(args.expr, { env: assembled.env, budgetMs, heapBudget, signal });
        this.log(ctx, args, startTime, run.crashed ? { success: false, errorMessage: run.crashed } : { success: true });
        return run.out;
      } finally {
        await assembled.dispose();
      }
    }

    // ── the session path: load the durable twin, warm-or-fold, run, persist. ──
    const identity: SessionRunIdentity = {
      v: 2,
      semanticsEpoch: SESSION_SEMANTICS_EPOCH,
      roster: this.roster(),
      configDigest: sessionConfigDigest(cfg),
    };
    const state = await this.loadState(session, ctx.store, identity);

    const warm = this.warm.get(session.id);
    const { env, entries } =
      warm !== undefined && warm.digest === identity.configDigest
        ? { env: warm.env, entries: new Map(Object.entries(state.cache)) }
        : await this.foldIntoFreshEnv(session.id, state, identity, cfg, { budgetMs, heapBudget, signal });

    const run = await this.runForms(args.expr, {
      env,
      budgetMs,
      heapBudget,
      signal,
      cache: new SessionRunCache("record", entries, state.counters),
      state,
    });

    // Stamp the CURRENT identity (the cache just recorded under it), serialize the cache
    // (settled entries only — pendings never reach the entry map), and persist BEFORE responding.
    state.semanticsEpoch = identity.semanticsEpoch;
    state.roster = identity.roster;
    state.configDigest = identity.configDigest;
    state.cache = Object.fromEntries(entries);
    state.lastCallAt = Date.now();
    state.counters.elapsedMsTotal += Date.now() - startTime;
    await this.persist(session, ctx.store, state);

    this.log(ctx, args, startTime, run.crashed ? { success: false, errorMessage: run.crashed } : { success: true });
    return run.out;
  }

  /** Dispose one session's warm env (the host's session-close hook — `onsessionclosed`/DELETE;
   *  the deployment wiring is R4's). Idempotent; a session with no warm pair is a no-op. */
  async closeSession(sessionId: string): Promise<void> {
    const warm = this.warm.get(sessionId);
    if (warm === undefined) return;
    this.warm.delete(sessionId);
    await warm.dispose();
  }

  /** Dispose every warm pair (connection teardown). */
  async dispose(): Promise<void> {
    const all = [...this.warm.values()];
    this.warm.clear();
    for (const warm of all) await warm.dispose();
  }

  // ── the session machinery: load / fold / run / persist ──────────────────────────────────────

  /** Load the session's durable twin: the injected store's blob (decoded), or the in-memory
   *  object in the session bag, or — v2 absent — a fresh state whose log is SEEDED from the
   *  legacy `__repl__` define history (§2.2: the v2 log is a superset of it; the `__cache__`
   *  value overlay is DISSOLVED, not migrated — D3). */
  private async loadState(
    session: { id: string; state: Record<string, unknown> },
    store: AsyncSessionStore | undefined,
    identity: SessionRunIdentity,
  ): Promise<SessionRunState> {
    if (store === undefined) {
      const bag = session.state.__run__;
      if (isSessionRunState(bag)) return bag;
    } else {
      const blob = await store.get(session.id);
      if (blob !== undefined) {
        const decoded = decodeSessionRunState(blob);
        if (decoded !== undefined) return decoded;
      }
    }
    const fresh = freshSessionRunState(identity);
    const history = session.state.__repl__;
    if (Array.isArray(history)) {
      fresh.log = history
        .filter((src): src is string => typeof src === "string")
        .map((src) => {
          const name = defineName(src);
          return name === undefined ? { src } : { src, definedName: name };
        });
    }
    return fresh;
  }

  /** Persist the durable twin — store blob (encoded + AWAITED before the response) or the
   *  in-memory session bag (stdio: the blob is one object; nothing serializes). */
  private async persist(
    session: { id: string; state: Record<string, unknown> },
    store: AsyncSessionStore | undefined,
    state: SessionRunState,
  ): Promise<void> {
    if (store !== undefined) {
      await store.set(session.id, encodeSessionRunState(state));
      return;
    }
    session.state.__run__ = state;
  }

  /** The cold path: dispose the stale warm pair (config-digest change), assemble fresh, validate
   *  the cache identity (mismatch ⇒ drop the cache, KEEP the log, re-record — self-heal), then
   *  FOLD: re-run the log over the cache. Fold inherits the poison rule at statement level — a
   *  statement whose re-run crashes is DROPPED from the log (with a counter increment) rather
   *  than allowed to poison the session; cancellation propagates instead. Returns the warm env
   *  plus the live entry map the new input's record-mode cache shares. The assembled env's
   *  ownership transfers to the warm map only on success — a fold crash disposes it in `finally`
   *  (§2.8's interim bar row). */
  private async foldIntoFreshEnv(
    sessionId: string,
    state: SessionRunState,
    identity: SessionRunIdentity,
    cfg: Record<string, unknown>,
    opts: { budgetMs: number; heapBudget: number; signal?: AbortSignal },
  ): Promise<{ env: SchemeEnv; entries: Map<string, RunCacheEntry> }> {
    const prior = this.warm.get(sessionId);
    if (prior !== undefined) {
      this.warm.delete(sessionId);
      await prior.dispose();
    }
    const assembled = await this.assemble(cfg);
    let owned = false;
    try {
      const cacheValid = cacheValidFor(state, identity);
      if (cacheValid === false) state.cache = {}; // drop the cache, keep the log — re-record (self-heal)
      const entries = new Map(Object.entries(state.cache));
      if (state.log.length > 0) state.counters.rehydrations += 1;
      const foldCache = new SessionRunCache(cacheValid ? "replay" : "record", entries, state.counters);
      const kept: LogStatement[] = [];
      for (const stmt of state.log) {
        try {
          await execSerialized(stmt.src, { env: assembled.env, ...opts, cache: foldCache });
          kept.push(stmt);
        } catch (error) {
          if (opts.signal?.aborted) throw error; // cancellation, not a poisoned statement
          state.counters.droppedOnReplay += 1; // the poison rule: drop, count, continue
        }
      }
      state.log = kept;
      this.warm.set(sessionId, { digest: identity.configDigest, env: assembled.env, dispose: assembled.dispose });
      owned = true;
      return { env: assembled.env, entries };
    } finally {
      if (!owned) await assembled.dispose();
    }
  }

  /** Parse + execute `expr` form-by-form (REPL semantics: earlier values stand, a crash stops the
   *  rest). With a session `state`, every executed top-level statement — defines AND bare
   *  expressions — is appended to the log in program order (§2.2), under the statement-count cap
   *  (a TEACHING error at the cap, never silent truncation). */
  private async runForms(
    expr: string,
    opts: {
      env: SchemeEnv;
      budgetMs: number;
      heapBudget: number;
      signal?: AbortSignal;
      cache?: RunCache;
      state?: SessionRunState;
    },
  ): Promise<{ out: string[]; crashed?: string }> {
    const { env, budgetMs, heapBudget, signal, cache, state } = opts;
    const cap = this.options.statementCap ?? defaultStatementCap();
    const out: string[] = [];
    let crashed: string | undefined;
    let forms: SchemeValue[];
    try {
      forms = await parse(expr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      crashed = message;
      out.push(`(error ${JSON.stringify(message)})`);
      if (state !== undefined) state.counters.crashes += 1;
      forms = [];
    }
    for (const [index, form] of forms.entries()) {
      if (state !== undefined && state.log.length >= cap) {
        crashed = `session statement cap reached (${cap})`;
        out.push(
          `(error ${JSON.stringify(
            `${crashed}: this session's statement log is full, so further statements cannot be recorded for replay. ` +
              `Start a fresh MCP session to continue; fold long accumulations into ONE program (a single top-level form) ` +
              `instead of many REPL steps.`,
          )})`,
        );
        break;
      }
      const src = sourceTextFor(form, index, forms, expr);
      try {
        out.push(...(await execSerialized(form, { env, budgetMs, heapBudget, signal, cache })));
      } catch (error) {
        if (signal?.aborted) throw error; // cancellation propagates — not a REPL crash
        crashed = error instanceof Error ? error.message : String(error);
        out.push(`(error ${JSON.stringify(crashed)})`); // REPL-style: earlier values stand; stop here
        if (state !== undefined) state.counters.crashes += 1;
        break;
      }
      if (state !== undefined) {
        const name = defineName(src);
        state.log.push(name === undefined ? { src } : { src, definedName: name });
        state.counters.statements += 1;
      }
    }
    return crashed === undefined ? { out } : { out, crashed };
  }

  /** Capability names across the dep closure, sorted — the roster (§2.4: advisory for grants,
   *  authoritative as a cache-validity component). */
  private roster(): readonly string[] {
    const names = new Set<string>();
    const seen = new Set<EnvCapability>();
    const visit = (cap: EnvCapability): void => {
      if (seen.has(cap)) return;
      seen.add(cap);
      for (const dep of cap.spec.deps ?? []) visit(dep);
      names.add(cap.name);
    };
    visit(this.capability);
    return [...names].toSorted((a, b) => a.localeCompare(b));
  }

  // ── env assembly: config from the actor args, resources armed by the capability ──

  private async assemble(cfg: Record<string, unknown>): Promise<{ env: SchemeEnv; dispose: () => Promise<void> }> {
    // The base is the constant safe floor (SAFE_BUILTINS) — vocabulary is added ONLY by the
    // capability's deps (the audited grant), never by swapping the base out from under it.
    const base = sandboxedEnv.inherit(this.name, {});
    const pack = this.capability.lower({
      config: cfg,
      evalScheme: (e, src) => execSerialized(src, { env: e }),
    });
    const assembled = await assembleEnv(base, [pack]);
    return {
      env: assembled.env as SchemeEnv,
      // INTERIM ownership (R3 — §2.8's first-tranche dispose row): the kernel's pack disposers
      // PLUS the lowered pack's resource wind-down. The full ownership table is R7's.
      dispose: async () => {
        await assembled.dispose();
        await pack.windDown();
      },
    };
  }

  /** The capability's `configuration` fields. Actor values come from call args for the
   *  exposable keys; host values (from `hostConfig` option) are merged in. */
  private async config(args: DiscoveryArgs): Promise<Record<string, unknown>> {
    const spec = this.capability.spec as McpCapabilitySpec<Record<string, z.ZodType>, never>;
    const configSchema = spec.configuration ?? {};
    const allKeys = Object.keys(configSchema);
    const exposable = this.options.exposableConfiguration ?? allKeys;

    // Pull exposable fields from actor args (the tool call payload)
    const fromActor: Record<string, unknown> = {};
    for (const k of exposable) {
      if (k in args) fromActor[k] = args[k];
    }

    // Host-provided (may be functions, per-request services, etc.)
    let fromHost: Record<string, unknown> = {};
    if (this.options.hostConfig) {
      fromHost = typeof this.options.hostConfig === 'function'
        ? await this.options.hostConfig(args)
        : this.options.hostConfig;
    }

    const merged = { ...fromActor, ...fromHost };

    const schema = z.object(configSchema as z.ZodRawShape);
    return schema.parse(merged);
  }

  // ── catalog + input schema: both derived from the capability ──

  private async inputSchema(clientInfo?: Record<string, unknown>): Promise<Tool["inputSchema"]> {
    const verbs = await this.catalog();
    const dynamic = verbs.some((v) => v.dynamic);
    const aiName = clientInfo?.name === "claude-ai" ? "Claude" : "";

    // ONE zod object is the source — the capability's `configuration` (transforms and all) merged
    // with expr/intent. Only *exposable* configuration keys are included in the schema presented
    // to the actor (host-only config such as functions is supplied via hostConfig and omitted here).
    const configShape =
      (this.capability.spec as McpCapabilitySpec<Record<string, z.ZodType>, never>).configuration ?? {};
    const allConfigKeys = Object.keys(configShape);
    const exposableKeys = this.options.exposableConfiguration ?? allConfigKeys;
    const exposedConfig = Object.fromEntries(
      exposableKeys.map((k) => [k, (configShape as any)[k]]),
    );
    const input = z.object({
      intent: z
        .string()
        .describe("What you're exploring and why. Shown to collaborating users in the studio UI.")
        .optional(),
      expr: z.string().describe(this.exprDescription(verbs, dynamic, aiName)),
      ...(exposedConfig as z.ZodRawShape),
    });
    const { $schema: _drop, ...jsonSchema } = z.toJSONSchema(input);
    return jsonSchema as Tool["inputSchema"];
  }

  /** The `expr` field's prose — the logic-bearing description an actor reads to use the REPL: the
   *  sandbox's base-env vocabulary (chain-walked, so the docs stay FAITHFUL to the env we run), the
   *  batch-query contract, the domain verbs, and — when any verb is live — the personalized,
   *  timestamped welcome-screen note. Ported from the original DiscoveryToolInteraction.getToolSchema
   *  so the migration to the value shape preserves it exactly. */
  private exprDescription(verbs: { text: string }[], dynamic: boolean, aiName: string): string {
    const baseSymbols = this.baseEnvSymbols().join(", ");
    const preamble = dedent`
      Expr is an input for Scheme (Lisp dialect) REPL that will be executed in sandboxed environment.
      This sandbox is providing access to the actual system state snapshot at the moment of request.
      This snapshot is stored locally and can be traversed in full.
      You can do anything you want, do any data transformations, lenses, views of any complexity.
      Sandbox provides the following base-environment symbols (use freely):
      ${baseSymbols}

      This REPL supports batch queries. You can express your curiosity like this in single \`expr\` request (e.g.):
      \`\`\`
      (user)
      (all-projects)
      \`\`\`
      and this server will provide response in two messages per each top-level expression.
      You can use any lisp features to obtain data you need: filter, map

      Domain-specific functions available in sandbox:
    `;
    const base = `${preamble}\n${verbs.map((v) => v.text).join("\n")}`;
    if (!dynamic) return base;
    const forName = aiName ? ` FOR ${aiName.toUpperCase()}` : "";
    const personalNote = aiName
      ? ` (yes, ${aiName}, this tool description is not static and was generated personally for you right now)`
      : "";
    const timestamp = format(new Date(), "MMM do, HH:MM X");
    const liveNote = dedent`
      NOTE${forName} ON LIVE DESCRIPTION:
      The data provided above IS NOT STATIC.
      It is dynamically generated at every MCP session start. <timestamp>${timestamp}</timestamp>

      Some descriptions have user- and session-personalized, actual state at session start directly in description.
      That data is generated dynamically${personalNote} on description fetch to provide instant basic awareness even before session starts.
      Consider it as a dashboard or welcome screen for this MCP application.
    `;
    return `${base}\n${liveNote}`;
  }

  /** The base env's full symbol set (chain-walked, sorted) — advertised in the schema in place of a
   *  hardcoded builtin constant, so the docs are FAITHFUL to the real env `environment()` assembles. */
  private baseEnvSymbols(): string[] {
    // The scope-node owns its chain-walk (`allBoundNames`); we keep only the
    // string-name filter + sort the schema advertises. No `__parent__`/`list` poking.
    const names = sandboxedEnv.inherit(this.name, {}).allBoundNames();
    return names.filter((k): k is string => typeof k === "string").toSorted((a, b) => a.localeCompare(b));
  }

  /** The verb catalog reflected off the capability's dep-closure annotations. A STATIC `inputSchema`
   *  renders a sig; a getter (resource-resolving) is NOT invoked here (no live activation). A
   *  `dynamicDescription` thunk resolves live (and flags the entry session-generated). */
  private async catalog(): Promise<{ text: string; dynamic: boolean }[]> {
    return Promise.all(
      Object.entries(this.capability.allAnnotations()).map(async ([name, a]: [string, McpAnnotation]) => {
        const d = Object.getOwnPropertyDescriptor(a, "inputSchema");
        const sig = d && !d.get && Array.isArray(d.value) ? (d.value as z.ZodType[]).map(argTypeName).join(" ") : "";
        const live = await a.dynamicDescription?.();
        const sigPart = sig ? ` ${sig}` : "";
        return { text: `(${name}${sigPart}) - ${live ?? a.description}`, dynamic: live !== undefined };
      }),
    );
  }

  private log(
    ctx: ToolCallCtx,
    args: DiscoveryArgs,
    startTime: number,
    outcome: { success: boolean; errorMessage?: string },
  ) {
    const { expr: _e, intent, ...rest } = args;
    ctx.record?.({
      sessionId: ctx.session?.id ?? "unknown",
      userSub: ctx.user?.sub,
      tool: this.name,
      intent,
      arguments: rest,
      durationMs: Date.now() - startTime,
      ...outcome,
    });
  }
}
