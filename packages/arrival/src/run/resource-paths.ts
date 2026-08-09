/**
 * resource-paths — named domain lanes for temporal zoning of domain immutability.
 *
 * A resource path is a segment tuple (e.g. `["db","projects",id]`). Overlap is
 * segment-wise prefix either direction — not string-join. Within one run, after
 * a domain has been effected, a new query genesis overlapping that effect is
 * illegal (door before impl). Holding prior query results is fine; outer-world
 * sync is not promised.
 *
 * Design: docs/working-proposals/cqs-reactivity/
 * Suite:  docs/working-proposals/cqs-reactivity/test-suite-design/SUITE.md
 *
 * THIS MODULE is the pure algebra + run log + door error. Path producers live
 * on CrossingContract (rosetta only); the chokepoint is the membrane apply.
 *
 * Channel model: unlike cache/effects/reads (opt-in undefined), ordinary
 * RunContext mints always carry a fresh MemoryResourcePathLog so CQS is on by
 * default for live runs; CONSTANT_CTX leaves the facility off.
 *
 * Segment types: prefer type-level (`ResourcePath = readonly string[]`). Runtime
 * non-string segment checks are opt-in via `strictCQSstrings` (default false).
 * Top-level producer return shape (must be an array of paths) is always checked.
 */

import { ArrivalError, type ErrorClass } from "../errors.js";

/** One named domain location — ordered segments. Empty tuples are out of generators. */
export type ResourcePath = readonly string[];

/**
 * Decoded-arg path producer (contract field). Invoked after decode, before impl.
 * Return type pins string segments at the type level; authors name decoded slots
 * with concrete param types. Sole home — re-exported from `_bake` for CrossingContract.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- authoring ergonomics; runtime is post-decode
export type ResourcePathFn = (...decodedArgs: any[]) => readonly ResourcePath[];

/** Segment-wise prefix overlap either direction. Empty path never overlaps. */
export function pathsOverlap(a: ResourcePath, b: ResourcePath): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Any-pair multi-set overlap (door fuel). */
export function anyPathOverlap(
  priorEffects: readonly ResourcePath[],
  thisQueries: readonly ResourcePath[],
): boolean {
  return findOverlappingPair(priorEffects, thisQueries) !== undefined;
}

/** First overlapping (priorE, thisQ) pair, if any — door discriminator payload. */
export function findOverlappingPair(
  priorEffects: readonly ResourcePath[],
  thisQueries: readonly ResourcePath[],
): { priorEffect: ResourcePath; thisQuery: ResourcePath } | undefined {
  for (const priorEffect of priorEffects) {
    for (const thisQuery of thisQueries) {
      if (pathsOverlap(priorEffect, thisQuery)) {
        return { priorEffect, thisQuery };
      }
    }
  }
  return undefined;
}

/**
 * Per-run prior-effect path set. Record only AFTER check passes (R-O2).
 * Optional query log is not required for the door.
 */
export interface ResourcePathLog {
  /**
   * Prior effect paths this run (live view of the internal array — same honesty
   * as MemoryEffectLog.entries; do not mutate).
   */
  readonly effectPaths: readonly ResourcePath[];
  /** Append effect paths that passed the CQS check (pre-impl). Empty paths ignored. */
  recordEffects(paths: readonly ResourcePath[]): void;
}

/**
 * Default in-memory log — one instance per run. Copies path arrays on record.
 * No dedup: repeated writes grow O(effects); check is O(|priorE|×|Q|×depth).
 * Fine for Phase 3a; index later if long-run hosts need it.
 */
export class MemoryResourcePathLog implements ResourcePathLog {
  private readonly _effects: ResourcePath[] = [];

  get effectPaths(): readonly ResourcePath[] {
    return this._effects;
  }

  recordEffects(paths: readonly ResourcePath[]): void {
    for (const path of paths) {
      if (path.length > 0) this._effects.push(Object.freeze([...path]));
    }
  }
}

/**
 * Door: prior effect paths ∩ this query paths ≠ ∅.
 * Thrown before impl; doored impl must not run.
 */
export class ResourcePathConflictError extends ArrivalError {
  public readonly name = "ResourcePathConflictError";
  readonly "arrival/error-category": ErrorClass = "domain-immutability";

  constructor(
    /** Offending symbol (the query penetration). */
    public readonly verbName: string,
    /** One prior effect path that overlaps. */
    public readonly priorEffect: ResourcePath,
    /** One query path from this penetration that overlaps. */
    public readonly thisQuery: ResourcePath,
  ) {
    super(
      `${verbName}: query path ${formatPath(thisQuery)} overlaps prior effect path ${formatPath(priorEffect)} ` +
        `in this run — a new query genesis on a domain after it was effected is illegal ` +
        `(temporal zoning of domain immutability; hold prior results instead of re-querying)`,
    );
  }
}

/** Bake-time: path producers only on rosetta. */
export class ResourcePathDeclarationError extends ArrivalError {
  public readonly name = "ResourcePathDeclarationError";
  readonly "arrival/error-category": ErrorClass = "contract-shape";

