/**
 * In-symbol path atoms (Phase 5 R6–R7).
 *
 * Capability impls bridge in-process sources onto query path atoms via
 * `this.reactiveAtoms` on CallCtx (01-unified-design §6.3).
 *
 * **Mint site:** after `applyResourcePathCqs` succeeds, at the rosetta impl call
 * (`hostImpl.call`), derive `{ …callCtx, reactiveAtoms }` closed over that
 * penetration’s produced Q (+ E for teaching `effects-only`). Doored penetrations
 * never mint. Minted whenever path producers are declared — INERT cells when the
 * bus is off / replay-silent (P-RX-ATOM-OFF-INERT); undefined only when the symbol
 * declares no path producers.
 *
 * **One-shot (ruling 2026-08-13):** `reportChanged` delivers at most once per
 * (penetration, path) — an invalidation signal, not a keep-alive channel. New
 * invocation regenerates. Packs bridge with one-time self-disposing watchers.
 *
 * **Liveness (R7, ruling 2026-08-13):** atoms live PER RUN CONTEXT. Cells retire
 * when their run ABANDONS or when a new owned run starts on the same bus
 * (supersede); a committed run with no successor keeps its cells live (the
 * bridge). See the per-RunContext liveness section below.
 *
 * Design: docs/working-proposals/cqs-reactivity/01-unified-design.md §6.3–6.5
 * Suite:  docs/working-proposals/cqs-reactivity/test-suite-design/reactivity/SUITE.md X6
 */

import { ArrivalError, type ErrorClass } from "../errors.js";
import type { PathAtomBus } from "./path-atom-bus.js";
import { serializeResourcePath, type ResourcePath } from "./resource-paths.js";

/** One path-keyed cell visible inside a query impl. */
export interface ReactiveAtomCell {
  /** This unit/run is tracking the view (same key space as membrane observe). */
  reportObserved(): void;
  /**
   * Query result is different now — dirties the path atom for hub re-invoke.
   * Not a substitute for declared `effects` / EffectLog.
   *
   * **One-shot** (P-RX-ATOM-ONESHOT, ruling 2026-08-13): at most ONE delivery per
   * (penetration, path) — a spent signal is inert until the next invocation mints
   * fresh cells. Packs bridge with one-time watchers (fire, self-dispose); the
   * re-invoked impl re-registers. Keep-alive subscriptions across re-invokes are
   * a leak by contract, not a supported pattern.
   *
   * Prefer async relative to impl (RX-ATOM-CLOCK); product first cut is sync
   * `bus.invalidate` (self-wake via foreign publish on envelope bus).
   */
  reportChanged(): void;
}

/**
 * Per-penetration handle, closed over that call’s produced Q paths.
 * `get` allowed iff exact membership in Q (RX-ATOM-MEMBER).
 * Optional closed-over E set enables teaching `effects-only` rejects (hybrid E half).
 *
 * ALWAYS minted when the symbol declares path producers (P-RX-ATOM-OFF-INERT):
 * when the path-atom bus is off (bare exec) or the run is replay-silent, cells are
 * INERT — `get` still membership-teaches, `report*` deliver nowhere. Bridge impls
 * run unchanged outside an envelope, with no undefined-guard boilerplate.
 */
export interface ReactiveAtoms {
  get(path: ResourcePath): ReactiveAtomCell;
}

/**
 * Teaching reject when path ∉ produced Q or is the E half of a hybrid.
 * Extends ArrivalError so the trampoline does not wrap as ForeignThrowError
 * (instanceof / name survive failAndWrap — same pattern as ResourcePathConflictError).
 */
export class ReactiveAtomMembershipError extends ArrivalError {
  public readonly name = "ReactiveAtomMembershipError";
  readonly "arrival/error-category": ErrorClass = "contract-shape";

  constructor(
    public readonly verbName: string,
    public readonly path: ResourcePath,
    public readonly reason: "not-in-q" | "effects-only",
  ) {
    super(
      `${verbName}: reactiveAtoms.get(${JSON.stringify([...path])}) rejected (${reason}) — ` +
        `only exact members of this penetration’s queries() paths are allowed`,
    );
  }
}

// ── Exact membership ─────────────────────────────────────────────────────────

function resourcePathsEqual(a: ResourcePath, b: ResourcePath): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function exactMember(path: ResourcePath, list: readonly ResourcePath[]): boolean {
  for (const p of list) {
    if (resourcePathsEqual(p, path)) return true;
  }
  return false;
}

