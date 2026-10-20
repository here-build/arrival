/**
 * Q16 (docs/PROVENANCE.md §4 + §7) — the RECORD-THEN-REPLAY
 * harness the replay laws (`replay.law.test.ts`, `track-cone.law.test.ts`'s Q16 rows)
 * share. Where `w1-harness.ts` (Q9) compares two STATIC cones, this harness produces
 * the RETROSPECTIVE side a replay needs: a real run, with emission ON, whose membrane
 * crossings land as `MintRecord`s + payloads in the store fakes — then hands back the
 * frozen stream (`FrozenMints`) γ replays against.
 *
 * ── Q16 DESIGN CALL (harness-level, named in replay.ts's D1 too) ──────────────────
 * The hook path (`eval/provenance-hooks.ts`) mints a crossing's id from its closure-call WINDOW
 * (`[…enclosing, r_C, k, n]`, §3) but does not know the OP, which replay's per-op ingress needs.
 * So this harness STANDS IN for the hook at the one place the op is reachable — the source
 * registration itself: each crossing awaits `emitMint` (the REAL Q11a emission core, against the
 * REAL store fakes) under the id the hook would have minted (`mintId` over the call's own
 * `CallCtx.closureCall` window), with the templateHash carrying the op (`q16:<op>`). The run is
 * recorded with the program's REAL `closureSites` (wireframe over the same parse), so a record's
 * ordinal path names the TRACK it ran under — its coordinate — independent of when it completed.
 * Ids, seq allocation, payload shape (§5 D2: value + stamp ids), and read-back path are the real
 * ones; only the DECIDING-WHEN caller is the harness.
 */
import invariant from "tiny-invariant";
import type { AmbientRuntime, ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execStateOverFrame } from "../../eval/generator-exec.js";
import { collapseProvenance } from "../../provenance/provenance-collapse.js";
import { toJS, jsToScheme } from "../../membrane/rosetta.js";
import { CONSTANT_CTX, type RunEmission } from "../../run/RunContext.js";
import * as z from "../../common/scheme-zod/index.js";
import { EnvCapability } from "../../common/capability.js";
import { AValue } from "../../values/primitives/AValue.js";
import { compareOrdinalPaths } from "../../provenance/store/ids.js";
import { emitMint } from "../../provenance/store/emit.js";
import { currentCallNode, currentClosureCall } from "../../eval/dynamic-call-site.js";
import { scopeId } from "../../provenance/scope-id.js";
import { mintId } from "../../eval/provenance-hooks.js";
import { parseProgram } from "../../eval/exec-phases.js";
import { buildWireframe, type WireframeBuildOptions } from "../../provenance/wireframe/builder.js";
import type { Classifier } from "../../provenance/lineage.js";
import { CORPUS_BASE_NAMES, CORPUS_ROLES } from "./w1-corpus.js";
import { PayloadStoreFake, ProvenanceStoreFake } from "../../provenance/store/fakes.js";
import { FrozenMints, trackOfRecord, type PlaybackEntry, type TrackPath } from "../../provenance/replay.js";
import type { Payload } from "../../provenance/store/interfaces.js";
import type { MintRecord } from "../../provenance/store/records.js";
import type { SchemeValue } from "../../values/types.js";
import { applyCapability } from "../_fresh-env.js";
import type { CallCtx } from "../../run/CallCtx.js";

// Same stamped-value constructors as w1-harness.ts (local copies, same rationale).
const stampedStr = (s: string, p: number): SchemeValue => z.string.encode(s).withProvenance(new Set([p]));
const stampedNum = (n: number, p: number): SchemeValue => z.number.encode(n).withProvenance(new Set([p]));

/** What a recording source returns per crossing:
 *  - `num`  — a fresh numeric mint (value = the mint id; distinct per crossing);
 *  - `str`  — `"<op>#<id>"`;
 *  - `dict` — one stamped string per field (ids per field, ONE mint record whose
 *    payload value is the whole dict — §3 I5's "no per-field port" LIMIT);
 *  - `echo` — the crossing's own (peeled) argument, re-stamped with a fresh mint id:
 *    the EFFECT-port shape (an `emit!`-style crossing observed with a payload);
 *  - custom — `{ value: (callSeq) => unknown }`, for mutated-world variants that
 *    must answer deterministically differently than the recorded world did. */
export type RecordingShape =
  | "num"
  | "str"
  | "echo"
  | { readonly dict: readonly string[] }
  | { readonly value: (callSeq: number) => unknown };

