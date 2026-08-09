/**
 * Path-keyed atom bus (Phase 5 R1).
 *
 * Live query penetrations (Q≠[]) observe atoms keyed by {@link serializeResourcePath}
 * verbatim (RX-KEY). Effect paths stage for invalidation at successful run commit
 * (RX-CLOCK); sink-gather does not stage (impl skipped — RX-CLOCK-2 / burst later).
 *
 * MobX (or a substitute) sits behind {@link AtomProxy} — this module never imports it.
 * Memory bus is the harness / X1 recording double; {@link ProxyPathAtomBus} is the
 * production shape for a host envelope (R2).
 *
 * Design: docs/working-proposals/cqs-reactivity/
 * Suite:  docs/working-proposals/cqs-reactivity/test-suite-design/reactivity/SUITE.md
 */

import type { AtomProxy, ProxyAtom } from "./atom-proxy.js";
import {
  pathsOverlap,
  serializeResourcePath,
  type ResourcePath,
} from "./resource-paths.js";

// ── Key algebra (X0) ─────────────────────────────────────────────────────────

/**
 * Atom key for one resource path — **verbatim** {@link serializeResourcePath} (RX-KEY).
 * Phase 5 must not mint a second encoding.
 */
export function atomKey(path: ResourcePath): string {
  return serializeResourcePath(path);
}

/**
 * Whether two serialized path keys are string-prefix-related (either direction).
 * Over **string** segments this matches {@link pathsOverlap} (F-RX2). Non-string
 * segments can be string-prefix-related while pathsOverlap is false (X-KEY-NONSTRING /
 * why RX-STRICT exists). Empty key `"[]"` is related to nothing.
 */
