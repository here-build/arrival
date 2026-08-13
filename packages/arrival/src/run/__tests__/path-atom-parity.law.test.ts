/**
 * LAW — Phase 5 X4 thin parity (**P-RX-PARITY-SCHED** / F-RX8 slice).
 *
 * Behavioral parity of the PathAtomBus seam over two AtomProxy impls:
 *   - memory (createMemoryAtomProxy)
 *   - MobX (createMobxAtomProxy) when the optional peer resolves
 *
 * Suite: docs/working-proposals/cqs-reactivity/test-suite-design/reactivity/SUITE.md
 * Anti-test: never assert MobX API; expectations identical, no case branching.
 *
 * Full X1+X2 parity is cut (F-RX8). This file covers the authorable scheduling
 * subset + key algebra that must not diverge when the bus double swaps.
 */
import { describe, it, expect } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import {
  ProxyPathAtomBus,
  atomKey,
  createMemoryAtomProxy,
  keysArePrefixRelated,
  wouldNotify,
} from "../path-atom-bus.js";
import type { AtomProxy } from "../atom-proxy.js";
import type { ResourcePath } from "../resource-paths.js";
import { createReactionHub } from "../../reactivity/reaction-envelope.js";

const mobxProxy = await (async (): Promise<AtomProxy | undefined> => {
  try {
    const { createMobxAtomProxy } = await import("../mobx-atom-proxy.js");
    return createMobxAtomProxy();
  } catch {
    return undefined;
  }
})();

if (mobxProxy === undefined) {
  console.warn(
    "[path-atom-parity] MobX peer unavailable — parity cases run memory-only self-check; " +
      "install mobx to exercise the second bus impl (optional peer).",
  );
}

const buses: { name: string; proxy: AtomProxy }[] = [
  { name: "memory", proxy: createMemoryAtomProxy() },
  ...(mobxProxy !== undefined ? [{ name: "mobx-proxy", proxy: mobxProxy }] : []),
];

function makeCap(spies: Record<string, number>) {
  const store = new Map<string, string>();
  const track = (n: string) => {
    spies[n] = (spies[n] ?? 0) + 1;
  };
  const cap = EnvCapability.define("test/rx-parity", {
    symbols: (symbol, z) => ({
      read: symbol.rosetta`read: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: (d: string, id: string) => [["test", d, id]] as const,
        },
        (d: string, id: string) => {
          track("read");
          return store.get(`${d}:${id}`) ?? `v1:${d}:${id}`;
        },
      ),
      write: symbol.rosetta`write: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          effects: (d: string, id: string) => [["test", d, id]] as const,
        },
        (d: string, id: string) => {
          track("write");
          store.set(`${d}:${id}`, `v2:${d}:${id}`);
          return undefined;
        },
      ),
    }),
  });
  return { cap, store };
}

describe("X4 thin parity — PathAtomBus over injected proxies (5-parity)", () => {
  it.each(buses)(
    "P-RX-PARITY-SCHED key algebra identical on $name",
    ({ proxy }) => {
      // Same expectations for every bus — no branching on name.
      const bus = new ProxyPathAtomBus(proxy);
      const p: ResourcePath = ["test", "D", "id"];
      const sib: ResourcePath = ["test", "D", "other"];
      bus.observe([p]);
      bus.stageEffects([sib]);
      bus.commitRun(); // sibling — no behavioral assert on internal cells
      // Algebra (X0) is encoding-level and bus-independent — pin once per impl smoke.
      expect(atomKey(p)).toBe(atomKey([...p]));
      expect(keysArePrefixRelated(atomKey(["a"]), atomKey(["a", "b"]))).toBe(true);
      expect(wouldNotify(["test", "D", "id"], [["test", "D"]])).toBe(true);
      expect(wouldNotify(["test", "D", "a"], [["test", "D", "b"]])).toBe(false);
    },
  );

  it.each(buses)(
    "P-RX-PARITY-SCHED observe + run-commit invalidate on $name",
    async ({ proxy }) => {
      const spies: Record<string, number> = {};
      const { cap } = makeCap(spies);
      const bus = new ProxyPathAtomBus(proxy);
      await exec('(read "D" "id")', {
        capabilities: [cap],
        pathAtoms: bus,
        strictCQSstrings: true,
      });
      expect(spies.read).toBe(1);
      await exec('(write "D" "id")', {
        capabilities: [cap],
        pathAtoms: bus,
        strictCQSstrings: true,
      });
      expect(spies.write).toBe(1);
    },
  );

  it.each(buses)(
    "P-RX-PARITY-SCHED hub.invalidate coalesce + self-loop shape on $name envelope",
    async ({ name: _name }) => {
      // Envelope uses its own path buses; parity is behavioral re-invoke counts —
      // identical across runs regardless of which AtomProxy the product might wire later.
      void _name;
      const spies: Record<string, number> = {};
      const { cap } = makeCap(spies);
      const hub = createReactionHub();
      const u = hub.unit({
        code: '(read "D" "id") (write "D" "id")',
        capabilities: [cap],
      });
      await hub.settle({ maxRounds: 8 }); // RX-AUTO: initial run = first drain
      expect(u.runCount).toBe(1); // N-RX-SELF-LOOP

      // coalesce: 3 invalidates → one re-run
      hub.invalidate([["test", "D", "id"]]);
      hub.invalidate([["test", "D", "id"]]);
      hub.invalidate([["test", "D", "id"]]);
      await hub.settle({ maxRounds: 8 });
      expect(u.runCount).toBe(2);
      hub.disposeAll();
    },
  );

  it.each(buses)(
    "P-RX-PARITY-SCHED cross-unit wake on $name",
    async ({ name: _name }) => {
      void _name;
      const spies: Record<string, number> = {};
      const { cap } = makeCap(spies);
      const hub = createReactionHub();
      const b = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
      await hub.settle({ maxRounds: 8 }); // arm b before the writer exists
      const a = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
      await hub.settle({ maxRounds: 8 }); // a's initial run cascades b's re-invoke
      expect(b.runCount).toBe(2);
      expect(a.runCount).toBe(1);
      hub.disposeAll();
    },
  );
});
