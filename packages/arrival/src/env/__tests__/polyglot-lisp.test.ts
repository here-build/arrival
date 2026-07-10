// polyglot-lisp pack — assemble onto a real env, then RUN the Common Lisp
// idiom family. Split out of polyglot.test.ts (V, 2026-07-10 dialect split —
// see polyglot.ts's header for the full rationale).
import { execState, type ExecOptions } from "../../index.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../inference-env.js";
import { assembleEnv } from "../../common/kernel.js";
import { type SchemeEnv } from "../../common/scheme-env.js";
import { describe, expect, it } from "vitest";

import polyglotLisp from "../polyglot-lisp.js";

async function exec(code: string, options?: ExecOptions) {
  return (await execState(code, options)).values.slice();
}

describe("@here.build/arrival/polyglot-lisp", () => {
  it("mapcar / remove-if / remove-if-not run correctly assembled STANDALONE (no core dep needed)", async () => {
    const env = sandboxedEnv.inherit("polyglot-lisp-test");
    const evalScheme = (e: SchemeEnv, src: string) => exec(src, { env: e as never });
    // Unlike its Clojure/Racket siblings, polyglot-lisp needs no dep on
    // scheme/polyglot (core) — nothing here reaches @/@?/@keys/dict/compose.
    await assembleEnv(env as unknown as SchemeEnv, [polyglotLisp.lower({ evalScheme })]);

    const str = async (src: string) => String((await exec(src, { env }))[0]);
    expect(await str("(mapcar (lambda (x) (* x x)) (list 1 2 3))")).toBe("(1 4 9)");
    expect(await str("(remove-if (lambda (x) (> x 2)) (list 1 2 3 4))")).toBe("(1 2)");
    expect(await str("(remove-if-not (lambda (x) (> x 2)) (list 1 2 3 4))")).toBe("(3 4)");
  });

  it("exports a well-formed SchemePackSpec", () => {
    expect(polyglotLisp.name).toBe("scheme/polyglot-lisp");
    expect(polyglotLisp.spec.prelude).toBeUndefined();
    const symbols = polyglotLisp.spec.symbols as Record<string, { kind?: string }>;
    expect(symbols["mapcar"]?.kind).toBe("define");
    expect(symbols["remove-if"]?.kind).toBe("define");
    expect(symbols["remove-if-not"]?.kind).toBe("define");
  });

  it("deps are exactly [srfi-1, equality, lists] — no core dep", () => {
    const names = (polyglotLisp.spec.deps ?? []).map((d) => d.name).sort();
    expect(names).toEqual(["scheme/equality", "scheme/lists", "scheme/srfi-1"]);
  });
});

// Cross-dialect stdlib completion, default assembled env — polyglot-lisp ships
// in BASE_PACKS in production, the same surface a model actually reaches.
describe("@here.build/arrival/polyglot-lisp — stdlib completion (Bucket A)", () => {
  const str = async (src: string) => String((await exec(src))[0]);

  it("mapcar (Common Lisp) — same arg order as R7RS map", async () => {
    expect(await str("(mapcar (lambda (x) (* x x)) (list 1 2 3))")).toBe("(1 4 9)");
  });

  it("remove-if / remove-if-not (Common Lisp) — filter with the predicate sense flipped/kept", async () => {
    expect(await str("(remove-if (lambda (x) (> x 2)) (list 1 2 3 4))")).toBe("(1 2)");
    expect(await str("(remove-if-not (lambda (x) (> x 2)) (list 1 2 3 4))")).toBe("(3 4)");
  });
});
