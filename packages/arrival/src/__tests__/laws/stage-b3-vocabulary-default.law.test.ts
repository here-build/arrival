/**
 * LAW — Stage B3 (docs/plans/stage-b-runcontext-absorbs-assembly.md, §Sub-stages "B3 —
 * consumers migrate") introduced the self-hosted vocabulary path as `exec`'s DEFAULT, alongside
 * a `{ ambient }` KEEP-LEGACY escape hatch to the old `lower()`/`assembleEnv`/`instantiate`
 * ambient. STAGE C CUT 3b (docs/plans/stage-c-corpse-deletion.md, "the massacre") retired that
 * escape hatch along with the ambient path itself — the vocabulary path is now the ONLY path,
 * so this file's original LAW 1 ("default-path equivalence: vocabulary vs ambient") and the
 * router pin's KEEP-LEGACY row have no surviving counterpart (there is nothing left to be
 * equivalent TO, and no second branch a router could route to) and are dropped. What survives,
 * unaffected by the router's collapse (neither pins ambient/glass at all):
 *
 *  LAW 2 (runCtx-reuse tuple-mismatch teaching error): `assembleRun`'s ONE invariant on a
 *    supplied `runCtx` — its `.vocabulary` must be THIS tuple's (identity-checked) — throws
 *    `RunContextVocabularyMismatchError` on a mismatch (a different tuple, or a bare
 *    `new RunContext({})` with no vocabulary at all), and threading the SAME tuple's runCtx
 *    through two `execState` passes (the REPL-continuity idiom, pre-minted via the exported
 *    `assembleRun`) skips a second prelude execution.
 *
 *  LAW 3 (static validation on the vocabulary path): `staticValidation: "on"` produces the
 *    `missing-configuration` diagnostic — thrown at parse phase, with ZERO side effects fired
 *    (not even a preceding form's own side effect runs).
 *
 * A cheap router-pin check confirms an ordinary `{ capabilities }` call carries a real
 * `RunContext.vocabulary` — the vocabulary path's own observable signature.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EnvCapability } from "../../common/capability.js";
import type { EvalPreludeInto, EvalSchemeInto } from "../../common/scheme-env.js";
import { exec, execState, execInFrame } from "../../eval/generator-exec.js";
import { assembleRun } from "../../env/assemble-run.js";
import { BASE_ROSTER } from "../../env/base-roster.js";
import { isAmbientRuntime } from "../../env/AmbientRuntime.js";
import { disposeRunContext } from "../../run/run-lifecycle.js";
import { RunContext } from "../../run/RunContext.js";
import { RunContextVocabularyMismatchError } from "../../errors.js";
import { StaticValidationError } from "../../static-validation/validate-program.js";
import { nil } from "../../values/primitives/ANil.js";

// The internal bake seam (Stage C Cut 3b) — never the public exec surface.
const realEvalScheme: EvalSchemeInto = (env, src) => {
  if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
  return execInFrame(src, env);
};
const realEvalPrelude: EvalPreludeInto = (env, src, runCtx) => {
  if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
  return execInFrame(src, env, runCtx);
};

describe("LAW 2 — runCtx reuse: tuple-identity invariant", () => {
  it("reusing a RunContext minted against a DIFFERENT capability set throws the teaching error", async () => {
    const capA = EnvCapability.define("law/b3-runctx-a", { symbols: () => ({}) });
    const capB = EnvCapability.define("law/b3-runctx-b", { symbols: () => ({}) });

    const runA = await assembleRun({ capabilities: [capA], evalScheme: realEvalScheme });
    try {
      await expect(assembleRun({ capabilities: [capB], evalScheme: realEvalScheme, runCtx: runA })).rejects.toThrow(
        RunContextVocabularyMismatchError,
      );
    } finally {
      await disposeRunContext(runA);
    }
  });

  it("reusing a bare-minted RunContext (no .vocabulary at all) also mismatches", async () => {
    const cap = EnvCapability.define("law/b3-runctx-legacy", { symbols: () => ({}) });
    // Bare `new RunContext(...)` — carries no vocabulary handle.
    const bareRunCtx = new RunContext({});
    await expect(
      assembleRun({ capabilities: [cap], evalScheme: realEvalScheme, runCtx: bareRunCtx }),
    ).rejects.toThrow(RunContextVocabularyMismatchError);
  });

  it("threading the SAME tuple's RunContext through two execState passes skips a second prelude run", async () => {
    let bumps = 0;
    const cap = EnvCapability.define("law/b3-runctx-repl", {
      resources: (): { count: number } => ({ count: 0 }),
      prelude: "(prelude/bump!)",
      symbols: (symbol, sz) => ({
        "prelude/bump!": symbol.rosetta`prelude/bump!: bump this run's counter`(
          { input: [], output: [sz.string], preludeOnly: true },
          function (this: { resources: { count: number } }) {
            this.resources.count += 1;
            bumps++;
            return "ok";
          },
        ),
      }),
    });
    const capabilities = [cap];
    const config = {};

    // The REPL idiom: pre-mint via the exported `assembleRun` (the vocabulary-path counterpart
    // of `new RunContext(...)`), then thread it through every pass. `execState`'s own fold
    // (`env/base-roster.ts`'s `BASE_ROSTER`) means a REUSED `runCtx`'s tuple-identity check
    // compares against THAT effective tuple, so a pre-mint wanting to interoperate with
    // `execState`'s reuse must fold the SAME roster in.
    const runCtx = await assembleRun({
      capabilities: [...capabilities, ...BASE_ROSTER],
      config,
      evalScheme: realEvalScheme,
      evalPrelude: realEvalPrelude,
    });
    expect(bumps).toBe(1); // the pre-mint's own prelude pass

    try {
      const first = await execState("(+ 1 1)", { capabilities, config, runCtx });
      const second = await execState("(+ 2 2)", { capabilities, config, runCtx });

      expect(bumps).toBe(1); // NEITHER execState pass re-ran the prelude
      expect(first.runCtx).toBe(runCtx);
      expect(second.runCtx).toBe(runCtx);
      expect((runCtx.capabilityResources?.get(cap) as { count: number }).count).toBe(1);
    } finally {
      await disposeRunContext(runCtx);
    }
  });
});

describe("LAW 3 — static validation on the vocabulary path", () => {
  it("an absent requiresConfig key reports missing-configuration at parse phase, zero side effects fired", async () => {
    let ran = false;
    const cap = EnvCapability.define("law/b3-static-validation", {
      configuration: { fs: z.custom<{ x: number }>(() => true).optional() },
      symbols: (symbol, sz) => ({
        "probe!": symbol.native`probe!: JS-side effect marker`({ input: [], output: [sz.value] }, () => {
          ran = true;
          return nil;
        }),
        "gated/verb": symbol.native`gated/verb: requires fs`(
          { input: [], output: [sz.value], requiresConfig: ["fs"] },
          () => nil,
        ),
      }),
    });

    let caught: unknown;
    try {
      await exec("(probe!) (gated/verb)", { capabilities: [cap], config: {}, staticValidation: "on" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaticValidationError);
    expect(ran).toBe(false); // the FIRST form's own side effect never fired either
    const err = caught as StaticValidationError;
    expect(err.diagnostics.some((d) => d.code === "missing-configuration")).toBe(true);
  });

  it("present config: the SAME program runs clean on the vocabulary path (no false positive)", async () => {
    const cap = EnvCapability.define("law/b3-static-validation-satisfied", {
      configuration: { fs: z.custom<{ x: number }>(() => true).optional() },
      symbols: (symbol, sz) => ({
        "gated/verb": symbol.native`gated/verb: requires fs`(
          { input: [], output: [sz.value], requiresConfig: ["fs"] },
          () => nil,
        ),
      }),
    });
    await expect(
      exec("(gated/verb)", { capabilities: [cap], config: { fs: { x: 1 } }, staticValidation: "on" }),
    ).resolves.toBeDefined();
  });
});

describe("router pin — an ordinary { capabilities } call carries a real vocabulary", () => {
  it("RunContext.vocabulary is present", async () => {
    const cap = EnvCapability.define("law/b3-router-pin", { symbols: () => ({}) });
    const state = await execState("(+ 1 1)", { capabilities: [cap] });
    expect(state.runCtx.vocabulary).toBeDefined();
  });
});
