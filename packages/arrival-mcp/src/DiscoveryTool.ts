// DiscoveryTool — a discovery tool as a VALUE, not a subclass.
//
// `new DiscoveryTool(name, capability, { description })`. Everything the old
// `DiscoveryToolInteraction` subclass hand-declared now derives from the one
// aggregating `McpEnvCapability` (`env`):
//   • input schema = { expr, intent } ∪ the capability's `configuration` (the actor's typed args)
//   • catalog      = `capability.allAnnotations()` (verbs, descriptions, dynamicDescription, aliases)
//   • eval         = assembleAmbient({ capabilities: [capability], config }) — the exec-phases
//                    phase-2 product (R7) — then per-form execState over `{ ambient, scope }`
//
// The three host concerns enter at three membrane TIMES, never co-mingled:
//   • eval-time  → the capability's `resources` (provider reads the per-call config; verbs read
//                  `this.resources.x.live`). Authorization = a resource that won't spawn.
//   • dispatch-time → the `ToolCallCtx` (session, user, abort signal, record sink). It lives ABOVE
//                  the eval membrane — a run can't reach it, so session/other-call state stays out.
//   • describe-time → infra closed over when the host built the capability (the welcome).

import {
  type EffectEntry,
  type EffectLog,
  type EvalTap,
  type RunCache,
  type RunCacheEntry,
  type SchemeValue,
  APair,
  LexicalScope,
  MemoryEffectLog,
  execState,
  is_callable_value,
  parse,
} from "@here.build/arrival";
import { EvalTrace } from "@here.build/arrival/provenance";
import type { EnvCapability } from "@here.build/arrival/capability";
import { type AssembledAmbient, assembleAmbient } from "@here.build/arrival/env";
import {
  type ExtrasState,
  type SerializedExtra,
  formatByteSize,
  initialExtrasState,
  serializeWithExtras,
  toSExprString,
} from "@here.build/arrival-serializer";
import type { AsyncSessionStore, ContentBlock, ReplEvent, StatementCounters } from "@here.build/mcp-substrate";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { format } from "date-fns";
import dedent from "dedent";
import * as z from "zod";

import { type ConfirmManifest, buildConfirmManifest, buildInvocationSource, isConfirmManifest } from "./confirm-manifest.js";
import { type RigAlteredCheck, noRigAlteredCheck } from "./confirm-burst.js";
import { lowerBinaryBlob } from "./dispatch.js";
import { MCPError } from "./errors.js";
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

// ── execSerializedState: run scheme, serialize each top-level form's value (inlined from the
// former @here.build/arrival umbrella — its only consumer was this tool). ──

// Total serialized-output budget for one MCP tool result (~10k tokens). Motivated by the
// 158k-char "exceeds maximum allowed tokens" drop: the serializer streams per-element caps
// and shrinks them to fit this budget rather than emitting an oversized payload the client
// rejects. Split across the result elements so the SUM stays bounded.
const MCP_OUTPUT_BUDGET = 40_000;
const perElementBudget = (count: number): number => Math.max(2_000, Math.floor(MCP_OUTPUT_BUDGET / Math.max(1, count)));

interface ExecSerializedOptions {
  /** The call's assembled ambient (exec-phases phase-2 product, R7) — CALLER-owned; exec never
   *  disposes it. Warm-reuse and per-call disposal are both DiscoveryTool's (ownership table). */
  ambient: AssembledAmbient;
  /** The session's lexical accumulation (phase 3's caller-passed scope) — top-level `define`s
   *  land HERE, never on the ambient's env, so REPL continuity is the designed
   *  `execState({ scope })` idiom rather than glass-env mutation. */
  scope: LexicalScope;
  budgetMs?: number;
  /** Per-run allocation bound — see {@link defaultHeapBudget}. Undefined ⇒ unbounded (the `exec`
   *  primitive's own default; callers of this function always pass one, see `call` below). */
  heapBudget?: number;
  signal?: AbortSignal;
  /** THE RUN CACHE (R2, `ExecOptions.cache`) — record mode on live input, replay mode on fold.
   *  Undefined ⇒ no interception (sessionless calls — byte-identical fast path). */
  cache?: RunCache;
  /** Per-form serialization budget, computed ONCE per call from the PARSED form count —
   *  §2.5's parse-first budget fix (closes §1.2's SUM regression: the per-exec
   *  `perElementBudget(results.length)` default sees one form per exec in the REPL split, so
   *  every form got the near-full budget and the batch SUM was unbounded). The REPL loop
   *  (`runForms`) always passes `perElementBudget(forms.length)`; the fold — whose output is
   *  discarded — keeps the per-exec default. */
  charBudget?: number;
  /** R6 (§2.6): the call-level attachment numbering/quota. Present ⇒ values render through
   *  `serializeWithExtras` (binary leaves extracted into `extras`, ~40-char tags in the core
   *  text); absent ⇒ plain `toSExprString` — the byte-identical fast path (the fold — whose
   *  output is discarded — stays here: no extraction work is wasted on it). */
  extrasState?: ExtrasState;
  /** THE EFFECT LOG (arrival-provenance-confirmation.md, values/effect-log.ts W1). Present ⇒
   *  every `sink`-classed penetration this form makes GATHERS onto the log instead of firing
   *  (`exec`'s own `effects` option, threaded verbatim) — the confirmation design's
   *  queries-then-effects-burst model. Absent (the fold path, sessionless calls) ⇒ sinks fire
   *  immediately, byte-identical to pre-confirmation behavior. */
  effects?: EffectLog;
  /** Lineage capture (default-on, §7.6's disable knob is the CALLER omitting this) — the
   *  `EvalTrace` a confirm-manifest's per-argument `groundingVerdict` annotation reads. Reused
   *  across every form of ONE call (the manifest's `forms` span the whole call, not one
   *  statement) so a later effect's arguments can trace back through an earlier statement's
   *  reads. */
  tap?: EvalTap;
}

/** The standard base's full symbol vocabulary (sorted), advertised in the tool schema in place
 *  of a hardcoded builtin constant — so the docs stay FAITHFUL to the base every eval ambient
 *  augments. Realm-memoized (the base is realm-scoped); read off a throwaway BARE ambient's
 *  sealed chain (`names()`), the privatization-era replacement for the retired
 *  instance-env `allBoundNames()` chain walk. */
let baseEnvSymbolsMemo: Promise<readonly string[]> | undefined;
function baseEnvSymbols(): Promise<readonly string[]> {
  return (baseEnvSymbolsMemo ??= (async () => {
    const ambient = await assembleAmbient({});
    try {
      return [...ambient.names()].filter((k): k is string => typeof k === "string").toSorted((a, b) => a.localeCompare(b));
    } finally {
      await ambient.dispose();
    }
  })());
}