/** The eager-oracle + emission side in one object: mints fresh stamped values like
 *  Q9's `SourceRegistry` (so eager cones still project ids → op names), AND lands
 *  every crossing as a real `MintRecord` + payload through Q11a's `emitMint`. */
export class RecordingRegistry {
  private nextId = 1;
  private readonly idToOp = new Map<number, string>();
  /** Per-op live-invocation counts — the replay-nondeterminism laws assert a γ
   *  replay leaves every one of these at zero (the world was never consulted). */
  readonly calls = new Map<string, number>();

  constructor(
    readonly store: ProvenanceStoreFake,
    readonly payloads: PayloadStoreFake,
    readonly regionId: string,
    /** Live-completion scheduler (a LAW's lever): when set, every source call waits for it before
     *  the world answers, so the order in which concurrent tracks' crossings COMPLETE is chosen. */
    readonly completion?: CompletionScheduler,
  ) {}

  private mint(op: string): number {
    const id = this.nextId++;
    this.idToOp.set(id, op);
    return id;
  }

  /** ids → declared op names (the shared vocabulary) — `SourceRegistry.opsOf`. */
  opsOf(ids: ReadonlySet<number>): Set<string> {
    const out = new Set<string>();
    for (const id of ids) {
      const op = this.idToOp.get(id);
      if (op !== undefined) out.add(op);
    }
    return out;
  }

  /** Register one RECORDING source on `env`: every crossing mints a stamped value
   *  (eager-oracle side) and awaits a real `emitMint` under a distinct RecordId
   *  (retrospective side) — see the module header's design call.
   *
   *  Uses a test-local `EnvCapability` with a `symbol.native` verb declared
   *  `provenance: "source"` — same WORLD-FLIP REBASELINE as w1-harness.ts's
   *  `SourceRegistry.register` (ruling 2026-08-13): a rosetta impl may not return an
   *  already-stamped `AValue`, and this fake source's whole point is minting its OWN
   *  stamps — a scheme-world act, so the native contour (`z.schemeValue` slots, no
   *  membrane, no auto-mint) is the honest home. Args arrive as raw scheme values;
   *  the impl runs `toJS` on each itself, as before. */
  async register(env: AmbientRuntime, op: string, shape: RecordingShape): Promise<void> {
    const registry = this;
    await applyCapability(env, [
      EnvCapability.define(`test/q16-source-${op}`, {
        symbols: (symbol) => ({
          [op]: symbol.native`${op}: Q16 harness recording source`(
            { input: [], inputRest: z.schemeValue, output: [z.schemeValue], provenance: "source" },
            // `any[]` rest param — a `z.schemeValue` slot hands over the raw SchemeValue, and
            // `toJS`'s generic constraint (`T extends SchemeValue | null | undefined`) can't be
            // satisfied by an `unknown`-typed rest param without a cast; `any` here is the SAME
            // erasure the factory's own impl boundary already performs one layer down.
            async function (this: CallCtx, ...args: any[]): Promise<SchemeValue> {
              args = args.map((a) => toJS(a));
              // The record id is claimed at call START (as the hook does for an async crossing): a
              // fan starts its calls in index order, but they COMPLETE in whatever order the world answers.
              const emission = this.runCtx.emission;
              invariant(emission !== undefined, `q16 source "${op}" ran outside a recording run`);
              const recordId = {
                ...mintId(emission, this.closureCall ?? currentClosureCall(this.runCtx)),
                // The op AND the static call site ride the template hash (store records carry no more).
                templateHash: `q16:${op}|${scopeId(currentCallNode(this.runCtx))}`,
              };
              await registry.completion?.admit(op);
              registry.calls.set(op, (registry.calls.get(op) ?? 0) + 1);
              const callSeq = registry.calls.get(op) ?? 1;
              let boxed: unknown;
              let peeled: unknown;
              let stampIds: number[];
              if (shape === "num") {
                const id = registry.mint(op);
                boxed = stampedNum(id, id);
                peeled = id;
                stampIds = [id];
              } else if (shape === "str") {
                const id = registry.mint(op);
                peeled = `${op}#${id}`;
                boxed = stampedStr(`${op}#${id}`, id);
                stampIds = [id];
              } else if (shape === "echo") {
                const id = registry.mint(op);
                const arg = args[0];
                invariant(typeof arg === "number", `q16 echo source "${op}" expects a numeric argument`);
                boxed = stampedNum(arg, id);
                peeled = arg;
                stampIds = [id];
              } else if ("dict" in shape) {
                const out: Record<string, unknown> = {};
                const peeledOut: Record<string, unknown> = {};
                stampIds = [];
                for (const field of shape.dict) {
                  const id = registry.mint(op);
                  out[field] = stampedStr(`${op}.${field}#${id}`, id);
                  peeledOut[field] = `${op}.${field}#${id}`;
                  stampIds.push(id);
                }
                // A native returns a scheme value — box the dict payload here (run-neutral
                // mint; stamped leaves ride jsToScheme's owned pass-through).
                boxed = jsToScheme(CONSTANT_CTX, out);
                peeled = peeledOut;
              } else {
                const id = registry.mint(op);
                peeled = shape.value(callSeq - 1);
                boxed = typeof peeled === "number" ? stampedNum(peeled, id) : stampedStr(String(peeled), id);
                stampIds = [id];
              }
              await emitMint({
                store: registry.store,
                payloads: registry.payloads,
                regionId: registry.regionId,
                id: recordId,
                value: peeled,
                stampIds,
              });
              return boxed as SchemeValue;
            },
          ),
        }),
      }),
    ]);
  }
}

