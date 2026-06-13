// The neural candidate-ranker worker — Qwen3.5-0.8B (or any transformers.js
// model) running OFF the main thread, scoring Σ∩T-proven candidates with one
// forward pass per request. A DEDICATED worker (not Shared): WebGPU adapters
// inside SharedWorkers are still patchy, and the model weights are cached by
// the browser anyway (IndexedDB/HTTP cache), so per-tab instances share the
// download — only the resident memory duplicates.
//
// Protocol (mirrors the LS worker's): {kind:"init", id, options} once, then
// {kind:"rank", id, prefix, candidates, minProb} → {kind:"reply", id, ok, value}.

import { createCandidateRanker, type CandidateRanker, type CandidateRankerOptions } from "@here.build/arrival-sampler";
import { env as tjsEnv } from "@huggingface/transformers";

interface RankerInit {
  kind: "init";
  id: number;
  options: CandidateRankerOptions & { localModelPath?: string };
}
interface RankerRank {
  kind: "rank";
  id: number;
  prefix: string;
  candidates: string[];
  minProb: number;
}

let ranker: CandidateRanker | null = null;

const scope = globalThis as unknown as {
  postMessage(data: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

// eslint-disable-next-line unicorn/prefer-add-event-listener -- property assignment auto-starts ports
scope.onmessage = (ev) => {
  const msg = ev.data as RankerInit | RankerRank;
  void (async () => {
    try {
      if (msg.kind === "init") {
        if (msg.options.localModelPath !== undefined) {
          // Local artifacts (e.g. the 2-bit Qwen): fetch from our own origin.
          tjsEnv.localModelPath = msg.options.localModelPath;
          tjsEnv.allowRemoteModels = false;
        }
        // Device reality check: WebGPU is SECURE-CONTEXT-gated — over plain
        // http://<lan-ip> `navigator.gpu` is hidden in every scope (page and
        // workers; only https/localhost expose it — V's iPad field test,
        // confirmed via cloudflared). transformers.js then throws
        // 'Unsupported device: "webgpu"'. Downgrade to wasm up front, and
        // REPORT the device actually used so callers/benches stay honest.
        const requested = msg.options.device;
        let device = requested;
        if (device === "webgpu" && !("gpu" in (globalThis.navigator ?? {}))) device = "wasm";
        if (ranker === null) {
          try {
            ranker = await createCandidateRanker({ ...msg.options, ...(device === undefined ? {} : { device }) });
          } catch (error) {
            // Adapter present but init failed (driver/feature gaps) → one wasm retry.
            if (device !== "webgpu") throw error;
            device = "wasm";
            ranker = await createCandidateRanker({ ...msg.options, device });
          }
        }
        scope.postMessage({ kind: "reply", id: msg.id, ok: true, value: { device: device ?? "default", requested } });
        return;
      }
      if (ranker === null) throw new Error("scheme-ranker: rank before init");
      const value = await ranker.rank(msg.prefix, msg.candidates, msg.minProb);
      scope.postMessage({ kind: "reply", id: msg.id, ok: true, value });
    } catch (error) {
      scope.postMessage({
        kind: "reply",
        id: msg.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
