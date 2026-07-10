// loader-capability.test.ts — `arrivalLoaderCapability`: the module system as a declarative
// EnvCapability. Proves the three postures against a REAL env + assembleEnv + exec:
//   1. capability withholding by absence — no `loader` config ⇒ lower succeeds, `require` is
//      simply unbound (same for `require/extension` without a registry);
//   2. an armed loader resolves data + spills `.scm` defines into the RUN env (the ctx-read
//      env — raw-bound `symbol.native`);
//   3. `require/register-extension` is the capability's `preludeOnly` symbol: callable from a
//      DEPENDENT capability's prelude during plain `assembleEnv` (the kernel's phase-gated
//      prelude scope — no caller wiring), a plain unbound-variable error from user code.
//   4. door-set degradation (design doc symbol-define-static-program-validation.md §3.7, W2):
//      under `degradation: "doors"`, postures 1's two withholds instead bind a cause-carrying
//      door teaching "provide fs/loader (or extensionRegistry) to enable it". Posture 1's OWN
//      tests are UNCHANGED — they don't pass `degradation`, so they exercise the default
//      `"forbid"` mode, byte-identical to pre-W2 (verified: still green, still "Unbound
//      variable" — the posture only changes for a caller that opts in).

import { afterEach, describe, expect, it } from "vitest";

import { exec, sandboxedEnv, schemeToJs } from "@here.build/arrival";
import { EnvCapability } from "@here.build/arrival/capability";
import { assembleEnv } from "@here.build/arrival/env";
import type { SchemeEnv } from "@here.build/arrival/scheme-env";

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
  const base = sandboxedEnv.inherit("loader-capability-test");
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
  const base = sandboxedEnv.inherit("loader-capability-test-degraded");
  const packs = [arrivalLoaderCapability].map((c) => c.lower({ evalScheme, config, degradation }));
  const assembly = await assembleEnv<SchemeEnv>(base as unknown as SchemeEnv, packs as never);
  return { env: assembly.env, degraded: assembly.degraded };
}

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

describe("arrivalLoaderCapability — the declarative module system", () => {
  it("withholding by absence: a config-less lower succeeds and `require` is unbound", async () => {
    const env = await assembled({});
    await expect(exec(`(require "x.json")`, { env })).rejects.toThrow(/Unbound variable/);
  });

  it("withholding by absence: no extensionRegistry ⇒ `require/extension` is unbound", async () => {
    const env = await assembled({ loader: files({}) });
    await expect(exec(`(require/extension :sql)`, { env })).rejects.toThrow(/Unbound variable/);
  });

  it("an armed loader resolves a data module (raw scheme args + no return marshal)", async () => {
    const env = await assembled({ loader: files({ "cfg.json": `{"name":"world"}` }) });
    const results = await exec(`(define cfg (require "cfg.json")) (assoc "irrelevant" (list)) cfg`, { env });
    const cfg = schemeToJs(results.at(-1), {}) as Record<string, unknown>;
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
    expect(schemeToJs(results.at(-1), {})).toBe("HELLO");
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
            env.set("greeting-of", () => "hi");
          },
        },
      ],
    ]);
    const env = await assembled({ loader: files({}), extensionRegistry: registry });
    const results = await exec(
      `(require/extension :greeter) (require/extension :greeter) (greeting-of)`,
      { env },
    );
    expect(schemeToJs(results.at(-1), {})).toBe("hi");
    expect(applies).toBe(1);
  });

  describe("door-set degradation (degradation: \"doors\") — the withhold-by-absence posture above, opted into a door instead", () => {
    it("no fs/loader + \"doors\": `require` teaches 'provide fs/loader to enable it' instead of Unbound variable", async () => {
      const env = await assembled({}, [], "doors");
      await expect(exec(`(require "x.json")`, { env })).rejects.toThrow(
        /require @ arrival\/loader is not available.*Provide "fs" \(or a pre-built "loader"\) to enable it\./s,
      );
    });

    it("no extensionRegistry + \"doors\": `require/extension` teaches the same, naming extensionRegistry", async () => {
      const env = await assembled({ loader: files({}) }, [], "doors");
      await expect(exec(`(require/extension :sql)`, { env })).rejects.toThrow(
        /require\/extension @ arrival\/loader is not available.*Provide "extensionRegistry" to enable it\./s,
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
      const cfg = schemeToJs(results.at(-1), {}) as Record<string, unknown>;
      expect(cfg).toMatchObject({ name: "world" });
    });

    it("under the default (\"forbid\") mode, behavior is BYTE-IDENTICAL to pre-W2 — still a plain Unbound variable", async () => {
      const env = await assembled({});
      await expect(exec(`(require "x.json")`, { env })).rejects.toThrow(/Unbound variable/);
      await expect(exec(`(require "x.json")`, { env })).rejects.not.toThrow(/PurityError|is not available/);
    });
  });
});