/** `execSerializedState`'s product: the serialized outputs plus this form's meter reads (§2.7). */
interface ExecSerializedOutcome {
  out: string[];
  /** R6: this form's extracted binary leaves, in encounter order (empty without `extrasState`). */
  extras: readonly SerializedExtra[];
  /** R6: how many binary leaves THIS form rendered tag-only past quota (never collected, never
   *  base64-encoded) — the per-statement delta the drained note reports, never silently. */
  overflowDelta: number;
  /** The run's allocation-meter read (0 when the run carried no meter — never the case on
   *  DiscoveryTool paths, where the heap budget is default-ON). */
  heapUsed: number;
  heapMax: number;
}

/** The callable face for serialization (see `hostFace`): any `typeof === "function"` value
 *  renders as `<function>` in the serializer, byte-identical to membrane `toJS`'s
 *  `callableToHostFn` wrapper on this serialize-only path. Never invoked, never escapes. */
function schemeCallableFace(): never {
  throw new Error("schemeCallableFace: a serialization-only face — never invocable");
}

/** A multiple-values result (`(values …)`) — sits OUTSIDE the AValue hierarchy, detected
 *  structurally the way membrane `toJS`'s `instanceof Values` arm does by class. */
function isValuesTuple(value: unknown): value is { __values__: SchemeValue[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "__values__" in value &&
    Array.isArray((value as { __values__?: unknown }).__values__)
  );
}

/**
 * Scheme→JS exit for serialization — mirrors the simple-tier `exec` unwrap (membrane `toJS`)
 * over the arrival PROTOCOL key (`"arrival/toJS"` — the same cross-package convention
 * arrival-serializer itself dispatches on), because R5 lands no core exports and `toJS` is
 * not on the public surface. Three arms, same order as membrane.toJS:
 *   • multiple values exit as a JS ARRAY of unwrapped elements;
 *   • a callable exits as a host FUNCTION face (serializer: `<function>` — byte-identical);
 *   • everything else dispatches its own `arrival/toJS` term (containers egress as the same
 *     lazy proxies `exec` returns); a raw crosser with no protocol key passes through — it
 *     is already JS.
 */
function hostFace(value: SchemeValue): unknown {
  if (isValuesTuple(value)) return value.__values__.map((element) => hostFace(element));
  if (is_callable_value(value)) return schemeCallableFace;
  const exit = (value as { "arrival/toJS"?: () => unknown })["arrival/toJS"];
  return typeof exit === "function" ? exit.call(value) : value;
}

/**
 * Execute scheme source (or an already-parsed form) and serialize each top-level form's value
 * under the MCP output budget, returning the run's heap-meter reads alongside (R5, §2.7 — the
 * COMPLEX-tier `execState` is used precisely so the per-form `runCtx.heapMeter` is readable
 * once at the end; values exit through `hostFace`, the same membrane crossing `exec` performs).
 * `execState` already returns one `SchemeValue` per top-level form, and the caller's REPL split
 * (one already-parsed form per call) means there's nothing to coalesce: serialize the results
 * directly. No `(list …)` wrap-and-unwrap — that round-trip predated the REPL split.
 */
async function execSerializedState(
  expr: string | SchemeValue,
  options: ExecSerializedOptions,
): Promise<ExecSerializedOutcome> {
  const state = await execState(expr, {
    ambient: options.ambient,
    scope: options.scope,
    budgetMs: options.budgetMs,
    heapBudget: options.heapBudget,
    signal: options.signal,
    cache: options.cache,
    effects: options.effects,
    tap: options.tap,
  });
  const values = state.values.map((element) => hostFace(element));
  const per = options.charBudget ?? perElementBudget(values.length);
  const meter = state.runCtx.heapMeter;
  const { extrasState } = options;
  const extras: SerializedExtra[] = [];
  let overflowDelta = 0;
  let out: string[];
  if (extrasState === undefined) {
    out = values.map((element) => toSExprString(element, { maxTotalChars: per }));
  } else {
    const overflowBefore = extrasState.overflow;
    out = values.map((element) => {
      const rendered = serializeWithExtras(element, { maxTotalChars: per, extrasState });
      extras.push(...rendered.extras);
      return rendered.core;
    });
    overflowDelta = extrasState.overflow - overflowBefore;
  }
  return {
    out,
    extras,
    overflowDelta,
    heapUsed: meter?.used ?? 0,
    heapMax: meter?.max ?? 0,
  };
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

// ── REPL sessions: statement log + first-class run cache (R3, §2.2/§2.4; R7 warm pair) ─────────
// A session's durable twin is `(log, cache)`. Live, the warm `(AssembledAmbient, LexicalScope)`
// pair is memoized on the call's config digest — same digest ⇒ reuse (zero fold cost); changed ⇒
// dispose the old ambient, assemble fresh, drop the cache (configDigest is part of the
// cache-validity identity), and FOLD:
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
// each form is then executed directly as a parsed AST via `execSerializedState`'s low-level
// `execState` path (never re-stringified-and-reparsed).

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
  /** The per-statement event stream (R5, §2.5 — `ReplEvent` in mcp-substrate). DISPATCH-TIME,
   *  exactly where `record` sits — ABOVE the eval membrane, so a run can never reach or forge
   *  its own event channel. Receives the wireframe-then-record order: ONE topology event (the
   *  future trace, before index 0 ever runs), then one statement event per executed top-level
   *  form — strictly ordered, terminal-on-error. Events are SAME-PRINCIPAL (they echo program
   *  source/results the same client sent, on that call's own response stream) and ADDITIVE
   *  observation: the aggregate `call` result is byte-identical with or without a listener. */
  onEvent?: (event: ReplEvent) => void;
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
   *  verbs' `dynamicDescription` (it rides the catalog), so this is static.
   *
   *  OPTIONAL as of the fusion (arrival-mcp-extended-capability.md §2.1/§2.10): the CAPABILITY
   *  itself is the self-contained home now (`McpEnvCapability`'s `description`/`dynamicDescription`
   *  — CAP_DESCRIPTION/CAP_DYNAMIC_DESCRIPTION) — "no side bag handed to the runner." Set here
   *  ONLY as a LEGACY, migration-time override: when present it WINS over the capability's own
   *  description (the same host-wins posture `config()`'s merge already takes); omitted ⇒
   *  `describe()` resolves the capability's own channel-1 description instead. */
  description?: string;
  /** Wall-clock eval budget (the interpreter TICK-checks it). Defaults to {@link DEFAULT_BUDGET_MS}. */
  budgetMs?: number;

  /** Per-run allocation bound (the memory analogue of `budgetMs` — catches the native-collection-op
   *  runaway the TICK-cadence wall-clock can't preempt). Defaults to {@link defaultHeapBudget}. */
  heapBudget?: number;

  /** Per-session statement-count cap (Part III LIMIT — rehydration is O(n) in log size, bounded
   *  honestly). Hitting it is a TEACHING error directing the client to a fresh session, never a
   *  silent truncation. Defaults to {@link defaultStatementCap}. */
  statementCap?: number;

  /** Per-call attachment quota (R6, §2.6 — the `AttachmentSink.beginCall(quota)` shape, consulted
   *  DURING the serializer walk): at most this many binary leaves are extracted + attached per
   *  call; further leaves render tag-only in the core text (never collected, never base64-encoded)
   *  and the overflow count drains into a note — never silently. Defaults to
   *  {@link defaultAttachmentQuota}. */
  attachmentQuota?: number;

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

  /**
   * Per-argument lineage annotation on a held confirm-manifest (arrival-provenance-
   * confirmation.md §7.6 — RULED default-on with a disable knob). Default `true`: every
   * session call installs an `EvalTrace` tap so a manifest (built only when the call
   * gathers a risky effect) can annotate each row's arguments with a `groundingVerdict`.
   * Set `false` for a small-context/degraded deployment that wants zero tracing tax —
   * a manifest still builds (digest, decoded args, `invocationSource`), just without
   * `argLineage`. Degraded confirmation POSTURES beyond this (always-confirm,
   * pause-to-confirm) are OUT of scope for this design — a future family alongside the
   * lineage knob, per the ruling's own note.
   */
  lineage?: boolean;

  /**
   * The per-effect rig-altered invariant seam (arrival-provenance-confirmation.md item 3,
   * Part V.3/W4 of the effect-burst doc). Defaults to {@link noRigAlteredCheck} — an HONEST
   * no-op (every row reports unaltered) because no host-generic re-derivation channel exists
   * yet (that needs W3's live plexus burst executor). A host with one wires its own check.
   */
  rigAlteredCheck?: RigAlteredCheck;
}

type DiscoveryArgs = { expr: string; intent?: string } & Record<string, unknown>;

/** One-word type tag for the session door's "what arrived instead" line. */
function describeSessionValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return `the string ${JSON.stringify(v)}`;
  if (typeof v !== "object") return typeof v;
  const s = v as { id?: unknown; state?: unknown };
  if (typeof s.id !== "string") return "an object with no string `id`";
  return "an object with `id` but no `state` object";
}