export function keysArePrefixRelated(a: string, b: string): boolean {
  if (a === "[]" || b === "[]") return false;
  if (a === b) return true;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Notify predicate over path tuples — same segment-wise prefix relation as the CQS door.
 * Sound and complete vs {@link pathsOverlap} (F-RX3).
 */
export function wouldNotify(
  write: ResourcePath,
  subscriptions: readonly ResourcePath[],
): boolean {
  for (const q of subscriptions) {
    if (pathsOverlap(write, q)) return true;
  }
  return false;
}

/**
 * Path-atom keys always begin with `"` (JSON-quoted first segment) or equal `"[]"`.
 * Param-atom keys (**RX-PARAM-NS**) must begin with neither so the namespaces are
 * structurally disjoint — an encoding property, not hand-maintained vigilance.
 */
export function isPathAtomKey(key: string): boolean {
  return key === "[]" || key.startsWith('"');
}

/** Mint a param-atom key in the namespace disjoint from path keys (RX-PARAM-NS). */
export function paramAtomKey(name: string): string {
  // Leading letter / no leading `"` — structurally disjoint from serializeResourcePath.
  return `param:${name}`;
}

// ── Bus interface ────────────────────────────────────────────────────────────

/**
 * Host/harness atom bus. Core calls {@link observe} on live Q≠[] penetrations and
 * {@link stageEffects} after successful non-sink E≠[] fires; {@link commitRun} flushes
 * staged invalidations only when the whole run succeeds (RX-CLOCK per-run grain).
 *
 * {@link invalidate} is a harness shortcut (RX-EXT) and also the flush target for
 * commit — not a public product surface for external writers in R1.
 */
export interface PathAtomBus {
  /** Observe query paths (key = atomKey). No-op on empty paths. */
  observe(paths: readonly ResourcePath[]): void;
  /**
   * Stage effect paths for invalidation at run commit. Not immediate — a run that
   * later doors or throws abandons staged work (RX-CLOCK).
   */
  stageEffects(paths: readonly ResourcePath[]): void;
  /** Successful run commit: flush staged → invalidate. Clears staged. */
  commitRun(): void;
  /** Failed run: drop staged; do not invalidate. */
  abandonRun(): void;
  /**
   * Invalidate atoms overlapping these write paths (prefix / pathsOverlap semantics
   * for subscribers; recording buses may record the write keys themselves).
   */
  invalidate(paths: readonly ResourcePath[]): void;
}

// ── Memory bus (X1 recording / no-MobX harness) ──────────────────────────────

/**
 * Recording bus for law tests (X1 white-box). Tracks observed / invalidated key sets.
 * Does not implement re-invoke (R2). `observed` mirrors what a ReadTracker-style
 * seam would log for path Q penetrations (RX-SEAM).
 */
export class MemoryPathAtomBus implements PathAtomBus {
  /** Keys observed this run (accumulates; harness may clear between cases). */
  readonly observed = new Set<string>();
  /** Keys invalidated at the last successful commitRun (or direct invalidate). */
  readonly invalidated = new Set<string>();
  private staged: ResourcePath[] = [];

  observe(paths: readonly ResourcePath[]): void {
    for (const p of paths) {
      if (p.length > 0) this.observed.add(atomKey(p));
    }
  }

  stageEffects(paths: readonly ResourcePath[]): void {
    for (const p of paths) {
      if (p.length > 0) this.staged.push(p);
    }
  }

  commitRun(): void {
    if (this.staged.length > 0) {
      this.invalidate(this.staged);
      this.staged = [];
    }
  }

  abandonRun(): void {
    this.staged = [];
  }

  invalidate(paths: readonly ResourcePath[]): void {
    for (const p of paths) {
      if (p.length > 0) this.invalidated.add(atomKey(p));
    }
  }

  /** Test helper: reset all sets between cases. */
  clear(): void {
    this.observed.clear();
    this.invalidated.clear();
    this.staged = [];
  }
}

// ── Proxy-backed bus (MobX or substitute via AtomProxy) ──────────────────────

/**
 * PathAtomBus over a thin {@link AtomProxy}. Production shape for host envelopes:
 * observe → reportObserved; invalidate → reportChanged on overlapping keys known
 * to this bus. Keys are created lazily on first observe/invalidate.
 *
 * Self-write suppression and envelope subscription sets are R2 concerns — this bus
 * only owns path-keyed cells.
 */
export class ProxyPathAtomBus implements PathAtomBus {
  private readonly atoms = new Map<string, ProxyAtom>();
  private staged: ResourcePath[] = [];

  constructor(private readonly proxy: AtomProxy) {}

  private cell(key: string): ProxyAtom {
    let a = this.atoms.get(key);
    if (a === undefined) {
      a = this.proxy.atom(key);
      this.atoms.set(key, a);
    }
    return a;
  }

  observe(paths: readonly ResourcePath[]): void {
    for (const p of paths) {
      if (p.length > 0) this.cell(atomKey(p)).reportObserved();
    }
  }

  stageEffects(paths: readonly ResourcePath[]): void {
    for (const p of paths) {
      if (p.length > 0) this.staged.push(p);
    }
  }

  commitRun(): void {
    if (this.staged.length > 0) {
      this.invalidate(this.staged);
      this.staged = [];
    }
  }

  abandonRun(): void {
    this.staged = [];
  }

  invalidate(paths: readonly ResourcePath[]): void {
    // Notify every known atom whose path key is prefix-related to a write key.
    // Unknown keys still mint a cell so future observers see a changed epoch.
    for (const p of paths) {
      if (p.length === 0) continue;
      const writeKey = atomKey(p);
      this.cell(writeKey).reportChanged();
      for (const [key, atom] of this.atoms) {
        if (key !== writeKey && keysArePrefixRelated(key, writeKey)) {
          atom.reportChanged();
        }
      }
    }
  }
}

/**
 * Minimal in-process {@link AtomProxy} for tests / X4 parity without MobX.
 * Tracks observe/change counts only — not a scheduler.
 */
export function createMemoryAtomProxy(): AtomProxy & {
  readonly stats: Map<string, { observed: number; changed: number }>;
} {
  const stats = new Map<string, { observed: number; changed: number }>();
  return {
    stats,
    atom(key: string) {
      if (!stats.has(key)) stats.set(key, { observed: 0, changed: 0 });
      return {
        reportObserved() {
          stats.get(key)!.observed++;
        },
        reportChanged() {
          stats.get(key)!.changed++;
        },
      };
    },
  };
}
