/** Middle-elision knobs for observation array rendering (serializer-elision plan). OPT-IN by
 *  presence — see `ObservationElisionOpts` in `render-observation.ts`, which this mirrors
 *  1:1 (kept as a separate type so mcp-substrate's calibration surface doesn't need to import
 *  render-observation just for this shape). `undefined` fields behave exactly as if the knob
 *  were never set. */
export interface ObservationElisionCalibration {
  maxItems?: number;
  topLevelArrayLimit?: number;
  secondLevelArrayLimit?: number;
  elideHead?: number;
  elideTail?: number;
}

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
  /** Per-STATEMENT allocation bound (the memory analogue of `defaultEvalTimeoutMs` — catches the
   *  native-collection-op runaway the TICK-cadence wall-clock can't preempt). Applies to each
   *  top-level form the runner evaluates individually (arrival-promises completion plan, gap 1;
   *  same per-form LIMIT as the other program-scoped entries — one `RunContext` per statement). */
  heapBudgetPerForm: number;
  /** OPT-IN (see `ObservationElisionCalibration`) — middle-elision knobs for observation array
   *  rendering. Omitted here in `DEFAULT_CALIBRATION`, so every `DoorsRunner` consumer keeps
   *  today's tail-truncation (`+N more of TOTAL`) unchanged unless it explicitly overrides
   *  this field (the manifold does — see arrival-manifold's own calibration wiring). */
  observationElision?: ObservationElisionCalibration;
}

/** Today's hardcoded values, unchanged — the default for every consumer until a calibration
 *  round says otherwise. */
export const DEFAULT_CALIBRATION: CalibrationOptions = {
  futilityRingSize: 6,
  doorsTier3Top: 10,
  responseSizeMinChars: 1000,
  responseSizeMaxChars: 40_000,
  defaultEvalTimeoutMs: 600_000,
  observationMaxTotalChars: 20_000,
  hintRaceBudgetMs: 300,
  heapBudgetPerForm: 100_000_000,
};
