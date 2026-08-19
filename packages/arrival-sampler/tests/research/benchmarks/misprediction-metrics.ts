// misprediction-metrics.ts — per-token misprediction instrumentation for the constrained decoder.
//
// The model runs greedy-CONSTRAINED (keepN:1), so the emitted program is always valid. A
// "misprediction" is what the model's unconstrained preference WANTED before the oracle vetoed it: at
// each decode step we read the model's argmax (`topIds[0]`) and classify it —
//   • structural  (M1) — the grammar/balance rejected it (incorrect syntax),
//   • sigma       (M2) — structurally fine but an UNBOUND operator/argument atom (non-existent symbol);
//                        we also record the trailing atom the model reached for, for a per-symbol tally,
//   • feasible          — the model's top pick was already admissible (no misprediction).
// Plus M3: how far down the model's top-K logit ranking we had to walk to find the first FEASIBLE token
// (`iterationsUntilFeasible`), and M4: the arity side-analyzer's per-tool "wrong args" verdict.
//
// Implemented as a no-extra-oracle-work subclass: `LazyOracleConstraintProcessor` already computed the
// top-K and the kept set; `onStep` reuses them and adds exactly ONE classification of the single
// preferred token (one `feasible` + ≤1 `analyze`) plus an O(len) arity reparse. The shipping processor
// is unchanged (its `onStep` is a no-op).

import { classifyCandidate, trailingAtom, type CandidateClass } from "../../../src/mask-compiler.js";
import type { OracleScanner } from "../../../src/oracle-types.js";
import type { ArityAnalyzer, ArityVerdict } from "../arity-analyzer.js";

/** How the model's preferred (unconstrained-argmax) token was classified this step. */
export type PreferKind = CandidateClass; // "feasible" | "structural" | "sigma"

/** One decode step's misprediction record. */
export interface StepMetric {
  readonly taskId: string;
  readonly stepIndex: number;
  readonly preferTokenId: number;
  readonly preferStr: string;
  readonly preferLogit: number;
  /** Confidence: softmax probability of the argmax over the (unmasked) logit row. */
  readonly preferProb: number;
  /** Confidence margin: logit gap between the model's #1 and #2 tokens (decisiveness). */
  readonly top2Margin: number;
  readonly preferKind: PreferKind;
  /** M2: the trailing atom the model reached for, when the preferred token was a Σ-reject; else null. */
  readonly attemptedAtom: string | null;
  /** M3: 1-indexed rank of the first FEASIBLE token in the top-K logit walk; null ⇒ none (fallback). */
  readonly iterationsUntilFeasible: number | null;
  readonly widened: boolean;
  readonly fallback: boolean;
  /** True iff the program is already closeable here (depth 0). When false the model is genuinely
   *  mid-construction; when true, a continuing model is padding/prose past a complete form — so the
   *  honest "is the model building valid Scheme" signal is the !closeable (mid-form) subset. */
  readonly closeable: boolean;
  /** True iff the FIRST balanced top-level `(...)` form has ALREADY closed at or before this step's
   *  accepted prefix. The task program IS that first form; everything after it (more top-level forms,
   *  markdown fences, prose — the model never emits EOS, so it pads to the token cap) is post-task
   *  noise that, while structurally feasible at top level, inflates the headline denominators. G3:
   *  excluded from totalSteps + every kind/mid-form/confidence tally, retained in the raw array. */
  readonly postForm: boolean;
  /** M4: the arity verdict at this step, when the cursor sits at a known-tool argument boundary. */
  readonly arity: ArityVerdict | null;
}

export interface ArityHeadTally {
  tooFewClose: number;
  overfullOpen: number;
  typeMismatch: number;
  ok: number;
}

