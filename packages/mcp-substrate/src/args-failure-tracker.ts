// args-failure-tracker — escalation state for the localized args-misuse door
// (second-foundation/arrival-manifold/docs/args-error-reporting-v2.md §2.4). A deliberate
// SIBLING of `FutilityTracker` (futility.ts) — same injection pattern, same export/import
// discipline for session round-trips — but the INVERSE gradient: futility's `seen` set is
// monotonic verbose-once-then-terse (repetition earns LESS teaching); this tracker's counter
// is monotonic terse-then-verbose (repetition earns MORE teaching, up to the L3 anti-guess
// script). Mixing the two state machines would corrupt both contracts, hence a separate file
// (design doc §2.4's "NOT in DoorSession" decision) rather than a shared class.
//
// NOT unified with FutilityTracker (design doc §2.4 open question 2, deliberately deferred):
// futility watches SUCCESSFUL non-progress, this watches FAILURES — different reset triggers.

/** Serialized tracker state — session-store round-trip shape (mirrors `FutilityTracker`'s own
 *  `exportState`/`importState` precedent, additive `argsFailures` key on the SessionBlob). */
export interface ArgsFailureState {
  /** `[key, count]` pairs — `key` per {@link trackerKey}. */
  entries: ReadonlyArray<readonly [string, number]>;
}

/** Composite key for one (tool, param) counter: `${qualifiedName} ${paramPathJoined}`, with
 *  `"⊥"` standing in for an UNLOCALIZED misuse (design doc §2.4: "the ⊥ key escalates too" —
 *  Level ⊥'s eventual "show everything" backstop needs its own counter, same monotone rule as
 *  a named param). A multi-segment path joins on `.` — the same dotted-path convention the
 *  own-decode humanizer's per-issue lines use (design doc §2.5). Space-joining `qualifiedName`
 *  and the param segment is safe: neither a qualified tool name (`slug/tool`) nor a JSON
 *  Schema property name can contain a literal space in this codebase's naming space. */
function trackerKey(qualifiedName: string, paramPath: readonly string[] | undefined): string {
  const paramPathJoined = paramPath && paramPath.length > 0 ? paramPath.join(".") : "⊥";
  return `${qualifiedName} ${paramPathJoined}`;
}

/** The escalation level a rendered door shows — capped at 3 (design doc §2.3 Levels 1-3; a
 *  4th-and-later consecutive failure keeps rendering the L3 anti-guess script, never a L4). */
export type ArgsFailureLevel = 1 | 2 | 3;

const MAX_LEVEL: ArgsFailureLevel = 3;

/** Per-(tool,param) consecutive-misuse-failure counters, capped at {@link MAX_LEVEL}. */
export class ArgsFailureTracker {
  private readonly byToolParam = new Map<string, number>();

  /** Record one misuse failure for `(qualifiedName, paramPath)`; returns the level to render.
   *  Monotone 1→2→3, then holds at 3 (never a hash-dedup gate, unlike futility's
   *  `firedFutileHash` — design doc §2.4: "count identical retries too… 34 near-identical
   *  retries is exactly the case escalation exists for"). `paramPath` absent ⇒ the `⊥` key. */
  recordFailure(qualifiedName: string, paramPath: readonly string[] | undefined): ArgsFailureLevel {
    const key = trackerKey(qualifiedName, paramPath);
    const level = Math.min((this.byToolParam.get(key) ?? 0) + 1, MAX_LEVEL) as ArgsFailureLevel;
    this.byToolParam.set(key, level);
    return level;
  }

  /** A SUCCESSFUL call of `qualifiedName` clears every one of ITS param counters (including its
   *  `⊥` counter) — the model has a working shape now; the next failure on this tool starts a
   *  fresh L1 lesson. Never touches a DIFFERENT tool's counters. Prefix-matched on
   *  `${qualifiedName} ` (the key format's own separator), safe because neither a qualified
   *  tool name nor a param-path segment can contain a literal space (see {@link trackerKey}). */
  recordSuccess(qualifiedName: string): void {
    const prefix = `${qualifiedName} `;
    for (const key of this.byToolParam.keys()) {
      if (key.startsWith(prefix)) this.byToolParam.delete(key);
    }
  }

  /** Serialize every counter — session-store round-trip primitive (session-store.ts / the
   *  SessionBlob's additive `argsFailures` key, design doc §2.4). */
  exportState(): ArgsFailureState {
    return { entries: [...this.byToolParam.entries()] };
  }

  /** Replace the tracker's state WHOLESALE (a full rehydration, never a merge) — mirrors
   *  `DoorSession.importState`'s identical contract in doors.ts. An absent/empty `entries`
   *  (an old SessionBlob predating this key) restores an empty tracker, never an error — the
   *  additive-key tolerance design doc §2.4 requires. */
  importState(state: ArgsFailureState): void {
    this.byToolParam.clear();
    for (const [key, count] of state.entries) this.byToolParam.set(key, count);
  }
}
