// ab-stats.ts — the significance layer for naming-scheme A/B comparisons.
//
// WHY THIS EXISTS: with ~14-50 tasks and a noisy per-task correctness/calibration metric, "scheme B
// scored higher than A" is almost never enough to claim B is really better — the difference is
// routinely inside the noise. The metrology research (2026-06-18) is explicit: declare a winner only
// under a DOUBLE-GATE — a paired bootstrap confidence interval whose relevant bound clears zero AND a
// permutation test below alpha. This module is that gate, and nothing else trusts a comparison without
// going through it.
//
// The design is PAIRED throughout: A and B are scored on the SAME tasks, so we compare per-task DELTAS
// (b_i - a_i). Pairing removes task-difficulty variance for free — the single cheapest sensitivity win
// at our tiny n. Everything here is a pure function of the two score vectors; randomness is from a
// SEEDED PRNG so a verdict is reproducible (and unit-testable).
//
// References: BCa bootstrap (Efron); sign-flip permutation test; "When +1% Is Not Enough"
// (arXiv:2511.19794) for the double-gate framing.

import { mulberry32 } from "../../src/rng.js";

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Standard normal CDF via the Abramowitz-Stegun erf approximation (|error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.231_641_9 * Math.abs(z));
  const d = 0.398_942_280_401_432_7 * Math.exp(-(z * z) / 2);
  const p =
    d * t * (0.319_381_53 + t * (-0.356_563_782 + t * (1.781_477_937 + t * (-1.821_255_978 + t * 1.330_274_429))));
  return z >= 0 ? 1 - p : p;
}

/** Inverse standard normal CDF (Acklam's rational approximation). Clamped to avoid ±Infinity. */
export function normalInv(p: number): number {
  const pp = Math.min(1 - 1e-9, Math.max(1e-9, p));
  const a = [
    -39.696_830_286_653_8, 220.946_098_424_521, -275.928_510_446_969, 138.357_751_867_269, -30.664_798_066_147_2,
    2.506_628_277_459_24,
  ];
  const b = [
    -54.476_098_798_224_1, 161.585_836_858_041, -155.698_979_859_887, 66.801_311_887_719_7, -13.280_681_552_885_7,
  ];
  const c = [
    -0.007_784_894_002_430_29, -0.322_396_458_041_136, -2.400_758_277_161_84, -2.549_732_539_343_73,
    4.374_664_141_464_97, 2.938_163_982_698_78,
  ];
  const d = [0.007_784_695_709_041_46, 0.322_467_129_070_04, 2.445_134_137_143, 3.754_408_661_907_42];
  const plow = 0.024_25;
  const phigh = 1 - plow;
  let q: number, r: number;
  if (pp < plow) {
    q = Math.sqrt(-2 * Math.log(pp));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (pp <= phigh) {
    q = pp - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - pp));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

const percentile = (sorted: readonly number[], q: number): number => {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
};

export interface CI {
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
}

/** BCa (bias-corrected and accelerated) bootstrap CI on the MEAN of `deltas`. Degenerate (zero-variance)
 *  input short-circuits to a point interval — the correct answer for an A/A comparison of a deterministic
 *  metric, where every per-task delta is exactly 0. */
export function bcaInterval(
  deltas: readonly number[],
  opts: { resamples?: number; alpha?: number; rng?: () => number } = {},
): CI {
  const { resamples = 10_000, alpha = 0.05, rng = mulberry32(0x5e_ed) } = opts;
  const n = deltas.length;
  const observed = mean(deltas);
  const variance = mean(deltas.map((d) => (d - observed) ** 2));
  if (variance < 1e-12) return { point: observed, lower: observed, upper: observed };

  const boots: number[] = Array.from({ length: resamples }, () => 0);
  for (let b = 0; b < resamples; b++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += deltas[Math.floor(rng() * n)];
    boots[b] = acc / n;
  }
  boots.sort((x, y) => x - y);

  // Bias correction z0 from the fraction of bootstrap means below the observed mean.
  const below = boots.filter((x) => x < observed).length;
  const z0 = normalInv(Math.min(1 - 0.5 / resamples, Math.max(0.5 / resamples, below / resamples)));

  // Acceleration a from the jackknife skew.
  const jk: number[] = Array.from({ length: n }, () => 0);
  const total = deltas.reduce((s, x) => s + x, 0);
  for (let i = 0; i < n; i++) jk[i] = (total - deltas[i]) / (n - 1);
  const jbar = mean(jk);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const diff = jbar - jk[i];
    num += diff ** 3;
    den += diff ** 2;
  }
  const a = den === 0 ? 0 : num / (6 * Math.pow(den, 1.5));

  const adjust = (zAlpha: number): number => {
    const denom = 1 - a * (z0 + zAlpha);
    return normalCdf(z0 + (z0 + zAlpha) / (denom === 0 ? 1e-9 : denom));
  };
  const lo = adjust(normalInv(alpha / 2));
  const hi = adjust(normalInv(1 - alpha / 2));
  return { point: observed, lower: percentile(boots, lo), upper: percentile(boots, hi) };
}

