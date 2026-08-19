// backends/types.ts — BACKEND CONTRACT (model+sequence as substrate).
//
// The device strategies drive. Knows nothing of constraints or policy. Exposes distribution,
// detokenize, commit, rewind, position. Used by all strategies.
//
//   stepDistribution() => the ranked best-first token distribution at the cursor (the per-step `dist`)
//   detokenize(id)     => id → string
//   commit(ids)        => append token(s) to the KV and advance `stepDistribution` to the successor
//   rewind(start, end) => KV-erase a token range (the primitive rollback/branch need)
//   position()         => the cursor index (nextTokenIndex)
//   eosIds             => the end-of-sequence id set
//
// WHY A BACKEND ABSTRACTION AT ALL. Two reasons, both load-bearing:
//   1. A strategy expressed against this interface is model-agnostic and (in principle) testable with a
//      scripted backend — no 5GB GGUF, no Metal. The greedy/rollback/beam policies differ only in WHICH
//      candidate strings they ask the kernel about and in what order; none of them should reach into
//      node-llama-cpp directly. (Reaching for the raw binding from a place that only needed the
//      distribution is exactly the coupling the architecture exists to remove.)
//   2. `rewind` names the ONE true in-memory reversal this binding offers (`eraseContextTokenRanges`),
//      which research rollback uses. Surfacing it as a named backend op (not an inline
//      `s.eraseContextTokenRanges` scattered through the loop) is what lets rollback compose cleanly.
//
// SCOPE NOTE: this is the autoregressive (llama.cpp) backend shape — it owns its decode loop and can
// `rewind`. (The historical transformers.js mask integration was different; the framework owned the loop.)
// Rollback etc. are deliberately not modelled for the old path.
//
// This is Node-only decode runtime (node-llama-cpp is a native addon), so it lives in `src/decode/`
// alongside the llama runner. It ships via `dist-server` and is excluded from the published browser
// `.` entry (tsconfig.json `exclude`).

import type { Token } from "node-llama-cpp";

import type { ForceEmitModel, ForceEmitSequence } from "../../../../force-emit.js";

/**
 * THE BACKEND CONTRACT — the model+sequence as data, the device a {@link DecodeStrategy} drives. Pure
 * substrate: no constraint, no policy. The token id type is the backend's own brand (llama's `Token`); a
 * strategy treats ids opaquely and only ever round-trips them through {@link detokenize} / {@link commit}.
 */
export interface DecodeBackend<Id extends number = Token> {
  /**
   * The ranked, best-first token distribution at the current cursor — the per-step distribution the decode
   * loop reads to pick a token. For the llama backend this is the full-vocab `Map<Token, number>` sorted by
   * probability descending (no native sampler applied), as returned by `controlledEvaluate`'s
   * `next.probabilities`. `undefined` when there is no successor distribution (the generator-`done`
   * analogue — e.g. before the first {@link commit} prefill, or after a commit that yielded none): the
   * strategy stops.
   *
   * The Map keys ARE the ranked ids (insertion order = rank); `entries().next()` is the argmax. A strategy
   * that wants only the top-K reads the first K keys without materializing the rest.
   */
  stepDistribution(): ReadonlyMap<Id, number> | undefined;

  /** Decode a single token id to its string. EOS / control ids detokenize to `""` on this binding; the
   *  strategy treats `""` as the end-here sentinel (gated via {@link eosIds}), never as a content string. */
  detokenize(id: Id): string;

  /**
   * Commit token id(s) into the KV and ADVANCE {@link stepDistribution} to the successor distribution after
   * the LAST committed token. One `controlledEvaluate` requesting `next.probabilities` only on the final id
   * (the shape both the prefill and the per-step advance use). Used for the prefill (the whole prompt), the
   * normal per-step single-token advance, and the multi-token force-emit commit.
   *
   * G3 RESTORE-OR-ABORT: if the underlying evaluate throws after advancing the KV past the pre-commit
   * boundary, the KV is rewound to that boundary before the error is rethrown — a dirty KV must never
   * silently corrupt the decode. (Research tooling: a failed eval is surfaced, never papered over.)
   */
  commit(ids: readonly Id[]): Promise<void>;

  /** Erase the committed-token range `[start, end)` from the KV (`eraseContextTokenRanges`) — the ONE true
   *  in-memory reversal this binding offers (used by research rollback/branch). A
   *  no-op when `end <= start`. Does NOT touch {@link stepDistribution} (the caller re-establishes it). */
  rewind(start: number, end: number): Promise<void>;

  /** The cursor position — the index of the next token to be committed (`nextTokenIndex`). The fork point a
   *  rollback strategy captures before a speculative commit and {@link rewind}s back to. */
  position(): number;

  /** The end-of-sequence id set (eos / eot / the resolved `<|eot_id|>`). A token in this set ends the
   *  program; it detokenizes to `""` and is gated by the strategy via closeability, never decoded as text. */
  readonly eosIds: ReadonlySet<Id>;

  /** The model as its MINIMAL surface ({@link ForceEmitModel}: `tokenize`/`detokenize`) — exactly what the
   *  force-emit round-trip and the explain bucketer touch, NOT the full node-llama handle. The real
   *  `LlamaModel` satisfies it structurally, so the llama backend exposes its handle unchanged; a scripted
   *  backend supplies a real stub (no `as unknown as`). A strategy that needs only the named ops ignores it. */
  readonly model: ForceEmitModel<Id>;

  /** The sequence as its MINIMAL surface ({@link ForceEmitSequence}: `nextTokenIndex` + `controlledEvaluate`
   *  + `eraseContextTokenRanges`) — exactly what `tryForceEmitSingleton` and the reversible `probeSuccessor`
   *  primitive touch, NOT the full node-llama handle. The named {@link commit}/{@link rewind}/{@link position}
   *  ops are the strategy-facing surface; this is the lower-level seam the force-emit + tier strategies use.
   *  The real `LlamaContextSequence` satisfies it structurally; a scripted backend supplies a real stub. */
  readonly seq: ForceEmitSequence<Id>;

  /**
   * Adopt a successor distribution produced OUT-OF-BAND (a commit run directly on {@link seq}, not through
   * {@link commit}) so {@link stepDistribution} follows it. The one caller is the singleton force-emit:
   * `tryForceEmitSingleton` commits the forced symbol on `seq` itself and returns the resulting distribution,
   * which the cached step distribution must then track (the inline loop did `dist = forced.dist`). It is on
   * the contract (not only the concrete class) because the SHARED greedy descent — which both the llama and
   * a scripted backend drive — runs the force-emit fast path; a backend that cannot force-emit (the scripted
   * test backend, which is never given a profile) implements it as a trivial cached-dist setter that is
   * never reached. A general strategy still never injects a distribution; this is the force-emit seam only.
   */
  adoptDistribution(dist: ReadonlyMap<Id, number> | undefined): void;
}
