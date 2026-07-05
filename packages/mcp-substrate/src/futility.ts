// futility — the FUTILITY DOOR's engine (the door itself is in doors.ts). Measured problem:
// a model retries a degraded upstream tool many times (a search tool returning the identical
// "no results / bot detection" body under varied queries), burning the whole turn budget and
// ending with no answer. Nothing tells it to stop digging. This tracker does — shape-based,
// semantics-free, per manifold-server session.
//
// It watches, per QUALIFIED TOOL SYMBOL, a small ring buffer of {argsHash, resultHash} for that
// tool's upstream calls (recorded at the membrane, bind.ts, where name+args+result are all
// visible). resultHash is over the NORMALIZED result text (normalizeResultText below) so
// "retry in 3 minutes" and "retry in 5 minutes" collapse to one hash. Two triggers queue a door;
// manifold-tool.ts drains the queue at the end of a call and appends each as an advisory `Note:`
// block. The tracker NEVER touches the tool's actual result value — that already flowed into
// scheme dataflow untouched; the door is pure advice.

import { duplicateCallDoor, type Door, futileRetryDoor } from "./doors.js";

/** Ring-buffer depth per tool. ~6 is enough to see the "last 3 identical" window plus a couple of
 *  distinct-result calls before/after, and keeps per-session memory trivially bounded.
 *
 *  Exported ONLY so a drift-guard test (calibration-constants.test.ts) can pin its literal value
 *  — see competence.ts's {@link WINDOW_SIZE} doc comment for why: this is a calibration constant
 *  the migration's Round 1 flags for eventually becoming an injected option, and exporting it now
 *  makes today's value observable without changing any behavior. */
export const RING_SIZE = 6;

/** Canonical-UUID and long-hex/hash runs: stripped WHOLE (a request id, session token, git sha,
 *  md5) so two otherwise-identical bodies differing only by such a token hash the same. Length ≥12
 *  keeps it clear of English words (a 12-letter all-hex word is essentially impossible). */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const HEX_RUN = /[0-9a-f]{12,}/g;
const DIGIT_RUN = /\d+/g;
const WHITESPACE = /\s+/g;

/** Normalize a result's rawest text to a shape-only key: lowercase, strip UUIDs / long hex runs /
 *  digit runs (so timestamps, "retry in N minutes", request ids all wash out), collapse
 *  whitespace. Two results that differ only in such volatile tokens normalize identically — the
 *  point: detect a tool that is returning the SAME SHAPE of answer regardless of input. */
export function normalizeResultText(raw: string): string {
  return raw
    .toLowerCase()
    .replaceAll(UUID, "")
    .replaceAll(HEX_RUN, "")
    .replaceAll(DIGIT_RUN, "")
    .replaceAll(WHITESPACE, " ")
    .trim();
}

/** FNV-1a over a string → a compact base-36 tag. Only equality matters here (no crypto), so a fast
 *  32-bit hash keeps ring entries tiny while collisions are astronomically unlikely to matter for
 *  a per-session window of a handful of calls. */
function hashString(s: string): string {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < s.length; i++) {
    // Pre-existing FNV-1a body, a pure relocation from arrival-manifold/src/futility.ts. FNV-1a
    // is defined over UTF-16 code units here (not code points), and codePointAt would silently
    // change the hash for astral-plane input — only equality matters (see this function's doc
    // comment), never a specific value.
    // eslint-disable-next-line unicorn/prefer-code-point
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(36);
}

/** Stable JSON of the call args (sorted keys) so `{a,b}` and `{b,a}` hash the same. The membrane
 *  builds args by iterating the tool's fixed param order, so this is already deterministic per
 *  tool; the sort is belt-and-braces. A value that will not stringify falls back to String(). */
function argsKey(args: Record<string, unknown>): string {
  try {
    // Pre-existing key-sort, a pure relocation from arrival-manifold/src/futility.ts. The
    // contract is only "the same arg set always sorts the same way" (a stable hash key), not a
    // specific locale-aware ordering, and `sort()`'s in-place mutation is discarded immediately
    // (a fresh array from `Object.keys`) — swapping to `toSorted`/`localeCompare` risks a
    // hash-value drift for non-ASCII property names with no behavioral upside.
    // eslint-disable-next-line unicorn/no-array-sort, sonarjs/no-alphabetical-sort
    return JSON.stringify(args, Object.keys(args).sort());
  } catch {
    return String(args);
  }
}

/** The rawest text form of an upstream result. bind.ts sees the value AFTER unwrapToolResult, so a
 *  bare string stays as-is (the most common degraded-body shape) and everything else is
 *  JSON.stringify'd; an unstringifiable/undefined value falls back to String(). */
function resultText(rawResult: unknown): string {
  if (typeof rawResult === "string") return rawResult;
  try {
    return JSON.stringify(rawResult) ?? String(rawResult);
  } catch {
    return String(rawResult);
  }
}

export interface RingEntry {
  argsHash: string;
  resultHash: string;
}

