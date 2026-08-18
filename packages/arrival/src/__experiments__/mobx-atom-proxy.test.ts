/**
 * MOBX ATOM-PROXY SPIKE (`__experiments__/` — opt-in via `pnpm experiments`, NEVER a
 * CI gate).
 *
 * Product law freezes MobX as the INTERNAL library of choice behind `AtomProxy`
 * (01-unified-design §8.4 / STATUS #4), and the frozen reactivity suite makes that a
 * two-sided rule: no case may assert MobX API, and any MobX-proxy spike lives here
 * rather than in `__tests__/` (SUITE §Phase gates). The behavioral contract is
 * carried by `run/__tests__/path-atom-arming.law.test.ts` over the memory proxy; all
 * this spike adds is evidence that a real MobX `createAtom` satisfies the same seam.
 *
 * mobx is an OPTIONAL peer dependency, so the spike LOUD-SKIPS when it is absent
 * (.claude/rules/tests.md) — a missing peer must never read as a passing gate.
 */
import { describe, expect, it } from "vitest";

import { EnvCapability } from "../common/capability.js";
import { exec } from "../eval/generator-exec.js";
import { ProxyPathAtomBus, atomKey } from "../run/path-atom-bus.js";
import type { ResourcePath } from "../run/resource-paths.js";

/** Resolve mobx without making it a hard import — absent ⇒ skip, never crash. */
const mobx = await (async () => {
  try {
    return await import("mobx");
  } catch {
    return undefined;
  }
})();

if (mobx === undefined) {
  console.warn(
    "[__experiments__/mobx-atom-proxy] SKIPPED — optional peer `mobx` is not installed. " +
      "Run `pnpm add -D mobx` in packages/arrival to exercise this spike. " +
      "The memory-proxy contract is covered by run/__tests__/path-atom-arming.law.test.ts.",
  );
}

describe.skipIf(mobx === undefined)("MobX-backed AtomProxy satisfies the PathAtomBus seam", () => {
  const cap = EnvCapability.define("experiment/mobx-atom-proxy", {
    symbols: (symbol, z) => ({
      read: symbol.rosetta`read: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: (d: string, id: string): readonly ResourcePath[] => [["test", d, id]],
        },
        (d: string, id: string) => `${d}:${id}`,
      ),
      write: symbol.rosetta`write: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          effects: (d: string, id: string): readonly ResourcePath[] => [["test", d, id]],
        },
        () => undefined,
      ),
    }),
  });

  it("a run arms and invalidates through a real MobX atom, observed by a MobX reaction", async () => {
    const { createMobxAtomProxy } = await import("../run/mobx-atom-proxy.js");
    const { autorun } = mobx!;
    const bus = new ProxyPathAtomBus(createMobxAtomProxy());
    const path: ResourcePath = ["test", "D", "id"];

    // A MobX reaction standing in for R2's envelope: it depends on the path atom, so
    // the bus's reportChanged must re-run it. Behavioral only — the assertion is the
    // wake, never a MobX API shape.
    let wakes = 0;
    const stop = autorun(() => {
      bus.observe([path]);
      wakes++;
    });
    expect(wakes).toBe(1);

    await exec('(write "D" "id")', { capabilities: [cap], pathAtoms: bus });
    expect(wakes).toBe(2);

    // A sibling write must NOT wake it (segment-wise matching, same as the door).
    await exec('(write "D" "other")', { capabilities: [cap], pathAtoms: bus });
    expect(wakes).toBe(2);

    stop();
    await exec('(write "D" "id")', { capabilities: [cap], pathAtoms: bus });
    expect(wakes).toBe(2);

    expect(atomKey(path)).toBe('"test"/"D"/"id"');
  });
});