/** The aggregated report rendered to JSON + markdown. */
export interface MispredictionReport {
  /** Task-program denominator: steps at or before the first top-level form closed. G3 EXCLUDES every
   *  post-form step (see {@link postFormSteps}) — this is the de-confounded headline `n`. */
  totalSteps: number;
  /** How many steps were excluded as post-first-top-level-close padding (transparency, not a denominator). */
  postFormSteps: number;
  /** Steps where the program was NOT yet closeable (the model is genuinely mid-construction) — the
   *  honest denominator, excluding post-complete-form padding/prose. */
  midFormSteps: number;
  /** M1+M2 headline: how often the model's top pick was feasible / structurally wrong / Σ-unbound. */
  kindFreq: Record<PreferKind, number>;
  /** The same, restricted to mid-form (!closeable) steps — the de-confounded headline. */
  kindFreqMidForm: Record<PreferKind, number>;
  /** CONFIDENCE by kind: was the model confident when its top pick was valid vs when it mispredicted?
   *  `meanProb` = mean softmax P(argmax); `meanMargin` = mean logit gap to the #2 token. */
  confidenceByKind: Record<PreferKind, { meanProb: number; meanMargin: number; n: number }>;
  /** M2: how often the model reached for each non-existent symbol (trailing atom), desc by count. */
  attemptedSymbolTally: Record<string, number>;
  /** M3: histogram of iterations-until-first-feasible (key = rank, or "miss" for fallback). */
  iterationsHistogram: Record<string, number>;
  /** M4: per-tool arity-misprediction tallies. */
  arityByHead: Record<string, ArityHeadTally>;
}

/** Everything ONE constrained decode step exposes to the misprediction recorder — a plain-data record any
 *  backend can produce. (Historically the onnx lazy loop's `onStep` argument; relocated here when that
 *  processor was retired. The llama.cpp loop emits the same StepMetric shape from its own probability-native
 *  per-step record.) The recorder reuses what the decode already computed — the model's unconstrained
 *  preference (`topIds[0]` = the argmax over un-masked logits) and the constrained outcome (`kept`, the
 *  first feasible being `kept[0]`, at rank `topIds.indexOf(kept[0]) + 1`). */
export interface StepObservation {
  /** The accepted generated prefix (decoded suffix) this step extends. */
  readonly prefix: string;
  /** The top-K ids actually walked this step, descending model score (widened to `wideK` after a fallback). */
  readonly topIds: readonly number[];
  /** The kept (valid) ids in walk order; `kept[0]` is the first feasible (the constrained argmax). */
  readonly kept: readonly number[];
  /** The raw logit row — for the preferred token's logit value and the softmax confidence. */
  readonly data: { readonly length: number; readonly [i: number]: number };
  /** Vocab size (logit row length). */
  readonly vocab: number;
  /** Whether the program is closeable (EOS legal) at this prefix. */
  readonly canEnd: boolean;
  /** The top-K widened to `wideK` this step (zero valid in the base top-K). */
  readonly widened: boolean;
  /** Even the widened top-K had zero valid ⇒ structural-completion fallback fired this step. */
  readonly fallback: boolean;
}

/** The decode context the recorder classifies against: the oracle, the id→string table, the EOS id, the
 *  arity side-analyzer, and the task/step identity stamped onto each emitted record. */
export interface StepMetricContext {
  readonly scanner: OracleScanner;
  readonly idToStr: ReadonlyMap<number, string>;
  readonly eosId: number;
  readonly analyzer: ArityAnalyzer;
  readonly taskId: string;
  readonly stepIndex: number;
}

/**
 * Classify ONE constrained decode step's observation into a {@link StepMetric} — the model-free,
 * backend-agnostic core the retired onnx `MetricsProcessor.onStep` wrapped. Any backend that produces a
 * {@link StepObservation} (a synthetic test, or the historical lazy loop) feeds it here; the llama.cpp loop
 * computes the same StepMetric shape from its probability-native per-step record. Returns null when the
 * top-K was empty (everything masked upstream — nothing to classify).
 */
