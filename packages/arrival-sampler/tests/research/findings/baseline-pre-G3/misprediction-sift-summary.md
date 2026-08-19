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
| `pids` | 1 |
| `ids` | 1 |
| `row` | 1 |
| `gets` | 1 |
| `'s` | 1 |
| `declare` | 1 |
| `seriv` | 1 |
| `This` | 1 |
| `Windows` | 1 |
| `services` | 1 |
| `info` | 1 |
| `image` | 1 |
| `i.e` | 1 |
| `e,` | 1 |
| `g.` | 1 |
| `hash/re` | 1 |

## 3. Arity mispredictions per tool (observe-only; oracle does not enforce arity)

| tool | too-few-close | overfull-open | type-mismatch | ok |
|---|--:|--:|--:|--:|
| `region/malfind` | 0 | 0 | 0 | 1 |
| `process/getsids` | 0 | 0 | 0 | 10 |
| `region/yara-scan-memory` | 0 | 0 | 0 | 1 |
| `hash/sha256?` | 0 | 0 | 0 | 1 |
| `ip/external-c2-candidate?` | 0 | 0 | 0 | 1 |
| `event/event-logs` | 0 | 0 | 0 | 1 |

## 4. Iterations until the first feasible token (top-K rank)

| rank | steps |
|---|--:|
| 1 (model's top pick was feasible) | 1230 |
| 2 | 96 |
| 3 | 6 |
| 4 | 2 |
| 5 | 2 |
| 7 | 3 |
| 8 | 1 |
| 9 | 1 |
| 10 | 1 |
| 22 | 1 |
| 28 | 1 |
