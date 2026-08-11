/**
 * In-symbol path atoms (Phase 5 R6–R7).
 *
 * Capability impls bridge in-process sources onto query path atoms via
 * `this.reactiveAtoms` on CallCtx (01-unified-design §6.3).
 *
 * **Mint site:** after `applyResourcePathCqs` succeeds, at the rosetta impl call
 * (`hostImpl.call`), derive `{ …callCtx, reactiveAtoms }` closed over that
 * penetration’s produced Q (+ E for teaching `effects-only`). Doored penetrations
 * never mint. Undefined when `pathAtoms` is off / replay-silent.
 *
 * **Supersede (R7):** each bus has a generation. Envelope advances it at every
 * invoke start; cells from a prior generation no-op `reportChanged` / `reportObserved`.
 *
 * Design: docs/working-proposals/cqs-reactivity/01-unified-design.md §6.3–6.5
 * Suite:  docs/working-proposals/cqs-reactivity/test-suite-design/reactivity/SUITE.md X6
 */

import { ArrivalError, type ErrorClass } from "../errors.js";
import type { PathAtomBus } from "./path-atom-bus.js";
import type { ResourcePath } from "./resource-paths.js";

/** One path-keyed cell visible inside a query impl. */
export interface ReactiveAtomCell {
  /** This unit/run is tracking the view (same key space as membrane observe). */
  reportObserved(): void;
  /**
   * Query result is different now — dirties the path atom for hub re-invoke.
   * Not a substitute for declared `effects` / EffectLog.
   * Prefer async relative to impl (RX-ATOM-CLOCK); product first cut is sync
   * `bus.invalidate` (self-wake via foreign publish on envelope bus).
   */
  reportChanged(): void;
}

/**
 * Per-penetration handle, closed over that call’s produced Q paths.
 * `get` allowed iff exact membership in Q (RX-ATOM-MEMBER).
 * Optional closed-over E set enables teaching `effects-only` rejects (hybrid E half).
 */
export interface ReactiveAtoms {
  get(path: ResourcePath): ReactiveAtomCell;
}

/**
 * Teaching reject when path ∉ produced Q, E-only misuse, or facility off.
 * Extends ArrivalError so the trampoline does not wrap as ForeignThrowError
 * (instanceof / name survive failAndWrap — same pattern as ResourcePathConflictError).
 */
export class ReactiveAtomMembershipError extends ArrivalError {
  public readonly name = "ReactiveAtomMembershipError";
  readonly "arrival/error-category": ErrorClass = "contract-shape";

  constructor(
    public readonly verbName: string,
    public readonly path: ResourcePath,
    public readonly reason: "not-in-q" | "effects-only" | "facility-off",
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

// ── Generation / supersede (R7) ──────────────────────────────────────────────

/**
 * Per-bus generation counter. Envelope advances at each invoke start so cells
 * minted in a prior run no-op after re-invoke (P-RX-ATOM-SUPERSEDE).
 * Bare `exec` never advances — cells live for that single run only.
 */
const busGeneration = new WeakMap<PathAtomBus, number>();

function generationOf(bus: PathAtomBus): number {
  return busGeneration.get(bus) ?? 0;
}

/**
 * Advance the reactive-atoms generation for this bus.
 * Call at the start of every envelope invoke (including the first).
 * Stale cells from the previous generation become silent no-ops.
 */
export function advanceReactiveAtomsGeneration(bus: PathAtomBus): void {
  busGeneration.set(bus, generationOf(bus) + 1);
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
  bus: PathAtomBus;
};

/**
 * Mint a per-penetration {@link ReactiveAtoms} handle after CQS.
 * Closed over frozen Q/E arrays from path producers (not re-read later).
 */
export function mintReactiveAtoms(opts: MintReactiveAtomsOpts): ReactiveAtoms {
  const { verbName, queries, effects, bus } = opts;
  // Capture generation at mint — supersede advances the bus; this mint dies.
  const genAtMint = generationOf(bus);

  const isLive = (): boolean => generationOf(bus) === genAtMint;

  return {
    get(path: ResourcePath): ReactiveAtomCell {
      if (exactMember(path, queries)) {
        // Q member — allow. Hybrid same-path still Q (membership wins over E).
        return {
          reportObserved() {
            if (!isLive()) return;
            bus.observe([path]);
          },
          reportChanged() {
            if (!isLive()) return;
            // invalidate (not stageEffects): bridge liveness ≠ declared E / EffectLog.
            // Envelope bus publishes with source=null → RX-ATOM-SELF-WAKE (self may re-invoke).
            bus.invalidate([path]);
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
