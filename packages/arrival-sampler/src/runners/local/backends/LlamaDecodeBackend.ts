// LlamaDecodeBackend.ts — the live node-llama-cpp {@link DecodeBackend}.
//
// A concrete backend over a loaded `LlamaModel` + an acquired `LlamaContextSequence`. Holds the per-step
// distribution (`dist`) so `stepDistribution()` reads the cursor's successor and `commit` advances it.
// Node-only decode runtime (native addon) — ships via dist-server, excluded from the browser `.` entry.

import type { ControlledEvaluateInputItem, LlamaContextSequence, LlamaModel, Token } from "node-llama-cpp";

import type { DecodeBackend } from "./common/types.js";

/**
 * The live node-llama-cpp backend: a concrete {@link DecodeBackend} over a loaded `LlamaModel` + an
 * acquired `LlamaContextSequence`. Holds the per-step distribution (`dist`) so `stepDistribution()` reads
 * the cursor's successor and `commit` advances it — the same `dist` the inline loop threaded by hand.
 *
 * Construct it AFTER the prefill (so `dist` carries the first decode distribution), or with `dist`
 * undefined and call {@link commit} with the prompt to prefill. The runner's prefill already produces the
 * first distribution via its own `controlledEvaluate`; passing that as `initialDist` adopts the backend
 * transparently with zero extra evaluate.
 */
export class LlamaDecodeBackend implements DecodeBackend {
  readonly model: LlamaModel;
  readonly seq: LlamaContextSequence;
  readonly eosIds: ReadonlySet<Token>;
  private dist: ReadonlyMap<Token, number> | undefined;

  constructor(
    model: LlamaModel,
    seq: LlamaContextSequence,
    eosIds: ReadonlySet<Token>,
    initialDist?: ReadonlyMap<Token, number>,
  ) {
    this.model = model;
    this.seq = seq;
    this.eosIds = eosIds;
    this.dist = initialDist;
  }

  stepDistribution(): ReadonlyMap<Token, number> | undefined {
    return this.dist;
  }

  detokenize(id: Token): string {
    return this.model.detokenize([id]);
  }

  async commit(ids: readonly Token[]): Promise<void> {
    if (ids.length === 0) return;
    // Request the successor distribution ONLY after the LAST id (the shape the prefill + per-step advance
    // both use). G3 restore-or-abort: capture the boundary; on a failure that advanced the KV, erase back
    // to it before rethrowing so a dirty KV never corrupts the decode.
    const input: ControlledEvaluateInputItem[] = [
      ...ids.slice(0, -1),
      [ids.at(-1)!, { generateNext: { probabilities: true } }],
    ];
    const boundary = this.seq.nextTokenIndex;
    try {
      const out = await this.seq.controlledEvaluate(input);
      this.dist = out.at(-1)?.next.probabilities;
    } catch (error) {
      if (this.seq.nextTokenIndex > boundary) {
        await this.seq.eraseContextTokenRanges([{ start: boundary, end: this.seq.nextTokenIndex }]);
      }
      throw error;
    }
  }

  async rewind(start: number, end: number): Promise<void> {
    if (end > start) await this.seq.eraseContextTokenRanges([{ start, end }]);
  }

  position(): number {
    return this.seq.nextTokenIndex;
  }

  /**
   * Adopt a successor distribution produced OUT-OF-BAND (a commit run directly on {@link seq}, not through
   * {@link commit}). The one caller is the singleton force-emit: `tryForceEmitSingleton` tokenizes + round-
   * trip-guards + commits the forced symbol on `seq` itself and returns the resulting distribution; the
   * backend's cached `dist` must then follow (the inline loop did `dist = forced.dist`). On the
   * {@link DecodeBackend} contract because the shared greedy descent runs the force-emit fast path; a
   * general strategy still never injects a distribution — this is the force-emit seam only.
   */
  adoptDistribution(dist: ReadonlyMap<Token, number> | undefined): void {
    this.dist = dist;
  }
}