export function recordStepMetric(obs: StepObservation, ctx: StepMetricContext): StepMetric | null {
  const preferId = obs.topIds[0];
  if (preferId === undefined) return null; // empty top-K (everything -Inf upstream) — nothing to classify.

  const preferStr = ctx.idToStr.get(preferId);
  const isEos = preferId === ctx.eosId;

  let kind: PreferKind;
  let attemptedAtom: string | null = null;
  if (preferStr === undefined) {
    // A special/EOS token (absent from the id→string table). EOS is feasible iff the program can end
    // here; any other special token is structurally inadmissible as Scheme source.
    kind = isEos ? (obs.canEnd ? "feasible" : "structural") : "structural";
  } else {
    kind = classifyCandidate(ctx.scanner, obs.prefix, preferStr);
    if (kind === "sigma") attemptedAtom = trailingAtom(obs.prefix + preferStr);
  }

  // M3: kept[0] is the first feasible token (greedy keepN:1); its index in the walked top-K is the rank.
  const iterationsUntilFeasible = obs.kept.length > 0 ? obs.topIds.indexOf(obs.kept[0]) + 1 : null;

  // CONFIDENCE: softmax probability of the argmax over the UNMASKED logit row (the recorder runs before the
  // mask is applied), plus the logit margin to the #2 token — how decisive the model was this step.
  const maxL = obs.data[preferId] ?? Number.NEGATIVE_INFINITY;
  let expSum = 0;
  for (let i = 0; i < obs.vocab; i++) {
    const v = obs.data[i];
    if (v === Number.NEGATIVE_INFINITY) continue;
    expSum += Math.exp(v - maxL);
  }
  const preferProb = expSum > 0 ? 1 / expSum : Number.NaN;
  const secondId = obs.topIds[1];
  const top2Margin = secondId === undefined ? Number.NaN : maxL - (obs.data[secondId] ?? Number.NEGATIVE_INFINITY);

  return {
    taskId: ctx.taskId,
    stepIndex: ctx.stepIndex,
    preferTokenId: preferId,
    preferStr: preferStr ?? (isEos ? "<eos>" : "<special>"),
    preferLogit: obs.data[preferId] ?? Number.NaN,
    preferProb,
    top2Margin,
    preferKind: kind,
    attemptedAtom,
    iterationsUntilFeasible,
    widened: obs.widened,
    fallback: obs.fallback,
    closeable: obs.canEnd,
    postForm: firstTopLevelFormClosed(obs.prefix),
    arity: ctx.analyzer.observe(obs.prefix, preferStr ?? ""),
  };
}

// ── Post-form detection (pure) ────────────────────────────────────────────────────────────────────
//
// The task program is the FIRST balanced top-level `(...)` form. Once it has closed, every later step
// is post-task padding (extra forms / fences / prose) — the model never makes EOS its argmax, so it
// runs to the token cap. This is the same string-respecting balance scan as runner/generate.ts
// `extractSchemeForm`; duplicated here (rather than imported) to keep this module free of the heavy
// transformers dependency graph that generate.ts pulls in.

/** True iff a balanced top-level `(...)` form opens and closes (depth returns to 0) within `text`. */
export function firstTopLevelFormClosed(text: string): boolean {
  const start = text.indexOf("(");
  if (start === -1) return false;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\")
        i++; // skip escaped char
      else if (ch === '"') inStr = false;
      continue;
    }
    switch (ch) {
      case '"': {
        inStr = true;
        break;
      }
      case "(": {
        depth++;
        break;
      }
      case ")": {
        depth--;
        if (depth === 0) return true; // first top-level form just closed
        break;
      }
      // No default
    }
  }
  return false;
}

// ── Aggregation (pure) ──────────────────────────────────────────────────────────────────────────────

const meanOf = (sum: number, n: number): number => (n > 0 ? sum / n : Number.NaN);

