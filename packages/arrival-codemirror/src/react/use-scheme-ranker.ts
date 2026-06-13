import { useEffect, useState } from "react";

import type { SchemeNeuralRanker } from "../index.js";

/**
 * The neural candidate ranker, as a lazily-spawned per-tab worker. OPT-IN:
 * the model is a real download (Qwen3.5-0.8B q4f16 ≈ 470MB, fetched once and
 * browser-cached), so nothing loads until a surface explicitly enables it.
 *
 * Failure is always soft: a missing WebGPU adapter, a failed download, or a
 * dead worker resolves to `null` and the editor keeps its pure Σ∩T ranking —
 * the ranker can only ever ADD preference on top of proof.
 */
export interface SchemeRankerConfig {
  /** transformers.js model id (or a localModelPath-resolved directory name). */
  modelId?: string;
  /** Quantization — q4f16 (stock) or q2 (the locally-quantized artifact). */
  dtype?: string;
  /** webgpu (default; falls back to wasm when no adapter). */
  device?: "webgpu" | "wasm";
  /** Serve models from a URL prefix instead of the HF hub — how the
   *  locally-quantized artifacts load (e.g. "/models" served by the studio). */
  localModelPath?: string;
}

let rankerPromise: Promise<SchemeNeuralRanker | null> | null = null;

function spawnRanker(config: SchemeRankerConfig): Promise<SchemeNeuralRanker | null> {
  rankerPromise ??= (async () => {
    if (typeof Worker !== "function") return null;
    try {
      const worker = new Worker(new URL("scheme-ranker.worker.js", import.meta.url), {
        type: "module",
        name: "arrival-scheme-ranker",
      });
      let nextId = 0;
      const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      worker.addEventListener("message", (ev) => {
        const msg = ev.data as { id: number; ok: boolean; value?: unknown; error?: string };
        const entry = pending.get(msg.id);
        if (entry === undefined) return;
        pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.value);
        else entry.reject(new Error(msg.error));
      });
      worker.addEventListener("error", (e) => {
        for (const p of pending.values()) p.reject(new Error(`ranker worker error: ${e.message}`));
        pending.clear();
      });
      const call = (message: Record<string, unknown>): Promise<unknown> =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          worker.postMessage({ ...message, id });
        });
      // Init = model download + load. Generous timeout: first run pulls weights.
      // Default = the MEASURED winner of the 2026-06-10 quant-ranking study
      // (arrival-sampler __research__): stock 360M q4f16 scores MRR .82 / top-1
      // .70 within the proven pool — identical to q8 — at 273MB, the smallest
      // artifact in the matrix. 360M is the semantic floor (135M ≈ noise on
      // names-vs-ages probes); Qwen3.5-0.8B is the likely-better configurable
      // upgrade, pending in-browser verification (its graph needs ort-web).
      const options = {
        modelId: config.modelId ?? "HuggingFaceTB/SmolLM2-360M-Instruct",
        dtype: config.dtype ?? "q4f16",
        device: config.device ?? "webgpu",
        ...(config.localModelPath === undefined ? {} : { localModelPath: config.localModelPath }),
      };
      await Promise.race([
        call({ kind: "init", options }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("ranker init timeout")), 600_000)),
      ]);
      return {
        rank: (prefix, candidates, minProb) =>
          call({ kind: "rank", prefix, candidates: [...candidates], minProb }) as Promise<
            { prob: number; inNucleus: boolean }[]
          >,
      } satisfies SchemeNeuralRanker;
    } catch (error) {
      console.warn("scheme neural ranker unavailable — completion stays proof-ranked", error);
      return null;
    }
  })();
  return rankerPromise;
}

/** The shared neural ranker, or `null` while loading / unavailable / disabled. */
export function useSchemeRanker(config: SchemeRankerConfig | null): SchemeNeuralRanker | null {
  const [ranker, setRanker] = useState<SchemeNeuralRanker | null>(null);
  useEffect(() => {
    if (config === null) return;
    let live = true;
    void spawnRanker(config).then((r) => {
      if (live && r !== null) setRanker(r);
    });
    return () => {
      live = false;
    };
    // config identity churn must not respawn the singleton
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config !== null]);
  return config === null ? null : ranker;
}
