// polyglot pack (SHARED CORE) — assemble onto a real env, then RUN the member-
// access protocol and composition family. DIALECT SPLIT (V, 2026-07-10): the
// threading macros (->/->>/~>/~>>) and the cross-dialect stdlib completion moved
// out to polyglot-clojure.test.ts / polyglot-lisp.test.ts / polyglot-racket.test.ts
// — see polyglot.ts's header for the full split rationale. This file keeps only
// what stays in the shared core: @/@?/@keys/dict, nil, compose/pipe/flow,
// %interleave.
import { execState, type ExecOptions } from "../../index.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../inference-env.js";
import { assembleEnv } from "../../common/kernel.js";
import { type SchemeEnv } from "../../common/scheme-env.js";
import { describe, expect, it } from "vitest";

import polyglot from "../polyglot.js";

// This whole file stringifies the BOXED result's Scheme print form (list "(1 4 9)")
// and checks box discipline directly (`.constructor.name === "AVector"`) — a
// boxed-state concern (RULINGS.md R1), not the SIMPLE tier's plain-JS exit. Local
// `exec` shadows the barrel export with the COMPLEX tier (execState) so every call
// site below is unchanged and still reads the boxed SchemeValue[] it always did.
async function exec(code: string, options?: ExecOptions) {
  return (await execState(code, options)).values.slice();
}

describe("@here.build/arrival/polyglot (shared core)", () => {
  // INVARIANT: the polyglot capability installs @/@?/@keys/dict and compose/pipe/flow, and
  // they thread correctly (the -> / ~> threading-macro half of this invariant moved to the
  // per-dialect test files in the 2026-07-10 dialect split — no longer exercised here)
  it("installs @/@?/@keys/dict and compose/pipe run correctly standalone", async () => {
    const env = sandboxedEnv.inherit("polyglot-core-test");
    const evalScheme = (e: SchemeEnv, src: string) => exec(src, { env: e as never });
    await assembleEnv(env as unknown as SchemeEnv, [polyglot.lower({ evalScheme })]);

    const num = async (src: string) => Number((await exec(src, { env }))[0]);
    // compose is right-to-left: (*2 (+1 5)) = 12
    expect(await num("((compose (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)")).toBe(12);
    // pipe is left-to-right: (*2 (+1 5)) = 12
    expect(await num("((pipe (lambda (x) (+ x 1)) (lambda (x) (* x 2))) 5)")).toBe(12);
    // flow is pipe's alias
    expect(await num("((flow (lambda (x) (+ x 1)) (lambda (x) (* x 2))) 5)")).toBe(12);

    const str = async (src: string) => String((await exec(src, { env }))[0]);
    expect(await str('(@ (dict :a 1) :a)')).toBe("1");
    // @keys mints a raw JS string array (not a scheme list — see polyglot.ts's
    // header note on why %dict-set/dict-keys lift it via vector->list) — plain
    // String() on that array joins with commas, not scheme list syntax.
    expect(await str('(@keys (dict :a 1))')).toBe("a");
  });

  // INVARIANT (partial — retired the "-> macro in prelude" half of the original claim: the
  // W4/H3 migration dropped the text-blob prelude entirely for individually-declared
  // symbol.define/symbol.native entries): polyglot exports a well-formed SchemePackSpec
  // named "scheme/polyglot" (pins implementation, not behavior)
  it("exports a well-formed SchemePackSpec — the shrunk core, post-split", () => {
    expect(polyglot.name).toBe("scheme/polyglot");
    expect(polyglot.spec.prelude).toBeUndefined();
    // W4/H3 migration baseline: no text-blob prelude, individually-declared
    // symbol.define/symbol.native entries only.
    const symbols = polyglot.spec.symbols as Record<string, { kind?: string; callable?: boolean }>;
    expect(symbols["compose"]?.kind).toBe("define");
    expect(symbols["compose"]?.callable).toBe(true);
    expect(symbols["flow"]?.callable).toBe(false);
    expect(symbols["nil"]?.callable).toBe(false);
    // Post-split: the threading macros are NOT here anymore — they moved to
    // polyglot-clojure.ts (->/->>) and polyglot-racket.ts (~>/~>>).
    expect(symbols["->"]).toBeUndefined();
    expect(symbols["~>"]).toBeUndefined();
    // Post-split: comp (Clojure's alias) moved to polyglot-clojure.ts too.
    expect(symbols["comp"]).toBeUndefined();
  });

  it("deps shrink to [equality, lists] — the whole cross-capability reach of the shrunk core", () => {
    const names = (polyglot.spec.deps ?? []).map((d) => d.name);
    expect(names.sort()).toEqual(["scheme/equality", "scheme/lists"]);
  });
});

describe("@here.build/arrival/polyglot — nil (LIPS dialect alias, shared)", () => {
  it("nil is the empty list", async () => {
    // `(if …)` normalizes over the boxed-ABool representation (same convention
    // the sibling dialect test files use for boolean-verdict assertions).
    const [truthy] = await exec('(if (null? nil) "yes" "no")');
    expect(String(truthy)).toBe("yes");
  });
});
