// SessionRunState v2 — THE durable twin of an MCP session (R3,
// docs/working-proposals/arrival-mcp-rework-over-phases.md §2.1/§2.2/§2.4).
//
// A session's durable form is `statement log + first-class run cache`; rehydration is
// *re-running the log over the same cache* (replay mode — every declared `view`
// penetration answered from the cache, every `sink` tombstone skipped, `pure`/undeclared
// re-run under their stable-behavior promise). Values are never restored around
// execution — execution is repeated, and the cache absorbs the membrane.
//
// Storage honesty (§2.4): in-memory/stdio the blob is ONE object (this module's
// encode/decode round-trips it as one JSON string for an injected `AsyncSessionStore`);
// the DO materialization DECOMPOSES the same logical record over storage keys (meta +
// chunked log + one key per cache entry) — that layout is R4's, in deployment territory.

import { canonicalJson, type RunCache, type RunCacheEntry } from "@inhuman.tools/arrival";

import { isConfirmManifest, type ConfirmManifest } from "./confirm-manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/** The interpreter-version component of the cache-validity identity — the
 *  `StreamHeader.semanticsEpoch` convention (provenance/store/interfaces.ts) applied to
 *  this surface. Bump when REPL/session semantics change incompatibly (an epoch change
 *  drops every stored cache and re-records — the log survives). */
export const SESSION_SEMANTICS_EPOCH = "arrival-mcp-session-v2";

/** The MANDATORY four-member cache-validity identity (§2.2): a stored cache is valid
 *  only under the exact identity it was recorded against. Any mismatch ⇒ drop the
 *  cache, KEEP the log, re-run with live penetrations (record mode) — the session
 *  self-heals into a fresh recording. */
