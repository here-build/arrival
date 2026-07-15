/**
 * ARM-A unit tests — atoms/bindings/structure (Lit, Ref, Quote, Define, Let,
 * Begin, Require, Door). Sources build through the REAL front pipeline
 * (parseSexprs → desugar → classify), exactly like extract-corpus.test.ts, so
 * NodeIds and Scope shapes are the genuine article, not hand-rolled fixtures.
 *
 * Scope discipline: every fixture stays strictly within ARM-A-owned CoreForm
 * kinds — no App, no Dict, no Lambda/If/And/Or/DefineFn-as-callee. ARM-B and
 * ARM-C are sibling G1 stubs mid-build in parallel; depending on their output
 * would make these tests flaky/coupled to work this file does not own. The
 * registry is hand-built here (never imported from arm-containers.js) for the
 * same reason — these fixtures never call classifyHead, so a local total stub
 * is equivalent and removes the cross-arm file dependency entirely.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { extractProgram } from "../../extract/index.js";
import { parseSexprs } from "../../front/parse.js";
import type { HeadClass, HeadRegistry, StaticProv } from "../../model/static-prov.js";

const stubRegistry: HeadRegistry = {
  classifyHead(name: string): HeadClass {
    return { role: "opaque", reason: `unknown-head/${name}` };
  },
};

const run = (src: string): StaticProv => {
  const { forms } = classify(desugar(parseSexprs(src)));
  return extractProgram(forms, stubRegistry);
};

describe("extractAtom — Lit / Quote", () => {
  it("Lit lifts to const", () => {
    expect(run("42").kind).toBe("const");
  });

  it("Quote lifts to ONE const for the whole datum (quoted data is inert)", () => {
    expect(run("'(1 2 3)").kind).toBe("const");
  });
});

describe("extractAtom — Ref", () => {
  it("a genuinely free (unbound) name lifts to InputProv", () => {
    expect(run("totally-free-name")).toMatchObject({ kind: "input", name: "totally-free-name" });
  });

  it("a define/overridable input wins over scope even though the SAME name is also bound there", () => {
    // "e" is both an input (overridableType set) and scope-bound to Lit(0) — ctx.inputs
    // must be checked first and unconditionally, per the contract's ordering.
    const prov = run(`(define/overridable e any 0)\ne`);
    expect(prov).toMatchObject({ kind: "input", name: "e" });
  });
});

describe("extractAtom — Let (all four kinds)", () => {
  it("let: every init resolves against the OUTER scope, never the new frame's own siblings — binding-site scoping forge", () => {
    // f's init `x` must resolve against the OUTER let's own scope (free there), NOT the
    // inner let's scope, which shadows `x` with a different free name (`shadow`). A
    // reference-site-scoping bug would resolve to "shadow" instead of "x".
    const prov = run(`
      (let ((f x))
        (let ((x shadow))
          f))
    `);
    expect(prov).toMatchObject({ kind: "input", name: "x" });
  });

  it("let*: each init sees only the PRIOR bindings of the SAME group (sequential chain, not parallel)", () => {
    // The inner let*'s `b` must resolve its `a` to the let*'s OWN a=inner (textually
    // prior, same group) — NOT the enclosing let's a=outer.
    const prov = run(`
      (let ((a outer))
        (let* ((a inner) (b a))
          b))
    `);
    expect(prov).toMatchObject({ kind: "input", name: "inner" });
  });

  it("letrec: every init sees the fully-extended frame — a forward reference within the group resolves", () => {
    const prov = run(`(letrec ((a b) (b marker)) a)`);
    expect(prov).toMatchObject({ kind: "input", name: "marker" });
  });

  it("letrec self-cycle lifts to opaque cyclic-binding", () => {
    const prov = run(`(letrec ((a a)) a)`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "cyclic-binding" });
  });

  it("letrec* self-cycle ALSO lifts to opaque cyclic-binding (same static treatment as letrec)", () => {
    const prov = run(`(letrec* ((a a)) a)`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "cyclic-binding" });
  });
});

describe("extractAtom — Begin / body-internal defines", () => {
  it("a chain of internal defines threads scope through to the final constant", () => {
    const prov = run(`
      (begin
        (define a 1)
        (define b a)
        b)
    `);
    expect(prov.kind).toBe("const");
  });

  it("all-defines body: attributes the last define's own value", () => {
    expect(run(`(begin (define a 1))`).kind).toBe("const");
  });

  it("a free reference alongside an internal define still lifts to input when it doesn't name the define", () => {
    const prov = run(`
      (begin
        (define a 1)
        elsewhere)
    `);
    expect(prov).toMatchObject({ kind: "input", name: "elsewhere" });
  });
});

describe("extractAtom — Require / Door", () => {
  it("Require lifts to a mint crossing (head 'require', evidence integrity, no closed inputs)", () => {
    const prov = run(`(require "./sibling.scm")`);
    expect(prov).toMatchObject({ kind: "mint", head: "require", integrity: "evidence", closed: [] });
  });

  it("Door passes through as opaque(form.id, form.code) — extract never upgrades a Door", () => {
    const prov = run(`(set! x 5)`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "prohibited-dynamics/set!" });
  });
});
