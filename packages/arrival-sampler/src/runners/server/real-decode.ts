// real-decode.ts — the PRODUCTION {@link DecodeFn}: wrap the sampler's `generateWithExplain`, with resident
// model handles managed by a {@link ModelManager} (JIT load, reuse, idle offload, LRU eviction). NODE-ONLY
// (native llama.cpp addon).
//
// DEFERRED / DO-NOT-RUN-IN-TESTS: this actually loads a model and decodes on the GPU. The test suite NEVER
// imports or calls this — it injects a canned DecodeFn into the handler, and tests the ModelManager with a
// fake (counting) loader. This module is the only file that touches `node-llama-cpp`.
//
// This makes the server a drop-in LM-Studio-like endpoint: point a harness's OPENAI_BASE_URL at us, send any
// of our served model ids, and the manager loads it on demand (resolved id → gguf via model-resolve), reuses
// it across requests, and offloads it after an idle period or LRU-evicts it when a different model is needed.

import { ModelManager } from "./model-manager.js";
import { resolveModelPath, defaultSources, resolveEnv, type Source } from "./model-resolve.js";
import type { DecodeArgs, DecodeFn } from "./handler.js";
// TYPE-ONLY import of the real llama handle type — erased at compile, so it does NOT pull the node-only
// native addon into the module graph. The VALUES (LlamaModelHandle / generateWithExplain) are dynamically
// imported below, lazily, only on the node/GPU path. The decode entry is the package-internal `../decode/`
// module (the `/decode` subpath from outside) — a relative import now that the server is part of this package.
import type { LlamaModelHandle } from "../local/server-generate.js";

/** Tuning knobs for the resident-model manager (surfaced as CLI flags / env in cli.ts). */
export interface RealDecodeOptions {
  /** Idle period (ms) before a model is offloaded. Default 5 min (the ModelManager default). `≤ 0` disables. */
  readonly idleTimeoutMs?: number;
  /** Max simultaneously-resident models. Default 1 (Metal holds one). LRU-evict at capacity. */
  readonly maxResident?: number;
  /** Model sources to resolve a served id → gguf path. Default {@link defaultSources} (roster + an auto-detected
   *  LM Studio / Ollama store). The CLI passes the source list built from its flags. */
  readonly sources?: readonly Source[];
}

/**
 * The REAL constrained-decode seam (primitive 2 slim wiring). Uses `generateWithExplain` + ModelManager
 * for on-demand GGUF loading. Default is the pure kernel's constrained greedy path.
 *
 * Exposes DecodeFn so the OpenAI server (and thus BFCL harness) can treat the sampler like any other model.
 */
