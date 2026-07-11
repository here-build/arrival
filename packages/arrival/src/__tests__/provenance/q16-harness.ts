/**
 * Q16 (PROVENANCE-PLAN.md; docs/PROVENANCE.md §4 + §7) — the RECORD-THEN-REPLAY
 * harness the replay laws (`replay.law.test.ts`, `track-cone.law.test.ts`'s Q16 rows)
 * share. Where `w1-harness.ts` (Q9) compares two STATIC cones, this harness produces
 * the RETROSPECTIVE side a replay needs: a real run, with emission ON, whose membrane
 * crossings land as `MintRecord`s + payloads in the store fakes — then hands back the
 * frozen stream (`FrozenMints`) γ replays against.
 *
 * ── Q16 DESIGN CALL (harness-level, named in replay.ts's D1 too) ──────────────────
 * Per-crossing RecordId minting is the WIREFRAME-WALKING DRIVER's job (the eventual
 * real installer `eval/provenance-hooks.ts`'s own header names for Q15/Q16-era work
 * — it would advance a `RecordCoordinate` per designated node). That driver does not
 * exist at HEAD, and the ambient-coordinate hook path can only carry ONE static id
 * per run (all mints would upsert-collide on it). So this harness STANDS IN for the
 * walking driver at the one place per-crossing granularity is reachable today — the
 * source registration itself: each crossing awaits `emitMint` (the REAL Q11a
 * emission core, against the REAL store fakes, flag-gated like production) under a
 * distinct RecordId whose templateHash encodes the op (`q16:<op>`) and whose
 * ordinalPath carries the per-run crossing ordinal. The emission CORE, ids, seq
 * allocation, payload shape (§5 D2: value + stamp ids), and read-back path are all
 * the real ones; only the DECIDING-WHEN caller is the harness.
 */
import invariant from "tiny-invariant";

import type { ResolvingAmbient } from "../../AmbientRuntime.js";
import { AmbientRuntime, mintFrame } from "../../AmbientRuntime.js";
import { execState } from "../../eval/generator-exec.js";
import { collapseProvenance } from "../../provenance-collapse.js";
import { schemeToJs } from "../../rosetta.js";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { AValue } from "../../values/primitives/AValue.js";
import { emitMint, setEmissionEnabled } from "../../provenance/store/emit.js";
import { PayloadStoreFake, ProvenanceStoreFake } from "../../provenance/store/index.js";
import { FrozenMints } from "../../provenance/replay.js";
import type { Payload } from "../../provenance/store/interfaces.js";
import type { MintRecord } from "../../provenance/store/records.js";
import type { SchemeValue } from "../../values/types.js";
import { isEagerProvenanceOracleEnabled, setEagerProvenanceOracleEnabled } from "../../values/op-helpers.js";

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
  private ordinal = 0;
  /** Per-op live-invocation counts — the replay-nondeterminism laws assert a γ
   *  replay leaves every one of these at zero (the world was never consulted). */
  readonly calls = new Map<string, number>();

  constructor(
    readonly store: ProvenanceStoreFake,
    readonly payloads: PayloadStoreFake,
    readonly regionId: string,
    readonly regionEpoch: string = "e0",
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
   *  Migrated off the retired `env.defineRosetta` onto a test-local `EnvCapability`
   *  (`symbol.rosetta` verb — the migration target), same `inputRest: z.value` /
   *  `output: [z.value]` untyped-source shape w1-harness.ts's `SourceRegistry.register`
   *  uses: args decode to the raw scheme value (no automatic JS conversion), so this
   *  impl runs `schemeToJs` on each arg itself — mirroring the retired wrapper's
   *  automatic conversion exactly (research-env.ts's `buildResearchScope` idiom) — and
   *  the boxed, already-stamped return crosses back out untouched via the output escape
   *  hatch. */
  async register(env: AmbientRuntime, op: string, shape: RecordingShape): Promise<void> {
    const impl = symbol.rosetta`${op}: Q16 harness recording source`(
      { input: [], inputRest: z.value, output: [z.value] },
      // `any[]` rest param — the research-env.ts `buildResearchScope` boundary: a
      // `z.value` slot decodes to the raw SchemeValue, and `schemeToJs`'s generic
      // constraint (`T extends SchemeValue | null | undefined`) can't be satisfied by
      // an `unknown`-typed rest param without a cast; `any` here is the SAME erasure
      // `symbol.rosetta`'s own `rawImpl` boundary already performs one layer down.
      async (...args: any[]): Promise<unknown> => {
        args = args.map((a) => schemeToJs(a));
        this.calls.set(op, (this.calls.get(op) ?? 0) + 1);
        const callSeq = this.calls.get(op) ?? 1;
        let boxed: unknown;
        let peeled: unknown;
        let stampIds: number[];
        if (shape === "num") {
          const id = this.mint(op);
          boxed = stampedNum(id, id);
          peeled = id;
          stampIds = [id];
        } else if (shape === "str") {
          const id = this.mint(op);
          peeled = `${op}#${id}`;
          boxed = stampedStr(`${op}#${id}`, id);
          stampIds = [id];
        } else if (shape === "echo") {
          const id = this.mint(op);
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
            const id = this.mint(op);
            out[field] = stampedStr(`${op}.${field}#${id}`, id);
            peeledOut[field] = `${op}.${field}#${id}`;
            stampIds.push(id);
          }
          boxed = out;
          peeled = peeledOut;
        } else {
          const id = this.mint(op);
          peeled = shape.value(callSeq - 1);
          boxed =
            typeof peeled === "number"
              ? stampedNum(peeled, id)
              : stampedStr(String(peeled), id);
          stampIds = [id];
        }
        const record = await emitMint({
          store: this.store,
          payloads: this.payloads,
          regionId: this.regionId,
          id: { templateHash: `q16:${op}`, ordinalPath: [this.ordinal++], regionEpoch: this.regionEpoch },
          value: peeled,
          stampIds,
        });
        invariant(record !== undefined, "q16 harness: emitMint no-oped — setEmissionEnabled(true) must wrap the record run");
        return boxed;
      },
    );
    await new EnvCapability(`test/q16-source-${op}`, { symbols: { [op]: impl } }).lower({}).apply(env, undefined as never);
  }
}