  constructor(
    public readonly op: string,
    public readonly kind: string,
  ) {
    super(
      `${op}: queries?/effects? path producers are rosetta-only — ${kind} cannot declare resource paths ` +
        `(domain lanes are a membrane crossing concern)`,
    );
  }
}

/**
 * Runtime bake door for contour factories (native / sequence / define).
 * Type-level excess-property checks refuse path producers on ContourContract;
 * this catches untyped / `as any` authors.
 */
export function assertNoResourcePathProducers(
  name: string,
  kind: string,
  contract: { queries?: unknown; effects?: unknown },
): void {
  if (contract.queries !== undefined || contract.effects !== undefined) {
    throw new ResourcePathDeclarationError(name, kind);
  }
}

/**
 * Path producer threw or returned a bad shape.
 * Category is type-mismatch — the producer's output violated the path contract.
 */
export class ResourcePathProducerError extends ArrivalError {
  public readonly name = "ResourcePathProducerError";
  readonly "arrival/error-category": ErrorClass = "type-mismatch";

  constructor(
    public readonly verbName: string,
    public readonly axis: "queries" | "effects",
    public readonly reason: string,
    cause?: unknown,
  ) {
    super(
      `${verbName}: ${axis} path producer ${reason}`,
      [],
      cause instanceof Error ? cause : undefined,
    );
  }
}

function formatPath(path: ResourcePath): string {
  return path.length === 0 ? "[]" : path.map((s) => JSON.stringify(s)).join("/");
}

/**
 * Call producer, then normalize return to a list of paths.
 * Always: top-level must be an array; each element must be an array (path).
 * Under strictCQSstrings: every segment must be a string.
 */
function producePaths(
  verbName: string,
  axis: "queries" | "effects",
  fn: ResourcePathFn,
  decodedArgs: readonly unknown[],
  strictCQSstrings: boolean,
): readonly ResourcePath[] {
  let raw: unknown;
  try {
    raw = fn(...decodedArgs);
  } catch (cause) {
    const detail =
      cause instanceof Error ? `threw: ${cause.message}` : `threw: ${String(cause)}`;
    throw new ResourcePathProducerError(verbName, axis, detail, cause);
  }
  if (!Array.isArray(raw)) {
    throw new ResourcePathProducerError(
      verbName,
      axis,
      `must return an array of paths (got ${raw === null ? "null" : typeof raw})`,
    );
  }
  const out: ResourcePath[] = [];
  for (let pi = 0; pi < raw.length; pi++) {
    const path = raw[pi];
    if (!Array.isArray(path)) {
      throw new ResourcePathProducerError(
        verbName,
        axis,
        `path at index ${pi} must be a segment array (got ${path === null ? "null" : typeof path}) — ` +
          `return e.g. [["db","projects",id]], not a flat path`,
      );
    }
    if (strictCQSstrings) {
      for (let si = 0; si < path.length; si++) {
        if (typeof path[si] !== "string") {
          throw new ResourcePathProducerError(
            verbName,
            axis,
            `non-string segment at path[${pi}][${si}] (got ${typeof path[si]}) — ` +
              `caught by strictCQSstrings (segments must be strings)`,
          );
        }
      }
    }
    out.push(path as ResourcePath);
  }
  return out;
}

/**
 * Run the CQS order for one penetration (R-O2):
 *   path fns → check vs prior E → record E → (caller runs impl)
 *
 * When `log` is undefined, path fns still run if provided (for observability) but
 * check/record are no-ops (facility off — CONSTANT_CTX).
 *
 * `strictCQSstrings` (default false): runtime assert every path segment is a string.
 * Prefer type-level `ResourcePath`; this flag is for non-prod harness stress only.
 * Top-level producer shape (array of arrays) is always enforced.
 */
export function applyResourcePathCqs(opts: {
  verbName: string;
  decodedArgs: readonly unknown[];
  queries?: ResourcePathFn;
  effects?: ResourcePathFn;
  log: ResourcePathLog | undefined;
  strictCQSstrings?: boolean;
}): { queries: readonly ResourcePath[]; effects: readonly ResourcePath[] } {
  const strict = opts.strictCQSstrings === true;
  const Q = opts.queries
    ? producePaths(opts.verbName, "queries", opts.queries, opts.decodedArgs, strict)
    : [];
  const E = opts.effects
    ? producePaths(opts.verbName, "effects", opts.effects, opts.decodedArgs, strict)
    : [];
  const log = opts.log;
  if (log !== undefined && Q.length > 0) {
    const pair = findOverlappingPair(log.effectPaths, Q);
    if (pair !== undefined) {
      throw new ResourcePathConflictError(opts.verbName, pair.priorEffect, pair.thisQuery);
    }
  }
  if (log !== undefined && E.length > 0) {
    log.recordEffects(E);
  }
  return { queries: Q, effects: E };
}