/** The session shape `call` requires, checked AT the boundary (errors-as-doors): a wrong
 *  shape used to surface as `TypeError: Cannot read properties of undefined (reading
 *  '__run__')` deep inside `loadState` — a misleading stack the first-day integrator
 *  debugs as transport/registration. The door states the expected shape and the cure. */
function assertSessionShape(
  tool: string,
  session: unknown,
): asserts session is { id: string; state: Record<string, unknown> } {
  const s = session as { id?: unknown; state?: unknown };
  if (
    typeof session === "object" &&
    session !== null &&
    typeof s.id === "string" &&
    typeof s.state === "object" &&
    s.state !== null
  ) {
    return;
  }
  throw new MCPError(
    "validation",
    `${tool}: ctx.session must be { id: string, state: {} } — got ${describeSessionValue(session)}. ` +
      `The session's run log lives at session.state.__run__ (this tool reads and writes it), so \`state\` ` +
      `must be a plain object you keep across calls: pass { id: "your-session-id", state: {} } on the first ` +
      `call and the SAME object on every later call for REPL continuity. Omit \`session\` entirely for a ` +
      `stateless one-shot call.`,
    { phase: "dispatch", target: tool },
  );
}

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

/** Per-call attachment quota default (R6, §2.6). A FUNCTION (like {@link defaultHeapBudget}) so
 *  it reads the env var live. The default mirrors arrival-manifold's
 *  `DEFAULT_PASSTHROUGH_ATTACHMENTS` (3) — the same "first N binary blocks, in encounter order"
 *  posture on the other MCP surface. `0` is honored (attach nothing, tag everything). */
export function defaultAttachmentQuota(): number {
  const raw = Number(process.env.MCP_ATTACHMENT_QUOTA);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
}

/** A discovery tool bound to one aggregating capability. Construct once per CONNECTION (the host
 *  builds `capability` with its infra armed into the resources); `call` runs once per request. */
export class DiscoveryTool {
  /** Warm pairs `(AssembledAmbient, LexicalScope)` (R7 — exec-phases §3.5's assembly-reuse row),
   *  memoized on the call's config digest (§2.4's one warm-reuse rule): same digest ⇒ reuse the
   *  live ambient + the session's lexical accumulation (zero fold cost); changed ⇒ dispose the
   *  old ambient, assemble fresh, fold. Keyed by session id — per-session state lives with the
   *  session, never module-level. The ambient is CALLER-owned everywhere it's passed to exec
   *  (the §3.3 ownership rule): this map's owner disposes it — digest change, `closeSession`,
   *  or `dispose()`. */
  private readonly warm = new Map<string, { digest: string; ambient: AssembledAmbient; scope: LexicalScope }>();

  constructor(
    readonly name: string,
    private readonly capability: McpEnvCapability,
    private readonly options: DiscoveryToolOptions,
  ) {}

  /** The MCP `Tool` definition — name, description, input schema. Read-only hint by construction. */
  async describe(clientInfo?: Record<string, unknown>): Promise<Tool> {
    return {
      name: this.name,
      description: await this.resolveToolDescription(),
      inputSchema: await this.inputSchema(clientInfo),
      annotations: { readOnlyHint: true },
    };
  }

  /** Channel-1 (human) description — the LEGACY host override (`options.description`) wins
   *  when supplied (migration-only, §2.10); otherwise the capability's OWN `description`/
   *  `dynamicDescription` (§2.2 CAP_DESCRIPTION/CAP_DYNAMIC_DESCRIPTION) is the self-contained
   *  home. The dynamic arm resolves against the SAME describe ambient the per-verb catalog
   *  channel already builds (§2.7/§2.8 of exec-phases-and-dynamic-metadata.md) — built lazily
   *  ONLY when the capability actually declares a dynamic arm, so a purely-static capability
   *  never pays the assembly cost. Resolving `undefined` (no capability description at all)
   *  falls back to the empty string, never a thrown error — a missing `Tool.description` is a
   *  host-authoring gap, not a runtime condition this method should crash over. */
  private async resolveToolDescription(): Promise<string> {
    if (this.options.description !== undefined) return this.options.description;
    const ambient = this.capability.dynamicDescription === undefined ? undefined : await this.describeAmbient();
    const live = await this.capability.resolveDescription(ambient?.activations.get(this.capability.name));
    return live ?? "";
  }

