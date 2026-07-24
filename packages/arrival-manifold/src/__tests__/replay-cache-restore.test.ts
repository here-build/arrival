// REPLAY-CACHE RESTORE — ★ RED BY DESIGN (TDD). These tests pin the TARGET cache-and-restore
// behavior of `replaySessionHistory` (session-history.ts); the mechanism does not exist yet, so
// every test here FAILS against today's code — that is the point. A later task makes them green by
// porting arrival-mcp's cache-restore into the replay path. This file changes NO production code.
//
// This is the exact MIRROR of the committed characterization file `replay-cache-safety.test.ts`
// (commit 64be3d240c), which pins what replay does TODAY (green): a tool-valued define is
// SKIPPED-AND-DROPPED — the name is pushed to `skipped` and left genuinely unbound. This file pins
// what it SHOULD do (red): a tool-valued define whose result is wire-safe is RESTORED from a cached
// value, so the name survives replay WITHOUT re-firing the tool.
//
// ── THE EXACT DROP MECHANISM (empirically confirmed, session start) ──────────────────────────────
// `replaySessionHistory` (session-history.ts:225-229):
//     for (const entry of entries) {
//       if (entry.toolValued) {
//         skipped.push(entry.name);   // :227
//         continue;                    // :228  ← THE DROP: no exec, no env binding, nothing restored
//       }
//       ...
//     }
// The `continue` at :228 means a tool-valued entry NEVER binds its name in the target env. The root
// is upstream of the guard: `SessionHistoryEntry` (session-history.ts:104-112) carries only
// `{ name, source, toolValued }` — there is NO cached-value field — and `push(name, source)`
// (session-history.ts:119, 135-139), fed from manifold-tool.ts:659
// (`sessionHistory.push(facts.definedName, statement)`), never captures the tool's RESULT. So even if the
// skip-guard were removed, there is nothing to restore FROM but the source, whose re-`exec` would
// re-invoke the tool — the side-effect-repeat bug the guard exists to prevent. A correct fix caches
// the wire-safe result at push time and restores THAT, not the source.
//
// Direct binding-level proof (a throwaway probe, deleted): after replay, the original env's
// `allBoundNames()` DOES contain `priced` (value 42) while the fresh env's does NOT — the binding is
// genuinely absent, not deferred and not a void/placeholder. Reading it throws `Unbound variable
// `priced'`.
//
// ── THE TARGET ────────────────────────────────────────────────────────────────────────────────────
// After a tool-valued define, replay into a fresh env must restore the name to its cached value with
// the upstream `invoke` spy still at exactly 1 call (never re-fired) — the assertion Test A
// implements. The reference implementation is arrival-mcp's DiscoveryTool.ts: cache the wire-safe
// result at push time (`jsonRoundTrippable(js) ? cache[src] = JSON.stringify(js) : …`), restore via
// a PURE value reconstruction (`env.set(name, jsToScheme(CONSTANT_CTX, JSON.parse(cache[src])))`)
// that consults no tool, so it restores tool-independently. `jsonRoundTrippable` gates what caches:
// scalars + plain arrays/objects thereof cache; closures/opaque handles/bigint do NOT and stay
// skipped (green today; see Test-D prose and replay-cache-safety.test.ts). This file only asserts
// the WIRE-SAFE case, whose target is unambiguous.
//
// ── ALTITUDE ─────────────────────────────────────────────────────────────────────────────────────
// Every test drives the PUBLIC path only — `tool.call()` → `tool.sessionHistory()` →
// `replaySessionHistory(history, fresh.capabilities, fresh.config, fresh.runCtx, fresh.scope)` — never hand-constructing entries. So they are agnostic
// to WHERE the fix parks the cache (an enriched `SessionHistoryEntry` field, or a side map threaded
// through the resumability surface): they pin the observable end-to-end contract manifold-tool.ts:186
// already promises ("feed [sessionHistory()] + a fresh env to replaySessionHistory to reconstruct"),
// not an internal representation. If the fix changes `replaySessionHistory`'s arity (e.g. a companion
// cache argument, per the doc's runner `exportSession()` at :620-624), the fix author reconciles the
// call sites here; the ASSERTIONS are the target and stand as-is.