// ── Per-RunContext liveness (R7, ruling 2026-08-13) ──────────────────────────
//
// Atoms live PER RUN CONTEXT — not per chunk execution. A cell's liveness domain
// is the RunContext its penetration ran under:
//   - REPL passes reusing one runCtx across execs share ONE liveness domain.
//   - A run that ABANDONS (fails) retires its cells immediately — the failed
//     run's observation never became a subscription (N-RX-ATOM-FAILED-RUN-CELL).
//   - A new OWNED run starting on the SAME bus retires the previous run's cells
//     (P-RX-ATOM-SUPERSEDE — the envelope re-invoke case, and any bus reuse).
//   - A committed bare run whose bus sees no successor keeps its cells live —
//     that is the bridge: the store may fire long after the run returned.
// Envelope dispose deliberately does NOT retire — a disposed unit's committed
// cells still publish store liveness to peers (P-RX-ATOM-DISPOSE neighbour law).

/** RunContexts whose reactive-atom cells are dead (abandoned or superseded). */
const retiredRuns = new WeakSet<object>();
/** Last OWNED runCtx seen per bus — the predecessor retired on bus reuse. */
const lastRunByBus = new WeakMap<PathAtomBus, object>();

/**
 * Note an owned run starting on `bus`: retires the previous run's cells on this
 * bus (supersede), installs this runCtx as the live one. Called by the exec
 * families for owned runCtx + armed pathAtoms; reused (non-owned) runCtx never
 * notes — its cells belong to the outer run context.
 */
export function noteReactiveAtomsRun(bus: PathAtomBus, runCtx: object): void {
  const prev = lastRunByBus.get(bus);
  if (prev !== undefined && prev !== runCtx) retiredRuns.add(prev);
  lastRunByBus.set(bus, runCtx);
}

/**
 * Retire a run context's cells immediately (exec abandon path; host doors).
 * Idempotent.
 */
export function retireReactiveAtomsRun(runCtx: object): void {
  retiredRuns.add(runCtx);
}

// ── Mint ─────────────────────────────────────────────────────────────────────

export type MintReactiveAtomsOpts = {
  verbName: string;
  /** Produced queries for this penetration (exact membership only). */
  queries: readonly ResourcePath[];
  /**
   * Produced effects — closed over only for teaching `effects-only` when `get`
   * hits an E path that is not also in Q. Does not allow get on E-only paths.
   */
  effects: readonly ResourcePath[];
  /**
   * `undefined` ⇒ inert mint (P-RX-ATOM-OFF-INERT): bus off / replay-silent.
   * Membership gating is identical; cells deliver nowhere.
   */
  bus: PathAtomBus | undefined;
  /** The penetration's RunContext — the cell's liveness domain (see module header). */
  runCtx: object;
};

/**
 * Mint a per-penetration {@link ReactiveAtoms} handle after CQS.
 * Closed over frozen Q/E arrays from path producers (not re-read later).
 */
export function mintReactiveAtoms(opts: MintReactiveAtomsOpts): ReactiveAtoms {
  const { verbName, queries, effects, bus, runCtx } = opts;

  const isLive = (): boolean => bus !== undefined && !retiredRuns.has(runCtx);

  // One-shot ledger (P-RX-ATOM-ONESHOT): serialized paths this mint has already
  // delivered a change for. Twin cells of one mint share the shot (same key).
  const fired = new Set<string>();

  return {
    get(path: ResourcePath): ReactiveAtomCell {
      if (exactMember(path, queries)) {
        // Q member — allow. Hybrid same-path still Q (membership wins over E).
        const key = serializeResourcePath(path);
        return {
          reportObserved() {
            if (!isLive()) return;
            bus!.observe([path]);
          },
          reportChanged() {
            if (!isLive()) return;
            if (fired.has(key)) return; // spent signal — one delivery per (mint, path)
            fired.add(key);
            // invalidate (not stageEffects): bridge liveness ≠ declared E / EffectLog.
            // Envelope bus publishes with source=null → RX-ATOM-SELF-WAKE (self may re-invoke).
            bus!.invalidate([path]);
          },
        };
      }
      if (exactMember(path, effects)) {
        throw new ReactiveAtomMembershipError(verbName, path, "effects-only");
      }
      throw new ReactiveAtomMembershipError(verbName, path, "not-in-q");
    },
  };
}
