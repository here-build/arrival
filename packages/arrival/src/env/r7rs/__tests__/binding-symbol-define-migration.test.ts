// binding-symbol-define-migration.test.ts — W4-H1 pack-migration law rows for
// `scheme/r7rs/binding` (docs/working-proposals/symbol-define-static-program-
// validation.md §4.2). This pack's ENTIRE former `prelude` was two `define-macro`
// forms (`let-values` / `let*-values`) and nothing else — zero `symbol.define`
// value/procedure defines to migrate, so this file's rows are narrower than the
// general per-pack template the wave names: no "contract enforcement on a
// migrated define" row (N/A, asserted below as a structural negative), no Pass-2
// contract-authoring rows. What DOES apply, one row each:
//
//   ROW 1 — structural: the pack declares no `prelude` field; both macros are
//     `kind: "define-syntax"`, contract-free, `macroAttribute: "binder"` (§3.4's
//     ternary — `let-values`/`let*-values` are the worked binder example, rev 2).
//   ROW 2 — bake / FV law: `.lower()` succeeds — the two-phase order (Pass 1 binds
//     `call-with-values` before Pass 2 evaluates the macro bodies) holds, and
//     `symbol.defineSyntax` bodies carry no §2.1 FV check to trip (define-bake.ts
//     skips it for `kind !== "define"` — asserted here as a live fact, not quoted).
//   ROW 3 — semantic equivalence: `let-values`/`let*-values` behave byte-for-byte
//     as the pre-migration prelude did — nested claws, `let*-values`' sequential
//     visibility, the zero-binding edge case, and mutual recursion between the two
//     macros' expansions (the exact catch this file's own migration-note comment
//     in binding.ts explains: the recursive self-reference resolves at macro-
//     EXPANSION time, not this def's bake time).
//   ROW 4 — the validator's macro-firewall row still holds: the SAME programs
//     validate clean under `staticValidation: "on"` (no false "unbound" on the
//     `vars`/`bindings`/`body` formals) — cross-checking, not duplicating, the
//     shared `laws/static-validation.law.test.ts`'s own LAW 4 `let-values` row,
//     which this migration must not regress.
import { describe, expect, it } from "vitest";
import bindingPack from "../binding.js";
import { exec, execState } from "../../../eval/generator-exec.js";
import { StaticValidationError } from "../../../static-validation/validate-program.js";
import { Macro } from "../../../eval/Macro.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import type { AEntity, DefineSyntaxSymbolDef } from "../../../common/symbol.js";

const symbols = bindingPack.spec.symbols as Record<string, AEntity>;

function defineSyntaxDef(name: string): DefineSyntaxSymbolDef {
  const def = symbols[name];
  if (def === undefined) throw new Error(`binding pack: no symbol named ${name}`);
  if (def.kind !== "define-syntax") throw new Error(`binding pack: ${name} is not a define-syntax def (got ${def.kind})`);
  return def;
}

// COMPLEX tier (execState) — mirrors srfi.test.ts's own `run` helper, the
// established convention for stringified boxed-result assertions in this suite.
async function run(src: string): Promise<string> {
  const { values: r } = await execState(src, {});
  const x = r[r.length - 1] as { toString(): string } | undefined;
  return String(x?.toString?.() ?? x);
}

describe("ROW 1 — structural: prelude is gone, both macros bake as contract-free define-syntax/binder", () => {
  it("the capability declares no prelude field", () => {
    expect(bindingPack.spec.prelude).toBeUndefined();
  });

  it("let-values / let*-values are kind: define-syntax, macroAttribute: binder", () => {
    for (const name of ["let-values", "let*-values"]) {
      const def = defineSyntaxDef(name);
      expect(def.kind).toBe("define-syntax");
      expect(def.macroAttribute).toBe("binder");
    }
  });

  it("contract enforcement — N/A, asserted structurally: a define-syntax def carries no contract surface", () => {
    // §1.1: defineSyntax is contract-FREE by construction. There is no `symbol.define`
    // in this pack to run the "contract enforcement fires" row against — this asserts
    // the N/A rather than leaving it silently unchecked: neither macro def exposes
    // `in`/`out`/`callable`/`validate` (the DefineSymbolDef-only fields).
    for (const name of ["let-values", "let*-values"]) {
      const def = defineSyntaxDef(name);
      expect("in" in def).toBe(false);
      expect("out" in def).toBe(false);
      expect("callable" in def).toBe(false);
      expect("validate" in def).toBe(false);
    }
  });
});

