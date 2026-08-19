// sampling.ts — temperature sampling over the ORACLE-FEASIBLE candidate set.
//
// WHY: greedy-constrained decoding (keepN:1, always the top feasible token) is deterministic, so the
// same (model, scheme, tasks) yields byte-identical output every run — zero measurement noise. That's
// great for reproducibility but useless for the Stage-0 measurement-trust work: an A/A test and a
// Gage R&R decomposition both need a real run-to-run noise source, and pass^k needs a DISTRIBUTION of
// outcomes per task. Sampling from the feasible set at temperature τ provides exactly that, WITHOUT
// ever admitting an infeasible token — we sample only among candidates the oracle already passed, so
// every emitted program is still valid by construction.
//
// This module is pure (no model, no native addon) so the sampling decision is unit-testable in the
// default suite; the llama.cpp backend imports `tempSample` and feeds it the feasible candidates it
// collected during its top-K walk.

/**
 * Sample an index into `probs` under temperature `temperature` (Boltzmann over p^(1/τ)).
 *   • τ <= 0  → argmax (greedy; the deterministic path — identical to keepN:1).
 *   • τ → 0+  → concentrates on the top candidate.
 *   • τ large → approaches uniform over the feasible set.
 * `rng` is an injected uniform [0,1) source so the draw is reproducible given a seed.
 */
export function tempSample(probs: readonly number[], temperature: number, rng: () => number): number {
  if (probs.length === 0) throw new Error("tempSample: empty candidate set");
  if (probs.length === 1) return 0;

  if (temperature <= 0) {
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
    return best;
  }

  const inv = 1 / temperature;
  const weights = probs.map((p) => Math.pow(Math.max(p, 0), inv));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || !Number.isFinite(sum)) {
    // Degenerate (all-zero or overflowed weights) → fall back to argmax of the raw probs.
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
    return best;
  }

  let r = rng() * sum;
  for (const [i, weight] of weights.entries()) {
    r -= weight;
    if (r <= 0) return i;
  }
  return weights.length - 1; // floating-point guard
}

/**
 * pass^k — the probability that ALL k of k i.i.d. trials of a task succeed, estimated unbiasedly from
 * `successes` out of `n` observed trials as C(successes, k) / C(n, k) (τ-bench's reliability metric).
 * Reliability, not discovery: a task right-on-average but flaky has high pass^1 and low pass^k. Returns
 * 0 when k > successes (can't draw k all-successes) and is defined only for k <= n.
 */
export function passAtK(successes: number, n: number, k: number): number {
  if (k > n) throw new Error(`passAtK: k (${k}) > n (${n})`);
  if (k > successes) return 0;
  // C(successes, k) / C(n, k), computed as a falling-factorial ratio to avoid overflow.
  let acc = 1;
  for (let i = 0; i < k; i++) acc *= (successes - i) / (n - i);
  return acc;
}
