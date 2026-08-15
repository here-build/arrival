// loader-capability.test.ts — `arrivalLoaderCapability`: the module system as a declarative
// EnvCapability. Proves the postures against the sanctioned `exec`/`execState({capabilities})`
// path:
//   1. door by absence (the Stage-6 `.define` posture — `Contract.requiresConfig`, D2): no
//      `fs`/`loader` config ⇒ the vocabulary builds and `require` binds a cause-carrying
//      DoorProcedure teaching "provide `fs` or `loader`" — the auto-derived door mints
//      unconditionally (requiresConfig is read mode-independently), replacing the old
//      unbound-variable withholding (same for `require/extension` without a registry, naming
//      `extensionRegistry`). `require`'s gate is the DISJUNCTIVE requiresConfig form
//      (`[["fs", "loader"]]` — any-of).
//   2. an armed loader resolves data + spills `.scm` defines into the RUN env;
//   3. `require/register-extension` is the capability's `preludeOnly` symbol: callable from a
//      DEPENDENT capability's prelude during the per-run prelude pass (`env/assemble-run.ts`),
//      a plain unbound-variable error from user code.
//   4. `Vocabulary.degraded` enumerates the missing keys (design doc
//      symbol-define-static-program-validation.md §3.7).
//
// STAGE C CUT 4 (docs/plans/stage-c-corpse-deletion.md) retired `lower()`/`assembleEnv` — this
// file's OWN hand-rolled `assembled()`/`assembledWithDegraded()` scaffold (a pre-armed `runCtx` +
// manual `assembleEnv` call, built to work around the ambient path's own plumbing) went with it.
// Every row below is now the SAME sanctioned `exec`/`execState({capabilities, config})` path the
// retired "CUT mode" describe block already proved equivalent to production — there is no
// second mode left to contrast it against, so that describe block's distinction collapses into
// this file's only mode.

import { describe, expect, it } from "vitest";

