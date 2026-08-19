// scripted-decode-backend.ts — A MODEL-FREE `DecodeBackend` driven by a canned script (the testability payoff).
//
// WHY THIS EXISTS (the whole point of the abstract `DecodeBackend`): a decode STRATEGY expressed against the
// abstract backend (distribution / detokenize / commit / rewind / position) is model-agnostic, so its WHOLE
// SEARCH can be exercised with NO 5GB GGUF, NO Metal, NO inference — just a canned `prefix → ranked
// distribution` map. `RollbackStrategy`'s backtracking (the rewind/restore/re-descend machinery the live
// path can only smoke-test) becomes deterministic and unit-testable here. This is the payoff §rollback's
// "build against the ABSTRACT backend, not the concrete llama one" demands.
//
// THE DRIVING MODEL: the script is keyed by the ACCEPTED PREFIX STRING. The backend reconstructs the live
// prefix by concatenating each committed token's string onto the initial prefill — exactly the `prefix` the
// shared `greedyDescend` grows — so `stepDistribution()` at any point returns `script.get(currentPrefix)`.
// A `rewind` truncates the committed-token list (restoring both the cursor position AND the reconstructed
// prefix), so re-descending a different arm from a fork reads the script the same way the model would have
// seen that fork — no re-evaluation, the cache/script IS the ground truth (the rollback contract).
//
// This lives in `src/decode/` beside the other backend runtime, but it carries NO node-llama-cpp dependency
// at all — its ids are plain `number` (it is a `DecodeBackend<number>`, the honest type of its synthetic
// script ids) and it imports only the `ForceEmitModel`/`ForceEmitSequence` TYPE surface — so the rollback
// test that drives it runs in the default `__tests__` gate with no native addon.

import type { ForceEmitModel, ForceEmitSequence } from "../../../force-emit.js";
import type { DecodeBackend } from "./common/types.js";

/** One ranked candidate in a scripted step distribution: its token id, probability, and decoded string.
 *  Entries are listed PROB-DESCENDING (the backend preserves order = the model's rank). An EOS entry uses
 *  the backend's `eosId` and an empty `str` (EOS carries no content). */
export interface ScriptEntry {
  readonly id: number;
  readonly prob: number;
  /** The decoded string of `id`. Empty for the EOS entry (gated via {@link ScriptedBackendSpec.eosId}). */
  readonly str: string;
}

/** An OPTIONAL synthetic tokenizer for the scripted backend's `model` surface. Supplied ONLY when a test
 *  drives a path that round-trips strings through the model (e.g. the fence preamble's `model.tokenize` /
 *  `detokenize` on the canonical opener). `tokenize(text)` returns the ids the test wants committed;
 *  `stringForId(id)` extends the backend's id→string table so those ids detokenize back. Omitted ⇒ the
 *  `model.tokenize` stub stays an honest throw (force-emit / fence never fire on that script). */
export interface ScriptedTokenizer {
  /** Map a string to the synthetic ids representing it (the bytes the test commits). */
  tokenize(text: string): number[];
  /** The decoded string for a synthetic id minted by {@link tokenize}, folded into the id→string table so a
   *  later `detokenize(id)` round-trips. Omit an id here ⇒ it detokenizes to "" (treated as an end sentinel). */
  stringForId(id: number): string;
}

/** The canned decode: a map from accepted-prefix STRING to that prefix's ranked step distribution, plus the
 *  prefill the decode starts from and the EOS id. A prefix absent from `steps` yields NO successor
 *  distribution (`stepDistribution() === undefined`) — the descent stops there (an unscripted dead end). */
export interface ScriptedBackendSpec {
  /** The accepted prefix the decode starts at (the strategy's `ctx.prefix` — `(` by default). */
  readonly prefill: string;
  /** prefix STRING → ranked candidates at that prefix (prob-descending). */
  readonly steps: ReadonlyMap<string, readonly ScriptEntry[]>;
  /** The single EOS token id (its entry, where present in a step, has `str: ""`). */
  readonly eosId: number;
  /** OPTIONAL synthetic tokenizer for the `model` surface (see {@link ScriptedTokenizer}). Supplied only when
   *  a test drives a model.tokenize/detokenize round-trip (the fence preamble); omitted ⇒ the tokenize stub
   *  throws (force-emit / fence never fire on that script), exactly as before. */
  readonly tokenizer?: ScriptedTokenizer;
}

/**
 * A `DecodeBackend` whose distributions come from a canned {@link ScriptedBackendSpec} rather than a model.
 * Tracks the committed token list; derives `position()` (its length) and the current prefix (prefill +
 * the committed strings) from it; `commit` appends, `rewind` truncates. `stepDistribution()` looks up the
 * current prefix in the script. Faithfully implements the rewind primitive rollback's search rests on.
 */
