/**
 * silent-region.test.ts — Q15's standing rows (docs/PROVENANCE.md §4 CHOSEN, round 2
 * A4 — the silent region: doors active, emission
 * off; gate: standing + silent-region rows (a replay emits ZERO records —
 * asserted)).
 *
 * Silence is a RUN FLAG (`RunContext.silent`, P19 — no module holder): every emission site
 * reads the flag off the run it serves, so the suppression below is per run and a concurrent
 * loud run is untouched (see `run/__tests__/concurrent-runs-holders.law.test.ts`).
 *
 * Three groups:
 *   A. `RunContext.silent` — suppression of track-open/track-close/host-schedule AND, via
 *      `eval/provenance-hooks.ts`'s own read of the SAME flag, mint — the leak-proof
 *      placement (a FRESH emission target on a silent run still cannot emit), doors
 *      unaffected, and run-granular nesting (a loud run beside a silent one).
 *   B. `hermeticApply` (`provenance/gamma.ts`) — γ's smoke row: the mechanism actually
 *      applies a wire correctly, on a hermetic run minted `silent`.
 *   C. The glass whole-program-replay discipline (§4 V ruling) — pinned as a targeted
 *      row: a real run mints; the SAME program re-run as a silent run mints
 *      nothing new, even though the identical rosetta crossing happens again. Full
 *      glass machinery (penetration caching / playback) is later product work — this
 *      row pins only the discipline the task brief calls out.
 *
 * Q16 proved the adjunction laws (wire-γ etc.) over `hermeticApply` — see
 * `replay.law.test.ts` (flipped) and `provenance/replay.ts`; nothing here attempts
 * those, this file stays the Q15 smoke/discipline suite.
 */
import type { CallCtx } from "../../run/CallCtx.js";
import { describe, expect, it } from "vitest";
import { type ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execStateOverFrame } from "../../eval/generator-exec.js";
import { EvalTrace } from "../../provenance/trace.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { toJS } from "../../membrane/rosetta.js";
import type { RecordCoordinate } from "../../eval/provenance-hooks.js";
import {
  closeRegionScope,
  openRegionScope,
  recordHostScheduleVerdict,
  withRegionScope,
} from "../../membrane/region-scope.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { RunContext, type RunEmission } from "../../run/RunContext.js";
import { AExact } from "../../values/primitives/AExact.js";
import { PayloadStoreFake, ProvenanceStoreFake } from "../../provenance/store/fakes.js";
import { hermeticApply } from "../../provenance/gamma.js";
import { hermeticEnv } from "../../provenance/hermetic-env.js";
import type { EmittedWire } from "../../provenance/wireframe/types.js";
import { EnvCapability } from "../../common/capability.js";
import { applyCapability } from "../../__tests__/_fresh-env.js";

const COORD: RecordCoordinate = { templateHash: "th-silent", ordinalPath: [0], regionEpoch: "e0" };
const REGION = "region-silent";

function makeEmission(regionId: string = REGION, coordinate: RecordCoordinate = COORD): RunEmission {
  return { store: new ProvenanceStoreFake(), payloads: new PayloadStoreFake(), regionId, coordinate };
}

/** Same shape `region-events.test.ts` uses — a trivial echo, enough surface for
 *  open/close counting, indifferent to what it computes. */
function makeEcho(): ANativeProcedure {
  return new ANativeProcedure({
    name: "echo",
    arity: { min: 1, max: 1 },
    contract: undefined,
    impl: (args) => args[0],
  });
}

/** Same shape `emission-hooks.test.ts` uses — one rosetta source, a real membrane
 *  crossing `notePotentialRosettaExit` can mint against. Test-local `EnvCapability`;
 *  a plain `z.number` output (the impl returns an ordinary JS number, no pre-stamped
 *  escape hatch needed). */
async function registerSource(env: ResolvingAmbient): Promise<void> {
  await applyCapability(env, [
    EnvCapability.define("test/fetch-item", {
      symbols: (symbol, z) => ({
        "fetch-item": symbol.rosetta`fetch-item: a zero-arg numeric source`(
          { input: [], output: [z.number] },
          function (this: CallCtx) {
            return 42;
          },
        ),
      }),
    }),
  ]);
}

