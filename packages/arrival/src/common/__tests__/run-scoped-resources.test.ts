// run-scoped-resources.test.ts — STAGE 2 (docs/execution.md §HERMETIC): capability resources
// keyed by RunContext, spawned lazily on first touch, reused across REPL passes that SHARE a
// RunContext, disposed exactly once at that RunContext's end — never per-exec-pass, never
// ambient-wide. Covers BOTH resource paths (`common/capability.ts`'s header names them):
//
//   • the CONSTRUCTOR path — `new EnvCapability(name, { resources: {...} })`, a baked verb's
//     `this.resources.<key>.live/.get()` (the `gateResources` wrapper).
//   • the DEFINE path — `EnvCapability.define(name, { resources: (config) => Resources })`,
//     a baked verb's `this.resources` as the WHOLE authored bag (`gateDefinedResources`).
//
// `capability.test.ts` / `callctx-activation-dispatch.test.ts` / `capability-define-symbols
// .test.ts` cover the AUTHORING/inference surface; this file is Stage 2's own lifecycle proof.
import { describe, expect, it } from "vitest";

import { EnvCapability } from "../capability.js";
import { symbol } from "../symbol.js";
import * as sz from "../scheme-zod.js";
import { port, type Resource } from "../resources.js";
import { exec } from "../../eval/generator-exec.js";
import { freshEnv } from "../../__tests__/_fresh-env.js";
import { makeRunContext } from "../../run/RunContext.js";
import { disposeRunContext } from "../../run/run-lifecycle.js";
import type { CallCtx } from "../../run/CallCtx.js";

