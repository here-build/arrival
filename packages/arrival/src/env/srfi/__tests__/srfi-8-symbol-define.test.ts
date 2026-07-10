// srfi-8-symbol-define.test.ts — W4-H2b pack migration rows for `scheme/srfi-8`
// (docs/working-proposals/symbol-define-static-program-validation.md §1/§2/§3.4/§4).
//
// `receive` is the design doc's OWN worked BINDER example (§3.4's table cites it by
// name: "`(receive (q r) (floor/ 7 2) (list q r))` has `q`/`r` in FORMALS position
// … a boolean-transparent walk treats every argument as expression space — so `q`
// and `r` report UNBOUND on a perfectly legal program"). `and-let*` (srfi-2, H1)
// landed the SAME classification first in commit order — this pack is the doc's own
// citation either way, and this suite pins the SAME three facts H1's binder/opaque
// siblings did, scoped to `receive`:
//
//   1. receive behavior equivalence — semantic behavior identical to the
//      pre-migration `define-macro` prelude (§4.2's "semantic equivalence, not
//      byte-identity" gate): multi-value binding, dotted-rest formals, nesting.
//   2. a contract-freeness row — `symbol.defineSyntax` is contract-FREE by design
//      (§1.1 — a macro has no call-boundary contract), so the row pins that
//      `receive` never grew an `in`/`out` vector migration would have wrongly
//      bolted on if the pack were decomposed with the WRONG factory
//      (`symbol.define` instead of `symbol.defineSyntax`).
//   3. the §2.1 bake FV law is CATEGORICALLY out of scope for this pack — a
//      `symbol.defineSyntax` body is never FV-walked (`define-bake.ts`'s own
//      comment: "a symbol.defineSyntax body's free variables would name the
//      EXPANSION env … out of scope for this wave") — so lowering `scheme/srfi-8`
//      standalone, with ZERO declared deps, never throws
//      `DefineLocalityError`/`DefineForwardReferenceError`/`ProvenanceRoleShapeError`
//      regardless of `formals`/`expr`/`body`'s names. This is the regression pin
//      that fact stays true (mirrors srfi-26's row 3 for `cut`/`cute`).
//   4. the §3 static validator does not false-positive on `receive`'s bound
//      formals — the declared `macroAttribute: "binder"` firewalls `q`/`r` from
//      ever being walked as free-variable references (companion to the shared
//      `static-validation.law.test.ts` LAW 4 row, which pins the same fact for
//      `(receive (q r) (values 1 2) (list q r))` against the DEFAULT assembled
//      base — this row additionally covers the dotted-rest-formals shape).
import { describe, expect, it } from "vitest";
import type { AEntity } from "../../../common/symbol.js";
import { exec } from "../../../eval/generator-exec.js";
import { global_env } from "../../../env-roots.js";
import { initBridge } from "../../../index.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { DefineForwardReferenceError, DefineLocalityError, ProvenanceRoleShapeError } from "../../../errors.js";
import srfi8 from "../srfi-8.js";
import type { ResolvingEnvironment } from "../../../Environment.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as ResolvingEnvironment, skipBootstrapWait: true });

describe("scheme/srfi-8 — receive behavior equivalence (semantic-equivalence gate, §4.2)", () => {
  it("binds a two-value producer to a fixed formals list", async () => {
    const [result] = await exec("(receive (q r) (values 3 1) (list q r))");
    expect(result).toEqual([3, 1]);
  });

  it("binds via a dotted-rest formals list — a single required + the remaining values", async () => {
    const [result] = await exec("(receive (a . rest) (values 1 2 3) (list a rest))");
    expect(result).toEqual([1, [2, 3]]);
  });

  it("binds via a fully-rest formals symbol (no fixed leading names)", async () => {
    const [result] = await exec("(receive all (values 1 2 3) all)");
    expect(result).toEqual([1, 2, 3]);
  });

  it("body is a sequence — every form runs, the last is returned", async () => {
    const [result] = await exec("(receive (q r) (values 3 1) (+ q 0) (* q r))");
    expect(result).toBe(3);
  });

  it("composes with a single-value producer (call-with-values' degenerate case)", async () => {
    const [result] = await exec("(receive (x) (+ 1 2) (* x 10))");
    expect(result).toBe(30);
  });

  it("nests — an inner receive's formals shadow the outer's, cleanly", async () => {
    const [result] = await exec("(receive (q r) (values 1 2) (receive (q r) (values 3 4) (list q r)))");
    expect(result).toEqual([3, 4]);
  });
});

describe("scheme/srfi-8 — contract-freeness (the WRONG-factory regression pin, §1.1)", () => {
  it("`receive`'s declared entry is a define-syntax kind, never in/out vectors", () => {
    const symbols = srfi8.spec.symbols as Record<string, AEntity & { macroAttribute?: string }>;
    const entry = symbols.receive;
    expect(entry, "srfi-8 pack: no symbol named receive").toBeDefined();
    expect(entry.kind).toBe("define-syntax");
    expect(entry).not.toHaveProperty("in");
    expect(entry).not.toHaveProperty("out");
    expect(entry.macroAttribute).toBe("binder");
  });
});

describe("scheme/srfi-8 — the §2.1 bake FV law is out of scope for defineSyntax (regression pin)", () => {
  it("lowers standalone, zero declared deps, never throws a bake FV/role door", async () => {
    await initBridge();
    const env = global_env.inherit("srfi-8-standalone");
    await expect(srfi8.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("never throws DefineLocalityError/DefineForwardReferenceError/ProvenanceRoleShapeError", async () => {
    await initBridge();
    const env = global_env.inherit("srfi-8-fv-pin");
    try {
      await srfi8.lower({ evalScheme }).apply(env, undefined as never);
    } catch (e) {
      expect(e).not.toBeInstanceOf(DefineLocalityError);
      expect(e).not.toBeInstanceOf(DefineForwardReferenceError);
      expect(e).not.toBeInstanceOf(ProvenanceRoleShapeError);
      throw e;
    }
  });
});

describe("scheme/srfi-8 — the §3 static validator does not false-positive on receive's formals", () => {
  it("a fixed formals list validates clean and runs", async () => {
    const [result] = await exec("(receive (q r) (values 1 2) (list q r))", { staticValidation: "on" });
    expect(result).toEqual([1, 2]);
  });

  it("a dotted-rest formals list validates clean and runs (the binder firewall covers the rest-name too)", async () => {
    const [result] = await exec("(receive (a . rest) (values 1 2 3) (list a rest))", { staticValidation: "on" });
    expect(result).toEqual([1, [2, 3]]);
  });

  it("a fully-rest formals symbol validates clean and runs", async () => {
    const [result] = await exec("(receive all (values 1 2 3) all)", { staticValidation: "on" });
    expect(result).toEqual([1, 2, 3]);
  });

  it("a genuinely unbound name INSIDE the body still reports (the firewall covers formals, not the body)", async () => {
    const env = await freshEnv();
    await expect(
      exec("(receive (q r) (values 1 2) (totally-unbound-name q r))", { env, staticValidation: "on" }),
    ).rejects.toThrow(/unbound/i);
  });
});
