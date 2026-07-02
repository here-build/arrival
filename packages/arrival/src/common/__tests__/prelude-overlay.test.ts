// prelude-overlay.test.ts — end-to-end proof of the SHARED, ACCUMULATING prelude-overlay
// mechanism (design doc §1.3), against a REAL Environment + assembleEnv + EnvCapability +
// exec (mirrors the pattern in env/__tests__/srfi.test.ts, which assembles real capabilities
// onto a real sandboxed env). This is the scheme-level proof that:
//   1. a preludeOnly verb is UNBOUND in the runtime env after assembly, but a LATER
//      capability's prelude that calls it during assembly succeeds (observable side effect).
//   2. an ordinary prelude `define` still lands in the runtime env (fact 1 of §1.3 — base
//      packs like scheme/core rely on this).
//   3. the overlay ACCUMULATES across capabilities: capability A contributes a preludeOnly
//      verb; capability B (deps on A) calls it from ITS OWN prelude.
//
// The re-parenting mechanism itself (sandboxBase ← preludeOverlay ← R, torn down after the
// C3 loop) is exercised INLINE here exactly as `buildArrivalEnv` (arrival-chain/run-program.ts)
// wires it — this file proves the mechanism arrival-chain's real build then reuses.

import { describe, expect, it } from "vitest";

import { exec, sandboxedEnv } from "../../index.js";
import { assembleEnv, type EnvPack } from "../kernel.js";
import { EnvCapability } from "../capability.js";
import { symbol } from "../symbol.js";
import * as z from "../scheme-zod.js";
import type { SchemeEnv } from "../scheme-env.js";

const evalScheme = (e: SchemeEnv, src: string) => exec(src, { env: e as never });

/** Mirrors buildArrivalEnv's overlay wiring exactly (design §1.3): build a transient overlay
 *  as a child of the sandbox base, re-parent `base` onto it for the duration of assembly, then
 *  restore `base`'s original parent and drop the overlay. Returns the assembled env (== base). */
async function assembleWithPreludeOverlay(
  base: ReturnType<typeof sandboxedEnv.inherit>,
  packs: readonly EnvPack<SchemeEnv>[],
): Promise<ReturnType<typeof sandboxedEnv.inherit>> {
  const originalParent = base.__parent__;
  const preludeOverlay = (originalParent ?? sandboxedEnv).inherit("prelude-overlay");
  base.__parent__ = preludeOverlay as never;
  try {
    await assembleEnv<SchemeEnv>(base as unknown as SchemeEnv, packs, { preludeScope: preludeOverlay as unknown as SchemeEnv });
  } finally {
    base.__parent__ = originalParent;
  }
  return base;
}

describe("prelude overlay — shared, accumulating, extended-scope mechanism (design §1.3)", () => {
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
      // B's prelude calls A's preludeOnly verb (visible because the overlay accumulates
      // across the C3 loop) and forwards the result to a RUNTIME-bound sink.
      prelude: `(sink/record (overlay/greet "world"))`,
    });

    const base = sandboxedEnv.inherit("overlay-test-1");
    const env = await assembleWithPreludeOverlay(base, [capB.lower({ evalScheme }) as never]);

    // The prelude ran during assembly and observably called the preludeOnly verb.
    expect(calls).toEqual(["hello world"]);

    // The preludeOnly verb itself is a plain unbound-variable error at runtime — nothing to seal.
    await expect(exec(`(overlay/greet "again")`, { env })).rejects.toThrow(/Unbound variable/);
  });

  it("an ordinary prelude `define` still lands in the runtime env when the overlay is active (fact 1 survives)", async () => {
    const cap = new EnvCapability("test/overlay-define", {
      prelude: `(define overlay-defined-value 42)`,
    });
    const base = sandboxedEnv.inherit("overlay-test-2");
    const env = await assembleWithPreludeOverlay(base, [cap.lower({ evalScheme }) as never]);

    const result = await exec(`overlay-defined-value`, { env });
    expect(Number(result[0])).toBe(42);
  });

  it("the overlay ACCUMULATES: A's preludeOnly verb is visible to a chain of TWO dependents via C3 order", async () => {
    const capA = new EnvCapability("test/overlay-chain-a", {
      symbols: {
        "chain/base-secret": symbol.rosetta`chain/base-secret: preludeOnly value contributed by A`(
          { input: [], output: [z.number], preludeOnly: true },
          () => 7,
        ),
      },
    });
    // B deps on A, contributes ITS OWN preludeOnly verb built from A's (proving accumulation,
    // not just single-hop visibility), and records what it saw at prelude-eval time.
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
    // C deps on B (transitively on A) — proves the overlay is the SAME shared scope across the
    // whole assembly, not re-built per-capability.
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
    await assembleWithPreludeOverlay(base, [capC.lower({ evalScheme }) as never]);

    expect(bSeen).toEqual([7]);
    expect(cSeen).toEqual([7]);
  });

  it("after assembly, base.__parent__ is restored to the original sandbox base (no residual overlay frame)", async () => {
    const cap = new EnvCapability("test/overlay-teardown", { symbols: {} });
    const base = sandboxedEnv.inherit("overlay-test-4");
    const originalParent = base.__parent__;
    await assembleWithPreludeOverlay(base, [cap.lower({ evalScheme }) as never]);
    expect(base.__parent__).toBe(originalParent);
  });
});
