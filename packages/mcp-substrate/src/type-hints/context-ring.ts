// context-ring — Ring 1 (doc §2/G3/G13, docs/working-proposals/manifold-type-hints.md rev 3).
// The per-rebuild-world ring of successful top-level `(define …)` source, re-lowered into a
// LoweredUnit's context region so session-state inference survives across manifold calls.
//
// Two invariants beyond plain FIFO storage:
//   • Tool-valued defines degrade at INSERTION (G13.1): a define whose source references any
//     `/`-qualified tool symbol anywhere in the form is stored as `declare const <name>:
//     unknown`, NEVER re-lowered from source — a mis-typed tool binding would poison the
//     current program's diagnostics; `unknown` yields only off-whitelist codes (no false hint).
//   • ~8k-char FIFO cap (G13.3): the cap bounds re-lowering latency (the ring re-lowers on
//     every errored call). Oldest evicted first; the newest push always survives.
//
// The ring never parses for the define NAME — the drain site (manifold-tool.ts, which walks
// the statements) extracts it and passes it in. push() is name + source only.

import type { ContextRing } from "./types.js";

/** {@link ContextRing}'s frozen contract (types.ts) has no export/restore seam — implementers
 *  change that file only by amending the design doc first. This is a STRUCTURAL superset (extra
 *  methods `ContextRing`'s own consumers never call), not a modification of the frozen shape:
 *  every existing `ContextRing`-typed consumer keeps working unchanged. `exportEntries` returns
 *  the ALREADY-DEGRADED (name, storedEntry) pairs verbatim — a tool-valued define's
 *  `declare const x: unknown` stand-in, not the original source — so `restoreEntries` never
 *  re-runs the tool-symbol detection (the session-export primitive, session-store.ts). */
export interface SerializableContextRing extends ContextRing {
  exportEntries(): readonly (readonly [string, string])[];
  restoreEntries(entries: Iterable<readonly [string, string]>): void;
}

/** ~8k-char total cap (G13.3). "~8k" — the eviction target; entries() stays at/under it. */
const MAX_TOTAL_CHARS = 8000;

/** A `/`-qualified tool symbol anywhere in the form (a slug head with non-empty name tail,
 *  e.g. `shop/list-orders`). The bare `/` division operator and pure-numeric ratios never
 *  match — the slug must begin with a letter. Detection is textual, matching the doc's
 *  "references any tool symbol … a `/`-qualified head anywhere in the form"; over-degrading
 *  is the SAFE direction (a degraded entry produces no hint, never a false one).
 *
 *  ★ BLIND SPOT found 2026-07-05 (full account: session-history.ts's sibling `TOOL_SYMBOL`
 *  doc): this assumes every qualified name contains `/`, which is false for a SLUGLESS
 *  single-server binding (bind.ts: `qualifiedName = server.slug === "" ? tool.name : ...`)
 *  bound to a tool whose own bare name has no separator either (e.g. `price`, `click`). Such
 *  a define was NOT degraded — verified directly, its raw tool-invoking source stayed in the
 *  ring — which is the dangerous direction here (a mis-typed tool binding poisoning this
 *  program's diagnostics, the exact failure G13.1 exists to prevent), the mirror image of
 *  session-history.ts's re-invocation risk from the same gap. `createContextRing`'s optional
 *  `knownToolNames` closes it — see `knownToolPattern` below. */
// Flagged by sonarjs/slow-regex: bounded input (one statement's source text); same accepted
// tradeoff as session-history.ts's identical sibling constant.
// eslint-disable-next-line sonarjs/slow-regex
const TOOL_SYMBOL = /[A-Z][\w.-]*\/[\w.-]+/i;

/** Token-boundary chars for {@link knownToolPattern} — byte-identical to session-history.ts's
 *  own copy (duplicated, not imported, matching this pair's existing `TOOL_SYMBOL` convention):
 *  the actual Scheme-reader token separators, so a roster name matches only as its OWN symbol,
 *  never as a substring of an unrelated longer identifier (`click` inside
 *  `double-click-handler`). */
const BEFORE = String.raw`(?:^|[\s()\[\]{}'\`,])`;
const AFTER = String.raw`(?:$|[\s()\[\]{}])`;

/** The ROSTER-BASED half of tool-valued detection (see `TOOL_SYMBOL`'s blind-spot doc above):
 *  a token-boundary-aware regex matching any of `names` as a whole symbol, or `undefined` when
 *  `names` is empty (no roster supplied — the caller falls back to `TOOL_SYMBOL` alone,
 *  byte-identical to this module's pre-2026-07-05 behavior). Escapes each name defensively:
 *  a real bound tool's qualified name is wire-constrained to `^[a-zA-Z0-9_-]+$` (bind.ts) and
 *  so never actually needs it, but nothing here can enforce that on a misbehaving upstream
 *  server — a regex-metacharacter name should degrade to "doesn't match", never a malformed
 *  pattern or a thrown `SyntaxError`. */
function knownToolPattern(names: Iterable<string>): RegExp | undefined {
  const escaped = [...new Set(names)]
    .filter((n) => n.length > 0)
    .map((n) => n.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`));
  return escaped.length > 0 ? new RegExp(`${BEFORE}(?:${escaped.join("|")})${AFTER}`) : undefined;
}

/** `knownToolNames` — the REAL bound-tool roster (manifold-tool.ts's `toolSchemas.keys()`),
 *  when the caller has one — closes `TOOL_SYMBOL`'s slugless-binding blind spot (see its doc
 *  above) without weakening the existing shape heuristic (both checks OR together). Optional and
 *  defaulted to empty so every existing direct caller (this package's own unit tests, which
 *  construct a ring with no env/roster at all) keeps today's exact behavior. Note this is a
 *  constructor-only parameter — {@link ContextRing}'s `push`/`entries` contract (the part
 *  documented as frozen) is untouched. */
export function createContextRing(knownToolNames: Iterable<string> = []): SerializableContextRing {
  // Insertion-ordered store; rebind moves the name to newest (delete-then-set).
  const store = new Map<string, string>();
  const knownPattern = knownToolPattern(knownToolNames);

  const totalChars = (): number => {
    let sum = 0;
    for (const entry of store.values()) sum += entry.length;
    return sum;
  };

  return {
    push(name, source) {
      const isToolValued = TOOL_SYMBOL.test(source) || (knownPattern?.test(source) ?? false);
      const entry = isToolValued ? `declare const ${name}: unknown` : source;
      if (store.has(name)) store.delete(name); // rebind → last-wins, refreshed to newest
      store.set(name, entry);
      // FIFO eviction: drop the oldest until under the cap; never evict the just-pushed newest.
      while (totalChars() > MAX_TOTAL_CHARS && store.size > 1) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    entries() {
      return [...store.values()];
    },
    exportEntries() {
      return [...store.entries()];
    },
    restoreEntries(entries) {
      store.clear();
      for (const [name, entry] of entries) store.set(name, entry);
    },
  };
}
