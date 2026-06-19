/**
 * G5 — the CONFLUENCE GUARD (runtime purity assertion).
 *
 * The whole static-lineage model rests on ONE honor-system invariant today:
 * evaluation is pure (design §3 — "must be guarded at assertion level, not by
 * comment"). This is the additive Wave-A detection that the two ways it can
 * silently fail are CAUGHT, not tolerated:
 *
 *   (1) a purity DOOR (set-car!/vector-set!/call/cc/dynamic-wind/…) is reopened;
 *   (2) a Rosetta declared `pure: true` SECRETLY MUTATES its inputs in place.
 *
 * Source under test: ../purity-assert.ts (isolated primitives) + the dev-flagged
 * hook in ../rosetta.ts (createRosettaWrapper). The detection PRIMITIVES are pure
 * functions (no flag), tested directly + deterministically. Door closure is also
 * exercised END-TO-END through the real macro-expansion via exec(). This is the
 * runnable companion to the `G5: …` it.todo in lineage-assumptions.test.ts.
 *
 * NOTE on the gates ledger: the it.todo named "G5" stays in lineage-assumptions
 * (that file is the shared ledger owned by another unit); these are the runnable
 * checks behind it. Match the inline-helper idiom of the provenance test dir.
 */
import { describe, it, expect, vi } from "vitest";
import { initBridge } from "../bridge";
import { exec } from "../stdlib";
import { sandboxedEnv } from "../sandbox-env";
import { Pair } from "../values/Pair";
import { SchemeVector } from "../values/SchemeVector";
import { SchemeString } from "../values/SchemeString";
import { AValue } from "../values/AValue";
import {
  PurityViolation,
  PURITY_DOOR_VERBS,
  probePurityDoors,
  assertPurityDoorsClosed,
  fingerprint,
  fingerprintChanged,
  snapshotInputs,
  assertInputsUnmutated,
} from "../purity-assert";

const p = (id: number) => new Set([id]);

// ── (1) Doors stay closed — the live env routes every door to a throw. ───────
describe("G5 confluence guard — purity doors stay closed", () => {
  it("end-to-end: every door verb THROWS through exec (the real %purity-door route)", async () => {
    await initBridge();
    // One representative door per family + a spot-check across the list. The macro
    // expands to (%purity-door …) → PurityError, surfaced as a SchemeError whose
    // message names the verb verbatim (cause is the PurityError).
    const probes: Record<string, string> = {
      "set-car!": `(set-car! (list 1 2) 9)`,
      "vector-set!": `(vector-set! (make-vector 3 0) 0 9)`,
      "call/cc": `(call/cc (lambda (k) 1))`,
      "dynamic-wind": `(dynamic-wind (lambda () 1) (lambda () 2) (lambda () 3))`,
      delay: `(delay 1)`,
    };
    for (const [verb, src] of Object.entries(probes)) {
      const env = sandboxedEnv.inherit(`door-${verb}`);
      await expect(exec(src, { env }), `${verb} must remain doored`).rejects.toThrow(verb);
    }
  });

  it("probePurityDoors: a clean env reports ALL doors closed (macros / unbound → not a reopened callable)", async () => {
    await initBridge();
    const env = sandboxedEnv.inherit("doors-clean");
    const verdicts = await probePurityDoors(env);
    expect(verdicts.map((v) => v.verb)).toEqual([...PURITY_DOOR_VERBS]);
    expect(verdicts.every((v) => v.closed)).toBe(true);
    await expect(assertPurityDoorsClosed(env)).resolves.toBeUndefined();
  });

  it("REOPENED door is CAUGHT: re-binding `set-car!` to a working fn trips the probe + assertion", async () => {
    await initBridge();
    const env = sandboxedEnv.inherit("doors-reopened");
    // Simulate the regression the guard exists to catch: someone re-binds a door
    // to a callable that does NOT throw (a working mutator). The probe must flag it.
    env.set("set-car!", (() => "I MUTATE NOW") as unknown as never);
    const reopened = (await probePurityDoors(env)).filter((v) => !v.closed);
    expect(reopened.map((v) => v.verb)).toEqual(["set-car!"]);
    await expect(assertPurityDoorsClosed(env)).rejects.toThrow(PurityViolation);
    await expect(assertPurityDoorsClosed(env)).rejects.toThrow(/set-car!.*REOPENED/s);
  });
});