import { exec, type LexicalScope } from "@inhuman.tools/arrival";
import { replaySessionHistory } from "@inhuman.tools/mcp-substrate";
import { describe, expect, it } from "vitest";

import { buildManifoldEnv, type BoundServer, type ManifoldEnv } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

// TODO(arrival exec-flip follow-up): the `String(await runExpr(...))` assertions in this file
// pass for small ints by coincidence (String(1) ≡ the old boxed print form) and would diverge
// for rationals, floats, and out-of-safe-range bigints. Assert the plain-JS value directly
// when next touched.

const runExpr = async (world: Pick<ManifoldEnv, "capabilities" | "config" | "runCtx" | "scope">, expr: string): Promise<unknown> => {
  const [value] = await exec(expr, {
    capabilities: world.capabilities,
    config: world.config,
    runCtx: world.runCtx,
    scope: world.scope,
  });
  return value;
};

/** A one-tool `shop/price` upstream whose `invoke` is a call-COUNTER spy returning a fixed wire-safe
 *  value. The spy is the load-bearing safety instrument (design doc §3 line 816c): it must stay at 1
 *  across a replay — a restore reads the cache, it does NOT re-fire the tool. `calls()` reads it. */
function pricingToolset(result: unknown = 42): { toolset: BoundServer[]; calls: () => number } {
  let invocations = 0;
  const toolset: BoundServer[] = [
    {
      slug: "shop",
      tools: [
        {
          name: "price",
          description: "price lookup",
          inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
          invoke: async () => {
            invocations += 1;
            return result;
          },
        },
      ],
    },
  ];
  return { toolset, calls: () => invocations };
}

// Session-level bindings (defines) live on the SCOPE now, never the ambient (the capability
// base is sealed and holds only stdlib/tools) — checking `scope.env.allBoundNames()` is the
// direct successor of the pre-cut "one merged env" read this helper originally did.
const boundNames = (scope: LexicalScope): (string | symbol)[] => scope.env.allBoundNames();

describe("replay-cache RESTORE (RED) — a wire-safe tool-valued define survives replay via its cached value", () => {
  it("Test A [design doc §3:816(a)] — restores the name to the cached value, upstream `invoke` spy STILL at exactly 1 (never re-fired)", async () => {
    // SHOULD: `(define priced (shop/price …))` fired once originally; its wire-safe result (42) was
    // cached at push time (DiscoveryTool.ts:254-255 reference). Replay must re-bind `priced` = 42
    // from that cache WITHOUT re-`exec`ing the source (so the tool never re-fires).
    // CURRENTLY: session-history.ts:226-228 takes the `toolValued` skip-guard and `continue`s —
    // `priced` is dropped, never bound. Reading it below throws `Unbound variable `priced'` (the RED).
    const { toolset, calls } = pricingToolset(42);
    const env = await buildManifoldEnv(toolset);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: '(define priced (shop/price :item "widget"))' });
    expect(calls()).toBe(1); // the ONE original, real invocation

    const history = tool.sessionHistory();
    const fresh = await buildManifoldEnv(toolset); // fresh env, SAME toolset (same spy)
    await replaySessionHistory(history, fresh.capabilities, fresh.config, fresh.runCtx, fresh.scope);

    // Safety guard first (passes today too — pins that no "fix" is allowed to re-fire the tool):
    expect(calls()).toBe(1);
    // The gap: the binding must be present AND equal to the cached value. Today this read throws
    // `Unbound variable `priced'` (session-history.ts:228 dropped it) — the RED, for the right reason.
    expect(boundNames(fresh.scope)).toContain("priced");
    expect(String(await runExpr(fresh, "priced"))).toBe("42");
  });

  it("Test B [reporting, fork-agnostic] — the restored name is NOT reported as a dropped `skipped` entry", async () => {
    // SHOULD: once `priced` is restored, it is no longer a silent unbound drop. The design doc's
    // pseudocode folds a cache-restored name into `applied` (line 590: `applied.push(entry.name)`);
    // a fix that instead adds a distinct `restored` category is equally valid. This assertion pins
    // only the invariant common to BOTH options — the name must leave `skipped`.
    // CURRENTLY: session-history.ts:227 pushes `priced` to `skipped` unconditionally, so
    // `result.skipped === ["priced"]` — this assertion fails (the RED).
    const { toolset } = pricingToolset(42);
    const env = await buildManifoldEnv(toolset);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: '(define priced (shop/price :item "widget"))' });

    const fresh = await buildManifoldEnv(toolset);
    const result = await replaySessionHistory(tool.sessionHistory(), fresh.capabilities, fresh.config, fresh.runCtx, fresh.scope);
    expect(result.skipped).not.toContain("priced");
  });

  it("Test C [blast radius] — a PLAIN dependent define that reads the tool-valued name reconstructs (not just the one name)", async () => {
    // SHOULD: `(define doubled (* priced 2))` is a pure, non-tool-valued define. Once `priced` is
    // restored to 42, replaying `doubled` yields 84 and it lands in `applied`. This proves the drop
    // is not cosmetic (one missing name) but breaks the whole DEPENDENT reconstruction the module
    // exists for (session-history.ts:9-14 resumability).
    // CURRENTLY: `priced` is dropped at session-history.ts:228; then `doubled`'s replay
    // (session-history.ts:231 `exec`) hits `Unbound variable `priced'`, is caught (:233), and
    // `doubled` lands in `failed`, itself unbound. Reading `doubled` below throws — the RED cascade.
    const { toolset, calls } = pricingToolset(42);
    const env = await buildManifoldEnv(toolset);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: '(define priced (shop/price :item "widget"))' });
    await tool.call({ expr: "(define doubled (* priced 2))" });
    expect(calls()).toBe(1);
    expect(tool.sessionHistory().map((e) => e.name)).toEqual(["priced", "doubled"]);

    const fresh = await buildManifoldEnv(toolset);
    await replaySessionHistory(tool.sessionHistory(), fresh.capabilities, fresh.config, fresh.runCtx, fresh.scope);

    expect(calls()).toBe(1); // still never re-fired
    expect(String(await runExpr(fresh, "doubled"))).toBe("84");
  });
});

