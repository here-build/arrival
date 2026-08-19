# R acceptance — G3 de-confound validated (apple, onnx Rnj-1, 2026-06-19)

Node R: re-run the misprediction harness WITH G3 (post-form-close padding excluded) and diff against
`baseline-pre-G3/`. Apple surface only — G3 is a surface-independent aggregation change, so apple (whose
tools the model knows, giving the purest padding signal) fully validates it; sift would re-test the same
aggregation logic with no extra signal, so it was skipped.

## Before → after (apple, 14 tasks)

| metric | baseline-pre-G3 | post-G3 | reading |
|---|---|---|---|
| denominator | 1344 all-steps / 520 "mid-form" | **134 task-program** (1210 post-form steps excluded) | the headline now measures the task program, not padding |
| feasible | 93.8% all / 97.5% mid-form | **94.8%** | the true rate; the constraint does more work than the old findings claimed |
| structural | 5.5% / 0.8% | 1.5% | |
| sigma | 0.7% / 1.7% | **3.7%** | unbound-symbol attempts are ~2× the old mid-form rate |

## The finding G3 surfaced: the old "mid-form" headline was itself contaminated

The baseline split on `closeable`, calling not-yet-closeable steps "mid-form" — but when the model opens a
SECOND top-level form after the first closes (padding, since it never emits EOS), those steps are
not-closeable too and counted as mid-form. They were easy, already-solved repeat tool calls inflating the
rate. G3's first-top-level-close cut removes them: the honest task program is **134 steps**, and on those
the argmax is feasible **~94.8%**, not the previously-reported ~97.7%. **The misprediction-findings.md
"~98% mid-form" headline was optimistic by the padding it still included.**

## The confidence signal is now clean

| kind | baseline mean P(argmax) | post-G3 mean P(argmax) |
|---|--:|--:|
| feasible (right) | 0.772 | **0.844** (margin 5.08) |
| structural (wrong) | 0.809 | **0.106** (margin 0.57) |
| sigma (wrong) | 0.562 | **0.362** (margin 0.87) |

Baseline showed structural at P=0.809 — "confidently wrong" — but that was confidently-emitted markdown
padding, not reasoning errors. De-confounded, the real pattern emerges: **the model is decisive when right
(P=0.84, margin 5.1) and uncertain when wrong (P≤0.36, margin≤0.9).** Its genuine mispredictions are its
low-confidence steps — exactly where a constraint earns its keep. This is the empirically clean version of
"the constraint is a safety net the model rarely needs, and needs precisely when it's unsure."

## Verdict

G3 validated: the all-steps denominator collapses onto the task program (padding gone), and the
de-confounded numbers are both lower (honest) and sharper (the confidence separation is now legible).
Follow-up: the committed `misprediction-findings.md` headline (~97.7% mid-form) should be annotated as
padding-inflated; the task-program rate is ~94.8%.
