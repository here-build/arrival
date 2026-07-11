/**
 * LAW — wire-γ, replay-nondeterminism, pure-mux derivation, effect-track
 * replay-between-records (docs/PROVENANCE.md §4 "Regions and replay", §7 law table;
 * docs/PROVENANCE-PLAN.md Q16). ALL FOUR FLIPPED at Q16.
 *
 * R1 FRAMING (§4 CHOSEN, quoted — not a separate §7 row, but the ruling every law below
 * depends on): "replay from frozen port payloads is stable. Replay NEVER re-invokes a
 * source; retrospective mint records are authoritative... Replay AVAILABILITY is
 * tier-governed: stability is claimed for whatever the tiers still hold, never past
 * them." Every row below is a facet of this one ruling — wire-γ is R1 restricted to
 * loop-free pure wires; replay-nondeterminism is R1 under an adversarial external
 * world; pure-mux-derivation is R1 applied to the decisions A2 collapsed out of the
 * record stream; effect-track replay-between-records is R1's interleaving discipline
 * for tracks that DO have port events to replay verbatim.
 *
 * MACHINERY (this wave's): `provenance/replay.ts` (the three replay faces + its D1-D4
 * design calls), `provenance/gamma.ts`'s boxed γ extension, `q16-harness.ts` (record
 * runs with emission ON through the REAL Q11a emit core + store fakes). The corpus is
 * Q9's `w1-corpus.ts`, reused: the SAME programs whose cones W1 proved now prove their
 * VALUES replay.
 *
 * Q9-FINDINGS DISCIPLINE (task-mandated): none of the rows below silently depends on
 * the six Q9 findings. The HOF-source hole (finding 5) and field-projection over-
 * inclusion (finding 6) are cone/designation gaps — the corpus rows here avoid HOF
 * source references, and field rows are asserted on VALUE equality only (the
 * per-field stamp granularity a dict mint record cannot carry is named at the dict
 * row). The begin-sink finding (3) is deliberately EXERCISED in track-cone.law's
 * effect rows, where replay is shown to be MORE precise than the abstract cone.
 */
