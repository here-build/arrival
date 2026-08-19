# baseline-pre-G3 — misprediction metrics snapshot

Date: 2026-06-19. Model: onnx-community/rnj-1-instruct-ONNX (q4f16), onnxruntime-node CPU.
Command: METRICS_MODE=real METRICS_SURFACE={apple,sift} METRICS_BACKEND=onnx \
  pnpm exec vitest run --config vitest.research.config.ts src/__research__/misprediction-metrics.test.ts

Captured BEFORE node G3 (stop counting post-form-close padding) edits the metrics loop,
so the post-G3 re-run can be diffed to tell 'fix worked' from 'no-op' from 'regression'.

## apple summary
# Rnj-1 constrained-decoding misprediction metrics

- **mode**: real
- **surface**: apple
- **model**: onnx-community/rnj-1-instruct-ONNX
- **tasks**: 14
- **steps**: 1344

Total decode steps: **1344** (mid-form, i.e. not-yet-closeable: **520**)

## 1. Preferred-token kind (what the model's argmax tried, before the mask)

| kind | all steps | share | mid-form | share |
|---|--:|--:|--:|--:|
| feasible (top pick already valid) | 1261 | 93.8% | 507 | 97.5% |
| structural (incorrect syntax) | 74 | 5.5% | 4 | 0.8% |
| sigma (non-existent symbol) | 9 | 0.7% | 9 | 1.7% |

> _Mid-form is the honest denominator: it excludes steps where the program was already complete and the model (which never emits EOS here) was padding with extra tool calls / markdown / prose, all of which is structurally feasible at top level._

## 1b. Model confidence — was it confident when it was right vs wrong?

| kind | steps | mean P(argmax) | mean top-2 logit margin |
|---|--:|--:|--:|
| feasible (top pick valid) | 1261 | 0.772 | 3.77 |
| structural (bad syntax) | 74 | 0.809 | 3.73 |
| sigma (non-existent symbol) | 9 | 0.562 | 1.88 |

> _Higher P(argmax) / margin = the model was more decisive. Compare feasible (right) vs structural/sigma (mispredicted): is it confidently wrong, or are its mistakes its uncertain steps?_

## 2. Symbols the model reached for that don't exist (Σ-rejects)

| attempted atom | count |
|---|--:|
| `SET` | 2 |
| `10` | 1 |
| `minute` | 1 |
| `seconds` | 1 |
| `reminder` | 1 |
| `PLAY` | 1 |

## sift summary
# Rnj-1 constrained-decoding misprediction metrics

- **mode**: real
- **surface**: sift
- **model**: onnx-community/rnj-1-instruct-ONNX
- **tasks**: 14
- **steps**: 1344

Total decode steps: **1344** (mid-form, i.e. not-yet-closeable: **999**)

## 1. Preferred-token kind (what the model's argmax tried, before the mask)

| kind | all steps | share | mid-form | share |
|---|--:|--:|--:|--:|
| feasible (top pick already valid) | 1230 | 91.5% | 924 | 92.5% |
| structural (incorrect syntax) | 87 | 6.5% | 48 | 4.8% |
| sigma (non-existent symbol) | 27 | 2.0% | 27 | 2.7% |

> _Mid-form is the honest denominator: it excludes steps where the program was already complete and the model (which never emits EOS here) was padding with extra tool calls / markdown / prose, all of which is structurally feasible at top level._

## 1b. Model confidence — was it confident when it was right vs wrong?

| kind | steps | mean P(argmax) | mean top-2 logit margin |
|---|--:|--:|--:|
| feasible (top pick valid) | 1230 | 0.796 | 4.18 |
| structural (bad syntax) | 87 | 0.808 | 3.64 |
| sigma (non-existent symbol) | 27 | 0.465 | 1.59 |

> _Higher P(argmax) / margin = the model was more decisive. Compare feasible (right) vs structural/sigma (mispredicted): is it confidently wrong, or are its mistakes its uncertain steps?_

## 2. Symbols the model reached for that don't exist (Σ-rejects)

| attempted atom | count |
|---|--:|
| `Run` | 3 |
| `definition` | 2 |
| `names` | 2 |
| `e.g` | 2 |
| `proto` | 1 |
| `PID` | 1 |
