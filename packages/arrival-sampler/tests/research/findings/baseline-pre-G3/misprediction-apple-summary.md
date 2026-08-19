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
| `OR` | 1 |
| `recipient` | 1 |

## 3. Arity mispredictions per tool (observe-only; oracle does not enforce arity)

| tool | too-few-close | overfull-open | type-mismatch | ok |
|---|--:|--:|--:|--:|
| `set-volume` | 0 | 0 | 0 | 5 |
| `set-brightness` | 0 | 0 | 0 | 1 |

## 4. Iterations until the first feasible token (top-K rank)

| rank | steps |
|---|--:|
| 1 (model's top pick was feasible) | 1261 |
| 2 | 81 |
| 3 | 1 |
| 6 | 1 |