export function aggregate(steps: readonly StepMetric[]): MispredictionReport {
  const kindFreq: Record<PreferKind, number> = { feasible: 0, structural: 0, sigma: 0 };
  const kindFreqMidForm: Record<PreferKind, number> = { feasible: 0, structural: 0, sigma: 0 };
  const attemptedSymbolTally: Record<string, number> = {};
  const iterationsHistogram: Record<string, number> = {};
  const arityByHead: Record<string, ArityHeadTally> = {};
  const conf: Record<PreferKind, { sumProb: number; nProb: number; sumMargin: number; nMargin: number; n: number }> = {
    feasible: { sumProb: 0, nProb: 0, sumMargin: 0, nMargin: 0, n: 0 },
    structural: { sumProb: 0, nProb: 0, sumMargin: 0, nMargin: 0, n: 0 },
    sigma: { sumProb: 0, nProb: 0, sumMargin: 0, nMargin: 0, n: 0 },
  };
  let midFormSteps = 0;
  let postFormSteps = 0;
  let totalSteps = 0;

  for (const s of steps) {
    // G3: a step whose accepted prefix is at/after the first top-level form's close is post-task
    // padding. Keep it in the raw `steps` array (caller's transparency), but exclude it from every
    // headline denominator/tally below so the task-program rates aren't inflated by prose/extra forms.
    if (s.postForm) {
      postFormSteps++;
      continue;
    }
    totalSteps++;

    kindFreq[s.preferKind]++;
    if (!s.closeable) {
      midFormSteps++;
      kindFreqMidForm[s.preferKind]++;
    }

    const c = conf[s.preferKind];
    c.n++;
    if (Number.isFinite(s.preferProb)) {
      c.sumProb += s.preferProb;
      c.nProb++;
    }
    if (Number.isFinite(s.top2Margin)) {
      c.sumMargin += s.top2Margin;
      c.nMargin++;
    }

    if (s.attemptedAtom !== null && s.attemptedAtom !== "") {
      attemptedSymbolTally[s.attemptedAtom] = (attemptedSymbolTally[s.attemptedAtom] ?? 0) + 1;
    }

    const bucket = s.iterationsUntilFeasible === null ? "miss" : String(s.iterationsUntilFeasible);
    iterationsHistogram[bucket] = (iterationsHistogram[bucket] ?? 0) + 1;

    if (s.arity) {
      const t = (arityByHead[s.arity.headSymbol] ??= { tooFewClose: 0, overfullOpen: 0, typeMismatch: 0, ok: 0 });
      switch (s.arity.kind) {
        case "too-few-close": {
          t.tooFewClose++;
          break;
        }
        case "overfull-open": {
          t.overfullOpen++;
          break;
        }
        case "type-coarse-mismatch": {
          t.typeMismatch++;
          break;
        }
        default:
          t.ok++;
      }
    }
  }

  const confOf = (k: PreferKind) => ({
    meanProb: meanOf(conf[k].sumProb, conf[k].nProb),
    meanMargin: meanOf(conf[k].sumMargin, conf[k].nMargin),
    n: conf[k].n,
  });
  const confidenceByKind: Record<PreferKind, { meanProb: number; meanMargin: number; n: number }> = {
    feasible: confOf("feasible"),
    structural: confOf("structural"),
    sigma: confOf("sigma"),
  };

  return {
    totalSteps,
    postFormSteps,
    midFormSteps,
    kindFreq,
    kindFreqMidForm,
    confidenceByKind,
    attemptedSymbolTally,
    iterationsHistogram,
    arityByHead,
  };
}

// ── Markdown rendering ────────────────────────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
  return total === 0 ? "0.0%" : `${((100 * n) / total).toFixed(1)}%`;
}

function arityTotal(t: ArityHeadTally): number {
  return t.tooFewClose + t.overfullOpen + t.typeMismatch;
}

const prob = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "—");
const marg = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "—");