import * as fc from "fast-check";
import { mintFrame } from "../../AmbientRuntime.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initBridge } from "../../index.js";
import { execState, parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../inference-env.js";
import { schemeToJs } from "../../rosetta.js";
import type { Classifier } from "../../values/lineage.js";
import { buildWireframe } from "../../provenance/wireframe/builder.js";
import { freeVars } from "../../provenance/wireframe/free-vars.js";
import { hermeticEnv } from "../../provenance/hermetic-env.js";
import {
  FrozenMints,
  ReplayScopeError,
  SENTINEL_BASE,
  boxPayload,
  replayBetweenRecords,
  replayGraphEgress,
  replayProgramWithPlayback,
} from "../../provenance/replay.js";
import { setEmissionEnabled } from "../../provenance/store/emit.js";
import type { Payload } from "../../provenance/store/interfaces.js";
import type { EmittedWire, WireframeGraph } from "../../provenance/wireframe/types.js";
import { symbol, type RosettaSymbolDef } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import * as z from "../../common/scheme-zod.js";
import { prospectiveSourceCone } from "./w1-harness.js";
import { CORPUS_BASE_NAMES, CORPUS_ROLES, W1_CORPUS, genLinearProgram, type CorpusEntry } from "./w1-corpus.js";
import { freezeMints, recordRun, replayedCone, type RecordedRun, type RecordingShape } from "./q16-harness.js";

const corpusClassifier: Classifier = { roleOf: (op) => CORPUS_ROLES[op] };
const corpusIsBaseName = (n: string): boolean => CORPUS_BASE_NAMES.has(n);

async function wfCorpus(code: string) {
  const forms = await parse(code);
  return buildWireframe(forms, { classifier: corpusClassifier, isBaseName: corpusIsBaseName });
}

/** Per-op payload queues for the whole-program playback face. */
function playbackOf(run: RecordedRun): Map<string, Payload[]> {
  const playback = new Map<string, Payload[]>();
  for (const m of run.mints) {
    const q = playback.get(m.op);
    if (q === undefined) playback.set(m.op, [m.payload]);
    else q.push(m.payload);
  }
  return playback;
}

/** The corpus rows the PER-WIRE γ composition claims (loop-free, fan-free — §1's
 *  adjunction scope). `nested-regions` rows replay as regions/whole-program (fan =
 *  D4 teaching door in the per-wire driver); `loop-programs` are the half wire-γ
 *  does NOT claim (asserted separately below). */
const PER_WIRE_CLASSES = new Set<CorpusEntry["klass"]>([
  "interior-sources",
  "structured-multi-field-egress",
  "field-access-chains",
  "prelude-helpers",
  "port-coupled-mux",
  "pure-mux",
  "deep-mux-nesting",
]);

beforeAll(async () => {
  await initBridge();
});

afterEach(() => {
  setEmissionEnabled(false); // module-global flag; recordRun restores, this is the belt+braces
});

describe("wire-γ (§4 CHOSEN: the frame is abstract interpretation, loop-free scope)", () => {
  // @ledger: Q16 — FLIPPED. apply(wire, recorded ingress) = recorded egress, per wire,
  // composed over the whole graph: sources bind their FROZEN mint payloads (never
  // re-invoked — the hermetic env doesn't even contain them), every wire between
  // designated nodes is γ'd (gamma.ts's applyWireInEnv), and the graph's egress must
  // reproduce the record run's egress exactly. eval∘uneval = id on pure segments.
  describe.each(W1_CORPUS.filter((e) => PER_WIRE_CLASSES.has(e.klass)))(
    "loop-free adjunction: $klass / $name",
    (entry) => {
      it(`${entry.code}`, async () => {
        const run = await recordRun(inferenceEnv, entry.code, entry.sources);
        const program = await wfCorpus(entry.code);
        const replayed = await replayGraphEgress({ program, frozen: run.frozen });
        expect(replayed.value).toEqual(run.egress);
        // D2's non-flow half: a sentinel (an untaken arm's unrecorded ingress) never
        // reaches the egress — the recorded run's value is derivable WITHOUT it.
        for (const id of replayedCone(replayed.boxed)) {
          expect(id, `sentinel leaked into the replayed egress cone`).toBeLessThan(SENTINEL_BASE);
        }
      });
    },
  );

  // @ledger: Q16 — FLIPPED (generative extension, mirroring W1's own property row):
  // random non-mux pipe/merge/let programs — the exact-equality claim, per wire.
  it("property: random non-mux source pipe/merge programs replay exactly, over 12 generated programs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2 ** 31 - 1 }), async (seed) => {
        const { code, sources } = genLinearProgram(seed);
        const sourceShapes: Record<string, RecordingShape> = {};
        for (const s of sources) sourceShapes[s] = "num";
        const run = await recordRun(inferenceEnv, code, sourceShapes);
        const program = await wfCorpus(code);
        const replayed = await replayGraphEgress({ program, frozen: run.frozen });
        expect(replayed.value, `program: ${code}`).toEqual(run.egress);
      }),
      { numRuns: 12 },
    );
  });

  // @ledger: Q16 — FLIPPED. Wire purity is by CONSTRUCTION (§1 collapse rule): no
  // interior source/sink/port-coupled mux survives inside any wire body, so γ needed
  // nothing beyond the wire's own closure — proven two ways: (1) no declared-role op
  // is FREE in any emitted wire body (they were all cut to nodes); (2) the hermetic
  // env the rows above replayed in binds NO source op at all — had a wire smuggled
  // one, γ would have hit an unbound variable instead of reproducing the egress.
  it("wire-γ subsumes segment losslessness — no interior source/sink/gensym/port-coupled mux inside a wire body", async () => {
    let wiresChecked = 0;
    for (const entry of W1_CORPUS.filter((e) => PER_WIRE_CLASSES.has(e.klass))) {
      const program = await wfCorpus(entry.code);
      const graphs: WireframeGraph[] = [program.main, ...[...program.templates.values()].map((t) => t.graph)];
      for (const g of graphs) {
        for (const w of g.wires) {
          const [lam] = await parse(w.source);
          for (const name of freeVars(lam)) {
            expect(
              CORPUS_ROLES[name],
              `declared-role op "${name}" is FREE in wire ${w.source} — it should have been cut to a node`,
            ).toBeUndefined();
          }
          wiresChecked++;
        }
      }
    }
    expect(wiresChecked).toBeGreaterThan(0);

    // (2) the replay env is source-free: γ can only answer from frozen ingress.
    const program = await wfCorpus(`(+ (src-a) 1)`);
    const env = await hermeticEnv([], program.prelude.source);
    for (const op of Object.keys(CORPUS_ROLES)) {
      if (CORPUS_ROLES[op] === "source") {
        expect(env.get(op, { throwError: false }), `"${op}" must NOT resolve in the hermetic replay env`).toBeUndefined();
      }
    }
  });

  // @ledger: Q16 — FLIPPED. Loops: the per-wire driver REFUSES the binder (teaching
  // door — §1 EXCLUDED: "widening makes loop cones non-least"; wire-γ never claims
  // the loop-carrying half), and exact reconstruction is ONE γ-STEP AWAY via
  // aggregation count + quoted body: the recorded stream carries exactly count
  // payloads, and whole-program playback of the quoted body reproduces the egress.
  it("loops: per-wire γ refuses (not claimed); aggregation count + quoted body reconstructs exactly, one γ-step away", async () => {
    const entry = W1_CORPUS.find((e) => e.klass === "loop-programs");
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const run = await recordRun(inferenceEnv, entry.code, entry.sources);
    // the aggregation count: the loop crossed its interior source once per iteration
    // (i = 0..3 under the corpus's literal bound) — 4 recorded payloads.
    expect(run.mints).toHaveLength(4);

    // (a) the per-wire driver names the refusal — never a silent widened value.
    const program = await wfCorpus(entry.code);
    await expect(replayGraphEgress({ program, frozen: run.frozen })).rejects.toThrow(ReplayScopeError);
    await expect(replayGraphEgress({ program, frozen: freezeMints(run.mints) })).rejects.toThrow(/loop|binder/);

    // (b) exact reconstruction: quoted body (the program source) + the counted
    // frozen payloads, replayed whole-program — equals the recorded egress.
    const reconstructed = await replayProgramWithPlayback({ source: entry.code, playback: playbackOf(run) });
    expect(reconstructed.value).toEqual(run.egress);
  });

  // @ledger: Q16 — FLIPPED. Fan/region rows (nested-regions class): a region is ONE
  // node from G (I5) — its VALUE replays at region granularity (whole-program
  // playback; per-element track γ is track-cone.law's subject), and the per-wire
  // driver's fan door names the route instead of fabricating a value.
  describe.each(W1_CORPUS.filter((e) => e.klass === "nested-regions"))(
    "regions replay at region granularity: $name",
    (entry) => {
      it(`${entry.code}`, async () => {
        const run = await recordRun(inferenceEnv, entry.code, entry.sources);
        const replayed = await replayProgramWithPlayback({ source: entry.code, playback: playbackOf(run) });
        expect(replayed.value).toEqual(run.egress);
      });
    },
  );
});

