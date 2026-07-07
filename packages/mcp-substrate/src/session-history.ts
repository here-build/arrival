// session-history — replayable record of successful top-level `(define ...)` statements.
//
// The live `SchemeEnv` provides cross-call persistence for a single world. This module
// exists for resumability: a history of source text can be replayed into a fresh environment
// (new process, resumed session, etc.).
//
// Tool-valued defines are skipped on replay (to avoid re-invoking side-effecting tools).
// Callers are expected to advise the user when a reconstruction may be incomplete because
// of skipped tool-valued statements.
//
// This module is a sibling to the type-hints context ring. They observe the same events
// but project different data (original source here vs. degraded `declare const ...` there).

import { exec, type SchemeEnv } from "@here.build/arrival";

/** `exec`'s `env` option uses arrival's internal `Environment`; `SchemeEnv` is the public view. */
type ExecEnv = NonNullable<Parameters<typeof exec>[1]>["env"];

/** Detects a qualified tool name (`server/tool`) anywhere in a form.
 *
 *  Used to decide whether a top-level define is "tool-valued" and should be skipped on replay.
 *  Over-flagging (skipping a define that merely mentions a tool-shaped literal) is safe.
 *
 *  Limitation: does not match slugless single-server tool names (no `/`). Callers that supply
 *  `knownToolNames` get a more precise check via `knownToolPattern`. */
// eslint-disable-next-line sonarjs/slow-regex
const TOOL_SYMBOL = /[A-Z][\w.-]*\/[\w.-]+/i;

/** Token-boundary chars for {@link knownToolPattern} — mirrors competence.ts's own
 *  `BEFORE`/`AFTER` (duplicated, not imported: this file's existing convention above is
 *  already to keep its own sibling copy of a small shared regex fragment rather than reach
 *  into another module). The actual Scheme-reader token separators, so a roster name is
 *  matched only as its OWN symbol, never as a substring of an unrelated longer identifier
 *  (`click` inside `double-click-handler`). */
const BEFORE = String.raw`(?:^|[\s()\[\]{}'\`,])`;
const AFTER = String.raw`(?:$|[\s()\[\]{}])`;

/** The ROSTER-BASED half of tool-valued detection (see `TOOL_SYMBOL`'s blind-spot doc
 *  above): a token-boundary-aware regex matching any of `names` as a whole symbol, or
 *  `undefined` when `names` is empty (no roster supplied — the caller falls back to
 *  `TOOL_SYMBOL` alone, byte-identical to this module's pre-2026-07-05 behavior). Escapes
 *  each name defensively before interpolating: a real bound tool's qualified name is
 *  wire-constrained to `^[a-zA-Z0-9_-]+$` (bind.ts) and so never actually needs it, but nothing
 *  here can enforce that on a misbehaving upstream server — a regex-metacharacter name should
 *  degrade to "doesn't match", never a malformed pattern or a thrown `SyntaxError`. */
