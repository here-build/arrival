// loader-capability.test.ts — `arrivalLoaderCapability`: the module system as a declarative
// EnvCapability. Proves the postures against a REAL env + assembleEnv + exec:
//   1. door by absence (the Stage-6 `.define` posture — `Contract.requiresConfig`, D2): no
//      `fs`/`loader` config ⇒ lower succeeds and `require` binds a cause-carrying
//      DoorProcedure teaching "provide `fs` or `loader`" — the auto-derived door mints under
//      EITHER degradation mode (requiresConfig is read unconditionally), replacing the old
//      unbound-variable withholding (same for `require/extension` without a registry, naming
//      `extensionRegistry`). `require`'s gate is the DISJUNCTIVE requiresConfig form
//      (`[["fs", "loader"]]` — any-of).
//   2. an armed loader resolves data + spills `.scm` defines into the RUN env (the ctx-read
//      env — raw-bound `symbol.native`);
//   3. `require/register-extension` is the capability's `preludeOnly` symbol: callable from a
//      DEPENDENT capability's prelude during plain `assembleEnv` (the kernel's phase-gated
//      prelude scope — no caller wiring), a plain unbound-variable error from user code.
//   4. `AssembledEnv.degraded` enumerates the missing keys (design doc
//      symbol-define-static-program-validation.md §3.7) under `degradation: "doors"`.

import { afterEach, describe, expect, it } from "vitest";

import { exec } from "../../eval/generator-exec.js";
import { inferenceEnv as sandboxedEnv } from "../../env/inference-env.js";
import { schemeToJs } from "../../membrane/rosetta.js";
import type { SchemeValue } from "../../values/types.js";
import { EnvCapability } from "../../common/capability.js";
import { assembleEnv } from "../../common/kernel.js";
import type { SchemeEnv } from "../../common/scheme-env.js";
import invariant from "tiny-invariant";
// In-package test: the module-internal storage write (hermetic-Environment ruling — no public set).
import { bindValue, AmbientRuntime, mintFrame } from "../../env/AmbientRuntime.js";

import { __resetExtensionRegistryForTest } from "../loader-extensions.js";
import { arrivalLoaderCapability } from "../loader-capability.js";
import { loaderFromResolver } from "../loader.js";

const evalScheme = (e: SchemeEnv, src: string) => exec(src, { env: e as never });

afterEach(() => __resetExtensionRegistryForTest());

/** Assemble the loader capability (plus any `extra` packs) onto a fresh sandboxed child.
 *  `degradation` defaults to unset (⇒ `"forbid"`, byte-identical to pre-W2 withhold).
 *  UNCHANGED return shape (bare env) — every existing call site keeps working untouched;
 *  `assembledWithDegraded` below is the (new, additive) sibling that also hands back
 *  `AssembledEnv.degraded` for the tests that need it. */
async function assembled(config: object, extra: readonly EnvCapability[] = [], degradation?: "forbid" | "doors") {
  const base = mintFrame(sandboxedEnv, "loader-capability-test");
  // The loader capability LAST (lowest precedence ⇒ applied first), the slot loader-core held —
  // so its preludeOnly register-extension is in the assembly's prelude scope before any
  // dependent capability's prelude evaluates.
  const packs = [...extra, arrivalLoaderCapability].map((c) => c.lower({ evalScheme, config, degradation }));
  await assembleEnv<SchemeEnv>(base as unknown as SchemeEnv, packs as never);
  return base;
}

/** Same assembly, but surfaces `AssembledEnv.degraded` too (§3.7's enumerable-degraded-list
 *  row) — a separate helper rather than changing `assembled`'s return shape, so every
 *  existing call site above (and below) is untouched. */
async function assembledWithDegraded(config: object, degradation?: "forbid" | "doors") {
  const base = mintFrame(sandboxedEnv, "loader-capability-test-degraded");
  const packs = [arrivalLoaderCapability].map((c) => c.lower({ evalScheme, config, degradation }));
  const assembly = await assembleEnv<SchemeEnv>(base as unknown as SchemeEnv, packs as never);
  return { env: assembly.env, degraded: assembly.degraded };
}

