/** Every numeric constant that today lives hardcoded in futility.ts/doors.ts/manifold-tool.ts/
 *  render-observation.ts/type-hints — injected so a re-tune for a new model/harness is a config
 *  change, never a code fork (the model/harness-agnosticism constraint, audited: only these
 *  numbers carry any overfitting risk — every mechanism itself keys on Scheme-syntax/
 *  arrival-symbol level, never on model/harness identity). */
export interface CalibrationOptions {
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