describe("replay-nondeterminism (§4 R1 + §7: frozen-payload replay stable under a mutated world)", () => {
  // MUTATED-WORLD PROTOCOL (implemented, was the staged sketch): a program with
  // interior gensym-shaped / source / clock-shaped reads executes ONCE against the
  // live world (emission ON — the real port-record stream + frozen payloads land in
  // the store fakes), then the world is DELIBERATELY MUTATED (the same ops re-bound
  // to answer differently), and the SAME stream replays. The law: replayed egress ==
  // recorded egress regardless of what the mutated world would answer NOW.
  const CODE = `(list (fetch-live) (clock-now) (gensym-id))`;
  const SOURCES: Record<string, RecordingShape> = { "fetch-live": "num", "clock-now": "num", "gensym-id": "num" };
  const MUTATED_ROLES: Classifier = {
    roleOf: (op) => (op in SOURCES ? "source" : CORPUS_ROLES[op]),
  };

  async function wfMutated(code: string) {
    const forms = await parse(code);
    return buildWireframe(forms, { classifier: MUTATED_ROLES, isBaseName: corpusIsBaseName });
  }

  /** The mutated world: same ops, DIFFERENT answers (offset by +1000), live. A
   *  test-local `EnvCapability` (`symbol.rosetta` verbs — the `env.defineRosetta`
   *  migration target), one verb per source op, all sharing the SAME per-op call
   *  counter closure the legacy loop built. */
  async function mutatedEnv(calls: Map<string, number>) {
    const env = mintFrame(inferenceEnv, "q16-mutated-world");
    const symbols: Record<string, RosettaSymbolDef> = {};
    for (const op of Object.keys(SOURCES)) {
      symbols[op] = symbol.rosetta`${op}: mutated-world source (offset +1000)`({ input: [], output: [z.number] }, () => {
        calls.set(op, (calls.get(op) ?? 0) + 1);
        return 1000 + (calls.get(op) ?? 0);
      });
    }
    await new EnvCapability("test/mutated-world", { symbols }).lower({}).apply(env, undefined as never);
    return env;
  }

  // @ledger: Q16 — FLIPPED. Frozen payloads AUTHORITATIVE: γ reproduces the RECORDED
  // egress, never the mutated world's answer — and the mutated world is provably
  // DIFFERENT (the live control run diverges), so the stability is non-vacuous.
  it("replay from frozen port payloads is stable under a deliberately mutated external world", async () => {
    const run = await recordRun(inferenceEnv, CODE, SOURCES);

    // The world mutates: the same ops now answer 1001, 1002, 1003.
    const mutatedCalls = new Map<string, number>();
    const live = await execState(CODE, { env: await mutatedEnv(mutatedCalls) });
    const liveNow = schemeToJs(live.values[live.values.length - 1], {});
    expect(liveNow).not.toEqual(run.egress); // the mutation is REAL — a live call answers differently now

    // γ under frozen ingress: the RECORDED values, exactly — gensym identity
    // included (§4 CHOSEN: "gensym is a mint; its identity is a recorded payload").
    const program = await wfMutated(CODE);
    const replayed = await replayGraphEgress({ program, frozen: run.frozen });
    expect(replayed.value).toEqual(run.egress);
    expect(replayed.value).not.toEqual(liveNow);

    // R1's mechanism, asserted structurally: the hermetic replay env binds NO live
    // source at all — re-invocation is unrepresentable, not merely avoided.
    const env = await hermeticEnv([], program.prelude.source);
    for (const op of Object.keys(SOURCES)) {
      expect(env.get(op, { throwError: false })).toBeUndefined();
    }
  });

  // @ledger: Q16 — FLIPPED. The EXCLUSION is part of the law: a fresh live run under
  // the mutated world is a DIFFERENT RUN, not a replay — its divergence from the
  // recorded egress is expected and claimed by nothing. Only γ (frozen ingress)
  // carries the stability claim.
  it("re-execution stability is NEVER claimed — a live re-fetch is a different run, only γ is stable (§4 EXCLUDED)", async () => {
    const run = await recordRun(inferenceEnv, CODE, SOURCES);
    const mutatedCalls = new Map<string, number>();

    // Fresh live run #1 and #2 under the mutated world: each is its own run — they
    // even differ from EACH OTHER (the gensym/clock-shaped ops advance), which is
    // exactly why re-execution stability is excluded rather than merely weakened.
    const env = await mutatedEnv(mutatedCalls);
    const live1 = schemeToJs((await execState(CODE, { env })).values[0], {});
    const live2 = schemeToJs((await execState(CODE, { env })).values[0], {});
    expect(live1).not.toEqual(run.egress);
    expect(live2).not.toEqual(live1);

    // …while γ over the SAME frozen stream is stable across repeated replays.
    const program = await wfMutated(CODE);
    const replayedA = await replayGraphEgress({ program, frozen: freezeMints(run.mints) });
    const replayedB = await replayGraphEgress({ program, frozen: freezeMints(run.mints) });
    expect(replayedA.value).toEqual(run.egress);
    expect(replayedB.value).toEqual(run.egress);
  });

  // @ledger: Q16 — FLIPPED. GLASS envs (§4 V ruling): cached membrane behavior +
  // whole-program re-run. The recorded answers are authoritative even where live
  // glass would answer differently NOW; the re-run emits ZERO new records (silent
  // region), and a divergent demand hits a teaching door, never a live re-fetch.
  it("GLASS: whole-program re-run with penetration playback — recorded answers authoritative, zero new records", async () => {
    const code = `(define (both) (cons (glass-read) (glass-read))) (both)`;
    const run = await recordRun(inferenceEnv, code, { "glass-read": "num" });
    expect(run.mints).toHaveLength(2);

    const before = (await run.store.readStream(run.regionId)).length;
    setEmissionEnabled(true); // emission live — the SILENT region must still suppress everything
    let replayed;
    try {
      replayed = await replayProgramWithPlayback({ source: code, playback: playbackOf(run) });
    } finally {
      setEmissionEnabled(false);
    }
    expect(replayed.value).toEqual(run.egress);
    const after = (await run.store.readStream(run.regionId)).length;
    expect(after).toBe(before); // the identical crossings happened again; nothing new landed

    // Availability is honest: demanding MORE penetrations than were recorded is a
    // door (the stream is incomplete or the program diverged) — never a live call.
    const starved = new Map([["glass-read", [run.mints[0].payload]]]); // one payload, two demands
    await expect(replayProgramWithPlayback({ source: code, playback: starved })).rejects.toThrow(
      /underflowed.*never answered live/s,
    );
  });
});