/** Render the four-section human summary. `meta` lines (model id, mode, task count) head the doc. */
export function renderSummary(report: MispredictionReport, meta: Record<string, string | number>): string {
  const {
    totalSteps,
    postFormSteps,
    midFormSteps,
    kindFreq,
    kindFreqMidForm,
    confidenceByKind,
    attemptedSymbolTally,
    iterationsHistogram,
    arityByHead,
  } = report;
  const metaLines = Object.entries(meta).map(([k, v]) => `- **${k}**: ${v}`);

  // Object.entries returns a fresh array each call, so the in-place sort mutates nothing shared.
  // eslint-disable-next-line unicorn/no-array-sort
  const symbols = Object.entries(attemptedSymbolTally).sort((a, b) => b[1] - a[1]);
  const symbolRows = symbols.length === 0 ? ["| _(none)_ | 0 |"] : symbols.map(([sym, n]) => `| \`${sym}\` | ${n} |`);

  // eslint-disable-next-line unicorn/no-array-sort
  const heads = Object.entries(arityByHead).sort((a, b) => arityTotal(b[1]) - arityTotal(a[1]));
  const headRows =
    heads.length === 0
      ? ["| _(none)_ | 0 | 0 | 0 | 0 |"]
      : heads.map(
          ([head, t]) => `| \`${head}\` | ${t.tooFewClose} | ${t.overfullOpen} | ${t.typeMismatch} | ${t.ok} |`,
        );

  // eslint-disable-next-line unicorn/no-array-sort
  const ranks = Object.entries(iterationsHistogram).sort((a, b) => {
    if (a[0] === "miss") return 1;
    if (b[0] === "miss") return -1;
    return Number(a[0]) - Number(b[0]);
  });
  const rankRows = ranks.map(([rank, n]) => `| ${rank === "1" ? "1 (model's top pick was feasible)" : rank} | ${n} |`);

  // 1. Per-token-kind frequencies (M1 + M2). Two denominators: ALL steps (includes post-complete-form
  // padding/prose, since the model never emits EOS and runs to the token cap) and the de-confounded
  // MID-FORM subset (steps where the model is actively building a form).
  return [
    "# Rnj-1 constrained-decoding misprediction metrics",
    "",
    ...metaLines,
    "",
    `Task-program decode steps: **${totalSteps}** (mid-form, i.e. not-yet-closeable: **${midFormSteps}**)`,
    "",
    `> _G3: **${postFormSteps}** post-form step(s) excluded — steps after the first top-level Scheme form closed (extra forms / markdown / prose the model padded with, since it never emits EOS here). All denominators below are over the task program only._`,
    "",
    "## 1. Preferred-token kind (what the model's argmax tried, before the mask)",
    "",
    "| kind | all steps | share | mid-form | share |",
    "|---|--:|--:|--:|--:|",
    `| feasible (top pick already valid) | ${kindFreq.feasible} | ${pct(kindFreq.feasible, totalSteps)} | ${kindFreqMidForm.feasible} | ${pct(kindFreqMidForm.feasible, midFormSteps)} |`,
    `| structural (incorrect syntax) | ${kindFreq.structural} | ${pct(kindFreq.structural, totalSteps)} | ${kindFreqMidForm.structural} | ${pct(kindFreqMidForm.structural, midFormSteps)} |`,
    `| sigma (non-existent symbol) | ${kindFreq.sigma} | ${pct(kindFreq.sigma, totalSteps)} | ${kindFreqMidForm.sigma} | ${pct(kindFreqMidForm.sigma, midFormSteps)} |`,
    "",
    "> _Mid-form is the honest denominator: it excludes steps where the program was already complete and the model (which never emits EOS here) was padding with extra tool calls / markdown / prose, all of which is structurally feasible at top level._",
    "",
    "## 1b. Model confidence — was it confident when it was right vs wrong?",
    "",
    "| kind | steps | mean P(argmax) | mean top-2 logit margin |",
    "|---|--:|--:|--:|",
    `| feasible (top pick valid) | ${confidenceByKind.feasible.n} | ${prob(confidenceByKind.feasible.meanProb)} | ${marg(confidenceByKind.feasible.meanMargin)} |`,
    `| structural (bad syntax) | ${confidenceByKind.structural.n} | ${prob(confidenceByKind.structural.meanProb)} | ${marg(confidenceByKind.structural.meanMargin)} |`,
    `| sigma (non-existent symbol) | ${confidenceByKind.sigma.n} | ${prob(confidenceByKind.sigma.meanProb)} | ${marg(confidenceByKind.sigma.meanMargin)} |`,
    "",
    "> _Higher P(argmax) / margin = the model was more decisive. Compare feasible (right) vs structural/sigma (mispredicted): is it confidently wrong, or are its mistakes its uncertain steps?_",
    "",
    "## 2. Symbols the model reached for that don't exist (Σ-rejects)",
    "",
    "| attempted atom | count |",
    "|---|--:|",
    ...symbolRows,
    "",
    "## 3. Arity mispredictions per tool (observe-only; oracle does not enforce arity)",
    "",
    "| tool | too-few-close | overfull-open | type-mismatch | ok |",
    "|---|--:|--:|--:|--:|",
    ...headRows,
    "",
    "## 4. Iterations until the first feasible token (top-K rank)",
    "",
    "| rank | steps |",
    "|---|--:|",
    ...rankRows,
    "",
  ].join("\n");
}
