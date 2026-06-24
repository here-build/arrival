/**
 * FALSIFICATION PROBES for the confluent-dataflow-IR design note
 * (docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md).
 *
 * Before building on the conjectures, pin what the CURRENT interpreter actually
 * does. `it(...)` records the measured baseline; `it.fails(...)` states the
 * design-note IDEAL — it passes today precisely because the interpreter doesn't
 * meet it yet, and flips to a hard failure (prompting promotion) when a slice
 * lands. Same convention as js-interop.test.ts.
 */
import { describe, it, expect } from "vitest";
import { exec } from "../stdlib";
import { inferenceEnv } from "../inference-env";
import { initBridge } from "../bridge";
import { AString } from "../values/primitives/AString.js";
import { AValue } from "../values/primitives/AValue.js";

const stamped = (s: string, ...pts: number[]) => new AString(s, new Set(pts));
const provOf = (v: unknown): number[] =>
  v instanceof AValue ? [...v.provenance].sort((a, b) => a - b) : [];

describe("PROBE — DROP: does (length (map f xs)) compute f today?", () => {
  it("BASELINE: map dispatches eagerly, so f runs once per element — the work the flip must elide", async () => {
    await initBridge();
    const env = inferenceEnv.inherit("probe-drop-baseline");
    let calls = 0;
    env.defineRosetta("ftick", { fn: (x: unknown) => (calls++, x) });
    const [n] = await exec(`(length (map ftick (list 1 2 3 4 5)))`, { env });
    expect(Number(n)).toBe(5);
    expect(calls).toBe(5); // eager: f ran for every element even though length ignores the values
  });

  it.fails("TARGET (slice 1 — the Fantasy Land flip): length through a lazy map runs f ZERO times", async () => {
    await initBridge();
    const env = inferenceEnv.inherit("probe-drop-target");
    let calls = 0;
    env.defineRosetta("ftick", { fn: (x: unknown) => (calls++, x) });
    const [n] = await exec(`(length (map ftick (list 1 2 3 4 5)))`, { env });
    expect(Number(n)).toBe(5);
    expect(calls).toBe(0); // flips to passing when the flip defers the map and length reads the cheap count
  });
});

describe("PROBE — ATTRIBUTION: does a count's provenance depend on which elements it counted?", () => {
  // The thesis (demand cone = provenance cone) says a COUNT depends only on the
  // cardinality, so its cone is MINIMAL — independent of element identities. But
  // fl-interop `length` deliberately unions every element's provenance, per the
  // teleological-sealing decision ("provenance everything; exclusion must be
  // impossible"). These are OPPOSITE goals. This probe measures which one the
  // live interpreter exhibits; the conflict is V's call before the spike commits.
  async function countProv(ids: [number, number, number]): Promise<number[]> {
    await initBridge();
    const env = inferenceEnv.inherit(`probe-attr-${ids.join("-")}`);
    env.set("a", stamped("a", ids[0]));
    env.set("b", stamped("b", ids[1]));
    env.set("c", stamped("c", ids[2]));
    const [n] = await exec(`(length (list a b c))`, { env });
    expect(Number(n)).toBe(3);
    return provOf(n);
  }

  it("MEASURE: count provenance for two different element-id sets (reveals entanglement)", async () => {
    const p1 = await countProv([100, 101, 102]);
    const p2 = await countProv([200, 201, 202]);
    // Assertions are locked to the observed reality after the first run (see the
    // run log in the PR). If p1/p2 carry the element ids and differ between the
    // two sets, the count is entangled with element identity (over-attribution
    // vs. the minimal-cone thesis; aligned with teleological provenance-everything).
    // If both are empty, the count is already minimal and there is NO conflict.
    expect({ p1, p2 }).toMatchInlineSnapshot(`
      {
        "p1": [
          100,
          101,
          102,
        ],
        "p2": [
          200,
          201,
          202,
        ],
      }
    `);
  });
});