/** Two-sided sign-flip permutation p-value for H0: mean(deltas) = 0. Under H0 each paired delta's sign
 *  is exchangeable, so we randomly negate each and count how often |permuted mean| >= |observed mean|.
 *  The +1 smoothing keeps p in (0,1]. For zero-variance input (A/A) every permutation reproduces the
 *  observed mean, giving p = 1 — correctly "not significant". */
export function permutationP(deltas: readonly number[], opts: { iters?: number; rng?: () => number } = {}): number {
  const { iters = 10_000, rng = mulberry32(0x13_57) } = opts;
  const observed = Math.abs(mean(deltas));
  const n = deltas.length;
  let atLeast = 0;
  for (let it = 0; it < iters; it++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += rng() < 0.5 ? -deltas[i] : deltas[i];
    if (Math.abs(acc / n) >= observed - 1e-12) atLeast++;
  }
  return (atLeast + 1) / (iters + 1);
}

export interface ABVerdict {
  readonly n: number;
  readonly meanA: number;
  readonly meanB: number;
  readonly meanDelta: number; // mean(b_i - a_i)
  readonly ci: CI; // BCa CI on the per-task delta
  readonly p: number; // permutation p-value
  readonly winner: "B" | "A" | "inconclusive";
  /** The double-gate: a direction wins iff its CI bound clears 0 AND the permutation p < alpha. */
  readonly significant: boolean;
}

/** Paired A/B verdict over two per-task score vectors (higher = better). The double-gate is deliberately
 *  strict: B beats A only if the delta CI's LOWER bound > 0 and p < alpha (symmetric for A). Anything
 *  else is inconclusive — the honest answer at small n, not a coin-flip. */
export function abVerdict(
  scoresA: readonly number[],
  scoresB: readonly number[],
  opts: { alpha?: number; resamples?: number; iters?: number; seed?: number } = {},
): ABVerdict {
  if (scoresA.length !== scoresB.length) throw new Error("abVerdict: paired vectors must be equal length");
  if (scoresA.length === 0) throw new Error("abVerdict: empty score vectors");
  const { alpha = 0.05, resamples = 10_000, iters = 10_000, seed = 0xa_b5_7a_75 } = opts;
  const deltas = scoresB.map((b, i) => b - scoresA[i]);
  const ci = bcaInterval(deltas, { resamples, alpha, rng: mulberry32(seed) });
  const p = permutationP(deltas, { iters, rng: mulberry32(seed ^ 0x9e_37_79_b9) });
  const meanDelta = mean(deltas);

  let winner: "B" | "A" | "inconclusive" = "inconclusive";
  if (p < alpha && ci.lower > 0) winner = "B";
  else if (p < alpha && ci.upper < 0) winner = "A";

  return {
    n: scoresA.length,
    meanA: mean(scoresA),
    meanB: mean(scoresB),
    meanDelta,
    ci,
    p,
    winner,
    significant: winner !== "inconclusive",
  };
}