// ── (2) A pure-marked rosetta must not mutate its inputs — fingerprint logic. ─
describe("G5 confluence guard — pure-rosetta mutation fingerprint (sound subset)", () => {
  it("fingerprint is STABLE across a no-op (a pure pass-through trips nothing)", () => {
    const pair = new Pair(new SchemeString("a", p(100)), new Pair(new SchemeString("b", p(101)), null as never));
    const before = fingerprint(pair);
    // identity transform — no slot touched
    expect(fingerprintChanged(before, fingerprint(pair))).toBe(false);
  });

  it("DETECTS set-car!-style mutation: reassigning Pair.car changes the fingerprint", () => {
    const pair = new Pair<AValue, AValue>(new SchemeString("a", p(100)), new SchemeString("b", p(101)));
    const before = fingerprint(pair);
    pair.car = new SchemeString("MUTATED", p(999)); // the doored mutation, done raw in JS
    expect(fingerprintChanged(before, fingerprint(pair))).toBe(true);
  });

  it("DETECTS vector-set!-style mutation: writing __vector__ in place changes the fingerprint", () => {
    const vec = new SchemeVector([new SchemeString("a", p(100)), new SchemeString("b", p(101))], p(7));
    const before = fingerprint(vec);
    vec.__vector__[0] = new SchemeString("MUTATED", p(999));
    expect(fingerprintChanged(before, fingerprint(vec))).toBe(true);
  });

  it("DETECTS a length change: pushing onto __vector__ trips the fingerprint", () => {
    const vec = new SchemeVector([new SchemeString("a", p(100))], p(7));
    const before = fingerprint(vec);
    vec.__vector__.push(new SchemeString("c", p(102)));
    expect(fingerprintChanged(before, fingerprint(vec))).toBe(true);
  });

  it("assertInputsUnmutated: clean inputs pass; a mutated input throws PurityViolation naming the verb + index", () => {
    const a = new Pair<AValue, AValue>(new SchemeString("x", p(1)), new SchemeString("y", p(2)));
    const b = new SchemeVector([new SchemeString("z", p(3))], p(7));
    const rawArg = 42; // non-AValue — never fingerprinted
    const args = [a, rawArg, b];
    const before = snapshotInputs(args);

    // No mutation → silent.
    expect(() => assertInputsUnmutated("my-pure-fn", args, before)).not.toThrow();

    // Mutate the SECOND AValue (index 2). The violation must name the verb + #2.
    b.__vector__[0] = new SchemeString("MUTATED", p(999));
    expect(() => assertInputsUnmutated("my-pure-fn", args, before)).toThrow(PurityViolation);
    expect(() => assertInputsUnmutated("my-pure-fn", args, before)).toThrow(/my-pure-fn.*#2/s);
  });

  it("a raw-JS-only arg list never fingerprints (the lineage contract is AValue-only)", () => {
    const args = [1, "two", true];
    const before = snapshotInputs(args);
    expect(before.every((f) => f.length === 0)).toBe(true);
    expect(() => assertInputsUnmutated("noop", args, before)).not.toThrow();
  });
});

// ── (2') End-to-end through createRosettaWrapper with the dev flag armed. ─────
// PURITY_ASSERT_ENABLED is read at module load from process.env, so we stub the
// env var and DYNAMIC-import a fresh module graph (resetModules) to observe the
// armed path. CRITICAL: every value the wrapper sees must come from the SAME fresh
// graph — `instanceof AValue` is per-realm, so a statically-imported SchemeVector
// would be a stranger to the fresh AValue and silently skip the fingerprint. So we
// re-import SchemeVector/SchemeString here too. (This realm-identity subtlety is
// itself why the primitive tests above use the static imports and no resetModules.)
describe("G5 confluence guard — armed wrapper catches a mutating pure rosetta (dev flag)", () => {
  it("clean pure rosetta passes; mutating pure rosetta throws PurityViolation; non-pure is never checked", async () => {
    vi.stubEnv("ARRIVAL_PURITY_ASSERT", "1");
    vi.resetModules();
    const { createRosettaWrapper } = await import("../rosetta");
    const { PurityViolation: PV } = await import("../purity-assert");
    const { SchemeVector: Vec } = await import("../values/SchemeVector");
    const { SchemeString: Str } = await import("../values/SchemeString");

    // A clean pure rosetta: returns a constant, never touches its input.
    const clean = createRosettaWrapper({ fn: function cleanPure() { return "ok"; }, pure: true });
    const vec1 = new Vec([new Str("a", p(100))], p(7));
    await expect(clean(vec1 as never)).resolves.toBeDefined();
    expect(vec1.__vector__.length).toBe(1); // untouched

    // A MUTATING pure rosetta: writes its scheme input in place, then returns. The
    // fn closes over and mutates the ORIGINAL scheme input via the captured
    // reference — the exact unsoundness the guard catches.
    const vec2 = new Vec([new Str("a", p(100))], p(7));
    const mutator = createRosettaWrapper({
      fn: function badPure() {
        vec2.__vector__[0] = new Str("MUTATED", p(999));
        return "done";
      },
      pure: true,
    });
    await expect(mutator(vec2 as never)).rejects.toThrow(PV);

    // A NON-pure rosetta (default = source) is NEVER fingerprinted — mutation
    // (while still wrong) does not trip THIS guard; sources are allowed to be effectful.
    const vec3 = new Vec([new Str("a", p(100))], p(7));
    const sourceish = createRosettaWrapper({
      fn: function sourceFn() { vec3.__vector__[0] = new Str("SRC", p(888)); return "x"; },
    });
    await expect(sourceish(vec3 as never)).resolves.toBeDefined();

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
