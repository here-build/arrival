# Quant-ranking study — size × quantization floor for the Σ∩T candidate ranker

Companion interpretation for the auto-generated `__research-output__/quant-ranking-*.json`. Run
2026-06-19 (node G5). The study ranks gold continuations for the autocomplete/materialize task under two
pools: **full** (ablation — all candidates) vs **proven** (restricted to the Σ∩T-proven pool = product
behavior). Metrics: MRR of gold (`MRRf`/`MRRp`), top-1, semantic-probe MRR (`sMRRp`, where the model must
disambiguate by *meaning* — names vs ages), control-probe MRR (`cMRRp`), frame-hit (gold inside the top
5% frame), and the proof-mask **boost** = `MRRp − MRRf`.

Matrix: SmolLM2 **135M** and **360M** Instruct × **q8 / q4 / q2** ONNX. q8/q4 ship in the HF repos; **q2
was generated locally** (onnxruntime `MatMulNBitsQuantizer`, bits=2) via
`src/__research__/build-smollm2-quant-matrix.py`. The model artifacts live under the gitignored `models/`; rebuild
with that script. Study runs 9/9 (`pnpm research`).

## Completed matrix (proven pool = product behavior)

```
spec              MRRp top1p MRRf top1f frame sMRRp cMRRp boost  ms
135M q8           0.45 0.20  0.32 0.10  0.00  0.24  0.60  0.13  ~50
135M q4           0.40 0.00  0.25 0.00  0.00  0.34  0.43  0.14   67
135M q2           0.55 0.40  0.14 0.00  0.00  0.20  0.78  0.41  102
360M q8           0.83 0.70  0.64 0.50  0.60  0.88  0.81  0.20  100
360M q4           0.82 0.70  0.63 0.40  0.20  0.75  0.88  0.19  177
360M q2           0.22 0.00  0.08 0.00  0.00  0.15  0.27  0.14  270
```

Local q8 dirs reproduce the stock-HF q8 references bit-for-bit (identical numbers) — confirms the local
artifact layout loads correctly.

## The size × quant floor: needs **≥360M params AND ≥q4**

- **360M is the working tier.** q8 ≈ q4 hold up (proven MRR 0.83/0.82, top-1 0.70, real semantic
  separation `sMRRp` 0.88/0.75 ≫ control, frame-hit 0.6/0.2). **q4 is the safe quantization floor.**
- **q2 at 360M is catastrophic, not viable.** MRRp craters 0.82→0.22, top-1→0, semantic MRR→0.15 (below
  its own control). It *runs* but collapses as a ranker. 360M survives q4, dies at q2.
- **135M is below the task floor at every quant.** Even q8 manages only MRRp 0.45 / top-1 0.20 with zero
  frame-hits, and `sMRRp < cMRRp` throughout — the model isn't adding meaning, the proof mask is.

## The key inversion: a large boost is a **degradation signal**, not a win

The proof-mask boost (`MRRp − MRRf`) stays **modest (~0.2)** exactly where the model genuinely contributes
(360M q8/q4) and **balloons (0.41)** only where the model has collapsed to near-random (135M q2) and the
proof carries everything. So: when the model is healthy, the mask is a safety net adding ~0.2; when the
boost is huge, the model has failed and the mask is doing all the work over noise. **Read a large boost as
"the model degraded here," not "the mask shines here."** (135M q2's headline MRRp 0.55 is a mirage —
MRRf 0.14 means the proof, not the model, produced it.)

## q2 producibility — a real toolchain finding

q2 quantization works (onnxruntime `MatMulNBitsQuantizer` bits=2; needs `onnx`/`onnxruntime`/`sympy`/
`onnx_ir`) but only from the **fp32** ONNX graph. Quantizing from **fp16** yields a graph the installed
`onnxruntime-node@1.24.3` CPU kernel rejects (`MatMulNBits<MLFloat16>::ComputeBUnpacked … nbits_ == 8 was
false` — the fp16 MatMulNBits kernel only implements 8-bit). Re-quantizing from fp32 gives a graph whose
float32 MatMulNBits path supports 2-bit. **q2 ONNX on this toolchain requires fp32 source weights.**

## Bottom line

For the Σ∩T candidate-ranking task, the on-device floor is **360M params at q4**. Below either axis (135M
at any bits, or 360M at q2) the model stops ranking by meaning and the proof mask masks the failure rather
than enabling success. The sampler-boost is a ~0.2 safety net when the model is healthy and a collapse
alarm when it isn't.