function splitOnce(text: string, sep: string): [string, string] {
  const at = text.indexOf(sep);
  return [text.slice(0, at), text.slice(at + 1)];
}

/** One recorded crossing, read back THROUGH the store (never a side channel). */
export interface RecordedMint {
  readonly op: string;
  readonly record: MintRecord;
  readonly payload: Payload;
  /** The track (closure/fan-lambda call) the crossing ran under, relative to the run's root. */
  readonly track: TrackPath;
  /** The static crossing site: `scopeId` of the call expression the source ran under (a HOF's own
   *  call for its element callbacks) — what a γ demand names. */
  readonly site: string;
}

/** The run's root coordinate path (`RunEmission.coordinate`) — track paths are relative to it. */
export const RECORD_ROOT: readonly number[] = [0];

/** A finished record run: the program's egress (both faces), its eager cone, the
 *  recorded crossings in seq order, a ready-to-γ `FrozenMints`, and the live
 *  stores/registry for follow-up assertions. */
export interface RecordedRun {
  readonly egress: unknown;
  readonly egressBoxed: SchemeValue;
  readonly eagerCone: Set<number>;
  readonly mints: readonly RecordedMint[];
  readonly frozen: FrozenMints;
  readonly store: ProvenanceStoreFake;
  readonly payloads: PayloadStoreFake;
  readonly registry: RecordingRegistry;
  readonly regionId: string;
}

let runCounter = 0;

/** Build a fresh `FrozenMints` from recorded crossings (seq order) — separate from
 *  `recordRun` so a law can thaw the SAME stream twice (FIFO queues are consumed). */
export function freezeMints(mints: readonly RecordedMint[]): FrozenMints {
  const frozen = new FrozenMints();
  for (const m of inCallOrder(mints)) frozen.push(m.op, m.payload, m.track, m.site);
  return frozen;
}

/** Recorded mints in CALL-START order (their record-id ordinals). The stream is in COMPLETION order;
 *  within one track calls are sequential and a fan starts its calls in index order, so start order is
 *  the deterministic one a replay's FIFO per (op, track) must be fed in. */
export function inCallOrder(mints: readonly RecordedMint[]): RecordedMint[] {
  return mints.toSorted((a, b) => compareOrdinalPaths(a.record.id.ordinalPath, b.record.id.ordinalPath));
}

/** The whole-program playback face of a record: per-op payloads in stream order, each addressed by track. */
export function playbackOf(run: { readonly mints: readonly RecordedMint[] }): Map<string, PlaybackEntry[]> {
  const playback = new Map<string, PlaybackEntry[]>();
  for (const m of inCallOrder(run.mints)) {
    const entry: PlaybackEntry = { ...m.payload, track: m.track, site: m.site };
    const q = playback.get(m.op);
    if (q === undefined) playback.set(m.op, [entry]);
    else q.push(entry);
  }
  return playback;
}

/** Fan hosts the corpus's base-name set does not list — resolvable in the hermetic base env. */
const FAN_HOST_NAMES: ReadonlySet<string> = new Set([
  "vector",
  "vector-map",
  "vector-for-each",
  "for-each",
  "string-for-each",
]);

/** The wireframe options a record run builds its closure sites with by default: the corpus's declared
 *  roles, every recorded source a `source`. A replay passes the SAME options (`wireframe`). */
