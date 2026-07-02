/**
 * Structural scope identity off an arrival-scheme AST `Pair` — `headOf` (the head
 * symbol name) and `scopeId` (`head@line:col`). Pure, dependency-free leaf.
 *
 * Lives on its own so BOTH `trace-to-forest` (which consumes the live trace) and
 * `trace-snapshot` (which projects a clone-safe payload) can read scope identity
 * without an import cycle — `trace-to-forest` already imports `trace-snapshot`, so
 * `trace-snapshot` cannot import scope logic back through it. Keeping this a leaf
 * also lets the ELK worker (A2) import `scopeId` for the off-thread region build
 * without dragging in `trace-to-forest`'s machinery.
 */

/** Head symbol name of a form: the `__name__` of its `car`, or `"?"` if absent. */
export function headOf(node: unknown): string {
  const car = (node as { car?: { __name__?: unknown } } | null)?.car;
  const name = (car as { __name__?: unknown } | undefined)?.__name__;
  return typeof name === "string" ? name : "?";
}

/** Stable structural scope id: `head@source:line:col` when the location carries a
 *  source file, `head@line:col` when sourceless, `head` if unlocated. The parser
 *  stamps a `__location__` symbol on located Pairs (with `source` when `parse` was
 *  given one — required `.scm` modules, `.prompt`-generated resolver lambdas).
 *  Exported so the unified flow-graph builder can bridge causal-chart nodes (keyed
 *  by Pair identity) back to forest boxes (keyed by this id) — both group by the
 *  same Pair, so the strings coincide.
 *
 *  WHY source is part of the identity: line:col alone COLLIDES across files — two
 *  forms at the same position in different required modules (or two `.prompt`s'
 *  generated lambdas, which all parse the same text at the same 1:13) would fold
 *  onto one scope, merging distinct call sites in every scope-keyed consumer
 *  (chain labels, region folding, boundary ports). Identity is file+line+col;
 *  sourceless forms (the main program body) keep the old shape byte-for-byte.
 *
 *  Note the `__location__` is a SYMBOL-keyed property: it survives on the live
 *  Pair but `structuredClone` strips it. Anything crossing a worker boundary must
 *  pre-derive this string while the live Pair is in hand (see `trace-snapshot`'s
 *  `scope` field), not call `scopeId` on a cloned node. */
export function scopeId(node: unknown): string {
  const head = headOf(node);
  if (node && typeof node === "object") {
    for (const s of Object.getOwnPropertySymbols(node)) {
      if (s.description === "__location__") {
        const loc = (node as Record<symbol, unknown>)[s] as { line?: number; col?: number; source?: string } | undefined;
        if (loc && typeof loc.line === "number") {
          const at = typeof loc.source === "string" && loc.source !== "" ? `${loc.source}:` : "";
          return `${head}@${at}${loc.line}:${loc.col ?? 0}`;
        }
      }
    }
  }
  return head;
}

/** Marker substring stamped into a `.prompt`'s generated-lambda source (see
 *  `resolvePrompt` in `arrival-scheme-env-infer/src/prompt.ts`: `parse(…, undefined,
 *  \`dotprompt:${path}\`)`). A `scopeId`/`PlainInv.scope` string containing this
 *  marker was minted on the RESOLVER-GENERATED `(infer/run …)` form inside the
 *  resolved lambda, not on the user's own call site. */
export const DOTPROMPT_SOURCE_MARKER = "@dotprompt:";

/** Shape shared by `PlainInv` (trace-snapshot.ts) and `ChainPoint`-like walkers:
 *  a pre-derived `scope` string plus a walkable `parent` chain. Kept minimal (not
 *  importing `PlainInv` itself) so this leaf stays dependency-free. */
export interface ScopedParented {
  readonly scope: string;
  readonly parent: ScopedParented | null;
}

/** Project a `.prompt` provenance point (minted on the generated `(infer/run …)`
 *  form inside the resolved lambda) back to the user's real call site: walk
 *  `parent` upward to the nearest ancestor whose OWN scope does NOT carry the
 *  `@dotprompt:` marker — that is the `(run-x …)` application the author actually
 *  wrote. Returns the input itself when it isn't a dotprompt point, or when no
 *  non-dotprompt ancestor exists (degrades safely — shouldn't happen in practice,
 *  every `.prompt` call is itself a non-dotprompt-scoped application). */
export function userCallSite<T extends ScopedParented>(inv: T): T {
  if (!inv.scope.includes(DOTPROMPT_SOURCE_MARKER)) return inv;
  for (let p = inv.parent; p; p = p.parent) {
    if (!p.scope.includes(DOTPROMPT_SOURCE_MARKER)) return p as T;
  }
  return inv;
}