describe("ROW 2 — bake / FV law: lower() succeeds, both macros bind as Macro values with the stamped attribute", () => {
  it("a bare lower() (no deps beyond this capability's own call-with-values) does not throw", () => {
    expect(() => bindingPack.lower({})).not.toThrow();
  });

  it("bound values are Macro instances carrying macroAttribute: binder (the W3 read-back channel, §3.4)", async () => {
    const env = await freshEnv();
    for (const name of ["let-values", "let*-values"]) {
      const bound = env.get(name);
      expect(bound).toBeInstanceOf(Macro);
      expect((bound as Macro).macroAttribute).toBe("binder");
    }
  });
});

describe("ROW 3 — semantic equivalence: unchanged runtime behavior vs. the pre-migration prelude", () => {
  it("let-values binds a single producer's values to formals", async () => {
    expect(await run("(let-values (((a b) (values 1 2))) (list a b))")).toBe("(1 2)");
  });

  it("let-values with a dotted rest formal", async () => {
    expect(await run("(let-values (((a . rest) (values 1 2 3))) (list a rest))")).toBe("(1 (2 3))");
  });

  it("let-values with MULTIPLE claws — every init expr sees the OUTER scope (never a sibling claw's binding)", async () => {
    expect(
      await run("(let ((x 10)) (let-values (((a) (values 1)) ((b) (values x))) (list a b)))"),
    ).toBe("(1 10)");
  });

  it("let-values zero-binding edge case — (let-values () body...)", async () => {
    expect(await run("(let-values () 42)")).toBe("42");
  });

  it("let*-values — SEQUENTIAL: a later claw's init expr sees an EARLIER claw's binding", async () => {
    expect(
      await run("(let*-values (((a) (values 5)) ((b) (values (* a 2)))) (list a b))"),
    ).toBe("(5 10)");
  });

  it("let*-values zero-binding edge case", async () => {
    expect(await run("(let*-values () 99)")).toBe("99");
  });

  it("mutual recursion between the two macros' expansions — nesting works both directions", async () => {
    expect(
      await run(
        "(let-values (((a) (values 1))) (let*-values (((b) (values (+ a 1))) ((c) (values (+ b 1)))) (list a b c)))",
      ),
    ).toBe("(1 2 3)");
  });

  it("interop with values/call-with-values (native, unmigrated in this pack) — unchanged", async () => {
    expect(await run("(call-with-values (lambda () (let-values (((a b) (values 1 2))) (values b a))) list)")).toBe(
      "(2 1)",
    );
  });
});

describe("ROW 4 — the validator's macro-firewall row still holds (no regression on the shared LAW 4)", () => {
  it("let-values claw formals do not report unbound under staticValidation: on", async () => {
    const [result] = await exec("(let-values (((a b) (values 3 4))) (list a b))", { staticValidation: "on" });
    expect(result).toEqual([3, 4]);
  });

  it("let*-values claw formals do not report unbound under staticValidation: on", async () => {
    const [result] = await exec("(let*-values (((a) (values 5)) ((b) (values (* a 2)))) (list a b))", {
      staticValidation: "on",
    });
    expect(result).toEqual([5, 10]);
  });

  it("a GENUINELY unbound name inside let-values' body is the documented `binder` blind spot (§3.4 LIMIT) — NOT a StaticValidationError; it surfaces only at runtime, the backstop", async () => {
    let caught: unknown;
    try {
      await exec("(let-values (((a b) (values 1 2))) (totally-unbound-name-xyz a b))", { staticValidation: "on" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // Under-report, never lie (§3.4's own framing): the whole call is firewalled as
    // one unit under `binder` (no per-macro binding-position metadata yet), so the
    // body's OWN genuinely-unbound reference is invisible to the static pass too —
    // it is not a StaticValidationError, it is the ordinary runtime unbound-variable
    // throw (the LIMIT's "backstop").
    expect(caught).not.toBeInstanceOf(StaticValidationError);
  });
});
