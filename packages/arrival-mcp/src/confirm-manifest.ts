/**
 * confirm-manifest — the provenance-offloaded confirmation artifact
 * (docs/working-proposals/arrival-provenance-confirmation.md, all §7 rulings).
 *
 * A finished DiscoveryTool run's gathered `EffectLog` (values/effect-log.ts, landed
 * W1) becomes ONE manifest: every effect the run WOULD have fired — risky and
 * non-risky alike, "the full burst is visible" (§5) — as a row carrying its decoded
 * args, its own minimal re-runnable invocation, and (opt-in default-on) a
 * per-argument lineage read off the RAW pre-decode args `EffectEntry.rawArgs`
 * now carries (the one additive core change this feature needed — see effect-log.ts).
 *
 * This module has no opinion on WHEN to hold vs burst (that's DiscoveryTool.call,
 * §7.2's "any risky row ⇒ the whole burst holds") or on how confirm-burst re-fires
 * an approved row (ConfirmBurstTool, confirm-burst.ts) — it only builds the artifact.
 */

import { canonicalJson, type EffectEntry } from "@here.build/arrival";
import { writeForm, type EvalTrace } from "@here.build/arrival/provenance";
import { groundingVerdict } from "@here.build/arrival-provenance/verdict";

// `groundingVerdict`'s own `trace` param types as `CoreEvalTrace` — a LOCAL alias
// (arrival-provenance/src/trace.ts) for core's plain `EvalTrace`, not re-exported under
// that name from the package's public surface. Same class, imported under its own name.
type CoreEvalTrace = EvalTrace;

// ─────────────────────────────────────────────────────────────────────────────
// The digest — RULED (§7.1): manifest IDENTITY only ("which manifest are you
// approving"), never a world/config-validity claim (that's the per-effect
// rig-altered invariant, confirm-burst.ts's `RigAlteredCheck` seam).
// ─────────────────────────────────────────────────────────────────────────────

/** FNV-1a over a prefixed canonical string — the codebase's one content-hash idiom
 *  (session-run-state.ts / values/run-cache.ts carry their own local copies for the
 *  same reason: different domains, same tiny algorithm, not worth a shared import). */
