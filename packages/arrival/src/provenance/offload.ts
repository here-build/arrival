/**
 * provenance/offload.ts — THE OFFLOAD PROTOCOL: γ is offloadable, and replay pins to
 * a semantics epoch. A wire (template hash) + frozen ingress payloads are
 * serializable by construction, so replay MAY execute in a stateless Worker outside
 * the DO — the DO serves records, workers serve drill-ins. The drill-in request
 * CARRIES the stream's semantics epoch; the worker refuses a mismatch, or runs a
 * sampled verification. Replay requires a matching epoch, or a sampled wire-γ
 * verification pass against recorded egresses before answers are trusted — silent
 * cross-version replay is EXCLUDED (a newer evaluator can lie politely).
 *
 * INTERFACE-LEVEL: `DrillInExecutor` is the protocol surface (any executor — same
 * process here, a stateless Worker in prod); no HTTP, no workerd. `SameProcessExecutor`
 * is the reference implementation the law rows below drive — it consumes `replay.ts`
 * (`replayGraphEgress`/`FrozenMints`/`boxPayload`/`ReplayScopeError`), `wireframe/hash.ts`
 * (`hashGraph`, to resolve a request's `templateHash` back to the graph it addresses),
 * and the store shapes (`Payload`/`EvidenceTier`/`TemplateHash`/`RegionId`) — READ-ONLY:
 * nothing here mutates or extends those modules.
 *
 * ── request/response serialization ──────────────────────────────────────────────
 * `DrillInRequest` is the self-contained request: `templateHash` (a per-GRAPH content
 * hash, addressing `WireframeProgram.main`, a `DefineTemplate.graph`, or a fan/binder's
 * private interior graph — `wireframe/hash.ts`'s own GRANULARITY RULING, reused
 * verbatim; "wire" and "region" are ONE addressing scheme at this granularity, not
 * two), `ingress` (frozen payloads — the graph's free `slot` bindings AND its interior
 * `source` nodes' recorded mint payloads, both as PLAIN `Payload`s: `{ value, stampIds,
 * retention? }`, never a boxed `SchemeValue` — boxing happens executor-side,
 * symmetrically with how `replay.ts`'s `FrozenMints`/`boxPayload` already box payloads
 * AT γ time, never before), and `streamEpoch` (the demanding stream's epoch header
 * value). `regionId` rides along too — not part of that three-item shape, but required
 * to seed the SAMPLED verification deterministically and to scope the executor's
 * per-stream trust cache below; it is itself a plain opaque string (`RegionId`), so the
 * request stays fully JSON-able/`structuredClone`-safe.
 *
 * `DrillInResponse` is "value + evidence tier + the epoch it was computed under":
 * `value` (the γ'd egress, already peeled — `replayGraphEgress`'s own
 * `ReplayedValue.value` contract), `evidenceTier` (always `"replayed"` here — offload
 * performs a LIVE γ, never a cache hit; memoization is `replay-memo.ts`'s concern,
 * layered IN FRONT of an executor, not this protocol's own concern), `epoch` (the
 * executor's OWN semantics epoch the value was actually computed under), and `trust`
 * (which disjunct below produced this answer — `"matched"` the ordinary case,
 * `"verified"` the sampled-verification case; load-bearing for the gate rows below,
 * which must assert BOTH disjuncts distinctly, not just that SOME answer came back).
 *
 * ── epoch refusal ────────────────────────────────────────────────────────────────
 * `drillIn` compares `request.streamEpoch` to `this.semanticsEpoch`. A mismatch with
 * no `verificationPool` attached (or `allowSampledVerification: false` at
 * construction) refuses via `EpochRefusalError` — a teaching door (errors-as-doors:
 * it names WHAT mismatched, WHY refusal is the default, and WHERE the second
 * disjunct is reachable from), never a silent stale-semantics answer.
 *
 * ── sampled wire-γ verification ──────────────────────────────────────────────────
 * When a `verificationPool` (recorded `templateHash`/`ingress`/`recordedEgress`
 * triples FROM THE SAME STREAM) accompanies a mismatched request, the executor MAY
 * verify instead of refusing outright: γ a DETERMINISTIC sample of the pool under its
 * OWN (current) semantics and compare each computed value against its recorded
 * egress. All agree ⇒ the stream is trusted going forward (`trustedStreams` caches
 * `regionId → streamEpoch`, so a later request need not re-supply/re-verify the same
 * pool) and this answer reports `trust: "verified"`. Any disagreement ⇒ refuse
 * (`EpochRefusalError`, reason `"verification-disagreed"`) — silently trusting a
 * PARTIALLY-diverged interpreter is exactly the "lie politely" failure this protocol
 * excludes.
 *
 * Sampling is DETERMINISTIC, seeded by `regionId` (no `Math.random` — unavailable by
 * design in some execution contexts, and nondeterminism breaks the protocol's
 * auditability) — `sampledIndices` below is a small seeded xorshift32 PRNG (advanced
 * from an FNV-1a seed over the seed string), the SAME "hand-rolled small hash, on
 * purpose, rather than pull in a dependency for four lines of math" idiom
 * `store/emit.ts`'s `hashPayload` already uses for the identical reason: this leaf has
 * no cause to depend on anything for a PRNG. Same `(seed, poolSize, sampleSize)` always
 * samples the identical indices — a verification's result is reproducible by anyone
 * re-running it, never a coin flip.
 */
