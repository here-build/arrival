// competence — COMPETENCE v2: rolling-window stable-capability gating + per-block banners
// (V's design, 2026-07-05). REPLACES the v1 monotone flags (recordSuccess/collectionProcessing/
// stringProcessing) and manifold-tool.ts's per-message banner dedup (both from commits
// 70df7f6fb3/16c7af68a7).
//
// WHY v1 WAS WRONG: the monotone flag conflated "demonstrated once" with "retained under
// load" — a single successful `map` call suppressed the remedy FOREVER, even if the model
// never used the pattern again. The per-message dedup deleted the FACT half of a repeat-
// shaped banner ("this was reduced, here's the budget") once an identical banner string had
// already appeared once in the same response — a capped statement-2 result then read as
// complete data.
//
// THE NEW CONTRACT (V-pinned, 2026-07-05):
//   1. Every truncated block gets its banner — the FACT (what was reduced + the applied
//      limits) always renders on every capped statement result. Dedup is GONE.
//   2. The remedy clause (the "how to fix this" teaching) ALSO renders on every truncated
//      block, but at a verbose→compact GRADIENT per session: the FIRST time a class's remedy
//      ever renders this world, it's the full teaching sentence; every later rendering is the
//      compact form of the same pattern (arrival-serializer's `RemedyMode`).
//   3. Suppression — dropping the remedy clause entirely, fact still renders — fires only
//      once a class is STABLY demonstrated: a rolling window of the last WINDOW_SIZE manifold
//      *calls* (not statements), where a call counts as "used it" for a class when ≥1
//      successful statement in that call used the class's trigger family. ≥STABLE_THRESHOLD
//      (70%) of the window ⇒ suppressed. Usage dropping back below the threshold
//      un-suppresses (remedy re-emerges — compact, since the "ever rendered" gradient flag
//      from #2 never resets on suppression toggling). A window shorter than WINDOW_SIZE calls
//      never suppresses (stability unproven).
//   4. The two classes (collection, string) are tracked fully independently, per-WORLD
//      lifecycle — same as v1: created fresh per `createManifoldTool` call (manifold-tool.ts),
//      so a tools/listChanged rebuild starts a brand-new tracker alongside the fresh env/
//      history/ring. A new toolset's session starts both the window and the gradient fresh.
//
// DETECTION remains TEXTUAL, unchanged from v1 — matched against a successful statement's
// SOURCE, never the runtime value (there is no cheap general way to tell "this list was
// produced by a filter call" from the value alone, and the source is right there at the call
// site that already knows the statement succeeded). A comment mention (`;; use map here`) is
// NOT excluded — a deliberate non-goal, see the original design note: stripping comments
// before matching would cost real code for a false positive whose only consequence is
// dropping a teaching hint one call earlier than ideal, never a false claim about rendered
// content. Over-flagging is the safe direction, matching this package's other textual
// heuristics (context-ring.ts's TOOL_SYMBOL, session-history.ts's TOOL_SYMBOL).
//
// BOUNDARY MATCHING: not `\b` — scheme identifiers routinely contain `-`/`?`/`!`/`*`, which
// `\b` treats as boundaries themselves, so `\bmap\b` would misfire inside `my-map-thing`.
// Instead a symbol must be flanked by whitespace, a bracket, a quote/quasiquote/unquote
// prefix, or start/end of source — the actual token-separator set for a Scheme reader.

/** Characters (or start-of-source) that can precede a token: whitespace, an opening
 *  bracket, or a quote/quasiquote/unquote/unquote-splicing prefix character. */
const BEFORE = String.raw`(?:^|[\s()\[\]{}'\`,])`;
/** Characters (or end-of-source) that can follow a token: whitespace or a closing bracket. */
const AFTER = String.raw`(?:$|[\s()\[\]{}])`;

/** Exact bound scheme symbol names demonstrating collection processing — the map/filter/
 *  reduce/fold family named in V's spec. (`fold`/`fold-left` are not currently bound
 *  builtins in foundations/arrival/arrival/src/env — only `reduce`/`fold-right`/
 *  `reduce-right` are — but are kept per spec: harmless if never matched, and forward-
 *  compatible with a future prelude that adds them.) */