describe("pure-mux derivation (§1 A2 soundness + §7: γ rederives every collapsed decision)", () => {
  const PURE_MUX_ROWS = W1_CORPUS.filter(
    (e) => e.precision === "abstract" && (e.klass === "pure-mux" || e.klass === "deep-mux-nesting"),
  );

  // @ledger: Q16 — FLIPPED. For every pure-mux corpus row: γ over frozen ingress
  // rederives the collapsed decision — the replayed egress equals the recorded one,
  // and the arm ATTRIBUTION (which sources actually flowed) matches the eager
  // oracle's recorded arm choice exactly. Recording the decision would have bought
  // nothing replay cannot reconstruct: A2's soundness, proven.
  describe.each(PURE_MUX_ROWS)("rederivation: $klass / $name", (entry) => {
    it(`${entry.code}`, async () => {
      const run = await recordRun(inferenceEnv, entry.code, entry.sources);
      const program = await wfCorpus(entry.code);
      const replayed = await replayGraphEgress({ program, frozen: run.frozen });

      // the VALUE rederives…
      expect(replayed.value).toEqual(run.egress);

      // …and the ARM rederives: the ops whose stamps flowed through γ are exactly
      // the ops the eager oracle recorded as the taken arm's.
      const derivedOps = run.registry.opsOf(replayedCone(replayed.boxed));
      const oracleOps = run.registry.opsOf(run.eagerCone);
      expect([...derivedOps].sort()).toEqual([...oracleOps].sort());

      // the UNTAKEN arm's ingress (bound as a D2 sentinel — it has no recorded
      // payload) provably never flowed: no sentinel id in the replayed cone.
      for (const id of replayedCone(replayed.boxed)) expect(id).toBeLessThan(SENTINEL_BASE);
      for (const extra of entry.extraInWireframe ?? []) {
        expect(derivedOps.has(extra), `untaken-arm op "${extra}" flowed through γ`).toBe(false);
      }
    });
  });

  // @ledger: Q16 — FLIPPED. The precision the m3 trade deferred from Q9 lands here:
  // W1's abstract both-arms cone is a PROPER superset; ONE γ-step refines it to the
  // exact taken arm — replayedCone ⊊ abstractCone, replayedCone == eagerCone.
  describe.each(PURE_MUX_ROWS)("exact arm attribution, one γ-step past W1's abstract cone: $name", (entry) => {
    it(`${entry.code}`, async () => {
      const run = await recordRun(inferenceEnv, entry.code, entry.sources);
      const program = await wfCorpus(entry.code);
      const abstract = prospectiveSourceCone(program); // W1's both-arms cone (Q9's own scope)
      const replayed = await replayGraphEgress({ program, frozen: run.frozen });
      const derivedOps = run.registry.opsOf(replayedCone(replayed.boxed));

      // exact: γ's attribution equals the eager oracle's…
      expect([...derivedOps].sort()).toEqual([...run.registry.opsOf(run.eagerCone)].sort());
      // …and is a PROPER refinement of the abstract cone (the trade IS the ruling —
      // the abstract cone stays both-arms; the γ-step is where exactness lives).
      for (const op of derivedOps) expect(abstract.has(op)).toBe(true);
      expect(abstract.size).toBeGreaterThan(derivedOps.size);
    });
  });
});