export function recordWireframe(sources: Record<string, RecordingShape>): WireframeBuildOptions {
  const classifier: Classifier = { roleOf: (op) => (op in sources ? "source" : CORPUS_ROLES[op]) };
  return { classifier, isBaseName: (n) => CORPUS_BASE_NAMES.has(n) || FAN_HOST_NAMES.has(n) };
}

/**
 * Chooses the order concurrent source calls COMPLETE in. Each call parks in `admit`; whenever the
 * program is quiescent (a macrotask hop ⇒ every microtask-driven track has run to its next crossing)
 * the scheduler releases ONE parked call, picked by `pick` from the park order. Logical, not
 * wall-clock: the schedule is identical under any CPU load.
 */
export class CompletionScheduler {
  private readonly parked: (() => void)[] = [];
  private pumping = false;

  constructor(private readonly pick: (parked: number) => number) {}

  /** FIFO (calls complete in the order they began). */
  static forward(): CompletionScheduler {
    return new CompletionScheduler(() => 0);
  }

  /** LIFO — the latest-started parked call completes first. */
  static reverse(): CompletionScheduler {
    return new CompletionScheduler((n) => n - 1);
  }

  /** Seeded pseudo-random (mulberry32). */
  static seeded(seed: number): CompletionScheduler {
    let a = seed >>> 0;
    return new CompletionScheduler((n) => {
      a = (a + 0x6d_2b_79_f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * n);
    });
  }

  admit(_op: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.parked.push(resolve);
      if (!this.pumping) void this.pump();
    });
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.parked.length > 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
        const [release] = this.parked.splice(this.pick(this.parked.length), 1);
        release();
      }
    } finally {
      this.pumping = false;
    }
  }
}

/**
 * THE record run: execute `code` in a fresh env (inheriting `baseEnv`'s assembled
 * base) with every source registered as a RECORDING source (they call `emitMint` directly — no
 * enable flag exists, P19); read the stream + payloads back through the store and
 * return the frozen retrospective side.
 */
export async function recordRun(
  baseEnv: ResolvingAmbient,
  code: string,
  sources: Record<string, RecordingShape>,
  opts: { readonly wireframe?: WireframeBuildOptions; readonly completion?: CompletionScheduler } = {},
): Promise<RecordedRun> {
  const regionId = `q16-region-${runCounter++}`;
  const store = new ProvenanceStoreFake();
  const payloads = new PayloadStoreFake();
  const registry = new RecordingRegistry(store, payloads, regionId, opts.completion);
  const env = baseEnv.child(`q16-record-${regionId}`);
  for (const [op, shape] of Object.entries(sources)) await registry.register(env, op, shape);

  // The wireframe and the evaluator share ONE parse: closure sites are keyed by pair identity.
  const program = await parseProgram(code);
  const emission: RunEmission = {
    store,
    payloads,
    regionId,
    coordinate: { templateHash: "q16", ordinalPath: RECORD_ROOT, regionEpoch: "e0" },
    closureSites: buildWireframe(program.forms, opts.wireframe ?? recordWireframe(sources)).closureSites,
  };
  const { values } = await execStateOverFrame(code, { env, eagerStamps: true, emission, program });
  const egressBoxed = values[values.length - 1];

  const stream = await store.readStream(regionId);
  const mints: RecordedMint[] = [];
  for (const record of stream) {
    // Only the harness's own source crossings (`q16:<op>`); the hook's rosetta mints carry no op.
    if (record.kind !== "mint" || !record.id.templateHash.startsWith("q16:")) continue;
    const stored = await payloads.get(record.payloadHash);
    const payload: Payload = { value: stored.value, stampIds: stored.stampIds };
    const [op, site] = splitOnce(record.id.templateHash.slice(4), "|");
    mints.push({
      op,
      site,
      record,
      payload,
      track: trackOfRecord(record.id.ordinalPath, RECORD_ROOT),
    });
  }

  return {
    egress: toJS(egressBoxed, {}),
    egressBoxed,
    eagerCone: collapseProvenance(egressBoxed),
    mints,
    frozen: freezeMints(mints),
    store,
    payloads,
    registry,
    regionId,
  };
}

/** The replayed cone's ids, off a boxed γ egress — I1/I3's comparison surface. */
export function replayedCone(boxed: SchemeValue): Set<number> {
  return boxed instanceof AValue ? collapseProvenance(boxed) : new Set<number>();
}