describe("A. silent runs suppress emission, never doors (§4 CHOSEN, round 2 A4)", () => {
  /** Open a scope on `runCtx` and wrap the echo callable under it. */
  function echoUnder(runCtx: RunContext) {
    const scope = openRegionScope({ runCtx, dynSite: undefined });
    const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);
    return { scope, wrapper };
  }

  it("a silent run emits ZERO records — track-open/track-close AND mint all suppressed against a store that would otherwise capture everything", async () => {
    const emission = makeEmission();
    const runCtx = new RunContext({ emission, silent: true });
    const { scope, wrapper } = echoUnder(runCtx);
    expect(await wrapper(41)).toBe(41); // the real call still works, unaffected
    closeRegionScope(scope);

    const env = inferenceEnv.child("silent-mint");
    await registerSource(env);
    const trace = new EvalTrace();
    const result = await execStateOverFrame("(fetch-item)", { env, tap: trace, emission, silent: true });
    expect(toJS(result.values[0])).toBe(42); // real program result, unaffected

    await Promise.resolve();
    await Promise.resolve();

    expect(await emission.store.readStream(REGION)).toHaveLength(0);
  });

  it("CONTROL — the identical setup WITHOUT `silent` DOES emit (proves the suppression above is doing real work, not a vacuous empty scenario)", async () => {
    const emission = makeEmission();
    const runCtx = new RunContext({ emission });
    const { scope, wrapper } = echoUnder(runCtx);
    await wrapper(41);
    closeRegionScope(scope);

    const env = inferenceEnv.child("loud-mint");
    await registerSource(env);
    const trace = new EvalTrace();
    await execStateOverFrame("(fetch-item)", { env, tap: trace, emission });

    await Promise.resolve();
    await Promise.resolve();

    const stream = await emission.store.readStream(REGION);
    expect(stream.filter((r) => r.kind === "track-open")).toHaveLength(1);
    expect(stream.filter((r) => r.kind === "track-close")).toHaveLength(1);
    expect(stream.filter((r) => r.kind === "mint")).toHaveLength(1);
    // Mint and track events share one coordinate; their ids must not collapse into each other.
    expect(stream).toHaveLength(3);
    expect(new Set(stream.map((r) => JSON.stringify(r.id))).size).toBe(3);
  });

  it("a FRESH emission target on a silent run still cannot emit — the leak-proof placement (silence rides the run, not the target)", async () => {
    const fresh = makeEmission("region-nested", {
      templateHash: "th-nested",
      ordinalPath: [9],
      regionEpoch: "e-nested",
    });
    const runCtx = new RunContext({ emission: fresh, silent: true });
    const { scope, wrapper } = echoUnder(runCtx);
    await wrapper(1);
    closeRegionScope(scope);

    const env = inferenceEnv.child("silent-nested-mint");
    await registerSource(env);
    const trace = new EvalTrace();
    await execStateOverFrame("(fetch-item)", { env, tap: trace, emission: fresh, silent: true });

    await Promise.resolve();
    await Promise.resolve();

    expect(await fresh.store.readStream("region-nested")).toHaveLength(0);
  });

  it("doors still fire on silent runs — escape and incomplete doors are unaffected by silence", async () => {
    const { scope, wrapper } = echoUnder(new RunContext({ emission: makeEmission(), silent: true }));

    // incomplete door: a call started but never awaited before close.
    const inFlight = wrapper(1);
    expect(() => closeRegionScope(scope)).toThrow(/reverse-lambda call.*incomplete/);
    await inFlight; // let it settle, no lingering unhandled rejection

    // escape door: a call attempted AFTER the scope closed.
    await expect(wrapper(2)).rejects.toThrow(/escaped its invocation/);
  });

  it("host-schedule: accumulate-then-flush is ALSO fully suppressed under silence (never accumulates, never flushes)", async () => {
    const emission = makeEmission();
    const scope = openRegionScope({ runCtx: new RunContext({ emission, silent: true }), dynSite: undefined });
    recordHostScheduleVerdict(scope, [0], [1], -1);
    expect(scope.hostSchedule).toHaveLength(0); // never accumulated under silence
    closeRegionScope(scope);

    await Promise.resolve();
    expect(await emission.store.readStream(REGION)).toHaveLength(0);
  });

  it("silence is run-granular: a silent run and a loud run on ONE emission target — only the loud run's calls are recorded", async () => {
    const emission = makeEmission();
    const loud = echoUnder(new RunContext({ emission }));
    const silent = echoUnder(new RunContext({ emission, silent: true }));

    await loud.wrapper(1); // loud — recorded
    await silent.wrapper(2); // silent — suppressed
    await loud.wrapper(3); // loud again — recorded
    closeRegionScope(loud.scope);
    closeRegionScope(silent.scope);

    await Promise.resolve();
    await Promise.resolve();

    const stream = await emission.store.readStream(REGION);
    // Exactly TWO calls recorded (1 and 3), never three — the silent run left no trace
    // despite sharing the SAME emission target as the recorded calls either side of it.
    expect(stream.filter((r) => r.kind === "track-open")).toHaveLength(2);
    expect(stream.filter((r) => r.kind === "track-close")).toHaveLength(2);
  });

  it("silence cannot be lifted from inside: the flag is readonly on the run and constant for its life", () => {
    const runCtx = new RunContext({ emission: makeEmission(), silent: true });
    expect(runCtx.silent).toBe(true);
    // A loud run minted while the silent one exists stays loud (no shared holder).
    expect(new RunContext({ emission: makeEmission() }).silent).toBe(false);
    expect(runCtx.silent).toBe(true);
  });
});

