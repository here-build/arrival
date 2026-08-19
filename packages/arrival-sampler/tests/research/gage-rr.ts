// gage-rr.ts — the pure variance-decomposition + pair-separability math behind Stage-0's Gage R&R gauge
// gate. Extracted out of measurement-trust.test.ts so the decomposition is a pure function of the
// per-(scheme, repeat) mean-correctness matrix, unit-testable WITHOUT a model in the default suite.
//
// Gage R&R (measurement-system analysis): fix each part (scheme), re-measure it under independent
// sampling (operator = seeded rng), and decompose the per-scheme mean-correctness variance into
//   • between-scheme variance — the SIGNAL we want the gauge to resolve (spread of scheme means), and
//   • run-to-run variance     — the measurement NOISE (within-scheme spread across repeats).
// %R&R = noise / total. Six-Sigma rule of thumb: <10% good, 10-30% marginal, >30% the gauge cannot
// resolve the differences we chase. (operator = seed, part = scheme.)
//
// Separability rule (the roadmap's escape hatch): when the gauge is irreducibly noisy, only scheme
// rankings separated by MORE than the pooled run-to-run sd are actionable. Two schemes A, B are
// SEPARABLE iff |mean(A) − mean(B)| > pooledRunToRunSd. This function emits both the partition and the
// raw numbers so callers (the harness AND the unit test) read one source of truth.

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const variance = (xs: readonly number[]): number => {
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
};

export interface SchemeStat {
  readonly scheme: string;
  readonly mean: number;
  /** Run-to-run sd of this scheme's per-repeat means (the within-scheme noise). */
  readonly sd: number;
}

export interface SchemePair {
  readonly a: string;
  readonly b: string;
  readonly delta: number; // |mean(a) − mean(b)|
}

export interface GageRR {
  /** Between-scheme variance: spread of the per-scheme means (the signal). */
  readonly betweenVar: number;
  /** Run-to-run variance: mean of each scheme's within-repeat variance (the noise). */
  readonly runToRunVar: number;
  /** %R&R as a variance fraction in [0,1]: runToRunVar / (betweenVar + runToRunVar). */
  readonly percentRR: number;
  /** Pooled run-to-run sd = sqrt(runToRunVar) — the actionability threshold for the escape hatch. */
  readonly pooledRunToRunSd: number;
  readonly perScheme: readonly SchemeStat[];
  /** Pairs whose mean gap EXCEEDS the pooled run-to-run sd → ranking is actionable. */
  readonly separablePairs: readonly SchemePair[];
  /** Pairs inside the run-to-run sd → ranking NOT trustworthy until the gauge tightens. */
  readonly nonSeparablePairs: readonly SchemePair[];
}

/**
 * Decompose a per-(scheme, repeat) correctness matrix into the Gage R&R variance components + the
 * pair-separability partition. `matrix[scheme]` is the vector of that scheme's per-repeat MEAN
 * correctness (one number per repeat). Schemes are kept in insertion order (matches the harness's
 * SCHEMES order) for stable reporting.
 */
export function gageRR(matrix: Record<string, number[]>): GageRR {
  const schemes = Object.keys(matrix);
  if (schemes.length === 0) throw new Error("gageRR: empty matrix");

  const schemeMeans = schemes.map((s) => mean(matrix[s]));
  const betweenVar = variance(schemeMeans); // signal: spread of scheme means
  const runToRunVar = mean(schemes.map((s) => variance(matrix[s]))); // noise: pooled run-to-run
  const totalVar = betweenVar + runToRunVar;
  const percentRR = totalVar === 0 ? 0 : runToRunVar / totalVar;
  const pooledRunToRunSd = Math.sqrt(runToRunVar);

  const perScheme: SchemeStat[] = schemes.map((s) => ({
    scheme: s,
    mean: mean(matrix[s]),
    sd: Math.sqrt(variance(matrix[s])),
  }));

  const separablePairs: SchemePair[] = [];
  const nonSeparablePairs: SchemePair[] = [];
  for (let i = 0; i < schemes.length; i++) {
    for (let j = i + 1; j < schemes.length; j++) {
      const a = schemes[i];
      const b = schemes[j];
      const delta = Math.abs(mean(matrix[a]) - mean(matrix[b]));
      const pair: SchemePair = { a, b, delta };
      if (delta > pooledRunToRunSd) separablePairs.push(pair);
      else nonSeparablePairs.push(pair);
    }
  }

  return {
    betweenVar,
    runToRunVar,
    percentRR,
    pooledRunToRunSd,
    perScheme,
    separablePairs,
    nonSeparablePairs,
  };
}