describe("Stage 2 — per-RunContext capability resources", () => {
  describe("constructor path (`new EnvCapability`)", () => {
    function spyCapability() {
      const counts = { acquired: 0, disposed: 0 };
      const resource: Resource<{ tag: string }> = {
        kind: "test/run-scoped-spy",
        async acquire() {
          counts.acquired += 1;
          return port({ tag: "live" }, () => {
            counts.disposed += 1;
          });
        },
      };
      const capability = new EnvCapability("test/run-scoped-ctor", {
        resources: { port: resource },
        symbols: {
          "spy/touch": symbol.rosetta`spy/touch: read the spy port's tag`(
            { input: [], output: [sz.string] },
            function (this: CallCtx): string {
              const res = this.resources as { port: { live: { tag: string } } } | undefined;
              return res?.port.live.tag ?? "NO-RESOURCE";
            },
          ),
        },
      });
      return { capability, counts };
    }

    it("(a) a resource with an observable [Symbol.asyncDispose] is disposed exactly once at run-end", async () => {
      const { capability, counts } = spyCapability();
      const env = await freshEnv();
      await capability.lower({}).apply(env, undefined as never);
      const runCtx = makeRunContext({});

      const [out] = await exec("(spy/touch)", { env, runCtx });
      expect(out).toBe("live");
      expect(counts.acquired).toBe(1);
      expect(counts.disposed).toBe(0); // still live — the RunContext hasn't ended yet

      await disposeRunContext(runCtx);
      expect(counts.disposed).toBe(1);

      await disposeRunContext(runCtx); // idempotent — a second call never double-disposes
      expect(counts.disposed).toBe(1);
    });

    it("(b) spawned once and REUSED across passes sharing one RunContext; FRESH across different RunContexts", async () => {
      const { capability, counts } = spyCapability();
      const env = await freshEnv();
      await capability.lower({}).apply(env, undefined as never);

      const sessionRunCtx = makeRunContext({});
      await exec("(spy/touch)", { env, runCtx: sessionRunCtx }); // pass 1
      await exec("(spy/touch)", { env, runCtx: sessionRunCtx }); // pass 2 — REPL continuity
      expect(counts.acquired).toBe(1); // single-flight across passes of ONE RunContext

      const otherRunCtx = makeRunContext({});
      await exec("(spy/touch)", { env, runCtx: otherRunCtx }); // a DIFFERENT session
      expect(counts.acquired).toBe(2); // per-run isolation — a fresh spawn, not a shared one

      await disposeRunContext(sessionRunCtx);
      await disposeRunContext(otherRunCtx);
      expect(counts.disposed).toBe(2);
    });

    it("(c) a resource-less capability's verb never touches any resource gate", async () => {
      const capability = new EnvCapability("test/run-scoped-none", {
        symbols: {
          "plain/touch": symbol.rosetta`plain/touch: no resources declared — the ungated fast path`(
            { input: [], output: [sz.string] },
            function (this: CallCtx): string {
              const res = this.resources as Record<string, unknown> | undefined;
              // No `resources` declared ⇒ the fast (ungated) path: whatever `this.resources` is,
              // it carries no keys — never a per-RunContext bag this capability never asked for.
              return `plain:${Object.keys(res ?? {}).length}`;
            },
          ),
        },
      });
      const env = await freshEnv();
      await capability.lower({}).apply(env, undefined as never);

      const [out] = await exec("(plain/touch)", { env });
      expect(out).toBe("plain:0");
    });
  });

  describe("define path (`EnvCapability.define`)", () => {
    interface Cache {
      readonly get: (k: string) => string | undefined;
      readonly set: (k: string, v: string) => void;
      [Symbol.asyncDispose]?: () => Promise<void>;
    }

    function spyDefined() {
      const counts = { spawned: 0, disposed: 0 };
      const capability = EnvCapability.define("test/run-scoped-define", {
        resources: (): Cache => {
          counts.spawned += 1;
          const store = new Map<string, string>();
          return {
            get: (k) => store.get(k),
            set: (k, v) => void store.set(k, v),
            [Symbol.asyncDispose]: async () => {
              counts.disposed += 1;
            },
          };
        },
        symbols: (symbol, sz) => ({
          "cache/put": symbol.rosetta`cache/put: write a key into this run's cache`(
            { input: [sz.string, sz.string], output: [sz.string] },
            function (key: string, value: string) {
              this.resources.set(key, value);
              return value;
            },
          ),
          "cache/get": symbol.rosetta`cache/get: read a key back — MISS if never written under this run`(
            { input: [sz.string], output: [sz.string] },
            function (key: string) {
              return this.resources.get(key) ?? "MISS";
            },
          ),
        }),
      });
      return { capability, counts };
    }

    it("(a) the produced bag's [Symbol.asyncDispose] fires exactly once at RunContext end", async () => {
      const { capability, counts } = spyDefined();
      const env = await freshEnv();
      await capability.lower({}).apply(env, undefined as never);
      const runCtx = makeRunContext({});

      const [out] = await exec('(cache/put "k" "v")', { env, runCtx });
      expect(out).toBe("v");
      expect(counts.spawned).toBe(1);
      expect(counts.disposed).toBe(0);

      await disposeRunContext(runCtx);
      expect(counts.disposed).toBe(1);
      await disposeRunContext(runCtx);
      expect(counts.disposed).toBe(1); // idempotent
    });

    it("(b) the cache PERSISTS across passes sharing a RunContext; a different RunContext starts EMPTY", async () => {
      const { capability, counts } = spyDefined();
      const env = await freshEnv();
      await capability.lower({}).apply(env, undefined as never);

      const sessionRunCtx = makeRunContext({});
      await exec('(cache/put "k1" "v1")', { env, runCtx: sessionRunCtx }); // pass 1: write
      const [stillThere] = await exec('(cache/get "k1")', { env, runCtx: sessionRunCtx }); // pass 2: read, no write
      expect(stillThere).toBe("v1"); // the SAME Map survived across passes of ONE RunContext
      expect(counts.spawned).toBe(1); // one bag for the whole session

      const otherRunCtx = makeRunContext({});
      const [fresh] = await exec('(cache/get "k1")', { env, runCtx: otherRunCtx });
      expect(fresh).toBe("MISS"); // a DIFFERENT Map — nothing carried over
      expect(counts.spawned).toBe(2);

      await disposeRunContext(sessionRunCtx);
      await disposeRunContext(otherRunCtx);
    });
  });
});