import { exec, execState, execInFrame } from "../../eval/generator-exec.js";
import { toJS } from "../../membrane/membrane.js";
import type { SchemeValue } from "../../values/types.js";
import { EnvCapability } from "../../common/capability.js";
import { buildVocabulary } from "../../env/vocabulary.js";
import invariant from "tiny-invariant";
// In-package test: the module-internal storage write (hermetic-Environment ruling — no public set).
import { bindValue, AmbientRuntime, type ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { AString } from "../../values/primitives/AString.js";

import { arrivalLoaderCapability } from "../loader-capability.js";
import { loaderFromResolver } from "../loader.js";
import type { RunEnv } from "../loader.js";

// `arrivalLoaderCapability` declares no `symbol.define`/`defineSyntax` entries, so
// `buildVocabulary`'s Pass-2 bake never actually calls this — a real evalScheme is supplied only
// because the parameter is required at the type level (`EvalSchemeInto`, no optional callers).
const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

/** Unwrap an `execState` boxed value. `exec` results are already JS — do not re-cross. */
const boxed = (v: SchemeValue): unknown => toJS(v);

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

describe("arrivalLoaderCapability — the declarative module system", () => {
  it("door by absence: a config-less run succeeds and `require` binds the fs-or-loader door", async () => {
    await expect(exec(`(require "x.json")`, { capabilities: [arrivalLoaderCapability] })).rejects.toThrow(
      /require @ arrival\/loader is not available.*requires configuration `fs` or `loader` — provide one of them/s,
    );
  });

  it("door by absence: no extensionRegistry ⇒ `require/extension` binds a door naming it", async () => {
    await expect(
      exec(`(require/extension :sql)`, { capabilities: [arrivalLoaderCapability], config: { loader: files({}) } }),
    ).rejects.toThrow(/require\/extension @ arrival\/loader is not available.*requires configuration `extensionRegistry`/s);
  });

  it("an armed loader resolves a data module (raw scheme args + no return marshal)", async () => {
    const results = await exec(`(define cfg (require "cfg.json")) (assoc "irrelevant" (list)) cfg`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: files({ "cfg.json": `{"name":"world"}` }) } });
    const cfg = results.at(-1) as Record<string, unknown>;
    expect(cfg).toMatchObject({ name: "world" });
  });

  it("JSONC (.json with // comments + trailing commas) resolves like strict JSON", async () => {
    const src = `{
      // provider roster
      "name": "world",
      "tags": ["a", "b",],
    }`;
    const results = await exec(`(define cfg (require "cfg.json")) cfg`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: files({ "cfg.json": src }) } });
    const cfg = results.at(-1) as Record<string, unknown>;
    expect(cfg).toMatchObject({ name: "world", tags: ["a", "b"] });
  });

  it("a .scm require spills its defines into the RUN env (the ctx-read frame)", async () => {
    const results = await exec(`(require "lib.scm") (+ lib-answer 1)`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: files({ "lib.scm": `(define lib-answer 41)` }) } });
    expect(Number(results.at(-1))).toBe(42);
  });

  it("require/register-extension: callable from a DEPENDENT capability's prelude via the per-run prelude pass; unbound from user code", async () => {
    // An ext-style capability, exactly like ext/yaml: a `symbol.native` resolver verb (the
    // `{ value }` raw-binding arm is retired — a resolver is an ordinary verb; the loader's
    // `applyCallback` dispatches its apply term) + a prelude that registers the suffix by
    // name. No overlay wiring anywhere — the per-run prelude pass supplies the scope.
    const extCap = EnvCapability.define("test/ext-upper", {
      symbols: (symbol, z) => ({
        "test/upper-resolve": symbol.native`test/upper-resolve: uppercases module contents (ResolverResult value kind)`(
          { input: [z.schemeValue, z.schemeValue], output: [z.schemeValue] },
          (contents: unknown) => ({ kind: "value", value: String(contents).toUpperCase() }) as never,
        ) }),
      prelude: `(require/register-extension ".upper" "test/upper-resolve")` });
    // Tuple identity is config-object-IDENTITY-keyed (`buildVocabulary`'s memo) — reuse the SAME
    // config (and capabilities array) across both calls so the reused `runCtx` matches this
    // tuple, not a distinct one.
    const capabilities = [extCap, arrivalLoaderCapability];
    const config = { loader: files({ "shout.upper": "hello" }) };
    const state = await execState(`(require "shout.upper")`, { capabilities, config });
    // The prelude registration took: a `.upper` require resolves through the by-name registry.
    expect(boxed(state.values.at(-1)!)).toBe("HELLO");
    // And the verb itself is assembly-time-only. Reuse the SAME runCtx (REPL continuity) so the
    // prelude pass does not re-fire.
    await expect(
      exec(`(require/register-extension ".x" "nope")`, { capabilities, config, runCtx: state.runCtx }),
    ).rejects.toThrow(/Unbound variable/);
  });

  it("(require/extension :name) applies a registry pack onto the live env, idempotently", async () => {
    let applies = 0;
    const registry = new Map([
      [
        "greeter",
        {
          name: "ext/greeter",
          apply: (env: RunEnv) => {
            applies += 1;
            // The assembler applies registry packs onto the REAL live env; with the
            // JS-side write surface retired, the pack binds through the module-internal
            // door exactly as capability.ts's apply does (same instanceof narrow).
            // W8: ANativeProcedure, not a bare host fn.
            invariant(env instanceof AmbientRuntime, "registry pack expects a real env");
            bindValue(
              env,
              "greeting-of",
              new ANativeProcedure({
                name: "greeting-of",
                arity: { min: 0, max: 0 },
                contract: undefined,
                impl: () => new AString("hi") }),
            );
          } },
      ],
    ]);
    const results = await exec(`(require/extension :greeter) (require/extension :greeter) (greeting-of)`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: files({}), extensionRegistry: registry } });
    expect(results.at(-1)).toBe("hi");
    expect(applies).toBe(1);
  });

  describe("door-set degradation — the auto-derived requiresConfig doors, mode-independent (D2)", () => {
    it("Vocabulary.degraded enumerates arrival/loader with ALL missing keys when nothing is configured", async () => {
      const vocabulary = await buildVocabulary([arrivalLoaderCapability], {}, evalScheme);
      expect(vocabulary.degraded).toEqual([
        {
          capability: "arrival/loader",
          needs: [
            { kind: "configuration", key: "fs" },
            { kind: "configuration", key: "loader" },
            { kind: "configuration", key: "extensionRegistry" },
          ] },
      ]);
    });

    it("an armed loader is NOT degraded — `require` binds for real", async () => {
      const results = await exec(`(require "cfg.json")`, {
        capabilities: [arrivalLoaderCapability],
        config: { loader: files({ "cfg.json": `{"name":"world"}` }) } });
      const cfg = results.at(-1) as Record<string, unknown>;
      expect(cfg).toMatchObject({ name: "world" });
    });

    it("the door mints unconditionally — requiresConfig is mode-independent", async () => {
      await expect(exec(`(require "x.json")`, { capabilities: [arrivalLoaderCapability] })).rejects.toThrow(
        /is not available/,
      );
      await expect(exec(`(require "x.json")`, { capabilities: [arrivalLoaderCapability] })).rejects.not.toThrow(
        /Unbound variable|PurityError/,
      );
    });
  });

  describe("a required .scm module composes with base builtins", () => {
    // THE REGRESSION (found by the CLI build, pre-Cut-4): under the self-hosted vocabulary path,
    // a required module's forms must resolve through the run's COMPOSED resolver
    // (`currentRunResolver()` → `execExpr({ resolver })`), not a bare frame rebuild — else module
    // code can't see base builtins (`string-append` unbound).
    it("a required .scm module sees base builtins (string-append) and spills its defines", async () => {
      const table: Record<string, string> = {
        "lib.scm": `(define (greet name) (string-append "hello " name))` };
      const results = await exec(`(require "lib.scm") (greet "world")`, {
        capabilities: [arrivalLoaderCapability],
        config: {
          fs: {
            readFile: (p: string) => {
              const hit = table[p];
              if (hit === undefined) throw new Error(`no such file: ${p}`);
              return hit;
            } },
          dirname: "" } });
      expect(results.at(-1)).toBe("hello world");
    });

    it("a required data module resolves too (fs IS the intent to support require)", async () => {
      const table: Record<string, string> = { "cfg.json": `{"name":"world"}` };
      const results = await exec(`(define cfg (require "cfg.json")) cfg`, {
        capabilities: [arrivalLoaderCapability],
        config: {
          fs: { readFile: (p: string) => table[p] ?? "" },
          dirname: "" } });
      expect(results.at(-1)).toMatchObject({ name: "world" });
    });
  });
});