export class ScriptedDecodeBackend implements DecodeBackend<number> {
  readonly eosIds: ReadonlySet<number>;
  // The model/seq the abstract contract carries as their MINIMAL surface ({@link ForceEmitModel}/
  // {@link ForceEmitSequence}). The shared descent reaches `model.detokenize([id])` (via pickConstrained /
  // collectFeasibleRanked); we back it with the SAME id→string table as the backend's own `detokenize`, so
  // the two never disagree. `tokenize` + the whole `seq` are touched only by the force-emit fast path, which
  // never fires here (no profile is ever set on a scripted run) — so they are honest throwing stubs (NOT an
  // `as unknown as` cast over an empty object, which would have lied about a tokenizer/sequence existing).
  readonly model: ForceEmitModel<number>;
  readonly seq: ForceEmitSequence<number>;

  private readonly spec: ScriptedBackendSpec;
  // The id→string table. MUTABLE (a plain Map) because an optional {@link ScriptedTokenizer} mints fence ids
  // at `tokenize` time whose strings must be folded in so a later `detokenize` round-trips; without a
  // tokenizer it is filled once in the constructor and never written again (the prior `readonly` behaviour).
  private readonly idToStr: Map<number, string>;
  /** The committed tokens since the prefill, in order. `position()` = its length; the current prefix is the
   *  prefill plus each committed token's string. A rewind truncates this (in place); a commit appends to it
   *  — the binding never changes, so it is `readonly`. */
  private readonly committed: number[] = [];

  constructor(spec: ScriptedBackendSpec) {
    this.spec = spec;
    this.eosIds = new Set<number>([spec.eosId]);
    // Build the id→string table from every entry across every scripted step (the union — an id has one
    // canonical string). The EOS id maps to "" (the "end here" sentinel the descent gates out-of-band).
    const idToStr = new Map<number, string>([[spec.eosId, ""]]);
    for (const entries of spec.steps.values()) {
      for (const e of entries) if (!idToStr.has(e.id)) idToStr.set(e.id, e.str);
    }
    this.idToStr = idToStr;
    const tokenizer = spec.tokenizer;
    // The model stub: `detokenize([id]) → the canned string`. `tokenize` is reachable ONLY when a
    // {@link ScriptedTokenizer} is supplied (the fence-preamble test): it mints the ids and folds each id's
    // string into the table so `detokenize` round-trips. With NO tokenizer it stays an unreachable honest
    // throw (force-emit / fence never fire on a no-tokenizer script), exactly as before.
    this.model = {
      detokenize: (ids: readonly number[]): string => this.idToStr.get(ids[0]) ?? "",
      tokenize:
        tokenizer === undefined
          ? (): number[] => {
              throw new Error("[scripted-backend] tokenize is unreachable — no tokenizer on this script");
            }
          : (text: string): number[] => {
              const ids = tokenizer.tokenize(text);
              for (const id of ids) if (!this.idToStr.has(id)) this.idToStr.set(id, tokenizer.stringForId(id));
              return ids;
            },
    };
    // The seq is never reached (force-emit is its only caller and it is gated off here): all three
    // ForceEmitSequence members are honest throwing stubs, never an `as unknown as` over `{}`.
    this.seq = {
      nextTokenIndex: 0,
      controlledEvaluate: (): never => {
        throw new Error("[scripted-backend] controlledEvaluate is unreachable — force-emit is gated off");
      },
      eraseContextTokenRanges: (): never => {
        throw new Error("[scripted-backend] eraseContextTokenRanges is unreachable on the scripted path");
      },
    };
  }

  /** The current accepted prefix: the prefill plus every committed token's decoded string (EOS → "", but an
   *  EOS is never committed — the descent breaks on it). This IS the `prefix` the shared descent grows. */
  private currentPrefix(): string {
    let p = this.spec.prefill;
    for (const tok of this.committed) p += this.idToStr.get(tok) ?? "";
    return p;
  }

  stepDistribution(): ReadonlyMap<number, number> | undefined {
    const entries = this.spec.steps.get(this.currentPrefix());
    if (entries === undefined) return undefined; // unscripted prefix — a dead end; the descent stops.
    // Build a prob-DESCENDING Map<number, number> (insertion order = rank), the shape the live backend
    // returns. The script lists entries already prob-descending; preserve that order.
    const dist = new Map<number, number>();
    for (const e of entries) dist.set(e.id, e.prob);
    return dist;
  }

  detokenize(id: number): string {
    return this.idToStr.get(id) ?? "";
  }

  // The async signature matches the abstract contract; there is nothing to await on the scripted path (the
  // committed list IS the state), so the body is synchronous under the Promise return.
  commit(ids: readonly number[]): Promise<void> {
    for (const id of ids) this.committed.push(id);
    return Promise.resolve();
  }

  rewind(start: number, end: number): Promise<void> {
    // Truncate the committed list back to `start` tokens — restoring BOTH the cursor and the reconstructed
    // prefix to the fork. (The live backend erases the KV range; here the committed list IS the KV.) No-op
    // when nothing advanced (`end <= start`), matching the live backend's guard.
    if (end > start) this.committed.length = Math.min(start, this.committed.length);
    return Promise.resolve();
  }

  position(): number {
    return this.committed.length;
  }

  /** Force-emit's out-of-band distribution adopt — never reached on a scripted run (no profile ⇒ no force-
   *  emit), present only to satisfy the contract. A no-op: the script, not an injected dist, drives steps. */
  adoptDistribution(_dist: ReadonlyMap<number, number> | undefined): void {
    // intentionally empty — see the doc above.
  }
}