const COLLECTION_SYMBOLS = ["map", "filter", "reduce", "fold", "fold-left", "fold-right", "filterv", "mapv"];

/** The string-* family (every bound `string-...` procedure: append, split, downcase,
 *  upcase, contains, trim, pad, join, ...) plus `substring` itself — the one string
 *  procedure the spec names without the `string-` prefix. */
const STRING_TRIGGER_BODY = String.raw`string-[\w?!*<>=]+|substring`;

// The escapes the next two lines get flagged for (regexp/no-useless-escape) live in BEFORE's
// own `String.raw` template literal (above): the backtick escape is required by TEMPLATE
// LITERAL syntax (this string is itself delimited by backticks), not by the regex; removing
// it would terminate the template early. The plugin attributes the finding to these
// constant-folded `new RegExp(...)` call sites rather than BEFORE's own definition.
// eslint-disable-next-line regexp/no-useless-escape
const COLLECTION_TRIGGER = new RegExp(`${BEFORE}(?:${COLLECTION_SYMBOLS.join("|")})${AFTER}`);
// eslint-disable-next-line regexp/no-useless-escape
const STRING_TRIGGER = new RegExp(`${BEFORE}(?:${STRING_TRIGGER_BODY})${AFTER}`);

/** The two independently-tracked trigger families. */
export type TriggerClass = "collection" | "string";

/** Remedy-clause rendering mode for a class, mirrored by arrival-serializer's own remedy-mode
 *  options on `SerializeOpts` (serializer.ts) — declared separately here (not imported)
 *  because arrival-manifold's typecheck resolves the serializer package via its PUBLISHED
 *  dist, which may not yet export this type even though its src does (the same dist-drift
 *  render-observation.ts already tolerates for the serializer's `format` seam). Structurally
 *  identical string union, so passing one where the other is expected is always safe. */
export type RemedyMode = "verbose" | "compact" | "suppressed";

/** Rolling window length (manifold *calls*, not statements) the stability gate looks back
 *  over. Below this many recorded calls, stability is unproven — never suppressed.
 *
 *  Exported ONLY so a drift-guard test (calibration-constants.test.ts) can pin its literal
 *  value — this is exactly the kind of model/harness-calibration constant Round 1 of
 *  docs/working-proposals/arrival-manifold-package-split-2026-07-05.md flags for becoming an
 *  injected runner option (with today's value as the default) once the doors-steering-runner
 *  extraction happens. Exporting it does not itself make it configurable — it only makes
 *  today's value observable, so a future re-tune is a visible diff, not a silent one. */
export const WINDOW_SIZE = 10;

/** Fraction of the window that must have used a class's trigger family for that class to be
 *  considered STABLY demonstrated (suppressible). ≥7 of the last 10 calls. Exported for the
 *  same drift-guard reason as {@link WINDOW_SIZE}. */
export const STABLE_THRESHOLD = 0.7;