/** One recorded crossing, read back THROUGH the store (never a side channel). */
export interface RecordedMint {
  readonly op: string;
  readonly record: MintRecord;
  readonly payload: Payload;
}

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
  for (const m of mints) frozen.push(m.op, m.payload);
  return frozen;
}

/**
 * THE record run: execute `code` in a fresh env (inheriting `baseEnv`'s assembled
 * base) with every source registered as a RECORDING source, emission flag ON for
 * exactly the run's extent; read the stream + payloads back through the store and
 * return the frozen retrospective side.
 */
export async function recordRun(
  baseEnv: ResolvingAmbient,
  code: string,
  sources: Record<string, RecordingShape>,
): Promise<RecordedRun> {
  const regionId = `q16-region-${runCounter++}`;
  const store = new ProvenanceStoreFake();
  const payloads = new PayloadStoreFake();
  const registry = new RecordingRegistry(store, payloads, regionId);
  const env = mintFrame(baseEnv, `q16-record-${regionId}`);
  for (const [op, shape] of Object.entries(sources)) registry.register(env, op, shape);

  // Q20b: production default is OFF — this run's `eagerCone` (the recorded-run's
  // ground truth the replay laws compare γ against) needs REAL accumulation, same as
  // w1-harness.ts's runEagerCone. Force ON for exactly the run's extent.
  const savedOracle = isEagerProvenanceOracleEnabled();
  setEagerProvenanceOracleEnabled(true);
  setEmissionEnabled(true);
  let values: readonly SchemeValue[];
  try {
    ({ values } = await execState(code, { env }));
  } finally {
    setEmissionEnabled(false);
    setEagerProvenanceOracleEnabled(savedOracle);
  }
  const egressBoxed = values[values.length - 1];

  const stream = await store.readStream(regionId);
  const mints: RecordedMint[] = [];
  for (const record of stream) {
    if (record.kind !== "mint") continue;
    const stored = await payloads.get(record.payloadHash);
    const payload: Payload = { value: stored.value, stampIds: stored.stampIds };
    const op = record.id.templateHash.startsWith("q16:") ? record.id.templateHash.slice(4) : record.id.templateHash;
    mints.push({ op, record, payload });
  }

  return {
    egress: schemeToJs(egressBoxed, {}),
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
