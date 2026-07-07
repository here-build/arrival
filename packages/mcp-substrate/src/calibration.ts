/** Tunable numeric constants for the teaching apparatus.
 *
 *  These are the only values with model/harness-specific risk. All mechanisms are driven by
 *  Scheme syntax and arrival-level rules. */
export interface CalibrationOptions {
  /** Ring buffer size for futility detection. */
  futilityRingSize: number;
  /** Top-N candidates for did-you-mean in unbound tool resolution. */
  doorsTier3Top: number;
  /** Clamp bounds for per-call response size. */
  responseSizeMinChars: number;
  responseSizeMaxChars: number;
  /** Whole-call evaluation timeout. */
  defaultEvalTimeoutMs: number;
  /** Character budget for a single rendered observation. */
  observationMaxTotalChars: number;
  /** Time budget for a type-hint lens run. */
  hintRaceBudgetMs: number;
}

/** Today's hardcoded values, unchanged — the default for every consumer until a calibration
 *  round says otherwise. */
export const DEFAULT_CALIBRATION: CalibrationOptions = {
  futilityRingSize: 6,
  doorsTier3Top: 10,
  responseSizeMinChars: 1000,
  responseSizeMaxChars: 40_000,
  defaultEvalTimeoutMs: 15_000,
  observationMaxTotalChars: 20_000,
  hintRaceBudgetMs: 300,
};