describe("B. hermeticApply — γ = apply(wire, ingress) under a silent region (Q15)", () => {
  /** `(lambda (x) (inc x))`, `inc` a pure prelude helper — the SAME shape
   *  `wireframe-agreement.law.test.ts`'s landed Q7 row already proved end-to-end
   *  (`` `(${w.source} 41)` `` against `hermeticEnv([], p.prelude.source)`), here
   *  driven through `hermeticApply` instead of a hand-rolled application string. */
  const WIRE: EmittedWire = {
    source: "(lambda (x) (inc x))",
    params: ["x"],
    paramRefs: [{ kind: "slot", name: "x" }],
    span: "silent-region-test-wire",
  };
  const PRELUDE = "(define (inc n) (+ n 1))";

  it("computes the correct γ result: apply(wire, ingress) against Q7's hermetic env", async () => {
    const result = await hermeticApply({
      wire: WIRE,
      ingress: { x: new AExact(41) },
      basePacks: [],
      prelude: PRELUDE,
    });
    expect(result).toBe(42);
  });

  it("the hermetic run γ replays on is minted `silent` + `eagerStamps` — region-silent by construction", async () => {
    const base = await hermeticEnv([], PRELUDE);
    expect(base.runCtx.silent).toBe(true);
    expect(base.runCtx.eagerStamps).toBe(true);
    expect(base.runCtx.emission).toBeUndefined();
  });

  it("a missing ingress binding for a declared wire param throws the teaching door, before ever reaching exec", async () => {
    await expect(hermeticApply({ wire: WIRE, ingress: {}, basePacks: [], prelude: PRELUDE })).rejects.toThrow(
      /no ingress binding was supplied/,
    );
  });
});

describe("C. glass whole-program replay — the SAME silent discipline generalizes (§4 V ruling)", () => {
  it("a real run mints; the identical program re-run as a silent run emits ZERO NEW records — 'penetration stream authoritative, re-run emits zero new records'", async () => {
    const emission = makeEmission("region-glass");

    // Real run — mints one record.
    const env1 = inferenceEnv.child("glass-real-run");
    await registerSource(env1);
    const trace1 = new EvalTrace();
    const real = await execStateOverFrame("(fetch-item)", { env: env1, tap: trace1, emission });
    expect(toJS(real.values[0])).toBe(42);

    await Promise.resolve();
    await Promise.resolve();
    expect(await emission.store.readStream("region-glass")).toHaveLength(1);

    // "Replay" — the SAME program (a stand-in for whole-program re-run with
    // penetration playback; the real penetration-cache machinery is later product
    // work per the task brief — this row pins only the discipline), run again as a
    // silent run, at the SAME emission target a real drill-in would reuse.
    const env2 = inferenceEnv.child("glass-replay-run");
    await registerSource(env2);
    const trace2 = new EvalTrace();
    const replayed = await execStateOverFrame("(fetch-item)", { env: env2, tap: trace2, emission, silent: true });
    expect(toJS(replayed.values[0])).toBe(42); // same behavior…

    await Promise.resolve();
    await Promise.resolve();
    // …but the stream is UNCHANGED — the identical rosetta crossing happened again,
    // and emitted nothing new.
    expect(await emission.store.readStream("region-glass")).toHaveLength(1);
  });
});