function fnv1a(prefix: string, canonical: string): string {
  const tagged = `${prefix}|${canonical}`;
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < tagged.length; i++) {
    h ^= tagged.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** `hash(sessionId ‖ statementIndex ‖ canonicalJson(effect list + decoded args))` —
 *  §7.1 verbatim. `canonicalJson` throws on non-JSON-representable decoded args (a
 *  class instance, a function slipped through a `z.value` escape hatch); the
 *  fallback keys on verb NAMES only — coarser (two structurally-different calls to
 *  the same verb could collide), but still a real digest, never a thrown 500 from
 *  a confirmation artifact whose whole job is to be inspectable. */
export function manifestDigest(
  sessionId: string,
  statementIndex: number,
  entries: readonly Pick<EffectEntry, "verbName" | "decodedArgs">[],
): string {
  let canonical: string;
  try {
    canonical = canonicalJson({
      sessionId,
      statementIndex,
      effects: entries.map((e) => ({ verb: e.verbName, args: e.decodedArgs })),
    });
  } catch {
    canonical = JSON.stringify({ sessionId, statementIndex, effects: entries.map((e) => e.verbName) });
  }
  return fnv1a("confirm-manifest-v0", canonical);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-argument lineage — the groundingVerdict annotation (§5's "here's where each
// and every argument is coming from"). Runs over the RAW (boxed, provenance-intact)
// arg values `EffectEntry.rawArgs` carries; a value with no recorded read behind it
// reports `origin: "input"` honestly rather than fabricating a source.
// ─────────────────────────────────────────────────────────────────────────────

/** One kwarg's lineage report. LIMIT (named, not hidden): `groundingVerdict`'s
 *  `reverseChain` (a re-derivation slice) is anchored on the PROGRAM's own output
 *  form (verdict.ts's `reverseChainOf`) — meaningless for an individual effect
 *  argument that was never the program's final result, so it is deliberately NOT
 *  surfaced here. The effect's OWN minimal re-runnable invocation is
 *  `ManifestRow.invocationSource` instead (built straight from `rawArgs`, §5's "each
 *  dangerous call becomes its own minimal re-runnable program") — a real slice at
 *  ROW granularity; per-argument backward-derivation slicing would need the
 *  invoking call's AST node threaded onto `EffectEntry` too, which this wave does
 *  not add. */
export interface ManifestArgLineage {
  readonly key: string;
  readonly verdict: "signable" | "scoped" | "unsigned";
  readonly leafCount: number;
  /** Source verb names the value traces to (e.g. "evidence-read"), deduped. */
  readonly from: readonly string[];
  /** `groundingVerdict`'s own report line — carries the truth-oracle disclaimer verbatim. */
  readonly report: string;
}

/** Fold a kwargs-style RAW args array (`[:key1, val1, :key2, val2, …]` — the shape
 *  every `tool.effect`/`tool.risky` verb's rest-arg call takes, `_bake.ts`'s
 *  `collectKwargsObject` convention) into `key → raw boxed value`. A local 4-line
 *  copy rather than importing `collectKwargsObject`: that helper lives on core's
 *  internal `_bake.js` path, not the public surface, and the fold itself is this
 *  small. An odd-length array (a malformed capture) drops its dangling last
 *  element rather than throwing — a manifest must never crash building itself. */
function foldRawKwargs(rawArgs: readonly unknown[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (let i = 0; i + 1 < rawArgs.length; i += 2) {
    out.set(String(rawArgs[i]).replace(/^:/, ""), rawArgs[i + 1]);
  }
  return out;
}

function argLineageFor(rawArgs: readonly unknown[], trace: CoreEvalTrace, source: string): ManifestArgLineage[] {
  const kwargs = foldRawKwargs(rawArgs);
  const out: ManifestArgLineage[] = [];
  for (const [key, value] of kwargs) {
    const verdict = groundingVerdict({ result: value, trace, source });
    const from = [...new Set(verdict.leaves.flatMap((l) => l.from))];
    out.push({ key, verdict: verdict.verdict, leafCount: verdict.leaves.length, from, report: verdict.report });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The effect's own minimal re-runnable invocation (§5 "each dangerous call becomes
// its own minimal re-runnable program"). Built from `rawArgs` (boxed AValue nodes,
// still provenance-intact) via `writeForm` — the SAME re-parseable serializer the
// reverse-chain slicer uses — so `invocationSource` is real Scheme source a burst
// executor (confirm-burst.ts) can `execState` verbatim, never a JSON reconstruction
// that risks losing round-trip fidelity.
// ─────────────────────────────────────────────────────────────────────────────

export function buildInvocationSource(verbName: string, rawArgs: readonly unknown[]): string {
  const argsText = rawArgs.map((a) => writeForm(a)).join(" ");
  return argsText.length > 0 ? `(${verbName} ${argsText})` : `(${verbName})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestRow {
  readonly effectIndex: number;
  readonly verb: string;
  /** The decoded args, JS-plain — the SINGLE kwargs object for every
   *  `tool.effect`/`tool.risky` verb (they declare no fixed `input`, only
   *  `inputRest`), unwrapped from `EffectEntry.decodedArgs`'s one-element array for
   *  direct readability. Falls back to the raw array for a verb shaped otherwise. */
  readonly decodedArgs: unknown;
  /** `tool.risky` (§7.5, static factory-declared danger) — never derived from the
   *  argument VALUES themselves. */
  readonly risky: boolean;
  /** Present iff `EffectEntry.rawArgs` was captured (always true for a burst-arm
   *  gathered sink — see run-cache.ts's `penetration.rawArgs`). */
  readonly invocationSource?: string;
  /** Present iff lineage is enabled (default-on, §7.6) AND `rawArgs` was captured. */
  readonly argLineage?: readonly ManifestArgLineage[];
}

export interface ConfirmManifest {
  /** §7.1: manifest IDENTITY only. */
  readonly digest: string;
  readonly sessionId: string;
  /** The session log's length just before this call's (held) statements — the
   *  position a re-submitted program would occupy; NOT persisted as committed,
   *  since a held manifest's statements never join `state.log` (fill-or-kill,
   *  §7.3 — "nothing rests on the book"). */
  readonly statementIndex: number;
  /** Every gathered effect, risky and non-risky alike (§5: "the full burst is
   *  visible, only the risky subset requires explicit approval"). */
  readonly rows: readonly ManifestRow[];
}

export interface BuildConfirmManifestOptions {
  readonly sessionId: string;
  readonly statementIndex: number;
  readonly entries: readonly EffectEntry[];
  readonly isRisky: (verbName: string) => boolean;
  /** Lineage context (default-on, §7.6's disable knob is the CALLER omitting this).
   *  `trace` must be the SAME `EvalTrace` the run installed as its `tap` (the
   *  argument values' provenance points resolve against it); `source` is the
   *  call's program text (the typed-literal laundering gate reads it). */
  readonly lineage?: { readonly trace: CoreEvalTrace; readonly source: string };
}

export function buildConfirmManifest(opts: BuildConfirmManifestOptions): ConfirmManifest {
  const { sessionId, statementIndex, entries, isRisky, lineage } = opts;
  const rows: ManifestRow[] = entries.map((entry) => {
    const decodedArgs = entry.decodedArgs.length === 1 ? entry.decodedArgs[0] : entry.decodedArgs;
    const invocationSource = entry.rawArgs === undefined ? undefined : buildInvocationSource(entry.verbName, entry.rawArgs);
    const argLineage =
      lineage !== undefined && entry.rawArgs !== undefined
        ? argLineageFor(entry.rawArgs, lineage.trace, lineage.source)
        : undefined;
    return {
      effectIndex: entry.index,
      verb: entry.verbName,
      decodedArgs,
      risky: isRisky(entry.verbName),
      ...(invocationSource === undefined ? {} : { invocationSource }),
      ...(argLineage === undefined ? {} : { argLineage }),
    };
  });
  return { digest: manifestDigest(sessionId, statementIndex, entries), sessionId, statementIndex, rows };
}

/** Structural guard for a decoded session blob's `pendingManifest` field — the
 *  same "salvage, don't trust" posture `session-run-state.ts`'s own decode takes.
 *  Not exhaustive (doesn't walk `rows`); good enough to keep a corrupted blob from
 *  being treated as a live manifest. */
export function isConfirmManifest(v: unknown): v is ConfirmManifest {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.digest === "string" &&
    typeof m.sessionId === "string" &&
    typeof m.statementIndex === "number" &&
    Array.isArray(m.rows)
  );
}