  /** Evaluate `args.expr` under the dispatch-time ctx — §2.1's per-call walk. Warm scope for
   *  this call's config digest? use it. Otherwise fold = re-run the session's statement log over
   *  its run cache (replay mode — a declared `view` penetration answers from the cache, a `sink`
   *  tombstone skips, everything else re-runs). New input then executes statement-by-statement in
   *  record mode over the SAME cache — REPL-style, so earlier statements' values stand even if a
   *  later one crashes — and the session's durable twin (log + cache + counters) is persisted
   *  (awaited) before the response. A cancellation propagates; a runtime crash is surfaced as an
   *  `(error …)` form and stops the rest of the input.
   *
   *  R6 (§2.6): with binary leaves in the output, the array interleaves the core strings with
   *  per-extra label strings + raw Blobs (in statement order) — `serializeResult` lowers each
   *  element to one content block, so the aggregate ≡ the ordered concat of the statement
   *  events' FULL block lists. A blob-free program still returns plain `string[]` (the R0
   *  output-shape pin, byte-identical). */
  async call(args: DiscoveryArgs, ctx: ToolCallCtx = {}): Promise<(string | Blob)[]> {
    const startTime = Date.now();
    const budgetMs = this.options.budgetMs ?? DEFAULT_BUDGET_MS;
    const heapBudget = this.options.heapBudget ?? defaultHeapBudget();
    const { signal, session } = ctx;
    if (session !== undefined) assertSessionShape(this.name, session);
    const cfg = await this.config(args);

    // ── sessionless: per-call ambient, disposed in `finally` (§2.8's dispose row — the R7
    // ownership table: THIS call assembled it ⇒ THIS call disposes it, kernel disposers + the
    // FULL lowered closure's resource wind-down) — no log, no cache, nothing durable. The exec
    // path carries no cache: byte-identical fast path.
    if (session === undefined) {
      const ambient = await this.assemble(cfg);
      try {
        const run = await this.runForms(args.expr, {
          ambient,
          scope: LexicalScope.fresh(`${this.name}:sessionless`),
          budgetMs,
          heapBudget,
          signal,
          onEvent: ctx.onEvent,
        });
        this.log(ctx, args, startTime, run.crashed ? { success: false, errorMessage: run.crashed } : { success: true });
        return run.out;
      } finally {
        await ambient.dispose();
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

    // FILL-OR-KILL (arrival-provenance-confirmation.md §7.3): a session with a pending
    // manifest that runs a NEW program — this call, whatever it turns out to do — kills the
    // old order unconditionally. "The manifest is an order; it fills now or dies; nothing
    // rests on the book." The only path that ever ACTS on a pending manifest is
    // `confirmBurst`, a separate method entirely — `call` always starts fresh.
    state.pendingManifest = undefined;

    const warm = this.warm.get(session.id);
    const { ambient, scope, entries } =
      warm !== undefined && warm.digest === identity.configDigest
        ? { ambient: warm.ambient, scope: warm.scope, entries: new Map(Object.entries(state.cache)) }
        : await this.foldIntoFreshAmbient(session.id, state, identity, cfg, { budgetMs, heapBudget, signal });

    // Snapshot BEFORE running — the fill-or-kill revert point if this call ends up holding
    // (§7.2/§7.3): a held manifest's statements/cache mutations must never commit ("nothing
    // rests on the book"), so a hold reverts `state.log`/`entries` back to exactly this.
    const preLogLen = state.log.length;
    const preEntries = new Map(entries);
    const preCounters = { ...state.counters };

    // THE EFFECT LOG (W1) + lineage tap (§7.6, default-on): every sink this call's forms
    // touch GATHERS here instead of firing — the gather-then-decide model the hold rule
    // needs. `lineageOn` governs ONLY whether a trace is installed to annotate a held
    // manifest's arguments; it never affects whether effects gather (that's structural).
    const effectLog = new MemoryEffectLog();
    const lineageOn = this.options.lineage !== false;
    const trace = lineageOn ? new EvalTrace() : undefined;

    const run = await this.runForms(args.expr, {
      ambient,
      scope,
      budgetMs,
      heapBudget,
      signal,
      cache: new SessionRunCache("record", entries, state.counters),
      state,
      onEvent: ctx.onEvent,
      effects: effectLog,
      tap: trace,
    });

    // THE HOLD RULE (§7.2): any risky row present ⇒ the ENTIRE burst holds as a proposal —
    // no split-commit, atomicity is the product claim. Risky-free programs burst immediately
    // right here, before persisting — zero tax on the common case (same response shape, same
    // persisted log/cache the pre-confirmation code produced).
    if (effectLog.entries.length > 0) {
      const riskyEntries = effectLog.entries.filter((e) => this.isRisky(e.verbName));
      if (riskyEntries.length === 0) {
        const burstError = await this.burstGatheredEffects(
          effectLog.entries,
          { ambient, scope, budgetMs, heapBudget, signal },
          entries,
          state.counters,
        );
        if (burstError !== undefined) {
          run.out.push(`(error ${JSON.stringify(burstError)})`);
          run.crashed = burstError;
          state.counters.crashes += 1;
        }
      } else {
        // HOLD: revert to the pre-call snapshot (fill-or-kill — this call's statements and
        // cache mutations never commit) and return the manifest INSTEAD of `run.out` — the
        // whole burst is a proposal now, not a completed response.
        state.log = state.log.slice(0, preLogLen);
        entries.clear();
        for (const [k, v] of preEntries) entries.set(k, v);
        state.counters = preCounters; // fill-or-kill: this call's counter deltas never happened either
        const manifest = buildConfirmManifest({
          sessionId: session.id,
          statementIndex: preLogLen,
          entries: effectLog.entries,
          isRisky: (v) => this.isRisky(v),
          lineage: trace === undefined ? undefined : { trace, source: args.expr },
        });
        state.pendingManifest = manifest;
        state.semanticsEpoch = identity.semanticsEpoch;
        state.roster = identity.roster;
        state.configDigest = identity.configDigest;
        state.cache = Object.fromEntries(entries);
        state.lastCallAt = Date.now();
        await this.persist(session, ctx.store, state);
        this.log(ctx, args, startTime, { success: true });
        return [
          `This run gathered ${riskyEntries.length} risky effect(s) among ${effectLog.entries.length} total — the ` +
            "WHOLE burst holds pending confirmation (fill-or-kill: nothing has been committed). Review the manifest " +
            "below, then call confirm-burst with { digest, approvedEffectIndexes: [...] } to fire the approved subset " +
            "in original order. Declining, or running a new program in this session, discards this manifest — its " +
            "effects leave no trace and must be re-issued.",
          JSON.stringify(manifest, null, 2),
        ];
      }
    }

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

  /** Is `verbName` a `tool.risky` verb? The catalog's own annotation reflection
   *  (`allAnnotations`, McpEnvCapability.ts) is the ONE lookup point — no second
   *  registry (§7.5: riskiness rides the same static factory-declared metadata channel
   *  `isTool`/`description` already use). */
  private isRisky(verbName: string): boolean {
    return this.capability.allAnnotations()[verbName]?.risky === true;
  }

  /** Fire every gathered (non-risky) effect for real, in program order, right after
   *  gathering — the immediate-burst arm of the hold rule (§7.2). Each entry's own
   *  minimal re-runnable invocation (`buildInvocationSource`, built from the RAW
   *  pre-decode args `EffectEntry.rawArgs` carries) is evaluated through the SAME
   *  ambient/scope/cache this call already established, so the sink fires through the
   *  ordinary `penetrateThroughCache` record-mode arm (tombstone written normally — a
   *  later fold skips it exactly as if it had fired inline). Returns an error message on
   *  the first entry that throws (stopping there, mirroring `runForms`'s own
   *  stop-on-first-crash REPL posture); `undefined` on a clean drain. */
  private async burstGatheredEffects(
    gathered: readonly EffectEntry[],
    opts: { ambient: AssembledAmbient; scope: LexicalScope; budgetMs: number; heapBudget: number; signal?: AbortSignal },
    entries: Map<string, RunCacheEntry>,
    counters: SessionRunState["counters"],
  ): Promise<string | undefined> {
    const cache = new SessionRunCache("record", entries, counters);
    for (const entry of gathered) {
      if (entry.rawArgs === undefined) {
        return `confirm-burst: effect ${entry.index} (${entry.verbName}) was gathered with no raw-argument capture — cannot reconstruct its invocation to fire it.`;
      }
      const source = buildInvocationSource(entry.verbName, entry.rawArgs);
      try {
        await execState(source, {
          ambient: opts.ambient,
          scope: opts.scope,
          budgetMs: opts.budgetMs,
          heapBudget: opts.heapBudget,
          cache,
          signal: opts.signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `effect ${entry.index} (${entry.verbName}) threw while bursting: ${message}`;
      }
    }
    return undefined;
  }

  /**
   * confirm-burst (arrival-provenance-confirmation.md, tool 2 of the confirmation design;
   * see confirm-burst.ts's `ConfirmBurstTool` — a thin MCP-tool-shaped wrapper over THIS
   * method, so confirmation reuses the same warm ambient / session state `call` itself
   * holds, rather than a second implementation).
   *
   * Requires a session — a pending manifest lives in `SessionRunState`, so there is
   * nothing to confirm sessionlessly. A wrong or absent digest is a "which manifest?"
   * teaching door (§7.1: the digest answers manifest IDENTITY only). The approved subset
   * fires in ORIGINAL program order (§5); each row goes through the rig-altered seam
   * ({@link DiscoveryToolOptions.rigAlteredCheck}, default {@link noRigAlteredCheck}) —
   * a row it flags doors THAT row alone, siblings still fire. Declined rows leave no
   * durable trace (fill-or-kill, §7.3): only re-issuing the original program re-offers
   * them.
   */
  async confirmBurst(
    args: { digest: string; approvedEffectIndexes: readonly number[] },
    ctx: ToolCallCtx = {},
  ): Promise<(string | Blob)[]> {
    const startTime = Date.now();
    const budgetMs = this.options.budgetMs ?? DEFAULT_BUDGET_MS;
    const heapBudget = this.options.heapBudget ?? defaultHeapBudget();
    const { session } = ctx;
    if (session === undefined) {
      throw new MCPError(
        "validation",
        `${this.name}.confirmBurst: requires a session — a pending manifest lives in session state, so there is ` +
          "nothing to confirm without one. Pass the SAME { id, state } the discovery call that returned the manifest used.",
        { phase: "dispatch", target: this.name },
      );
    }
    assertSessionShape(`${this.name}.confirmBurst`, session);

    const throwawayIdentity: SessionRunIdentity = { v: 2, semanticsEpoch: SESSION_SEMANTICS_EPOCH, roster: [], configDigest: "" };
    const state = await this.loadState(session, ctx.store, throwawayIdentity);
    const manifest = state.pendingManifest;
    if (manifest === undefined || !isConfirmManifest(manifest) || manifest.digest !== args.digest) {
      throw new MCPError(
        "validation",
        manifest === undefined
          ? `${this.name}.confirmBurst: no manifest is pending for this session — nothing to confirm. A manifest ` +
            "is produced only when a discovery-tool call gathers a risky effect; re-issue that program."
          : `${this.name}.confirmBurst: digest "${args.digest}" does not match the pending manifest (digest ` +
            `"${manifest.digest}"). Which manifest? Re-read the discovery-tool response that held this run and ` +
            "pass its digest back verbatim — or re-issue the program if you intend a fresh one.",
        { phase: "validation", target: this.name },
      );
    }

    const validIndexes = new Set(manifest.rows.map((r) => r.effectIndex));
    const unknown = args.approvedEffectIndexes.filter((i) => !validIndexes.has(i));
    if (unknown.length > 0) {
      throw new MCPError(
        "validation",
        `${this.name}.confirmBurst: approvedEffectIndexes ${JSON.stringify(unknown)} are not in the pending ` +
          `manifest (valid: ${JSON.stringify([...validIndexes].toSorted((a, b) => a - b))}).`,
        { phase: "validation", target: this.name },
      );
    }

    const approved = new Set(args.approvedEffectIndexes);
    const orderedRows = manifest.rows.filter((r) => approved.has(r.effectIndex)).toSorted((a, b) => a.effectIndex - b.effectIndex);
    const rigCheck = this.options.rigAlteredCheck ?? noRigAlteredCheck;

    // Rehydrate the SAME warm ambient `call` would (identity taken from the STATE itself —
    // confirm-burst carries no actor config to recompute one from; the session's own
    // recorded identity is exactly the world the manifest was built against).
    const identity: SessionRunIdentity = {
      v: 2,
      semanticsEpoch: state.semanticsEpoch,
      roster: state.roster,
      configDigest: state.configDigest,
    };
    const warm = this.warm.get(session.id);
    const { ambient, scope, entries } =
      warm !== undefined && warm.digest === identity.configDigest
        ? { ambient: warm.ambient, scope: warm.scope, entries: new Map(Object.entries(state.cache)) }
        : await this.foldIntoFreshAmbient(session.id, state, identity, await this.config({ expr: "" }), {
            budgetMs,
            heapBudget,
            signal: ctx.signal,
          });

    const cache = new SessionRunCache("record", entries, state.counters);
    let fired = 0;
    const doors: string[] = [];
    for (const row of orderedRows) {
      const rig = await rigCheck(row);
      if (rig.altered) {
        doors.push(
          `effect ${row.effectIndex} (${row.verb}): rig altered — the world moved under this specific effect` +
            (rig.detail ? ` (${rig.detail})` : "") +
            "; declined (fill-or-kill — re-issue the original program to re-offer it).",
        );
        continue;
      }
      if (row.invocationSource === undefined) {
        doors.push(`effect ${row.effectIndex} (${row.verb}): no reconstructable invocation — declined.`);
        continue;
      }
      try {
        await execState(row.invocationSource, { ambient, scope, budgetMs, heapBudget, cache, signal: ctx.signal });
        state.log.push({ src: row.invocationSource });
        state.counters.statements += 1;
        fired += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        doors.push(`effect ${row.effectIndex} (${row.verb}) threw while bursting: ${message}`);
      }
    }

    const declinedCount = manifest.rows.length - fired;
    state.pendingManifest = undefined;
    state.semanticsEpoch = identity.semanticsEpoch;
    state.roster = identity.roster;
    state.configDigest = identity.configDigest;
    state.cache = Object.fromEntries(entries);
    state.lastCallAt = Date.now();
    state.counters.elapsedMsTotal += Date.now() - startTime;
    await this.persist(session, ctx.store, state);

    this.log(
      ctx,
      { expr: "", digest: args.digest, approvedEffectIndexes: args.approvedEffectIndexes },
      startTime,
      { success: doors.length === 0 },
    );

    const summary =
      `confirm-burst: ${fired}/${manifest.rows.length} effect(s) fired in original order; ${declinedCount} declined ` +
      "effect(s) left no durable trace (re-run the original program to re-offer them).";
    return doors.length === 0 ? [summary] : [summary, ...doors];
  }

  /** Dispose one session's warm ambient (the host's session-close hook — `onsessionclosed`/
   *  DELETE; the deployment wiring is R4's). The ambient's dispose is the R7 ownership-table
   *  teardown: kernel pack disposers (LIFO) + EVERY lowered pack's resource wind-down across
   *  the whole dep closure — every port the call ambient spawned is released, gateway included.
   *  Idempotent; a session with no warm pair is a no-op. */
  async closeSession(sessionId: string): Promise<void> {
    const warm = this.warm.get(sessionId);
    if (warm === undefined) return;
    this.warm.delete(sessionId);
    await warm.ambient.dispose();
  }

  /** Dispose every warm pair + the describe ambient (connection teardown). */
  async dispose(): Promise<void> {
    const all = [...this.warm.values()];
    this.warm.clear();
    for (const warm of all) await warm.ambient.dispose();
    // The describe-time ambient (per-connection, memoized on this tool) dies with the tool.
    const describeCtx = this.describeCtx;
    this.describeCtx = undefined;
    await (await describeCtx)?.dispose();
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

  /** The cold path: dispose the stale warm ambient (config-digest change), assemble fresh,
   *  validate the cache identity (mismatch ⇒ drop the cache, KEEP the log, re-record —
   *  self-heal), then FOLD: re-run the log over the cache, onto a FRESH session scope (the
   *  lexical accumulation the replayed defines land in). Fold inherits the poison rule at
   *  statement level — a statement whose re-run crashes is DROPPED from the log (with a counter
   *  increment) rather than allowed to poison the session; cancellation propagates instead.
   *  Returns the warm pair plus the live entry map the new input's record-mode cache shares.
   *  The ambient's ownership transfers to the warm map only on success — a fold crash disposes
   *  it in `finally` (§2.8's dispose row). */
  private async foldIntoFreshAmbient(
    sessionId: string,
    state: SessionRunState,
    identity: SessionRunIdentity,
    cfg: Record<string, unknown>,
    opts: { budgetMs: number; heapBudget: number; signal?: AbortSignal },
  ): Promise<{ ambient: AssembledAmbient; scope: LexicalScope; entries: Map<string, RunCacheEntry> }> {
    const prior = this.warm.get(sessionId);
    if (prior !== undefined) {
      this.warm.delete(sessionId);
      await prior.ambient.dispose();
    }
    const ambient = await this.assemble(cfg);
    const scope = LexicalScope.fresh(`${this.name}:${sessionId}`);
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
          const run = await execSerializedState(stmt.src, { ambient, scope, ...opts, cache: foldCache });
          state.counters.heapUsedTotal += run.heapUsed; // fold re-runs burn heap too — cumulative honesty (§2.7)
          kept.push(stmt);
        } catch (error) {
          if (opts.signal?.aborted) throw error; // cancellation, not a poisoned statement
          state.counters.droppedOnReplay += 1; // the poison rule: drop, count, continue
        }
      }
      state.log = kept;
      this.warm.set(sessionId, { digest: identity.configDigest, ambient, scope });
      owned = true;
      return { ambient, scope, entries };
    } finally {
      if (!owned) await ambient.dispose();
    }
  }

  /** Parse + execute `expr` form-by-form (REPL semantics: earlier values stand, a crash stops the
   *  rest). With a session `state`, every executed top-level statement — defines AND bare
   *  expressions — is appended to the log in program order (§2.2), under the statement-count cap
   *  (a TEACHING error at the cap, never silent truncation).
   *
   *  R5 (§2.5/§2.7): with an `onEvent` listener, the run streams wireframe-then-record — ONE
   *  topology event (the future trace: all forms' exact LOCATION slices, before index 0 runs),
   *  then one statement event per form {content blocks, counters, error? terminal}. The
   *  per-form serialization budget is computed ONCE here from the parsed form count (the
   *  bounded-SUM fix), and each form's heap-meter read accrues into the session's
   *  `heapUsedTotal`. The aggregate `out` is byte-identical with or without a listener — the
   *  statement events' FULL content IS `out`, sliced per form (the aggregate law).
   *
   *  R6 (§2.6): each form's values render through `serializeWithExtras` under ONE call-level
   *  `ExtrasState` (ids `att-1…` unique per call; the attachment quota consulted DURING the
   *  serializer walk). Extracted extras drain per form — the v1 downstream-owned strategy:
   *  after the core text, per extra a label text block `attachment #N: att-N (mime, size)`
   *  then its binary block (the ONE `dispatch.ts` base64 lowering, verbatim) — appended to
   *  that statement's event content AND to the aggregate `out` (label string + raw Blob;
   *  `serializeResult` lowers the Blob through the same branch, so aggregate ≡ concat holds
   *  block-for-block). Quota overflow drains a note with the count, never silently. */
  private async runForms(
    expr: string,
    opts: {
      ambient: AssembledAmbient;
      scope: LexicalScope;
      budgetMs: number;
      heapBudget: number;
      signal?: AbortSignal;
      cache?: RunCache;
      state?: SessionRunState;
      onEvent?: (event: ReplEvent) => void;
      effects?: EffectLog;
      tap?: EvalTap;
    },
  ): Promise<{ out: (string | Blob)[]; crashed?: string }> {
    const { ambient, scope, budgetMs, heapBudget, signal, cache, state, onEvent, effects, tap } = opts;
    const cap = this.options.statementCap ?? defaultStatementCap();
    const attachmentQuota = this.options.attachmentQuota ?? defaultAttachmentQuota();
    // R6: ONE shared numbering/quota across every form of THIS call (the beginCall(quota) shape).
    const extrasState = initialExtrasState(attachmentQuota);
    let attachmentOrdinal = 0;
    const out: (string | Blob)[] = [];
    let crashed: string | undefined;

    const statement = (
      index: number,
      texts: readonly string[],
      extraBlocks: readonly ContentBlock[],
      counters: StatementCounters,
      error?: string,
    ): void => {
      // R6 (landed): `extraBlocks` are the extracted extras' label/binary blocks, appended
      // after the core text blocks; the aggregate law (§2.5) carries the FULL list, text and
      // binary alike.
      const blocks: ContentBlock[] = [...texts.map((text): ContentBlock => ({ type: "text", text })), ...extraBlocks];
      onEvent?.(
        error === undefined
          ? { kind: "statement", index, content: blocks, counters }
          : { kind: "statement", index, content: blocks, counters, error },
      );
    };

    const started = Date.now();
    let forms: SchemeValue[];
    try {
      forms = await parse(expr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      crashed = message;
      const door = `(error ${JSON.stringify(message)})`;
      out.push(door);
      if (state !== undefined) state.counters.crashes += 1;
      // Parse-crash convention (repl-event.ts): an EMPTY topology (nothing will execute) + ONE
      // synthetic terminal statement at index 0 carrying the reader door — the aggregate law
      // holds mechanically (that door is the whole output).
      onEvent?.({ kind: "topology", total: 0, forms: [] });
      const elapsedMs = Date.now() - started;
      statement(
        0,
        [door],
        [],
        { heapUsed: 0, heapMax: heapBudget, elapsedMs, budgetMsRemaining: Math.max(0, budgetMs - elapsedMs) },
        message,
      );
      return { out, crashed };
    }
    // The future trace — emitted BEFORE index 0 ever runs (§2.5). Slices are the reader's exact
    // LOCATION spans (sourceTextFor), computed once and reused for the log append below.
    const sources = forms.map((form, index) => sourceTextFor(form, index, forms, expr));
    onEvent?.({ kind: "topology", total: forms.length, forms: sources.map((source, index) => ({ index, source })) });
    // Parse-first budget fix (§2.5, closes §1.2 item 2): `total` is known at parse time, so the
    // per-element budget is computed ONCE up front and each form serializes under its fair
    // share at emit time — the SUM across the batch stays bounded by MCP_OUTPUT_BUDGET.
    const charBudget = perElementBudget(forms.length);
    for (const [index, form] of forms.entries()) {
      const formStarted = Date.now();
      if (state !== undefined && state.log.length >= cap) {
        crashed = `session statement cap reached (${cap})`;
        const door = `(error ${JSON.stringify(
          `${crashed}: this session's statement log is full, so further statements cannot be recorded for replay. ` +
            `Start a fresh MCP session to continue; fold long accumulations into ONE program (a single top-level form) ` +
            `instead of many REPL steps.`,
        )})`;
        out.push(door);
        statement(
          index,
          [door],
          [],
          { heapUsed: 0, heapMax: heapBudget, elapsedMs: 0, budgetMsRemaining: budgetMs },
          crashed,
        );
        break;
      }
      const src = sources[index] as string;
      try {
        const run = await execSerializedState(form, {
          ambient,
          scope,
          budgetMs,
          heapBudget,
          signal,
          cache,
          charBudget,
          extrasState,
          effects,
          tap,
        });
        out.push(...run.out);
        // R6 drain — the v1 rendering strategy (downstream-owned, §2.6): per extra, a label
        // text block then its binary block, appended to THIS statement's content and to the
        // aggregate. The binary block is only ENCODED when someone listens (the aggregate
        // carries the raw Blob; `serializeResult` lowers it through the same base64 branch).
        const extraBlocks: ContentBlock[] = [];
        for (const extra of run.extras) {
          attachmentOrdinal += 1;
          const mime = extra.blob.type || "application/octet-stream";
          const renderable = mime.startsWith("image/") || mime.startsWith("audio/");
          const size = formatByteSize(extra.blob.size);
          const label = renderable
            ? `attachment #${attachmentOrdinal}: ${extra.id} (${mime}, ${size})`
            : `attachment #${attachmentOrdinal}: ${extra.id} (${mime}, ${size}) — no MCP block kind renders this mime inline`;
          out.push(label);
          extraBlocks.push({ type: "text", text: label });
          if (renderable) {
            out.push(extra.blob);
            if (onEvent !== undefined) extraBlocks.push(await lowerBinaryBlob(extra.blob));
          }
        }
        if (run.overflowDelta > 0) {
          // Overflow drains a NOTE with the count — never silently (the tag-only leaves are
          // already visible in the core text as `#attachment "over-quota (…)"`).
          const note =
            `#| ${run.overflowDelta} attachment(s) over quota (${attachmentQuota}) — rendered tag-only, ` +
            `not attached, not encoded. Fetch fewer binary values per call, or raise the tool's attachmentQuota. |#`;
          out.push(note);
          extraBlocks.push({ type: "text", text: note });
        }
        const elapsedMs = Date.now() - formStarted;
        if (state !== undefined) state.counters.heapUsedTotal += run.heapUsed; // §2.7 — monotonic contributions
        statement(index, run.out, extraBlocks, {
          heapUsed: run.heapUsed,
          heapMax: run.heapMax,
          elapsedMs,
          // Each form's exec carries its OWN wall-clock budget + heap meter (a per-form
          // runCtx): the ONE-runCtx-per-call collapse (per-form deltas = two reads of one
          // meter, per-call bounds) stays blocked on core's ledgered runProgram gap — "a
          // cumulative multi-form bound needs a shared RunContext, which no caller can
          // inject yet" (generator-exec.ts, execExpr). The phase products (ambient/scope)
          // are adopted (R7); the instance seam is core's follow-up. Wire shape is already
          // the collapsed one: per-form heapUsed reads off the form's meter.
          budgetMsRemaining: Math.max(0, budgetMs - elapsedMs),
        });
      } catch (error) {
        if (signal?.aborted) throw error; // cancellation propagates — not a REPL crash
        crashed = error instanceof Error ? error.message : String(error);
        const door = `(error ${JSON.stringify(crashed)})`; // REPL-style: earlier values stand; stop here
        out.push(door);
        if (state !== undefined) state.counters.crashes += 1;
        const elapsedMs = Date.now() - formStarted;
        // TERMINAL statement event: the crashed form's meter is unobservable (the exec threw
        // before returning its state) — heapUsed honestly reads 0, never a guess.
        statement(
          index,
          [door],
          [],
          { heapUsed: 0, heapMax: heapBudget, elapsedMs, budgetMsRemaining: Math.max(0, budgetMs - elapsedMs) },
          crashed,
        );
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

  // ── ambient assembly: config from the actor args, resources armed by the capability ──

  /** Assemble the phase-2 product for one config (R7 — exec-phases §3.1): the capability (and
   *  its whole dep closure) lowered onto a fresh child of the standard base, sealed, returned
   *  as an owning `AssembledAmbient` handle. Its `dispose()` IS the full ownership-table
   *  teardown — kernel pack disposers (LIFO) + resource wind-down over the ENTIRE lowered
   *  closure (roots + deps), replacing R3's interim root-only `pack.windDown()`, which never
   *  reached a dep capability's cells. Vocabulary is added ONLY by the capability's deps (the
   *  audited grant); the base chain is the same stdlib the old sandboxed inherit resolved
   *  through. */
  private assemble(cfg: Record<string, unknown>): Promise<AssembledAmbient> {
    return assembleAmbient({ capabilities: [this.capability], config: cfg });
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
      expr: z.string().describe(this.exprDescription(verbs, dynamic, aiName, await baseEnvSymbols())),
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
  private exprDescription(verbs: { text: string }[], dynamic: boolean, aiName: string, baseNames: readonly string[]): string {
    const baseSymbols = baseNames.join(", ");
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

  /** The DESCRIBE ambient (exec-phases §2.7): a HOST-CONFIG-ONLY `AssembledAmbient` (the
   *  phase-2 product, R7), built lazily on the first catalog read that needs one (some verb
   *  declares a `dynamicDescription`), memoized per tool (per CONNECTION — the class doc),
   *  disposed with the tool. Its `activations` are the channel a metadata-declared dynamic
   *  field resolves `this` against — the A2 read path riding the describe ambient product.
   *
   *  LEDGERED (V-pending decision #6, resolved per the doc's own recommendation): describe
   *  happens BEFORE any actor args exist — a dynamic description reads HOST infra and HOST
   *  config ONLY (exactly what the closure form could reach, now through the declared channel).
   *  Honest fallbacks, never a faked actor-args call: a FUNCTION-form `hostConfig` (needs the
   *  per-call args) or a config schema requiring actor keys ⇒ NO describe ambient — dynamic
   *  thunks then run with their legacy receiver (a closure-form thunk ignores `this`; a
   *  metadata-declared field reading `this.configuration` resolves `undefined` and the static
   *  description stands, un-flagged). */
  private describeCtx?: Promise<AssembledAmbient | undefined>;
  private describeAmbient(): Promise<AssembledAmbient | undefined> {
    return (this.describeCtx ??= (async () => {
      if (typeof this.options.hostConfig === "function") return undefined;
      try {
        const cfg = await this.config({ expr: "" });
        return await this.assemble(cfg);
      } catch {
        return undefined; // actor-key-requiring schema — static catalog, the honest floor
      }
    })());
  }

  /** The verb catalog reflected off the capability's dep-closure annotations. A STATIC `inputSchema`
   *  renders a sig; a getter (resource-resolving) is NOT invoked here (no live activation). A
   *  `dynamicDescription` thunk resolves live (and flags the entry session-generated) — per read,
   *  no memo, against the OWNING capability's describe-ambient activation when one is derivable
   *  (the metadata channel); a closure-form legacy thunk ignores the receiver and behaves as
   *  before. Resolving `undefined` falls back to the static description, NOT flagged dynamic. */
  private async catalog(): Promise<{ text: string; dynamic: boolean }[]> {
    const entries = this.capability.allAnnotationEntries();
    const describeCtx = entries.some(({ annotation }) => annotation.dynamicDescription !== undefined)
      ? await this.describeAmbient()
      : undefined;
    return Promise.all(
      entries.map(async ({ owner, name, annotation: a }) => {
        const d = Object.getOwnPropertyDescriptor(a, "inputSchema");
        const sig = d && !d.get && Array.isArray(d.value) ? (d.value as z.ZodType[]).map(argTypeName).join(" ") : "";
        const thunk = a.dynamicDescription;
        // `this` = the owner's activation when the describe ambient exists; else the
        // annotation object (the legacy method-call receiver — byte-compatible).
        const live = thunk === undefined ? undefined : await thunk.call(describeCtx?.activations.get(owner) ?? a);
        const sigPart = sig ? ` ${sig}` : "";
        // §2.5's exposure taxonomy, channel-2 rendering: an `isTool` verb is catalogued here
        // AND (once a runner derives `tools/list` from it) its own top-level MCP tool — the
        // REPL can compose it where a bare `tools/call` can't, so it stays advertised in both
        // places rather than one replacing the other.
        const exposedNote = a.isTool ? " [also a top-level tool]" : "";
        return { text: `(${name}${sigPart}) - ${live ?? a.description}${exposedNote}`, dynamic: live !== undefined };
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