// ── DESIGN CANDIDATE — cache-invalidation when the tool is ABSENT from the resumed env ─────────────
// A genuine fork the fix author must decide (the task flagged it explicitly). Today BOTH options drop
// the binding, so only ONE side is expressible as a red test:
//   • OPTION C1 (value-independence) — a restored wire-safe value is a PURE value, not a live tool
//     handle, so it restores regardless of whether the resumed env still binds the tool. This is the
//     arrival-mcp reference behavior: DiscoveryTool.ts:228-230 restores via
//     `jsToScheme(JSON.parse(cache[src]))`, consulting no tool/roster. ← Test D pins THIS (red today).
//   • OPTION C2 (invalidate-when-tool-gone) — if the resumed env no longer binds the tool, treat the
//     cached binding as stale and drop it. For THIS sub-case C2 coincides with today's drop, so it
//     cannot be written as a red test (it would be green now); it is documented here, not tested.
// If the fix author chooses C2, invert or delete Test D. It is labeled, not silently assumed.
describe("replay-cache RESTORE (RED, design candidate C1) — a cached wire-safe value restores even into a toolset that no longer has the tool", () => {
  it("Test D [candidate C1] — replaying into a fresh env built WITHOUT the pricing tool still restores `priced` to its cached value", async () => {
    // SHOULD (under C1): the value 42 was cached from the original call; restoring it needs only
    // `jsToScheme(JSON.parse(...))` (DiscoveryTool.ts:229), no tool — so a fresh env from an empty
    // toolset still gets `priced` = 42.
    // CURRENTLY: the entry's `toolValued` flag (computed true at push time against the original
    // roster) makes replay take session-history.ts:226-228's skip-guard regardless of the new env's
    // toolset — `priced` is dropped and reading it throws `Unbound variable `priced'` (the RED).
    const { toolset } = pricingToolset(42);
    const env = await buildManifoldEnv(toolset);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: '(define priced (shop/price :item "widget"))' });

    const history = tool.sessionHistory();
    const freshWithoutTool = await buildManifoldEnv([]); // resumed env: the pricing tool is gone
    await replaySessionHistory(history, freshWithoutTool.capabilities, freshWithoutTool.config, freshWithoutTool.runCtx, freshWithoutTool.scope);

    expect(boundNames(freshWithoutTool.scope)).toContain("priced");
    expect(String(await runExpr(freshWithoutTool, "priced"))).toBe("42");
  });
});