export interface ToolState {
  ring: RingEntry[];
  /** The result hash of the previous record — a change RESETS the re-fire gate (a tool that
   *  recovered, then degrades again, may fire once more). */
  lastResultHash?: string;
  /** The result hash each trigger last fired on, so an unchanged run does not re-fire (no door
   *  spam on the 4th/5th identical call — the terse repeat rides DoorSession's verbosity gate). */
  firedFutileHash?: string;
  firedDuplicateHash?: string;
}

/** {@link FutilityTracker.exportState}'s plain-data shape — every tool's ring state, keyed by
 *  qualified tool name. Pending (not-yet-drained) doors are deliberately NOT included: they are
 *  per-call, in-flight advisory notes, not session-lived teaching state (matching the "drain
 *  before the call returns" contract every real caller already honors). */
export type FutilityState = readonly (readonly [string, ToolState])[];

/** A door queued for the current manifold call, tagged with the tool it concerns (for renderNote's
 *  telemetry line). */
export interface PendingDoor {
  tool: string;
  door: Door;
}

/** One tracker per manifold-server process (server.ts builds it once and threads it into BOTH the
 *  membrane env — bind.ts, the record site — and the tool options — manifold-tool.ts, the drain
 *  site). It survives tools/listChanged rebuilds, like DoorSession. */
export class FutilityTracker {
  private readonly byTool = new Map<string, ToolState>();
  private readonly pending: PendingDoor[] = [];

  /** `ringSize` — the calibration seam (calibration.ts's `futilityRingSize`): a re-tune is an
   *  injected constructor option, never a code fork. Defaults to {@link RING_SIZE} — today's
   *  value, unchanged for every caller that doesn't pass an override. */
  constructor(private readonly ringSize: number = RING_SIZE) {}

  /** Record one successful upstream call. Called at the membrane AFTER the result is in hand and
   *  BEFORE it is returned — recording never modifies or delays the value. Evaluates the two
   *  triggers and queues at most one door for this record (futility subsumes a bare duplicate). */
  record(qualifiedName: string, args: Record<string, unknown>, rawResult: unknown): void {
    const resultHash = hashString(normalizeResultText(resultText(rawResult)));
    const argsHash = hashString(argsKey(args));
    const state = this.byTool.get(qualifiedName) ?? { ring: [] };
    this.byTool.set(qualifiedName, state);

    // The buffer's contents changed to a different result → clear the re-fire gate.
    if (state.lastResultHash !== undefined && state.lastResultHash !== resultHash) {
      state.firedFutileHash = undefined;
      state.firedDuplicateHash = undefined;
    }
    state.lastResultHash = resultHash;

    state.ring.push({ argsHash, resultHash });
    if (state.ring.length > this.ringSize) state.ring.shift();

    const n = state.ring.length;

    // TRIGGER 1 — degraded tool: the last 3 results are hash-identical while ≥2 DISTINCT argsHashes
    // appear among them (the tool is insensitive to input). Fires at most once per identical run.
    if (n >= 3) {
      const last3 = state.ring.slice(-3);
      const sameResult = last3.every((e) => e.resultHash === resultHash);
      const distinctArgs = new Set(last3.map((e) => e.argsHash)).size;
      if (sameResult && distinctArgs >= 2 && state.firedFutileHash !== resultHash) {
        state.firedFutileHash = resultHash;
        this.pending.push({ tool: qualifiedName, door: futileRetryDoor(qualifiedName) });
        return; // one door per record — the stronger degraded-tool signal wins over a bare repeat
      }
    }

    // TRIGGER 2 — pure repeat: the last 2 calls share BOTH argsHash and resultHash. Fires at most
    // once per identical run (needs only 1 distinct argsHash, so a constant tool hit with the SAME
    // args fires THIS but never trigger 1).
    if (n >= 2) {
      const [a, b] = state.ring.slice(-2);
      if (a!.argsHash === b!.argsHash && a!.resultHash === b!.resultHash && state.firedDuplicateHash !== resultHash) {
        state.firedDuplicateHash = resultHash;
        this.pending.push({ tool: qualifiedName, door: duplicateCallDoor(qualifiedName) });
      }
    }
  }

  /** Drain the doors queued since the last drain (one manifold call's worth). Empties the queue. */
  drainPending(): PendingDoor[] {
    return this.pending.splice(0);
  }

  /** Serialize every tool's ring state — session-export primitive (session-store.ts). Pending
   *  (undrained) doors are deliberately excluded — see {@link FutilityState}'s doc. */
  exportState(): FutilityState {
    return [...this.byTool.entries()].map(([name, state]) => [name, { ...state, ring: [...state.ring] }]);
  }

  /** Replace the tracker's per-tool ring state wholesale (session restore) — a full rehydration,
   *  never a merge. Pending doors are untouched (there is nothing to restore for them). */
  importState(state: FutilityState): void {
    this.byTool.clear();
    for (const [name, toolState] of state) this.byTool.set(name, { ...toolState, ring: [...toolState.ring] });
  }
}
