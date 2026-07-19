// REPLAY-CACHE SAFETY — KNOWN GAP, NOT FIXED HERE. This file CHARACTERIZES today's actual
// `replaySessionHistory` (session-history.ts) behavior around tool-valued defines — it does not
// change session-history.ts, and it does not "fix" anything.
//
// `replaySessionHistory` has NO cache — for every history entry it either (a) SKIPS a tool-valued
// define entirely (leaving the name UNBOUND in the target env, `session-history.ts:182-185`) or
// (b) re-`exec`s a non-tool-valued one unconditionally. The hazard a future runner extraction must
// avoid: if step (a)'s skip-guard is ever removed in favor of a fresh-env-per-call model's "just
// re-exec everything, the cache will restore the wire-safe ones" WITHOUT also porting an actual
// cache-restore mechanism, a tool-valued define would be RE-EXECUTED on every replay — re-invoking
// the real upstream tool as a side effect of mere session reconstruction, not just re-costing CPU.
//
// Today's shipped code does NOT have that hazard. The existing skip-guard (`entry.toolValued`) is
// unconditional and always taken first — a tool-valued define is unconditionally skipped, NEVER
// re-`exec`'d, so the upstream tool is never re-invoked by replay as it stands. This test file
// confirms that with a call-counter spy (①) and pins the ACTUAL current cost of the gap, which is
// not "unsafe re-invocation" but "silent data loss": the tool-valued binding is not merely
// deferred, it is DROPPED — the fresh env can never read that name at all (②), a strictly worse
// reconstruction than a real cache-restore, which would recover the wire-safe VALUE without
// re-firing. (③ additionally probes an INDIRECT tool call — bound through a helper name — to rule
// out a back-door re-invocation path the textual `TOOL_SYMBOL` heuristic might miss; it does not
// find one, for the concrete reason explained there.)
//
// Porting a real cache-restore into the runner's replay is the fix that closes this gap; it is
// out of scope for this file, which only characterizes current behavior. session-history.ts is
// UNTOUCHED by this file.
//
// A related, already-closed blind spot: the `_`-shape heuristic alone can miss a SLUGLESS tool
// binding whose bare name has no underscore either (a real tool literally named `price`/`click`),
// which would let replay genuinely RE-INVOKE such a tool — an instance of exactly the hazard this
// file's ③ probe goes looking for (by a different route: an underscore-free name, not an indirect
// helper call). That hole is closed by a roster-based `knownToolPattern` check, threaded from
// manifold-tool.ts's real bound-tool list, that ORs with the shape heuristic (see
// session-history.ts's own `TOOL_SYMBOL` doc). It does NOT change this file's own finding: even
// with that hole closed, there is still no cache — a correctly tool-valued define is still
// SKIPPED-AND-DROPPED on replay, never restored. This file is about THAT residual gap, which the
// roster-based detection fix does not touch.

import { exec } from "@inhuman.tools/arrival";
import { replaySessionHistory } from "@inhuman.tools/mcp-substrate";
import { describe, expect, it } from "vitest";

import { buildManifoldEnv, type BoundServer, type ManifoldEnv } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

const runExpr = async (world: Pick<ManifoldEnv, "ambient" | "scope">, expr: string): Promise<unknown> => {
  const [value] = await exec(expr, { ambient: world.ambient, scope: world.scope });
  return value;
};

describe("replay-cache safety — ① the tool is NEVER re-invoked by replay (today's skip-and-drop guard holds)", () => {
  it("a tool-valued define, replayed into a fresh env, invokes the upstream tool ZERO additional times", async () => {
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
              return 10;
            },
          },
        ],
      },
    ];

    const env = await buildManifoldEnv(toolset);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: '(define priced (shop/price :item "widget"))' });
    expect(invocations).toBe(1); // the ONE real, original invocation

    const history = tool.sessionHistory();
    const fresh = await buildManifoldEnv(toolset); // a fresh env, SAME toolset (same spy)
    await replaySessionHistory(history, fresh.ambient, fresh.scope);

    // The empirical answer: the spy count is UNCHANGED — replay never called the tool again.
    expect(invocations).toBe(1);
  });
});