import type { EnvironmentValue } from "../Environment.js";
import type { EnvCapability } from "../common/capability.js";
import { boxPayload, FrozenMints, replayGraphEgress, ReplayScopeError } from "./replay.js";
import { hashGraph } from "./wireframe/hash.js";
import type { RegionId, TemplateHash } from "./store/ids.js";
import type { EvidenceTier, Payload } from "./store/interfaces.js";
import type { WireframeGraph, WireframeProgram } from "./wireframe/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Wire format — plain, JSON-able, structuredClone-safe.
// ─────────────────────────────────────────────────────────────────────────────

/** One graph's frozen ingress, split exactly like `replay.ts`'s own two inputs to a
 *  graph γ: `slots` are the graph's FREE `slot` bindings (program ingress, or a
 *  template/track's formals — `ReplayGraphOptions.slots`), `sources` are the recorded
 *  mint payloads for the graph's INTERIOR `source` nodes, keyed by op, in EMISSION
 *  order (exactly what `FrozenMints.push` expects to replay FIFO-per-op). Both
 *  are plain `Payload`s (`{ value, stampIds, retention? }`) — never a boxed
 *  `SchemeValue`; boxing is an EXECUTOR-side step (`boxPayload`), same as every other
 *  γ face in `replay.ts`. */
export interface OffloadIngress {
  readonly slots: Readonly<Record<string, Payload>>;
  readonly sources: Readonly<Record<string, readonly Payload[]>>;
}

/** One prior recorded crossing an executor can re-γ to VERIFY its own semantics
 *  against, for the second disjunct: apply `templateHash`'s graph to `ingress` under
 *  the executor's CURRENT semantics and compare against `recordedEgress` (what the
 *  ORIGINAL semantics epoch actually produced). Drawn from the SAME stream as the
 *  demanding request — an executor has no business verifying against a foreign
 *  stream's history. */
export interface VerificationCandidate {
  readonly templateHash: TemplateHash;
  readonly ingress: OffloadIngress;
  readonly recordedEgress: unknown;
}

/** The self-contained drill-in demand: everything a STATELESS executor needs
 *  to γ one wire/region with ZERO shared state beyond its own static program
 *  deployment (an executor serves exactly ONE program version — program version =
 *  wireframe hash — so resolving `templateHash` needs no per-request context beyond
 *  what this struct carries). `verificationPool` is OPTIONAL — a caller that has no
 *  reason to expect a stale executor omits it and gets refusal-only behavior on
 *  mismatch; attaching one makes the second disjunct reachable. */
export interface DrillInRequest {
  readonly templateHash: TemplateHash;
  readonly ingress: OffloadIngress;
  readonly streamEpoch: string;
  readonly regionId: RegionId;
  readonly verificationPool?: readonly VerificationCandidate[];
}