function knownToolPattern(names: Iterable<string>): RegExp | undefined {
  const escaped = [...new Set(names)]
    .filter((n) => n.length > 0)
    .map((n) => n.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`));
  return escaped.length > 0 ? new RegExp(`${BEFORE}(?:${escaped.join("|")})${AFTER}`) : undefined;
}

export interface SessionHistoryEntry {
  /** The bound variable/function name (topLevelDefineName's extraction). */
  readonly name: string;
  /** The exact top-level `(define ...)` statement source, verbatim. */
  readonly source: string;
  /** True when `source` references a qualified tool symbol anywhere in the form —
   *  `replaySessionHistory` SKIPS these (see file header tradeoff). */
  readonly toolValued: boolean;
}

export interface SessionHistory {
  /** Record a top-level define whose own evaluation SUCCEEDED. Only call this for a
   *  statement that actually ran without error. Rebinding an existing name replaces its
   *  entry (last-wins) and moves it to the newest position — replay reproduces the
   *  session's FINAL binding for that name, not every historical rebind. */
  push(name: string, source: string): void;
  /** Entries in insertion (application) order. */
  entries(): readonly SessionHistoryEntry[];
  /** Replace the store wholesale with `entries`, VERBATIM — including each entry's already-
   *  computed `toolValued` flag, never recomputed from `source` against this instance's
   *  `knownToolNames` (session restore; session-store.ts). A restore is a full rehydration of
   *  the EXACT prior session, not a re-derivation against the restoring env's own roster —
   *  those may legitimately differ (e.g. arrival-mcp's per-call toolset). */
  restoreEntries(entries: readonly SessionHistoryEntry[]): void;
}

/** `knownToolNames` — the REAL bound-tool roster (manifold-tool.ts's `toolSchemas.keys()`),
 *  when the caller has one — closes `TOOL_SYMBOL`'s slugless-binding blind spot (see its doc
 *  above) without weakening the existing shape heuristic (both checks OR together; either one
 *  seeing a tool reference is enough). Optional and defaulted to empty so every existing direct
 *  caller (this package's own unit tests) keeps today's exact behavior. */
export function createSessionHistory(knownToolNames: Iterable<string> = []): SessionHistory {
  // Insertion-ordered store; rebind moves the name to newest (delete-then-set) — same
  // last-wins rule as context-ring.ts, independently implemented (see file header).
  const store = new Map<string, SessionHistoryEntry>();
  const knownPattern = knownToolPattern(knownToolNames);
  return {
    push(name, source) {
      if (store.has(name)) store.delete(name);
      const toolValued = TOOL_SYMBOL.test(source) || (knownPattern?.test(source) ?? false);
      store.set(name, { name, source, toolValued });
    },
    entries() {
      return [...store.values()];
    },
    restoreEntries(entries) {
      store.clear();
      for (const entry of entries) store.set(entry.name, entry);
    },
  };
}

export interface ReplayResult {
  /** Names successfully replayed and (re)bound in the target env, in application order. */
  readonly applied: readonly string[];
  /** Tool-valued define names skipped — never replayed (file header tradeoff note). */
  readonly skipped: readonly string[];
  /** Names whose replay statement itself threw. Best-effort, errors-as-doors reconstruction
   *  (matching this package's REPL-continue philosophy elsewhere, manifold-tool.ts): one
   *  entry's failure never aborts the rest. The one known cause (rebind ordering, below)
   *  aside, an entry can also fail replay for the same reasons any statement can — a builtin
   *  it used no longer exists in the target env's toolset, etc.
   *
   *  ORDERING CAVEAT: `entries()` orders a rebound name at its NEWEST position (last-wins,
   *  matching type-hints/context-ring.ts's rule, per this feature's spec). That is the right
   *  fairness rule for a FIFO eviction cap, but it means a statement that read another name's
   *  EARLIER value, where that other name is rebound AFTER, replays AFTER the rebind in
   *  history order — e.g. `(define a 1)`, `(define b (+ a 1))`, `(define a 100)` replays as
   *  `[b, a]` (b moved-past by a's rebind), and `(define b (+ a 1))` throws unbound in a
   *  fresh env because `a` hasn't been (re)established yet at that point in replay. This is
   *  an accepted limitation of reconstructing from a COMPACTED define history (only the
   *  final source per name is kept, not the intermediate one `b` actually depended on) —
   *  the alternative (never compact rebinds) would defeat the compactness goal replay exists
   *  for. Surfaced honestly here, never silently wrong: `b` lands in `failed`, not `applied`. */
  readonly failed: readonly string[];
}

// ─── LocalBindingTracker — per-session LOCAL (non-top-level) binding occurrences ───
// SCOPE-CONFUSION DOOR (docs/working-proposals/manifold-scope-confusion-door.md, doors.ts's
// `scopeConfusionDoor`): a SIBLING store to `SessionHistory` above, tracking a DIFFERENT event —
// not a successful top-level `(define X ...)` (this file's main export), but every symbol bound
// in a NON-top-level lexical scope (a let/let*/letrec/letrec* binding, a lambda parameter, or a
// nested `(define X ...)`) that appeared in ANY submitted program's SOURCE this session,
// regardless of whether that statement itself succeeded — the SYNTAX is the signal ("you've used
// this name locally before"), not the runtime outcome (scope-scan.ts's `scanLocalBindings` is the
// v1 tokenizer-based scan manifold-tool.ts feeds this from every call's raw source). Recorded per
// CALL INDEX (manifold-tool.ts's per-tool call counter) so the door can report "N message(s) ago"
// and detect a REPEATED local-binding STYLE (≥2 occurrences) without forcing the model toward a
// global `(define)` (the spec's "don't force an implementation" special case).
export interface LocalBindingTracker {
  /** Record every locally-bound name this call's submitted program contained, tagged with
   *  `callIndex`. A name already recorded at THIS exact call index is not duplicated — multiple
   *  mentions within one call count as ONE occurrence (the spec's "N prior CALLS", not "N
   *  mentions"). */
  record(names: Iterable<string>, callIndex: number): void;
  /** Every call index (this session, oldest → newest) at which `name` was locally bound, or `[]`
   *  when it never was. */
  occurrences(name: string): readonly number[];
  /** Serialize the store wholesale — session-export primitive (session-store.ts). */
  exportState(): LocalBindingState;
  /** Replace the store wholesale (session restore) — a full rehydration, never a merge. */
  importState(state: LocalBindingState): void;
}

/** {@link LocalBindingTracker.exportState}'s plain-data shape: name → its recorded call
 *  indexes, oldest→newest. */
export type LocalBindingState = readonly (readonly [string, readonly number[]])[];

export function createLocalBindingTracker(): LocalBindingTracker {
  const store = new Map<string, number[]>();
  return {
    record(names, callIndex) {
      for (const name of names) {
        const list = store.get(name);
        if (list === undefined) store.set(name, [callIndex]);
        else if (list.at(-1) !== callIndex) list.push(callIndex);
      }
    },
    occurrences(name) {
      return store.get(name) ?? [];
    },
    exportState() {
      return [...store.entries()].map(([name, indexes]) => [name, [...indexes]]);
    },
    importState(state) {
      store.clear();
      for (const [name, indexes] of state) store.set(name, [...indexes]);
    },
  };
}

/** Reconstructs session state into `env` by replaying a history's non-tool-valued defines,
 *  in order. `env` is typically a FRESH env for the same toolset (e.g. a new
 *  `buildManifoldEnv` call) — replay only rebinds names into it, it never builds tools or
 *  touches the env otherwise. A tool-valued entry is skipped, never executed (it would
 *  re-invoke the tool) and its name is reported in `skipped` so a caller can warn that the
 *  reconstruction is not a complete replica of the original session. A statement that itself
 *  errors on replay (see `ReplayResult.failed`'s ordering caveat) is caught, never thrown —
 *  replay is best-effort and always finishes, reporting exactly what did/didn't land. */
export async function replaySessionHistory(
  entries: readonly SessionHistoryEntry[],
  env: SchemeEnv,
): Promise<ReplayResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const entry of entries) {
    if (entry.toolValued) {
      skipped.push(entry.name);
      continue;
    }
    try {
      await exec(entry.source, { env: env as unknown as ExecEnv });
      applied.push(entry.name);
    } catch {
      failed.push(entry.name);
    }
  }
  return { applied, skipped, failed };
}