describe("replay-cache safety — ② the ACTUAL current cost of the gap: the value is DROPPED, not deferred", () => {
  it("after replay, the fresh env cannot read the tool-valued name AT ALL — not '0', not stale, not deferred: genuinely unbound", async () => {
    const toolset: BoundServer[] = [
      {
        slug: "shop",
        tools: [
          {
            name: "price",
            description: "price lookup",
            inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
            invoke: async () => 42,
          },
        ],
      },
    ];

    const env = await buildManifoldEnv(toolset);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: '(define priced (shop/price :item "widget"))' });
    // Confirm the ORIGINAL env really does hold the value (a sanity control — the gap is about
    // the RECONSTRUCTED env, not the original one, which is exactly why manifold's hot path
    // never needs replay at all — server.ts's one persistent env already has this).
    const originalVal = await runExpr(env, "priced");
    expect(String(originalVal)).toBe("42");

    const history = tool.sessionHistory();
    expect(history).toEqual([
      { name: "priced", source: '(define priced (shop/price :item "widget"))', toolValued: true },
    ]);

    const fresh = await buildManifoldEnv(toolset);
    const result = await replaySessionHistory(history, fresh.ambient, fresh.scope);
    // THE GAP, PLAINLY: `priced` is neither restored to 42 nor to any placeholder — it is
    // reported as skipped, and the fresh env genuinely has no binding for it whatsoever. A
    // consumer whose per-call authorization model REQUIRES a fresh env every call (arrival-mcp's
    // shape) loses this value on every single call, forever, under today's mechanism — that is
    // the concrete regression the cache-restore design exists to close.
    expect(result).toEqual({ applied: [], skipped: ["priced"], failed: [] });
    await expect(runExpr(fresh, "priced")).rejects.toThrow(/Unbound variable/);
  });
});

describe("replay-cache safety — ③ probe: an INDIRECT tool call (through a helper name) does not sneak past the guard either", () => {
  it("a helper lambda that closes over a tool call is ITSELF flagged tool-valued (contains the qualified name) and skipped; the statement that calls the helper then fails replay (helper unbound), never silently re-invoking anything", async () => {
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
              return 7;
            },
          },
        ],
      },
    ];

    const env = await buildManifoldEnv(toolset);
    const tool = createManifoldTool(env, "CATALOG");
    // `fetch-it` is a THUNK closing over the tool call — defining it does NOT invoke the tool
    // (a lambda body isn't evaluated at define time); calling it later does.
    await tool.call({ expr: '(define fetch-it (lambda () (shop/price :item "widget")))' });
    await tool.call({ expr: "(fetch-it)" }); // the ONE real invocation, via the helper
    expect(invocations).toBe(1);

    const history = tool.sessionHistory();
    // BOTH entries are flagged toolValued: `fetch-it`'s own source textually contains the
    // qualified `shop/price` call (the regex is a SOURCE-TEXT scan, not a data-flow analysis) —
    // it is skipped, never re-defined. `(fetch-it)` itself is NOT a `(define ...)` at all, so it
    // was never pushed to session history in the first place (only successful top-level DEFINEs
    // are recorded) — there is nothing here to even attempt replaying it.
    expect(history.map((e) => e.name)).toEqual(["fetch-it"]);
    expect(history[0]!.toolValued).toBe(true);

    const fresh = await buildManifoldEnv(toolset);
    const result = await replaySessionHistory(history, fresh.ambient, fresh.scope);
    expect(result).toEqual({ applied: [], skipped: ["fetch-it"], failed: [] });
    // The tool was NOT re-invoked by replay (the helper's OWN body never ran — replay skipped its
    // define outright), and calling the (now-unbound) helper in the reconstructed env fails
    // cleanly rather than silently doing anything.
    expect(invocations).toBe(1);
    await expect(runExpr(fresh, "(fetch-it)")).rejects.toThrow(/Unbound variable/);
  });
});
