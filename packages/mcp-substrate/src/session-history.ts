// session-history — SESSION DECLARATION PERSISTENCE, the REPLAY model (V's design,
// 2026-07-04). CORRECTNESS of cross-call `(define ...)` persistence needs no code here:
// manifold-tool.ts's `call()` closes over ONE live `SchemeEnv` instance for the tool's
// whole lifetime, and server.ts constructs exactly one ManifoldTool per "world", reused
// across every CallTool until a tools/listChanged rebuild swaps in a fresh world (see
// server.ts's design note + src/__tests__/list-changed.test.ts, and the direct proof in
// src/__tests__/session-declaration-persistence.test.ts). Mechanism (a), already in place.
//
// This module exists for RESUMABILITY instead: V's requirement is that session state be
// RECONSTRUCTABLE from a replay of only the top-level `(define ...)` SOURCE statements
// that evaluated successfully — not by requiring the full live env to stay resident. A
// history serializes to a few KB of scheme source and can be handed to a fresh env (a new
// process, a migrated session, a persisted-and-resumed conversation); a live `Environment`
// instance cannot be serialized at all.
//
// SIBLING, NOT A DUPLICATE, of type-hints/context-ring.ts: that ring tracks the identical
// "successful top-level define" event, but for a different consumer (feeding a TS-checker
// context region) and with different storage semantics — it DEGRADES a tool-valued define
// to `declare const x: unknown` AT INSERTION, which is the right shape for type inference
// but is not valid Scheme and could never be replayed. This module keeps the ORIGINAL
// source and defers the tool-valued decision to replay time (see below). The two rings are
// deliberately separate stores: `ContextRing` (type-hints/types.ts) is a frozen contract
// this feature has no license to bend, and the two consumers genuinely want different data
// projected from the same event.
//
// TOOL-VALUED DEFINES (`(define x (some_tool ...))`) — replaying the statement verbatim
// would RE-INVOKE the tool. Chosen handling: SKIP-AND-NOTE, matching V's compactness goal:
//   • no snapshotted value bloats the history (a tool result is frequently unserializable —
//     an opaque host resource, a closure, a handle tied to this process);
//   • re-invoking on every reconstruction would silently repeat a side effect the original
//     call may not be safe (or cheap, or idempotent) to repeat, and the invoked tool might
//     not even be reachable from the reconstructing world.
// Tradeoff: a statement that reads a skipped tool-valued name resolves as an ordinary
// unbound-variable error in the reconstructed env — exactly as if the caller never
// (re)defined it there. `replaySessionHistory`'s `skipped` list is exactly the set a caller
// should advise about before trusting a reconstruction is complete.

import { exec, type SchemeEnv } from "@here.build/arrival";

/** `exec`'s `env` option is typed against arrival's concrete (unexported) `Environment`
 *  class; `SchemeEnv` is the public structural contract it implements. Same widen-then-
 *  narrow cast as manifold-tool.ts / bind.test.ts. */
type ExecEnv = NonNullable<Parameters<typeof exec>[1]>["env"];

/** A qualified tool symbol anywhere in the form — the same textual detection rule as
 *  type-hints/context-ring.ts's `TOOL_SYMBOL` (kept as a sibling constant rather than a
 *  shared import: this module intentionally does not reach into that frozen contract's
 *  implementation file).
 *
 *  Detects an `_`-joined shape — today's real qualified-name join character (bind.ts). A
 *  legacy `/`-joined attempt is NOT matched here (deliberately): a `/`-joined call can no
 *  longer resolve to a bound symbol at all post-flip, so it never reaches `push()` in the
 *  first place (only a define whose OWN evaluation SUCCEEDED is ever pushed — see this
 *  module's `push()` contract) — there is no genuine tool call this regex could still be
 *  missing by dropping `/`.
 *
 *  Unlike `/` (never legal inside an ordinary identifier), `_` is a common word separator
 *  this dialect's OWN library/SRFI symbols never use (they are consistently kebab-case — see
 *  catalog.ts's preamble) but a bound tool's bare name often does (`search_museum_objects`) —
 *  so this is deliberately NOT trying to precisely recognize "a real bound tool call" (that
 *  would need the live toolset, which this module never has); it recognizes "looks like it
 *  MIGHT be one". Over-flagging is the safe direction — worst case a plain define that merely
 *  CONTAINS an underscored literal (an ordinary `my_variable`) is skipped from replay, never
 *  the reverse.
 *
 *  ★ BLIND SPOT found + closed 2026-07-05: this assumes EVERY qualified tool name contains
 *  `_` — false for a SLUGLESS single-server binding (bind.ts: `qualifiedName = server.slug
 *  === "" ? tool.name : ...`, "the natural single-server shape") whose tool's own bare name
 *  has no underscore either (a real tool literally named `price`, `click`, `search`, ...).
 *  `(define p (price ...))` then matches NEITHER `_` nor anything else here, so `toolValued`
 *  came out `false` — the OPPOSITE of "over-flagging is the safe direction": replay actually
 *  RE-INVOKES the tool, verified directly (a fresh env's replay bumped a probe tool's
 *  invocation counter from 1 to 2), the exact side-effect repetition this module exists to
 *  prevent. `createSessionHistory`'s optional `knownToolNames` closes this — see
 *  `knownToolPattern` below, which needs no `_` assumption at all because it matches the
 *  REAL roster, not a shape guess. Omitted (or empty — e.g. a hand-rolled test env with no
 *  roster to offer) ⇒ this regex alone, unchanged from before. */
// Flagged by sonarjs/slow-regex: bounded input (one statement's source text, never
// attacker-scaled beyond what the manifold call itself already caps); over-flagging (never
// re-invoking a tool) is the accepted tradeoff this file's header documents at length.
// eslint-disable-next-line sonarjs/slow-regex
const TOOL_SYMBOL = /[A-Z][\w.-]*_[\w.-]+/i;

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
 *  when the caller has one — closes `TOOL_SYMBOL`'s underscore-blind-spot (see its doc above)
 *  without weakening the existing shape heuristic (both checks OR together; either one seeing
 *  a tool reference is enough). Optional and defaulted to empty so every existing direct
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