describe("effect-track replay-between-records (§4 CHOSEN, §7 sub-gate)", () => {
  /** The pure stretch between recorded events, lifted from the program's own
   *  accumulator body `(+ acc (emit-step! v))` with the port event cut to a param —
   *  exactly the shape `unevalWire` mints for a cut crossing. Q16 DESIGN CALL
   *  (replay.ts `EffectStretch`): automatic extraction from accumulator-role fan
   *  templates is the wireframe-walking driver's future job; the law pins the MODE. */
  const STRETCH: EmittedWire = {
    source: "(lambda (acc ev) (+ acc ev))",
    params: ["acc", "ev"],
    paramRefs: [
      { kind: "slot", name: "acc" },
      { kind: "slot", name: "ev" },
    ],
    span: "q16-effect-stretch",
  };

  /** An accumulator chain whose per-iteration step crosses an EFFECT port
   *  (`emit-step!` observes and echoes) interleaved with pure arithmetic — the
   *  generator-corpus shape the sub-gate names. */
  const foldProgram = (xs: readonly number[]): string =>
    `(let loop ((xs (list ${xs.join(" ")})) (acc 0)) (if (null? xs) acc (loop (cdr xs) (+ acc (emit-step! (car xs))))))`;

  // @ledger: Q16 (sub-gate) — FLIPPED. Pure stretches APPLIED (γ), recorded port
  // events INTERLEAVED VERBATIM (seq order), and the mode is NEITHER extreme:
  // events are not recomputed, stretches are not stored.
  it("an effect track replays in REPLAY-BETWEEN-RECORDS mode — pure stretches γ'd, port events verbatim", async () => {
    const xs = [10, 20, 30];
    const run = await recordRun(inferenceEnv, foldProgram(xs), { "emit-step!": "echo" });
    expect(run.egress).toBe(60);
    expect(run.mints.map((m) => m.payload.value)).toEqual([10, 20, 30]); // the recorded crossings, seq order

    const { steps, egress } = await replayBetweenRecords({
      store: run.store,
      payloads: run.payloads,
      regionId: run.regionId,
      stretch: { wire: STRETCH, accParam: "acc", eventParam: "ev" },
      initial: boxPayload({ value: 0, stampIds: [] }),
    });

    // the interleave: event ↔ pure, strictly alternating, event payloads VERBATIM
    // (the recorded values, in the stream's own seq order), pure values γ-DERIVED
    // (the running accumulator: 10, 30, 60).
    expect(steps.map((s) => s.kind)).toEqual(["port-event", "pure", "port-event", "pure", "port-event", "pure"]);
    expect(steps.flatMap((s) => (s.kind === "port-event" ? [s.payload.value] : []))).toEqual([10, 20, 30]);
    expect(steps.flatMap((s) => (s.kind === "pure" ? [s.value] : []))).toEqual([10, 30, 60]);
    expect(egress).toBe(run.egress);

    // NEITHER pure-γ-only NOR playback-only: mutate the world (the effect op now
    // answers ×100) — the replay is IDENTICAL, because the events come from the
    // stream and the stretches from γ, and the live op is never consulted.
    const mutated = mintFrame(inferenceEnv, "q16-mutated-effect");
    let liveCalls = 0;
    // Test-local EnvCapability (`symbol.rosetta` — the `env.defineRosetta` migration
    // target). `mutated` is never actually touched by `replayBetweenRecords` below (no
    // `env` field in its args) — this binding exists only so `liveCalls` staying 0
    // is a meaningful (not vacuously-typed-away) assertion that the live op is never
    // consulted, exactly the legacy fixture's own shape.
    const emitStep = symbol.rosetta`emit-step!: mutated-world effect echo (×100)`(
      { input: [z.number], output: [z.number] },
      (x) => {
        liveCalls++;
        return x * 100;
      },
    );
    await new EnvCapability("test/mutated-effect", { symbols: { "emit-step!": emitStep } })
      .lower({})
      .apply(mutated, undefined as never);
    const replayAgain = await replayBetweenRecords({
      store: run.store,
      payloads: run.payloads,
      regionId: run.regionId,
      stretch: { wire: STRETCH, accParam: "acc", eventParam: "ev" },
      initial: boxPayload({ value: 0, stampIds: [] }),
    });
    expect(replayAgain.egress).toBe(60);
    expect(liveCalls).toBe(0);
  });

  // @ledger: Q16 (sub-gate) — FLIPPED. The completeness precondition composes
  // fold.ts: a region with a pending (never-closed) track REFUSES replay-between-
  // records — the incomplete door's post-hoc mirror (I4), a teaching door.
  it("an INCOMPLETE region refuses replay-between-records (fold-checked, I4's post-hoc mirror)", async () => {
    const run = await recordRun(inferenceEnv, foldProgram([1, 2]), { "emit-step!": "echo" });
    // Fabricate an eviction-shaped stream state: a track opened, never closed.
    setEmissionEnabled(true);
    try {
      const { emitTrackOpen } = await import("../../provenance/store/emit.js");
      await emitTrackOpen({
        store: run.store,
        regionId: run.regionId,
        id: { templateHash: "q16:pending-track", ordinalPath: [99], regionEpoch: "e0" },
      });
    } finally {
      setEmissionEnabled(false);
    }
    await expect(
      replayBetweenRecords({
        store: run.store,
        payloads: run.payloads,
        regionId: run.regionId,
        stretch: { wire: STRETCH, accParam: "acc", eventParam: "ev" },
        initial: boxPayload({ value: 0, stampIds: [] }),
      }),
    ).rejects.toThrow(/pending track.*only replays COMPLETED regions/s);
  });

  // @ledger: Q16 (sub-gate) — FLIPPED. Generator rows: seeded random accumulator
  // chains (length AND values drawn per seed) — the replayed interleave is
  // IDENTICAL to the recorded stream's order, event for event, stretch for stretch.
  it("property: generated effect-callback chains replay with the identical interleave the stream captured, over 8 seeds", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2 ** 31 - 1 }), async (seed) => {
        // deterministic per-seed values via the corpus's own mulberry32-style trick:
        // derive k in 2..6 and k values in 1..99 from the seed arithmetic alone.
        const k = 2 + (seed % 5);
        const xs = Array.from({ length: k }, (_, i) => 1 + ((seed >>> (i % 24)) % 99));
        const run = await recordRun(inferenceEnv, foldProgram(xs), { "emit-step!": "echo" });

        const { steps, egress } = await replayBetweenRecords({
          store: run.store,
          payloads: run.payloads,
          regionId: run.regionId,
          stretch: { wire: STRETCH, accParam: "acc", eventParam: "ev" },
          initial: boxPayload({ value: 0, stampIds: [] }),
        });

        // interleave order == the stream's seq order, verbatim
        const eventSeqs = steps.flatMap((s) => (s.kind === "port-event" ? [s.record.seq] : []));
        expect(eventSeqs).toEqual(run.mints.map((m) => m.record.seq));
        expect(steps.flatMap((s) => (s.kind === "port-event" ? [s.payload.value] : []))).toEqual(xs);
        // the chained pure stretches re-derive the exact running accumulator
        const expectedAccs = xs.reduce<number[]>((acc, x) => [...acc, (acc.at(-1) ?? 0) + x], []);
        expect(steps.flatMap((s) => (s.kind === "pure" ? [s.value] : []))).toEqual(expectedAccs);
        expect(egress).toBe(run.egress);
      }),
      { numRuns: 8 },
    );
  });
});
