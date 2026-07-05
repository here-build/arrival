/** Every numeric constant that today lives hardcoded in competence.ts/futility.ts/doors.ts/
 *  manifold-tool.ts/render-observation.ts/type-hints — injected so a re-tune for a new
 *  model/harness is a config change, never a code fork (the model/harness-agnosticism
 *  constraint, audited: only these numbers carry any overfitting risk — every mechanism itself
 *  keys on Scheme-syntax/arrival-symbol level, never on model/harness identity). */
export interface CalibrationOptions {
  /** competence.ts — rolling-window size for "has the model demonstrated this pattern recently". */
  competenceWindowSize: number;
  /** competence.ts — fraction of the window that must show the pattern before it's "stable". */
  competenceStableThreshold: number;
  /** futility.ts — ring-buffer size for the futile-retry shape detector. */
  futilityRingSize: number;
  /** doors.ts — top-N candidates considered by the did-you-mean distance gate. */
  doorsTier3Top: number;
  /** manifold-tool.ts — clamp floor for the per-call `response-size` override. */
  responseSizeMinChars: number;
  /** manifold-tool.ts — clamp ceiling for the per-call `response-size` override. */
  responseSizeMaxChars: number;
  /** manifold-tool.ts — whole-call wall-clock deadline. */
  defaultEvalTimeoutMs: number;
  /** render-observation.ts — total budget for one rendered result value. */
  observationMaxTotalChars: number;
  /** type-hints/deliver.ts — race budget for one lens run before it's dropped from this call. */
  hintRaceBudgetMs: number;
  /** A/B measurement knob (V's design, 2026-07-06; arrival-serializer's
   *  `SerializeOpts.truncationBanner`, threaded through render-observation.ts): whether the
   *  reduced-output banner (`#| ⚠ output reduced to fit response budget ... |#`, and its
   *  raw-string-shortcut twin) is emitted at all when a call's output gets truncated. The
   *  caps themselves are NEVER affected — "none" only silences the announcement, to measure
   *  whether the banner's mere presence (as opposed to its content) changes model behavior.
   *    - "full" (default) — today's behaviour, banner renders whenever a shrink happened.
   *    - "none" — truncation still happens; the banner line is never emitted, and
   *      `onRemedyRendered` never fires (there's no clause to give feedback about). */
  truncationBanner: "full" | "none";
}

/** Today's hardcoded values, unchanged — the default for every consumer until a calibration
 *  round says otherwise. */
export const DEFAULT_CALIBRATION: CalibrationOptions = {
  competenceWindowSize: 10,
  competenceStableThreshold: 0.7,
  futilityRingSize: 6,
  doorsTier3Top: 10,
  responseSizeMinChars: 1000,
  responseSizeMaxChars: 40_000,
  defaultEvalTimeoutMs: 15_000,
  observationMaxTotalChars: 40_000,
  hintRaceBudgetMs: 300,
  truncationBanner: "full",
};