export interface SessionRunIdentity {
  v: 2;
  /** {@link SESSION_SEMANTICS_EPOCH}. */
  semanticsEpoch: string;
  /** Capability names (dep closure, sorted). ADVISORY for grants — the host re-derives
   *  authority per call, a stored roster never authorizes anything. AUTHORITATIVE as a
   *  cache-validity component — a roster mismatch drops the cache (§2.4). */
  roster: readonly string[];
  /** INTERIM config digest (Part III LIMIT): the hash of `canonicalJson` of the call's
   *  data-config — the same canonicalization the run-cache keys use. Upgrades to the C6
   *  digest when C6 lands (the upgrade is itself a digest change ⇒ one clean cache drop). */
  configDigest: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The state (§2.4's normative shape)
// ─────────────────────────────────────────────────────────────────────────────

/** Cumulative session counters (§2.7) — persisted, so a session's burn (including its
 *  cache economy) is visible across rehydrations. */
export interface SessionCounters {
  /** Top-level statements executed (new input, successful). */
  statements: number;
  /** REPL crashes (parse-time + runtime) in new input. */
  crashes: number;
  /** Statements dropped by the poison rule during fold (replay-time crash ⇒ drop, count). */
  droppedOnReplay: number;
  /** Replay-mode `view` penetrations answered from the cache. */
  cacheHits: number;
  /** Replay-mode penetrations that missed (fired live + recorded). */
  cacheMisses: number;
  /** Replay-mode `sink` tombstone skips. */
  effectsSkipped: number;
  /** Cumulative per-form heap-meter reads (`runCtx.heapMeter.used`, wired by R5 — new input
   *  AND fold re-runs; a crashed form contributes 0, its meter being unobservable). */
  heapUsedTotal: number;
  elapsedMsTotal: number;
  /** How many times this session was cold-folded (log re-run over cache). */
  rehydrations: number;
}

/** One top-level statement of the log — ALL statements, defines AND expression/effect
 *  statements, in program order (§2.2; the sink tombstone-skip is unreachable if only
 *  defines replay). `definedName` marks the `(define …)` statements. */
export interface LogStatement {
  src: string;
  definedName?: string;
}

/** The session's durable twin — ONE logical record (§2.4). */
export interface SessionRunState {
  v: 2;
  semanticsEpoch: string;
  roster: readonly string[];
  configDigest: string;
  /** ALL top-level statements, order = program order. */
  log: LogStatement[];
  /** THE first-class run cache, serialized — settled entries only (in-flight promises
   *  never survive eviction, values/run-cache.ts). */
  cache: Record<string, RunCacheEntry>;
  counters: SessionCounters;
  createdAt: number;
  lastCallAt: number;
  /** The held confirm-manifest (arrival-provenance-confirmation.md), if a prior call
   *  gathered a risky effect and returned it instead of bursting (§7.2's hold rule).
   *  FILL-OR-KILL (§7.3): a NEW program call kills any manifest already pending
   *  (DiscoveryTool.call clears this before running) — "the manifest is an order; it
   *  fills now or dies." Absent when there is nothing held. */
  pendingManifest?: ConfirmManifest;
}

export function freshCounters(): SessionCounters {
  return {
    statements: 0,
    crashes: 0,
    droppedOnReplay: 0,
    cacheHits: 0,
    cacheMisses: 0,
    effectsSkipped: 0,
    heapUsedTotal: 0,
    elapsedMsTotal: 0,
    rehydrations: 0,
  };
}

export function freshSessionRunState(identity: SessionRunIdentity, now = Date.now()): SessionRunState {
  return {
    v: 2,
    semanticsEpoch: identity.semanticsEpoch,
    roster: identity.roster,
    configDigest: identity.configDigest,
    log: [],
    cache: {},
    counters: freshCounters(),
    createdAt: now,
    lastCallAt: now,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Encode / decode (structural guards, not zod — the shape is OURS end to end and the
// decode must be able to SALVAGE a log out of a mismatched blob, which a strict schema
// parse can't express)
// ─────────────────────────────────────────────────────────────────────────────

const COUNTER_KEYS: readonly (keyof SessionCounters)[] = [
  "statements",
  "crashes",
  "droppedOnReplay",
  "cacheHits",
  "cacheMisses",
  "effectsSkipped",
  "heapUsedTotal",
  "elapsedMsTotal",
  "rehydrations",
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isCounters(v: unknown): v is SessionCounters {
  return isRecord(v) && COUNTER_KEYS.every((k) => typeof v[k] === "number");
}

function isLogStatement(v: unknown): v is LogStatement {
  return isRecord(v) && typeof v.src === "string" && (v.definedName === undefined || typeof v.definedName === "string");
}

function isCacheEntry(v: unknown): v is RunCacheEntry {
  return isRecord(v) && (v.kind === "effect" || (v.kind === "value" && "value" in v));
}

/** Structural guard for the FULL v2 shape — used both by decode and by the in-memory
 *  (stdio) path, where the blob is one live object in the session bag. */
export function isSessionRunState(v: unknown): v is SessionRunState {
  return (
    isRecord(v) &&
    v.v === 2 &&
    typeof v.semanticsEpoch === "string" &&
    Array.isArray(v.roster) &&
    v.roster.every((r) => typeof r === "string") &&
    typeof v.configDigest === "string" &&
    Array.isArray(v.log) &&
    v.log.every((s) => isLogStatement(s)) &&
    isRecord(v.cache) &&
    Object.values(v.cache).every((e) => isCacheEntry(e)) &&
    isCounters(v.counters) &&
    typeof v.createdAt === "number" &&
    typeof v.lastCallAt === "number" &&
    (v.pendingManifest === undefined || isConfirmManifest(v.pendingManifest))
  );
}

export function encodeSessionRunState(state: SessionRunState): string {
  return JSON.stringify(state);
}

/**
 * Decode a persisted blob. A well-formed v2 blob round-trips whole. Anything else is
 * SALVAGED per the identity rule ("any identity mismatch ⇒ drop the cache, keep the
 * log", §2.2): if a `log` of well-formed statements can be recovered, return a state
 * carrying that log with an EMPTY cache and a never-matching identity (the caller's
 * validity check then re-records — self-heal); otherwise `undefined` (treated as a
 * fresh session).
 */
export function decodeSessionRunState(blob: string): SessionRunState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return undefined;
  }
  if (isSessionRunState(parsed)) return parsed;
  if (!isRecord(parsed) || !Array.isArray(parsed.log)) return undefined;
  const log = parsed.log.filter((s): s is LogStatement => isLogStatement(s));
  if (log.length === 0) return undefined;
  const salvaged = freshSessionRunState({ v: 2, semanticsEpoch: "", roster: [], configDigest: "" });
  salvaged.log = log;
  if (isCounters(parsed.counters)) salvaged.counters = parsed.counters;
  if (typeof parsed.createdAt === "number") salvaged.createdAt = parsed.createdAt;
  return salvaged;
}

/** Is the stored cache valid under the CURRENT identity? (§2.2's four-member check —
 *  `v` equality is already enforced by the decode guard, both sides being literal 2 by
 *  type; roster compared element-wise, both sides sorted at construction.) */
export function cacheValidFor(state: SessionRunState, identity: SessionRunIdentity): boolean {
  return (
    state.semanticsEpoch === identity.semanticsEpoch &&
    state.configDigest === identity.configDigest &&
    state.roster.length === identity.roster.length &&
    state.roster.every((name, i) => name === identity.roster[i])
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The interim config digest (§2.2 / Part III LIMIT)
// ─────────────────────────────────────────────────────────────────────────────

/** FNV-1a over a prefixed canonical string — the codebase's one content-hash idiom.
 *  A local copy, deliberately NOT imported from run-cache/wireframe (different domains:
 *  those key a membrane penetration / a wireframe graph, this one a session config). */
function fnv1a(prefix: string, canonical: string): string {
  const tagged = `${prefix}|${canonical}`;
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < tagged.length; i++) {
    h ^= tagged.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The INTERIM config digest: `hash(canonicalJson(data-config))` — the same
 * canonicalization the run-cache keys use (core's `canonicalJson`, reused). The
 * data-config is the JSON-representable subset of the call's lowered config; host
 * services (functions, per-request resources — `hostConfig`'s domain) cannot
 * canonicalize and stay OUTSIDE the interim digest by construction. Upgrades to the C6
 * digest when C6 lands (Part III LIMIT — the upgrade is itself one clean cache drop).
 */
export function sessionConfigDigest(config: Record<string, unknown>): string {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    try {
      canonicalJson(value);
      data[key] = value;
    } catch {
      // non-data config (function / service / non-plain object) — outside the interim digest
    }
  }
  return fnv1a("mcp-session-config-v0", canonicalJson(data));
}

// ─────────────────────────────────────────────────────────────────────────────
// The session's cache view — a counting RunCache over ONE shared entry map
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `RunCache` view over the session's shared entry map. Mode is fixed at construction
 * (values/run-cache.ts: "a rehydration builds a NEW replay cache over the same entries,
 * it never flips a live one") — the fold builds a `"replay"` view, the new-input run a
 * `"record"` view, both over the SAME map, so fold-recorded misses are visible to the
 * live run and everything serializes from one place. Replay-mode reads tick the session
 * counters (§2.7: "the cache is observable"); record mode never reads (the mode law),
 * so the counters meter exactly the replay economy.
 */
export class SessionRunCache implements RunCache {
  constructor(
    readonly mode: "record" | "replay",
    readonly entries: Map<string, RunCacheEntry>,
    private readonly counters?: SessionCounters,
  ) {}

  get(key: string): Promise<RunCacheEntry | undefined> {
    const entry = this.entries.get(key);
    if (this.mode === "replay" && this.counters !== undefined) {
      if (entry === undefined) this.counters.cacheMisses += 1;
      else if (entry.kind === "value") this.counters.cacheHits += 1;
      else this.counters.effectsSkipped += 1;
    }
    return Promise.resolve(entry);
  }

  set(key: string, entry: RunCacheEntry): Promise<void> {
    this.entries.set(key, entry);
    return Promise.resolve();
  }
}
