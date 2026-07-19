/**
 * The `(sql/query …)` MEMBRANE — real scheme forms crossing `arrivalSqlCapability`
 * into a stub resolver. This is the coverage the old `defineDataEffectRosettas`
 * membrane suite used to attempt over a bare frame (deleted as broken when the
 * registration path changed); the capability era's idiom runs the real assembly:
 * `exec` with the capability rooted and a per-call config, exactly as production
 * arms it.
 */
import { exec, schemeToJs, type SchemeValue } from "@inhuman.tools/arrival";
import { describe, expect, it } from "vitest";

import { arrivalSqlCapability } from "../sql-capability.js";
import type { SqlEffect, SqlEffectResolver } from "../sql-effect.js";

/** Run scheme against a per-call assembly of the sql verb; return the last (awaited) value,
 *  schemeToJs-peeled (the run surface's own final peel). */
async function runScm(scm: string, resolve?: SqlEffectResolver): Promise<unknown> {
  const r = await exec(scm, { capabilities: [arrivalSqlCapability], config: resolve ? { sql: resolve } : {} });
  const last = r.at(-1);
  const awaited = last && typeof (last as { then?: unknown }).then === "function" ? await last : last;
  return schemeToJs(awaited as SchemeValue, {});
}

/** A stub resolver that records every descriptor it receives, then replies. */
function recordingResolver(reply: unknown): { resolve: SqlEffectResolver; seen: SqlEffect[] } {
  const seen: SqlEffect[] = [];
  const resolve: SqlEffectResolver = async (_ctx, effect) => {
    seen.push(effect);
    return reply;
  };
  return { resolve, seen };
}

describe("(sql/query …) — the read verb", () => {
  it("canonicalises label/query/params into the descriptor and hands the resolver's reply back to scheme", async () => {
    const rows = [{ id: 1, name: "ada" }];
    const { resolve, seen } = recordingResolver(rows);
    const v = await runScm(`(sql/query "analytics" "select * from users where id = $1" (list 42))`, resolve);
    expect(v).toEqual(rows);
    expect(seen).toEqual([{ kind: "sql", label: "analytics", query: "select * from users where id = $1", params: [42] }]);
  });

  it("params stay SEPARATE from the query text — injection-safe by construction", async () => {
    const { resolve, seen } = recordingResolver([]);
    await runScm(`(sql/query "db" "select * from t where name = $1" (list "'; drop table t; --"))`, resolve);
    expect(seen[0].query).toBe("select * from t where name = $1");
    expect(seen[0].params).toEqual(["'; drop table t; --"]);
  });

  it("omitted params ⇒ empty bind list", async () => {
    const { resolve, seen } = recordingResolver([]);
    await runScm(`(sql/query "db" "select 1")`, resolve);
    expect(seen).toEqual([{ kind: "sql", label: "db", query: "select 1", params: [] }]);
  });

  it("the empty scheme list (list) ⇒ empty bind list — no spurious Nil sentinel", async () => {
    const { resolve, seen } = recordingResolver([]);
    await runScm(`(sql/query "db" "select 1" (list))`, resolve);
    expect(seen).toEqual([{ kind: "sql", label: "db", query: "select 1", params: [] }]);
  });

  it("a bare scalar param is sugar for a one-element list", async () => {
    const { resolve, seen } = recordingResolver([]);
    await runScm(`(sql/query "db" "select * from t where id = $1" 42)`, resolve);
    expect(seen[0].params).toEqual([42]);
  });

  it("a composite param element is a verb-layer teaching error, never a lying cast", async () => {
    const { resolve } = recordingResolver([]);
    await expect(runScm(`(sql/query "db" "select $1" (list (dict :a 1)))`, resolve)).rejects.toThrowError(
      /param \$1 must be a scalar/,
    );
  });
});

describe("inert by default", () => {
  it("an unarmed environment throws the teaching error at call time (never a silent no-op)", async () => {
    await expect(runScm(`(sql/query "db" "select 1")`)).rejects.toThrowError(
      /sql effects are not enabled in this environment/,
    );
  });
});
