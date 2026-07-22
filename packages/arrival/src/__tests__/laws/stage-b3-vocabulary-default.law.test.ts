/**
 * LAW — Stage B3 (docs/plans/stage-b-runcontext-absorbs-assembly.md, §Sub-stages "B3 —
 * consumers migrate"): `exec(code, { capabilities, config })` — the branch every real session
 * takes — now resolves through `env/vocabulary.ts`'s memoized `Vocabulary` + `env/assemble-run
 * .ts`'s `assembleRun` BY DEFAULT (`eval/generator-exec.ts`'s `execState` router), not the old
 * `lower()`/`assembleEnv`/`instantiate` ambient. This file pins the THREE laws the stage's spec
 * calls for:
 *
 *  LAW 1 (default-path equivalence): the SAME program, the SAME capability set, run once
 *    through the new default (vocabulary) and once through the explicit `{ ambient }` KEEP-
 *    LEGACY escape hatch — identical results, including a `requiresConfig` door firing
 *    identically and `this.configuration` reads seeing the same validated bag.
 *
 *  LAW 2 (runCtx-reuse tuple-mismatch teaching error): `assembleRun`'s ONE invariant on a
 *    supplied `runCtx` — its `.vocabulary` must be THIS tuple's (identity-checked) — throws
 *    `RunContextVocabularyMismatchError` on a mismatch (a different tuple, or a legacy-minted
 *    runCtx with no vocabulary at all), and threading the SAME tuple's runCtx through two
 *    `execState` passes (the REPL-continuity idiom, pre-minted via the now-exported
 *    `assembleRun`) skips a second prelude execution.
 *
 *  LAW 3 (static validation on the vocabulary path): `staticValidation: "on"` produces the
 *    SAME `missing-configuration` diagnostic on the (now default) vocabulary path as it always
 *    did on the ambient path — thrown at parse phase, with ZERO side effects fired (not even
 *    a preceding form's own side effect runs).
 *
 * A fourth, cheap check (router pin) confirms an ordinary `{ capabilities }` call — no `env`/
 * `ambient`/`override`/`irLineage` — actually took the new default branch (`ExecState.ambient`
 * absent, `RunContext.vocabulary` present), the ambient path's own observable inverse.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EnvCapability } from "../../common/capability.js";
import type { EvalPreludeInto, EvalSchemeInto } from "../../common/scheme-env.js";
import { assembleAmbient, ensureBaseAssembled, exec, execState } from "../../eval/generator-exec.js";
import { LexicalScope } from "../../eval/LexicalScope.js";
import { assembleRun } from "../../env/assemble-run.js";
import { BASE_ROSTER } from "../../env/base-roster.js";
import { disposeRunContext } from "../../run/run-lifecycle.js";
import { RunContext } from "../../run/RunContext.js";
import { PurityError, RunContextVocabularyMismatchError } from "../../errors.js";
import { StaticValidationError } from "../../static-validation/validate-program.js";
import { nil } from "../../index.js";

const realEvalScheme: EvalSchemeInto = (env, src) => exec(src, { env, skipBootstrapWait: true });
const realEvalPrelude: EvalPreludeInto = (env, src, runCtx) => exec(src, { env, runCtx, skipBootstrapWait: true });

describe("LAW 1 — default-path equivalence: vocabulary (default) vs explicit ambient (KEEP-LEGACY)", () => {
  it("this.configuration reads and results are identical on both paths", async () => {
    const cap = EnvCapability.define("law/b3-equivalence", {
      configuration: { greeting: z.string().optional() },
      symbols: (symbol, sz) => ({
        "read-config": symbol.rosetta`read-config: this run's configured greeting, or "none"`(
          { input: [], output: [sz.string] },
          function (this: { configuration?: { greeting?: string } }) {
            return this.configuration?.greeting ?? "none";
          },
        ),
      }),
    });
    const config = { greeting: "hello" };

    const [viaDefault] = await exec("(read-config)", { capabilities: [cap], config });
    expect(viaDefault).toBe("hello");

    const ambient = await assembleAmbient({ capabilities: [cap], config });
    try {
      const [viaAmbient] = await exec("(read-config)", { ambient, scope: LexicalScope.fresh("b3-equiv-configured") });
      expect(viaAmbient).toBe(viaDefault);
    } finally {
      await ambient.dispose();
    }
  });

  it("a requiresConfig door fires identically on both paths when the key is absent", async () => {
    const cap = EnvCapability.define("law/b3-equivalence-door", {
      configuration: { greeting: z.string().optional() },
      symbols: (symbol, sz) => ({
        gated: symbol.rosetta`gated: requires greeting`(
          { input: [], output: [sz.string], requiresConfig: ["greeting"] },
          () => "should-not-run",
        ),
      }),
    });

    await expect(exec("(gated)", { capabilities: [cap] })).rejects.toBeInstanceOf(PurityError);

    const ambient = await assembleAmbient({ capabilities: [cap] });
    try {
      await expect(exec("(gated)", { ambient, scope: LexicalScope.fresh("b3-equiv-door") })).rejects.toBeInstanceOf(
        PurityError,
      );
    } finally {
      await ambient.dispose();
    }
  });
});

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

  it("reusing a legacy-minted RunContext (no .vocabulary at all) also mismatches", async () => {
    const cap = EnvCapability.define("law/b3-runctx-legacy", { symbols: () => ({}) });
    // Bare `new RunContext(...)` — the ambient/glass mint shape, carrying no vocabulary handle.
    const legacyRunCtx = new RunContext({});
    await expect(
      assembleRun({ capabilities: [cap], evalScheme: realEvalScheme, runCtx: legacyRunCtx }),
    ).rejects.toThrow(RunContextVocabularyMismatchError);
  });

  it("threading the SAME tuple's RunContext through two execState passes skips a second prelude run", async () => {
    await ensureBaseAssembled();
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

    // The REPL idiom: pre-mint via the now-exported `assembleRun` (the vocabulary-path
    // counterpart of `new RunContext(...)`), then thread it through every pass. Stage C Cut 2:
    // `execState`'s own `execStateViaVocabulary` folds `BASE_ROSTER` (env/base-roster.ts) into
    // its EFFECTIVE capabilities before calling `assembleRun` — a REUSED `runCtx`'s
    // tuple-identity check (`assembleRun`'s own header) compares against THAT tuple, so a
    // pre-mint wanting to interoperate with `execState`'s reuse must fold the SAME roster in.
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

describe("LAW 3 — static validation on the (now default) vocabulary path", () => {
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

describe("router pin — an ordinary { capabilities } call takes the vocabulary (default) branch", () => {
  it("ExecState.ambient is absent and RunContext.vocabulary is present", async () => {
    const cap = EnvCapability.define("law/b3-router-pin", { symbols: () => ({}) });
    const state = await execState("(+ 1 1)", { capabilities: [cap] });
    expect(state.ambient).toBeUndefined();
    expect(state.runCtx.vocabulary).toBeDefined();
  });

  it("KEEP-LEGACY: passing `ambient` explicitly still takes the ambient branch (ExecState.ambient present)", async () => {
    const cap = EnvCapability.define("law/b3-router-pin-legacy", { symbols: () => ({}) });
    const ambient = await assembleAmbient({ capabilities: [cap] });
    try {
      const state = await execState("(+ 1 1)", { ambient, scope: LexicalScope.fresh("b3-router-pin-legacy") });
      expect(state.ambient).toBe(ambient);
      expect(state.runCtx.vocabulary).toBeUndefined();
    } finally {
      await ambient.dispose();
    }
  });
});
