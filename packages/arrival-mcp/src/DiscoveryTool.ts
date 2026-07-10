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
  type SchemeEnv,
  type SchemeValue,
  APair,
  CONSTANT_CTX,
  exec,
  jsToScheme,
  parse,
  sandboxedEnv,
  schemeToJs,
} from "@here.build/arrival";
import { assembleEnv } from "@here.build/arrival/env";
import { toSExprString } from "@here.build/arrival-serializer";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { format } from "date-fns";
import dedent from "dedent";
import * as z from "zod";

import type { McpAnnotation, McpCapabilitySpec, McpEnvCapability } from "./McpEnvCapability.js";

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

// ── REPL replay: structural cache per top-level statement ──────────────────────────────────────
// A REPL session re-establishes its bindings each call (the env is per-call). Rather than re-running
// every prior statement (which would re-fire its membrane penetrations), each statement is cached by
// its canonical SOURCE: a `(define …)` whose value is wire-safe is RESTORED from cache (its statement
// is never re-run, so the penetration never re-fires); a closure/uncacheable define is re-run, which
// is penetration-free because defining a lambda doesn't evaluate its body. The wire-safe membrane is
// what makes this sound — every penetrating statement yields a cacheable value, every uncacheable one
// is a closure. No verb-wrap, no interpreter tap: the statement source IS the structural key.

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

/** Can this JS value (already `schemeToJs`-peeled) round-trip through JSON faithfully? True for
 *  primitives, plain arrays/objects of the same; FALSE for functions/symbols/bigint and non-plain
 *  objects (bytevectors, class instances) — those statements re-run rather than restore. */
function jsonRoundTrippable(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === null) return true;
  switch (typeof v) {
    case "number":
    case "string":
    case "boolean":
      return true;
    case "object": {
      if (seen.has(v)) return false;
      seen.add(v);
      if (Array.isArray(v)) return v.every((x) => jsonRoundTrippable(x, seen));
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return false; // bytevector / class instance
      return Object.values(v as Record<string, unknown>).every((x) => jsonRoundTrippable(x, seen));
    }
    default:
      return false; // function / symbol / bigint / undefined
  }
}

/** The dispatch-time context the host threads per call — ABOVE the eval membrane, so a run can't
 *  reach session identity or another call's state (the invariant the run isolation rests on). */
export interface ToolCallCtx {
  /** The MCP session: its id + replay/state bag (`state.__repl__` is the honest-replay history). */
  session?: { id: string; state: Record<string, unknown> };
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

/** A discovery tool bound to one aggregating capability. Construct once per CONNECTION (the host
 *  builds `capability` with its infra armed into the resources); `call` runs once per request. */
export class DiscoveryTool {
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

  /** Evaluate `args.expr` in the env assembled from the capability, under the dispatch-time ctx.
   *  Re-establishes the session's prior bindings (structural cache), runs the new input statement
   *  by statement — REPL-style, so earlier statements' values stand even if a later one crashes —
   *  and threads `ctx.signal` + a wall-clock budget into every eval. A cancellation propagates; a
   *  runtime crash is surfaced as an `(error …)` form and stops the rest of the input. */
  async call(args: DiscoveryArgs, ctx: ToolCallCtx = {}): Promise<string[]> {
    const startTime = Date.now();
    const budgetMs = this.options.budgetMs ?? DEFAULT_BUDGET_MS;
    const heapBudget = this.options.heapBudget ?? defaultHeapBudget();
    const { signal } = ctx;
    const env = await this.environment(args);
    const state = ctx.session?.state ?? {};
    const history = (state.__repl__ as string[] | undefined) ?? [];
    const cache = (state.__cache__ as Record<string, string> | undefined) ?? {};

    // Re-establish prior bindings: restore a wire-safe define from the structural cache (NOT re-run →
    // its membrane penetration never re-fires); re-run a closure/uncacheable define (penetration-free,
    // since defining a lambda doesn't evaluate its body). A re-run that no longer reproduces is dropped
    // rather than allowed to poison the session. History holds only define statements.
    for (const src of history) {
      const name = defineName(src);
      if (cache[src] !== undefined && name) {
        env.set(name, jsToScheme(CONSTANT_CTX, JSON.parse(cache[src])));
        continue;
      }
      try {
        await execSerialized(src, { env, budgetMs, heapBudget, signal });
      } catch (error) {
        if (signal?.aborted) throw error; // cancellation, not a dead binding
      }
    }

    // Run the new input statement-by-statement; cache each wire-safe define's value by its source.
    const out: string[] = [];
    let crashed: string | undefined;
    let forms: SchemeValue[];
    try {
      forms = await parse(args.expr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      crashed = message;
      out.push(`(error ${JSON.stringify(message)})`);
      forms = [];
    }
    for (const [index, form] of forms.entries()) {
      const src = sourceTextFor(form, index, forms, args.expr);
      try {
        out.push(...(await execSerialized(form, { env, budgetMs, heapBudget, signal })));
      } catch (error) {
        if (signal?.aborted) throw error; // cancellation propagates — not a REPL crash
        crashed = error instanceof Error ? error.message : String(error);
        out.push(`(error ${JSON.stringify(crashed)})`); // REPL-style: earlier values stand; stop here
        break;
      }
      const name = defineName(src);
      if (!name) continue; // bare expression — output only, nothing to replay
      if (!history.includes(src)) history.push(src);
      // `env.get` is typed `unknown` on the public `SchemeEnv` surface (its concrete return type
      // is internal-only), but the runtime fact here is solid: `name` was just bound by the
      // `(define …)` this loop iteration ran seconds ago via `execSerialized`, so this is a real
      // `SchemeValue`, not an arbitrary unknown. Narrowed by cast, not `as any` — the same "one
      // sanctioned narrowing" idiom `schemeToJs`'s own doc comment documents for this exact
      // membrane boundary.
      const js = schemeToJs(env.get(name) as SchemeValue);
      if (jsonRoundTrippable(js)) cache[src] = JSON.stringify(js);
    }
    state.__repl__ = history;
    state.__cache__ = cache;

    this.log(ctx, args, startTime, crashed ? { success: false, errorMessage: crashed } : { success: true });
    return out;
  }

  // ── env assembly: config from the actor args, resources armed by the capability ──

  private async environment(args: DiscoveryArgs): Promise<SchemeEnv> {
    // The base is the constant safe floor (SAFE_BUILTINS) — vocabulary is added ONLY by the
    // capability's deps (the audited grant), never by swapping the base out from under it.
    const base = sandboxedEnv.inherit(this.name, {});
    const cfg = await this.config(args);
    return assembleEnv(base, [
      this.capability.lower({
        config: cfg,
        evalScheme: (e, src) => execSerialized(src, { env: e }),
      }),
    ]).then(({ env }) => env as SchemeEnv);
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
