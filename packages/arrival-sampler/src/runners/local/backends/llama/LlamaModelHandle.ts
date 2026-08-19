// backends/llama/LlamaModelHandle.ts — the GGUF model SUBSTRATE of the node-llama-cpp backend: the loaded
// model+context+backend handle (with TC39 async disposal) and the stop-token set the decode loop gates on.
// This is the only piece of the backend that touches the native node-llama-cpp runtime (`getLlama`), so it
// ships via `dist-server` only. The generator (llama-cpp-generate.ts) imports + re-exports both symbols, so
// consumers (and the dist-server deep-import `mod.LlamaModelHandle.load`) are byte-unchanged.

import { getLlama, type Llama, type LlamaContext, type LlamaModel, type Token } from "node-llama-cpp";

import { buildEosTokenSet } from "./eos-tokens.js";

/**
 * A loaded GGUF model handle (model + context + the owning `Llama` backend), with TC39 async disposal.
 * Construct via {@link LlamaModelHandle.load} — the constructor is private, so a handle can only ever
 * exist fully-loaded. Dispose via `await using` or an explicit `await handle[Symbol.asyncDispose]()`:
 *
 *     await using handle = await LlamaModelHandle.load(modelPath);  // auto-freed at scope exit
 *     // ...reuse `handle` across many generateWithExplain calls...
 *
 * Loading the GGUF ONCE and reusing the handle avoids the ~7s per-call reload a load/dispose-per-call
 * would incur; each per-call generator frees only its own sequence slot, while the model+context+backend
 * outlive the calls and are released by the dispose above.
 */
export class LlamaModelHandle {
  private constructor(
    readonly modelPath: string,
    readonly llama: Llama,
    readonly model: LlamaModel,
    readonly context: LlamaContext,
  ) {}

  /** Load a GGUF on the Metal GPU. `contextSize` must hold the shared system prompt (~1.5k) + the task
   *  tail + the ≤maxNewTokens output — 2048 is comfortable for these short device intents. */
  static async load(modelPath: string, contextSize = 2048): Promise<LlamaModelHandle> {
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext({ contextSize });
    return new LlamaModelHandle(modelPath, llama, model, context);
  }

  /** Tear down the handle: context → model → llama. Invoked by `await using` or an explicit
   *  `await handle[Symbol.asyncDispose]()`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.context.dispose();
    await this.model.dispose();
    await this.llama.dispose();
  }
}

/**
 * The stop-token set for the decode loop: the model's own `eos`/`eot` PLUS the family's literal turn
 * `turnTerminator` (`FAMILY_TURN_TERMINATOR[family]` — `<|eot_id|>` for Llama-3, `<|im_end|>` for ChatML, …).
 * FAMILY-AWARE because node-llama-cpp's `model.tokens.eos`/`eot` frequently report a different id than the
 * template's turn-ender (Llama-3 ends turns with `<|eot_id|>`=128009 but `tokens.eot` reports
 * `<|end_of_text|>`=128001), so without the terminator natural stopping never fires. The terminator is
 * resolved as a SINGLE special token; a model whose vocab lacks it gets a warn + drop — never a spurious
 * content-token id (the bug this replaces: hardcoding `<|eot_id|>` for ALL families split it into content
 * tokens on a ChatML model and injected the first as an early-stop id).
 *
 * EXPORTED so the loop-parity test builds the IDENTICAL stop set the decode loop uses — its
 * generator-stepping reference must gate EOS-as-closer the exact same way (a different eos set would
 * diverge the moment the program becomes closeable).
 */
export function buildEosTokens(model: LlamaModel, turnTerminator: string | null): Set<Token> {
  return buildEosTokenSet(
    model.tokens.eos,
    model.tokens.eot,
    (text, special) => model.tokenize(text, special),
    turnTerminator,
  );
}