/** "value + evidence tier + the epoch it was computed under", plus
 *  `trust` naming WHICH disjunct produced this answer (see file header). */
export interface DrillInResponse {
  readonly value: unknown;
  readonly evidenceTier: EvidenceTier;
  readonly epoch: string;
  readonly trust: "matched" | "verified";
}

// ─────────────────────────────────────────────────────────────────────────────
// The first disjunct — the teaching door refusal carries.
// ─────────────────────────────────────────────────────────────────────────────

/** The teaching door for both refusal paths: an outright mismatch with nothing to
 *  verify against, and a mismatch whose sampled verification disagreed. Names WHAT
 *  mismatched, WHY this executor refuses rather than answering, and (for the
 *  no-pool case) WHERE the second disjunct is reachable from — errors-as-doors, never
 *  a bare "epoch mismatch" string. */
export class EpochRefusalError extends Error {
  constructor(
    readonly requestEpoch: string,
    readonly executorEpoch: string,
    readonly regionId: RegionId,
    readonly reason: "no-verification-offered" | "verification-disabled" | "verification-disagreed",
    teach: string,
  ) {
    super(
      `offload: stream epoch mismatch (request="${requestEpoch}" executor="${executorEpoch}") ` +
        `for region "${regionId}" — ${teach}`,
    );
    this.name = "EpochRefusalError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The second disjunct — deterministic, seeded sampling.
// ─────────────────────────────────────────────────────────────────────────────

/** Default sample size when a caller doesn't override it at construction — small on
 *  purpose (interactive drill-ins want the epoch-upgrade decision fast; a wrong
 *  interpreter is expected to disagree on nearly everything, so a handful of
 *  candidates is enough signal, not exhaustive replay-and-compare of the whole
 *  stream). */
export const DEFAULT_SAMPLE_SIZE = 3;

/** FNV-1a seed — the SAME small hand-rolled hash idiom `store/emit.ts`'s
 *  `hashPayload`/`wireframe/hash.ts`'s `fnv1a` already use, a deliberately separate
 *  four-line copy (this leaf has no reason to import either for a PRNG seed). */
function fnvSeed(text: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return h >>> 0;
}

/** Deterministic (no `Math.random`), seeded partial Fisher–Yates: picks up to
 *  `sampleSize` DISTINCT indices in `[0, poolSize)`. `seed` is the stream id
 *  (`regionId`), so the SAME stream always samples the SAME positions of its own
 *  verification pool, and a verification's outcome is reproducible by anyone
 *  re-running it against the identical pool. A `xorshift32` advanced from the FNV-1a
 *  seed — small, dependency-free, and deterministic across platforms (unlike
 *  `Math.random`, which is unavailable by design in some execution contexts). Indices
 *  are returned SORTED ascending: sampling order carries no information here, only
 *  WHICH positions were sampled does. */
export function sampledIndices(seed: string, poolSize: number, sampleSize: number): readonly number[] {
  const n = Math.max(0, Math.min(sampleSize, poolSize));
  if (n === 0) return [];
  const pool = Array.from({ length: poolSize }, (_, i) => i);
  let state = fnvSeed(seed) || 1; // xorshift32 requires a nonzero state
  const nextUint32 = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  for (let i = 0; i < n; i++) {
    const j = i + (nextUint32() % (poolSize - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, n).sort((a, b) => a - b);
}

/** Structural agreement over plain, JSON-able values (the wire-format requirement
 *  above already guarantees every `value`/`recordedEgress` here qualifies) —
 *  the SAME "JSON.stringify, `String()` fallback on failure" idiom `store/emit.ts`'s
 *  `hashPayload` uses for exactly the same reason (a value that doesn't stringify
 *  cleanly still needs a stable-enough comparison, never a correctness-load-bearing
 *  one — every value flowing through this protocol is JSON-safe by construction). */
function valuesAgree(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return String(a) === String(b);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The protocol surface — interface-level.
// ─────────────────────────────────────────────────────────────────────────────

/** ANY executor — same-process here, a stateless Worker in prod (replay MAY execute
 *  in a stateless Worker outside the DO). No HTTP/workerd
 *  machinery is assumed by this interface; a real adapter wraps `drillIn` behind
 *  whatever transport it needs, unchanged. */
export interface DrillInExecutor {
  /** This executor's OWN interpreter version — what `request.streamEpoch` is compared
   *  against, and what a computed `DrillInResponse.epoch` actually reports. */
  readonly semanticsEpoch: string;
  drillIn(request: DrillInRequest): Promise<DrillInResponse>;
}

interface SameProcessExecutorOptions {
  /** The ONE program version this executor serves — every
   *  `templateHash` a request addresses must resolve to a graph reachable from here
   *  (`program.main`, a `program.templates` entry, or a fan/binder's private
   *  interior, recursively — `indexProgramGraphs` below). */
  readonly program: WireframeProgram;
  readonly semanticsEpoch: string;
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
  /** Executor-side POLICY: does this deployment ever attempt the second disjunct at
   *  all? Default `true`. `false` collapses this executor to refusal-only, even if a
   *  request attaches a `verificationPool` — an executor operator's own choice, not a
   *  per-request one (a caller cannot force verification the deployment disallows). */
  readonly allowSampledVerification?: boolean;
  readonly sampleSize?: number;
}

/** Recursively index every `WireframeGraph` reachable from `program` by its own
 *  `hashGraph` — `program.main`, every `DefineTemplate.graph`, and every fan/binder
 *  node's private interior graph, transitively (mirroring `hashGraph`'s OWN recursive
 *  canonicalization of those same interiors — see `wireframe/hash.ts`'s `canonicalNode`
 *  fan/binder cases). Two structurally-identical graphs at different sites dedupe to
 *  ONE index entry, which is exactly correct here: γ needs
 *  the STRUCTURE, and identical structure replays identically regardless of which site
 *  a request's `templateHash` happened to be minted from. */
function indexProgramGraphs(program: WireframeProgram): ReadonlyMap<TemplateHash, WireframeGraph> {
  const index = new Map<TemplateHash, WireframeGraph>();
  const visit = (graph: WireframeGraph): void => {
    const hash = hashGraph(graph);
    if (index.has(hash)) return;
    index.set(hash, graph);
    for (const node of graph.nodes) {
      if (node.kind === "fan" && node.template !== undefined) visit(node.template);
      else if (node.kind === "binder") visit(node.interior);
    }
  };
  visit(program.main);
  for (const template of program.templates.values()) visit(template.graph);
  return index;
}

/**
 * The reference `DrillInExecutor` — same process (tests drive this directly), the
 * shape a stateless Worker adapter wraps in prod. Holds no PER-REQUEST state: its only
 * mutable field (`trustedStreams`) is a second-disjunct optimization cache (a
 * verified stream need not re-verify on every subsequent request), not a correctness
 * dependency — clearing it just means the NEXT mismatched request re-verifies (or
 * refuses) instead of trusting instantly; no request's ANSWER depends on cache state.
 */
export class SameProcessExecutor implements DrillInExecutor {
  readonly semanticsEpoch: string;
  private readonly program: WireframeProgram;
  private readonly basePacks: readonly EnvCapability[];
  private readonly config?: object;
  private readonly allowSampledVerification: boolean;
  private readonly sampleSize: number;
  private readonly graphIndex: ReadonlyMap<TemplateHash, WireframeGraph>;
  /** The second disjunct's epoch-upgrade memory: `regionId → streamEpoch` for every
   *  stream this executor has already verified-trusted. Ephemeral (process lifetime),
   *  same status as `replay-memo.ts`'s memo — an optimization, never
   *  authoritative; losing it (a fresh executor instance) only costs a re-verification,
   *  never a wrong answer. */
  private readonly trustedStreams = new Map<RegionId, string>();

  constructor(opts: SameProcessExecutorOptions) {
    this.program = opts.program;
    this.semanticsEpoch = opts.semanticsEpoch;
    this.basePacks = opts.basePacks ?? [];
    this.config = opts.config;
    this.allowSampledVerification = opts.allowSampledVerification ?? true;
    this.sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
    this.graphIndex = indexProgramGraphs(opts.program);
  }

  async drillIn(request: DrillInRequest): Promise<DrillInResponse> {
    const { templateHash, ingress, streamEpoch, regionId } = request;
    const matches = streamEpoch === this.semanticsEpoch;
    const alreadyTrusted = this.trustedStreams.get(regionId) === streamEpoch;

    if (!matches && !alreadyTrusted) {
      if (!this.allowSampledVerification) {
        throw new EpochRefusalError(
          streamEpoch,
          this.semanticsEpoch,
          regionId,
          "verification-disabled",
          "this executor's deployment policy disallows sampled verification — " +
            "refusing outright via the first disjunct only; a request cannot opt this executor into the second disjunct",
        );
      }
      const pool = request.verificationPool;
      if (pool === undefined || pool.length === 0) {
        throw new EpochRefusalError(
          streamEpoch,
          this.semanticsEpoch,
          regionId,
          "no-verification-offered",
          "the request carried no `verificationPool` — refusing outright; attach " +
            "recorded (templateHash, ingress, recordedEgress) triples from this stream to make the second " +
            "disjunct (sampled wire-γ verification) reachable instead",
        );
      }
      const indices = sampledIndices(regionId, pool.length, this.sampleSize);
      for (const i of indices) {
        const candidate = pool[i];
        const computed = await this.computeEgress(candidate.templateHash, candidate.ingress);
        if (!valuesAgree(computed, candidate.recordedEgress)) {
          throw new EpochRefusalError(
            streamEpoch,
            this.semanticsEpoch,
            regionId,
            "verification-disagreed",
            `sampled wire-γ verification disagreed on template "${candidate.templateHash}" (sample index ${i} ` +
              `of ${pool.length}) — this executor's semantics ("${this.semanticsEpoch}") reproduce a DIFFERENT ` +
              `egress than the recorded run under "${streamEpoch}"; refusing rather than trusting a partially` +
              `-diverged interpreter — a newer evaluator lying politely is exactly what this protocol excludes`,
          );
        }
      }
      // Every sampled candidate agreed under this executor's OWN semantics: the
      // stream is trusted — cache the upgrade so later requests for this exact
      // (regionId, streamEpoch) pair skip re-verification.
      this.trustedStreams.set(regionId, streamEpoch);
    }

    const value = await this.computeEgress(templateHash, ingress);
    return {
      value,
      evidenceTier: "replayed",
      epoch: this.semanticsEpoch,
      trust: matches ? "matched" : "verified",
    };
  }

  /** γ one `templateHash`'s graph against `ingress`, reusing `replay.ts`'s machinery
   *  verbatim: thaw `ingress.sources` into a fresh `FrozenMints` (per-op FIFO keying),
   *  box `ingress.slots` (`boxPayload`, the same boxing idiom every other γ
   *  face uses), and hand both to `replayGraphEgress` against this executor's static
   *  program/base-packs/config. An unresolvable `templateHash` is a `ReplayScopeError`
   *  (the SAME teaching door the per-wire replay driver already uses for "nothing to
   *  replay here" — a foreign/stale hash is a caller bug or a program-version
   *  mismatch, never silently answered). */
  private async computeEgress(templateHash: TemplateHash, ingress: OffloadIngress): Promise<unknown> {
    const graph = this.graphIndex.get(templateHash);
    if (graph === undefined) {
      throw new ReplayScopeError(
        "template-ref",
        templateHash,
        `no graph in this executor's program matches template-hash "${templateHash}" — this executor serves ` +
          "exactly ONE program version (program version = wireframe hash); a foreign/stale template-hash " +
          "is a caller bug or a program-version mismatch, never silently answered",
      );
    }
    const frozen = new FrozenMints();
    for (const [op, payloads] of Object.entries(ingress.sources)) {
      for (const payload of payloads) frozen.push(op, payload);
    }
    const slots: Record<string, EnvironmentValue> = {};
    for (const [name, payload] of Object.entries(ingress.slots)) slots[name] = boxPayload(payload);
    const replayed = await replayGraphEgress({
      program: this.program,
      graph,
      frozen,
      slots,
      basePacks: this.basePacks,
      config: this.config,
    });
    return replayed.value;
  }
}