export interface CompetenceTracker {
  /** Scan a statement's SOURCE for each class's trigger family. Call this for every
   *  statement that evaluated SUCCESSFULLY — never for one that threw (a failed attempt is
   *  not demonstrated competence) — and fold the per-statement results (OR across the
   *  call's statements) into the two booleans passed to {@link recordCall} once the whole
   *  call settles. Pure — has no side effect on the tracker's own state. */
  scanSuccess(source: string): { collection: boolean; string: boolean };
  /** Record ONE manifold call's outcome into the rolling window: did ANY successful
   *  statement in that call use the collection / string trigger family? Call exactly once
   *  per call that reaches this point (including an all-failed call, which still counts as
   *  one call in the window, contributing `false` for both classes — see manifold-tool.ts's
   *  call site for which early-return paths are deliberately excluded). */
  recordCall(usedCollection: boolean, usedString: boolean): void;
  /** The mode `cls`'s remedy clause should render at RIGHT NOW — read at render time, BEFORE
   *  knowing whether this particular render will actually cap (that's the serializer's own
   *  concern; see `markRendered` below for the feedback loop). "suppressed" when the class is
   *  stably demonstrated (the rolling-window gate); otherwise "compact" once this class's
   *  remedy has rendered at least once this world, "verbose" the first time. */
  remedyMode(cls: TriggerClass): RemedyMode;
  /** Feedback from a render that ACTUALLY included `cls`'s remedy clause (it capped, and
   *  {@link remedyMode} wasn't "suppressed") — flips the class from verbose to compact for
   *  every later rendering this world. Idempotent: a no-op once already flipped. Never call
   *  this for a class whose remedy did NOT render (nothing was taught, nothing to compact). */
  markRendered(cls: TriggerClass): void;
  /** Serialize the tracker's FULL state (rolling window + gradient flags) — the doors-runner
   *  session-export primitive (session-store.ts's `AsyncSessionStore`, mcp-substrate's
   *  `DoorsRunner.exportSession`). Plain data, JSON-round-trippable. */
  exportState(): CompetenceState;
  /** Replace the tracker's state wholesale (session restore). Never merges with the current
   *  state — a restore is a full rehydration, matching every other teaching-state store's
   *  restore contract (session-history's replay, DoorSession's importState). */
  importState(state: CompetenceState): void;
}

/** {@link CompetenceTracker.exportState}'s plain-data shape — the rolling window (oldest→newest)
 *  and the per-class verbose→compact gradient flags. */
export interface CompetenceState {
  usageWindow: readonly { collection: boolean; string: boolean }[];
  everRendered: Record<TriggerClass, boolean>;
}

/** `windowSize`/`stableThreshold` — the calibration seam (calibration.ts's
 *  `competenceWindowSize`/`competenceStableThreshold`): a re-tune is an injected option, never a
 *  code fork. Defaults to {@link WINDOW_SIZE}/{@link STABLE_THRESHOLD} — today's values, unchanged
 *  for every caller that doesn't pass an override. */
export function createCompetenceTracker(
  windowSize: number = WINDOW_SIZE,
  stableThreshold: number = STABLE_THRESHOLD,
): CompetenceTracker {
  // The rolling window: one entry per recorded CALL (not per statement), oldest evicted once
  // the window exceeds windowSize. A plain array + shift is O(windowSize) per call —
  // trivial at this size, and simpler than a ring-buffer index.
  let usageWindow: { collection: boolean; string: boolean }[] = [];
  // Per-class "has this class's remedy ever rendered (in any mode) this world" — the
  // verbose→compact gradient flag. Independent of the window/suppression state: it never
  // resets when suppression toggles on or off, only on a fresh tracker (world rebuild).
  let everRendered: Record<TriggerClass, boolean> = { collection: false, string: false };

  function usageFraction(cls: TriggerClass): number | undefined {
    if (usageWindow.length < windowSize) return undefined; // stability unproven
    const used = usageWindow.filter((entry) => entry[cls]).length;
    return used / usageWindow.length;
  }

  function isStable(cls: TriggerClass): boolean {
    const fraction = usageFraction(cls);
    return fraction !== undefined && fraction >= stableThreshold;
  }

  return {
    scanSuccess(source) {
      return {
        collection: COLLECTION_TRIGGER.test(source),
        string: STRING_TRIGGER.test(source),
      };
    },
    recordCall(usedCollection, usedString) {
      usageWindow.push({ collection: usedCollection, string: usedString });
      if (usageWindow.length > windowSize) usageWindow.shift();
    },
    remedyMode(cls) {
      if (isStable(cls)) return "suppressed";
      return everRendered[cls] ? "compact" : "verbose";
    },
    markRendered(cls) {
      everRendered[cls] = true;
    },
    exportState() {
      return { usageWindow: [...usageWindow], everRendered: { ...everRendered } };
    },
    importState(state) {
      usageWindow = [...state.usageWindow];
      everRendered = { ...state.everRendered };
    },
  };
}
