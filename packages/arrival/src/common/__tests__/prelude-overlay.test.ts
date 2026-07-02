// prelude-overlay.test.ts — end-to-end proof of the phase-gated `preludeOnly` mechanism
// (design doc §1.3, reworked: the kernel owns the prelude scope — a per-assembly Map behind
// `ctx.preludeScope`, answered by a phase-gated resolver on the base env), against a REAL
// Environment + assembleEnv + EnvCapability + exec. No caller-side wiring exists anymore:
// plain `assembleEnv(base, packs)` is the WHOLE story. Facts proven:
//   1. a preludeOnly verb is callable from a LATER capability's prelude during assembly,
//      and a plain unbound-variable error at runtime.
//   2. an ordinary prelude `define` lands in the runtime env (fact 1 of §1.3 — now trivially:
//      the prelude evaluates against the runtime env itself, no overlay in the chain).
//   3. the prelude scope ACCUMULATES across capabilities (C3 dep order).
//   4. THE CONTRACT: preludeOnly means ASSEMBLY-TIME-ONLY — even a lambda DEFINED BY a prelude
//      cannot reach the verb at runtime (closures walk the live chain at call time; the
//      phase-gated resolver has gone silent). A prelude bridges a value to runtime by capturing
//      the call's RESULT (`(define x (verb …))`), never the verb.

import { describe, expect, it } from "vitest";

import { exec, sandboxedEnv } from "../../index.js";
import { assembleEnv, type EnvPack } from "../kernel.js";
import { EnvCapability } from "../capability.js";
import { symbol } from "../symbol.js";
import * as z from "../scheme-zod.js";
import type { SchemeEnv } from "../scheme-env.js";

const evalScheme = (e: SchemeEnv, src: string) => exec(src, { env: e as never });

/** Plain assembly onto a fresh sandboxed child — the kernel supplies the prelude scope. */
async function assemble(
  base: ReturnType<typeof sandboxedEnv.inherit>,
  packs: readonly EnvPack<SchemeEnv>[],
): Promise<ReturnType<typeof sandboxedEnv.inherit>> {
  await assembleEnv<SchemeEnv>(base as unknown as SchemeEnv, packs);
  return base;
}

describe("preludeOnly — the kernel's phase-gated prelude scope (design §1.3)", () => {
  it("a preludeOnly verb is UNBOUND at runtime, but a LATER capability's prelude that calls it during assembly works", async () => {
    // Capability A contributes a preludeOnly rosetta. Capability B (deps on A) calls it from
    // its OWN prelude, recording the call as an observable side effect via a runtime-bound sink.
    const calls: string[] = [];
    const capA = new EnvCapability("test/overlay-a", {
      symbols: {
        "overlay/greet": symbol.rosetta`overlay/greet: prelude-only greeting verb`(
          { input: [z.string], output: [z.string], preludeOnly: true },
          (name) => `hello ${name}`,
        ),
      },
    });
    const capB = new EnvCapability("test/overlay-b", {
      deps: [capA],
      symbols: {
        "sink/record": symbol.rosetta`sink/record: record a call for the test to observe`(
          { input: [z.string], output: [z.string] },
          (s) => {
            calls.push(s);
            return s;
          },
        ),
      },
      // B's prelude calls A's preludeOnly verb (visible because A applied first — C3 dep
      // order — and the assembly's resolver answers from the shared Map) and forwards the
      // result to a RUNTIME-bound sink.
      prelude: `(sink/record (overlay/greet "world"))`,
    });

    const base = sandboxedEnv.inherit("overlay-test-1");
    const env = await assemble(base, [capB.lower({ evalScheme }) as never]);

    // The prelude ran during assembly and observably called the preludeOnly verb.
    expect(calls).toEqual(["hello world"]);

    // The preludeOnly verb itself is a plain unbound-variable error at runtime — nothing to seal.
    await expect(exec(`(overlay/greet "again")`, { env })).rejects.toThrow(/Unbound variable/);
  });

  it("an ordinary prelude `define` still lands in the runtime env (fact 1 — now trivially, no overlay)", async () => {
    const cap = new EnvCapability("test/overlay-define", {
      prelude: `(define overlay-defined-value 42)`,
    });
    const base = sandboxedEnv.inherit("overlay-test-2");
    const env = await assemble(base, [cap.lower({ evalScheme }) as never]);

    const result = await exec(`overlay-defined-value`, { env });
    expect(Number(result[0])).toBe(42);
  });

  it("the prelude scope ACCUMULATES: A's preludeOnly verb is visible to a chain of TWO dependents via C3 order", async () => {
    const capA = new EnvCapability("test/overlay-chain-a", {
      symbols: {
        "chain/base-secret": symbol.rosetta`chain/base-secret: preludeOnly value contributed by A`(
          { input: [], output: [z.number], preludeOnly: true },
          () => 7,
        ),
      },
    });
    // B deps on A, records what it saw at prelude-eval time.
    const bSeen: number[] = [];
    const capB = new EnvCapability("test/overlay-chain-b", {
      deps: [capA],
      symbols: {
        "chain/note": symbol.rosetta`chain/note: record a number seen during B's prelude`(
          { input: [z.number], output: [z.number] },
          (n) => {
            bSeen.push(n);
            return n;
          },
        ),
      },
      prelude: `(chain/note (chain/base-secret))`,
    });
    // C deps on B (transitively on A) — proves the prelude scope is the SAME shared Map across
    // the whole assembly, not re-built per-capability.
    const cSeen: number[] = [];
    const capC = new EnvCapability("test/overlay-chain-c", {
      deps: [capB],
      symbols: {
        "chain/note-c": symbol.rosetta`chain/note-c: record a number seen during C's prelude`(
          { input: [z.number], output: [z.number] },
          (n) => {
            cSeen.push(n);
            return n;
          },
        ),
      },
      prelude: `(chain/note-c (chain/base-secret))`,
    });

    const base = sandboxedEnv.inherit("overlay-test-3");
    await assemble(base, [capC.lower({ evalScheme }) as never]);

    expect(bSeen).toEqual([7]);
    expect(cSeen).toEqual([7]);
  });

  it("THE CONTRACT: a lambda DEFINED BY a prelude cannot reach the preludeOnly verb at runtime — capture the RESULT, not the verb", async () => {
    const cap = new EnvCapability("test/overlay-closure", {
      symbols: {
        "closure/secret": symbol.rosetta`closure/secret: preludeOnly source`(
          { input: [], output: [z.number], preludeOnly: true },
          () => 99,
        ),
      },
      // Two preludes-in-one: the WRONG bridge (a lambda naming the verb — resolves nothing at
      // runtime) and the RIGHT bridge (capture the call's result at assembly time).
      prelude: `
        (define (broken-bridge) (closure/secret))
        (define captured-secret (closure/secret))
      `,
    });
    const base = sandboxedEnv.inherit("overlay-test-4");
    const env = await assemble(base, [cap.lower({ evalScheme }) as never]);

    // The captured VALUE is an ordinary runtime binding.
    const result = await exec(`captured-secret`, { env });
    expect(Number(result[0])).toBe(99);
    // The closure walks the LIVE chain at call time — the phase-gated resolver is silent, so
    // the free variable is a plain unbound error. Assembly-time-only is the contract, not a gap.
    await expect(exec(`(broken-bridge)`, { env })).rejects.toThrow(/Unbound variable/);
  });
});