/** Deep-unwrap an `exec` result for assertion. `exec` returns plain-JS-observable values
 *  (containers egress as lazy proxies), typed `unknown`; `schemeToJs`'s strict parameter
 *  (`SchemeValue | null | undefined`) is the membrane law's face. The narrow is the SAME
 *  seam every loader consumer crosses today (chain-env's `schemeToJs(last, {})`) — the
 *  proxy IS schemeToJs-consumable at runtime; the static story lands with the in-flight
 *  AListAlike propagation. */
const plain = (v: unknown): unknown => schemeToJs(v as SchemeValue, {});

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

describe("arrivalLoaderCapability — the declarative module system", () => {
  it("door by absence: a config-less lower succeeds and `require` binds the fs-or-loader door", async () => {
    const env = await assembled({});
    await expect(exec(`(require "x.json")`, { env })).rejects.toThrow(
      /require @ arrival\/loader is not available.*requires configuration `fs` or `loader` — provide one of them/s,
    );
  });

  it("door by absence: no extensionRegistry ⇒ `require/extension` binds a door naming it", async () => {
    const env = await assembled({ loader: files({}) });
    await expect(exec(`(require/extension :sql)`, { env })).rejects.toThrow(
      /require\/extension @ arrival\/loader is not available.*requires configuration `extensionRegistry`/s,
    );
  });

  it("an armed loader resolves a data module (raw scheme args + no return marshal)", async () => {
    const env = await assembled({ loader: files({ "cfg.json": `{"name":"world"}` }) });
    const results = await exec(`(define cfg (require "cfg.json")) (assoc "irrelevant" (list)) cfg`, { env });
    const cfg = plain(results.at(-1)) as Record<string, unknown>;
    expect(cfg).toMatchObject({ name: "world" });
  });

  it("a .scm require spills its defines into the RUN env (the ctx-read frame)", async () => {
    const env = await assembled({ loader: files({ "lib.scm": `(define lib-answer 41)` }) });
    const results = await exec(`(require "lib.scm") (+ lib-answer 1)`, { env });
    expect(Number(results.at(-1))).toBe(42);
  });

  it("require/register-extension: callable from a DEPENDENT capability's prelude via plain assembleEnv; unbound from user code", async () => {
    // An ext-style capability, exactly like ext/yaml: a `{ value }` resolver + a prelude that
    // registers the suffix by name. No overlay wiring anywhere — the kernel supplies the scope.
    const extCap = new EnvCapability("test/ext-upper", {
      symbols: {
        "test/upper-resolve": {
          value: (contents: unknown) => ({ kind: "value", value: String(contents).toUpperCase() }),
        },
      },
      prelude: `(require/register-extension ".upper" "test/upper-resolve")`,
    });
    const env = await assembled({ loader: files({ "shout.upper": "hello" }) }, [extCap]);
    // The prelude registration took: a `.upper` require resolves through the by-name registry.
    const results = await exec(`(require "shout.upper")`, { env });
    expect(plain(results.at(-1))).toBe("HELLO");
    // And the verb itself is assembly-time-only.
    await expect(exec(`(require/register-extension ".x" "nope")`, { env })).rejects.toThrow(/Unbound variable/);
  });

  it("(require/extension :name) applies a registry pack onto the live env, idempotently", async () => {
    let applies = 0;
    const registry = new Map([
      [
        "greeter",
        {
          name: "ext/greeter",
          apply: (env: SchemeEnv) => {
            applies += 1;
            // The assembler applies registry packs onto the REAL live env; with the
            // JS-side write surface retired, the pack binds through the module-internal
            // door exactly as capability.ts's apply does (same instanceof narrow).
            invariant(env instanceof AmbientRuntime, "registry pack expects a real env");
            bindValue(env, "greeting-of", () => "hi");
          },
        },
      ],
    ]);
    const env = await assembled({ loader: files({}), extensionRegistry: registry });
    const results = await exec(
      `(require/extension :greeter) (require/extension :greeter) (greeting-of)`,
      { env },
    );
    expect(plain(results.at(-1))).toBe("hi");
    expect(applies).toBe(1);
  });

  describe("door-set degradation — the auto-derived requiresConfig doors, mode-independent (D2)", () => {
    it("no fs/loader + \"doors\": `require` teaches the fs-or-loader disjunction", async () => {
      const env = await assembled({}, [], "doors");
      await expect(exec(`(require "x.json")`, { env })).rejects.toThrow(
        /require @ arrival\/loader is not available.*requires configuration `fs` or `loader` — provide one of them to enable this verb\./s,
      );
    });

    it("no extensionRegistry + \"doors\": `require/extension` teaches the same, naming extensionRegistry", async () => {
      const env = await assembled({ loader: files({}) }, [], "doors");
      await expect(exec(`(require/extension :sql)`, { env })).rejects.toThrow(
        /require\/extension @ arrival\/loader is not available.*requires configuration `extensionRegistry` — provide it to enable this verb\./s,
      );
    });

    it("AssembledEnv.degraded enumerates arrival/loader with BOTH missing keys when nothing is configured", async () => {
      const { degraded } = await assembledWithDegraded({}, "doors");
      expect(degraded).toEqual([
        {
          capability: "arrival/loader",
          needs: [
            { kind: "configuration", key: "fs" },
            { kind: "configuration", key: "loader" },
            { kind: "configuration", key: "extensionRegistry" },
          ],
        },
      ]);
    });

    it("an armed loader is NOT degraded — `require` binds for real, even under \"doors\" mode", async () => {
      const env = await assembled({ loader: files({ "cfg.json": `{"name":"world"}` }) }, [], "doors");
      const results = await exec(`(require "cfg.json")`, { env });
      const cfg = plain(results.at(-1)) as Record<string, unknown>;
      expect(cfg).toMatchObject({ name: "world" });
    });

    it("under the default (\"forbid\") mode the door mints all the same — requiresConfig is mode-independent", async () => {
      const env = await assembled({});
      await expect(exec(`(require "x.json")`, { env })).rejects.toThrow(/is not available/);
      await expect(exec(`(require "x.json")`, { env })).rejects.not.toThrow(/Unbound variable|PurityError/);
    });
  });

  describe("CUT mode — exec({ capabilities: [arrivalLoaderCapability] })", () => {
    // THE REGRESSION (found by the CLI build): under the cut, the run resolves through
    // `Resolver(lexicalRoot, capabilityBase)` — the lexical frame is null-rooted, the stdlib
    // lives on the capability base. A required module's forms used to evaluate via
    // `execExpr({ env: currentRunEnv() })`, which rebuilt a GLASS resolver over the bare
    // frame — so module code couldn't see base builtins (`string-append` unbound). The fix
    // threads the run's COMPOSED resolver (`currentRunResolver()` → `execExpr({ resolver })`),
    // so cut and glass resolve identically.
    it("a required .scm module sees base builtins (string-append) and spills its defines", async () => {
      const table: Record<string, string> = {
        "lib.scm": `(define (greet name) (string-append "hello " name))`,
      };
      const results = await exec(`(require "lib.scm") (greet "world")`, {
        capabilities: [arrivalLoaderCapability],
        config: {
          fs: {
            readFile: (p: string) => {
              const hit = table[p];
              if (hit === undefined) throw new Error(`no such file: ${p}`);
              return hit;
            },
          },
          dirname: "",
        },
      });
      expect(results.at(-1)).toBe("hello world");
    });

    it("a required data module resolves under the cut too (fs IS the intent to support require)", async () => {
      const table: Record<string, string> = { "cfg.json": `{"name":"world"}` };
      const results = await exec(`(define cfg (require "cfg.json")) cfg`, {
        capabilities: [arrivalLoaderCapability],
        config: {
          fs: { readFile: (p: string) => table[p] ?? "" },
          dirname: "",
        },
      });
      expect(plain(results.at(-1))).toMatchObject({ name: "world" });
    });
  });
});