export function makeRealDecode(opts: RealDecodeOptions = {}): {
  decode: DecodeFn;
  dispose: () => Promise<void>;
  residentIds: () => string[];
  preload: (ids: readonly string[]) => Promise<string[]>;
} {
  // The source list + env are fixed for this server's lifetime: every id resolves against the same sources.
  const sources = opts.sources ?? defaultSources();
  const env = resolveEnv();
  const manager = new ModelManager<LlamaModelHandle>({
    // Loader: resolve the served id → gguf path, then load the handle. Runs once per resident lifetime; the
    // manager dedups concurrent same-id loads. `LlamaModelHandle.load` returns the handle directly — no cast.
    load: async (modelId: string): Promise<LlamaModelHandle> => {
      const { LlamaModelHandle } = await import("../local/server-generate.js");
      const ggufPath = resolveModelPath(modelId, sources, env);
      if (ggufPath === null) {
        throw new Error(
          `real-decode: cannot resolve model ${JSON.stringify(modelId)} to a .gguf (no matching file across ${sources.length} source(s))`,
        );
      }
      return LlamaModelHandle.load(ggufPath);
    },
    // Disposer: free the llama context/model/backend (Metal/RAM) via the handle's canonical async teardown
    // (`[Symbol.asyncDispose]` — context → model → llama). Called on idle offload, LRU eviction, shutdown.
    dispose: async (handle: LlamaModelHandle): Promise<void> => {
      await handle[Symbol.asyncDispose]();
    },
    ...(opts.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: opts.idleTimeoutMs }),
    ...(opts.maxResident === undefined ? {} : { maxResident: opts.maxResident }),
  });

  const decode: DecodeFn = async (args: DecodeArgs): Promise<string> => {
    // Lazy import: the server subpath is node-only (native addon). Never pulled into the test/browser graph.
    const { generateWithExplain } = await import("../local/server-generate.js");

    // Acquire (JIT-load or reuse) a resident handle. The lease keeps it from being offloaded mid-decode.
    const lease = await manager.acquire(args.model);
    try {
      // `generateWithExplain` still wants a ggufPath field (unused when a handle is supplied — it never reloads).
      // Resolve again (cheap fs check); the load above already proved it resolves.
      const ggufPath = resolveModelPath(args.model, sources, env);
      if (ggufPath === null) {
        throw new Error(`real-decode: model ${JSON.stringify(args.model)} vanished between load and decode`);
      }

      // The accepted program IS `generateWithExplain`'s return value (the final accepted prefix). No onExplain
      // accumulation needed — main's generateWithExplain returns the program string directly.
      const program = await generateWithExplain({
        prompt: args.userPrompt,
        grantEnv: args.grantEnv,
        ggufPath,
        systemPrompt: args.systemPrompt,
        // ABSTAIN UNLOCK: empty prefill (NOT `"("`). The top-level `"("` seed forced a tool call before the model
        // ever chose to call — blocking BFCL irrelevance + multi-turn (which need no-call turns) and manufacturing
        // calls that confound results. With no seed the model decides call-vs-abstain itself; if it calls, the Σ
        // oracle still constrains the form (the structural `(` opening a sub-expr INSIDE a committed call is the
        // grammar's, not this seed's, and is unchanged). A no-call / `(respond …)` result → handler prose path.
        // NB: `""` (not omitted) — `generateWithExplain`/`llamaCppGenerator` fall back to `prefill ?? "("`, and `??`
        // keeps `""` (only null/undefined trips it), so an empty string is the explicit "no force" the default isn't.
        prefill: "",
        // GRAMMAR mode (Σ-only). TODO(typed): wire `asyncTypeLens` here once the type layer rework lands — it
        // narrows each arg slot to its JSON-Schema-derived TS union (Σ∩T). The extension point is exactly this
        // call: build the lens from the tool schemas and pass `asyncTypeLens`. Left unwired by design.
        ...(args.maxNewTokens === undefined ? {} : { maxNewTokens: args.maxNewTokens }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
        // The managed handle: generateWithExplain reuses it (releases only this call's sequence slot, never the
        // shared model — the ModelManager owns the model's lifetime). Typed end-to-end via
        // ModelManager<LlamaModelHandle>, so it matches `handle` with NO cast.
        handle: lease.handle,
      });

      return program;
    } finally {
      lease.release();
    }
  };

  // Warm the resident cache: acquire then immediately release each id, so its handle is loaded + cached before
  // the first request. Best-effort — an id that fails to load (missing/corrupt gguf) is skipped, not fatal, so
  // the server still starts. The caller (cli.ts) sizes `maxResident` to hold the whole set, so warming one
  // model never LRU-evicts a previously-warmed one. (Idle offload still applies: a preloaded-but-never-hit
  // model is freed after `idleTimeoutMs`; preload buys instant FIRST hits, not permanent residency.)
  const preload = async (ids: readonly string[]): Promise<string[]> => {
    const warmed: string[] = [];
    for (const id of ids) {
      try {
        const lease = await manager.acquire(id);
        lease.release();
        warmed.push(id);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.warn(`[openai-server] preload: skipping ${JSON.stringify(id)} — ${reason}`);
      }
    }
    return warmed;
  };

  return {
    decode,
    dispose: () => manager.dispose(),
    residentIds: () => manager.residentIds(),
    preload,
  };
}
