/**
 * Engine walker gate tests (engine-walker.md; constitution §3.5/§4.2/§5.2). Every
 * special form renders through the REAL pipeline — parse → desugar → classify →
 * walk → render — to an inline golden (pinned typescript@6.0.2 printer bytes: 4-space
 * indent, LF, trailing newline; prettier runs downstream and is not part of this seam).
 *
 * Door goldens assert the CODE PREFIX (`"<category>/<slug>: …"`), not the teaching
 * message — the code is the stable identity, the wording is free to move
 * (errors-as-doors Rule 3 + the door-throw contract).
 */
import { describe, expect, it } from "vitest";

import type { EmitRule, TypeFacts } from "@here.build/arrival/emit";

import { classify } from "../coreform/index.js";
import type { And, ClassifyResult, DefineFn, If as CfIf, NodeId } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import type { EmitRegistry, EmitRegistryRow } from "../registry/index.js";
import { render } from "../residual/render.js";
import type { BinOp, CompilationUnit, R } from "../residual/types.js";
import { Bin, Index, Lit } from "../residual/types.js";
import { runtimeRefsOf, walk, WalkDoorError, type WalkOptions } from "../walker/index.js";

// ── a hand-rolled registry (EmitRegistry is an interface — no capability tree needed) ──

const row = (symbol: string, over: Partial<EmitRegistryRow> = {}): EmitRegistryRow => ({
  symbol,
  capability: "«test»",
  kind: "rosetta",
  refPolicy: "shim",
  ...over,
});
const registryOf = (...rows: EmitRegistryRow[]): EmitRegistry => {
  const m = new Map(rows.map((r) => [r.symbol, r]));
  return { lookup: (n) => m.get(n), names: new Set(m.keys()) };
};

/** Strict-binary test rules (real slice rules fold variadics; the fixed arity here
 *  doubles as the ctx.door test surface). Authored against the real `R` — assigning
 *  them into the opaque `EmitRegistryRow.emit` slot exercises the bivariance the
 *  narrowing seam depends on. */
const binRule = (op: BinOp): EmitRule<R> => ({
  call: (args, ctx) => (args.length === 2 ? Bin(op, args[0]!, args[1]!) : ctx.door(`binary ${op} wants exactly 2 args`)),
});
const carRule: EmitRule<R> = {
  call: ([xs], ctx) => (xs === undefined ? ctx.door("car wants an argument") : Index(xs, Lit(0))),
};

const testRegistry = registryOf(
  row("=", { emit: binRule("===") }),
  row("+", { emit: binRule("+") }),
  row("-", { emit: binRule("-") }),
  row("car", { emit: carRule }),
  row("reverse"), // no emit rule → rung 3, the RuntimeRef shim
  row("current-jiffy", { kind: "door", doorReason: "wall-clock reads are a runtime capability, not compilable." }),
  row("first-class-only", { refPolicy: "door" }),
);

const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));
const compile = (src: string, over: Partial<WalkOptions> = {}): CompilationUnit =>
  walk(cf(src), { registry: testRegistry, register: "run", ...over });
const emit = (src: string, over: Partial<WalkOptions> = {}): string => render(compile(src, over));

// ── special forms ─────────────────────────────────────────────────────────────────────

describe("define / lambda / begin", () => {
  it("top-level define → ConstDecl; top-level DefineFn → FnDecl", () => {
    expect(emit(`(define x 1) (define (f y) y)`)).toBe(`const x = 1;\nfunction f(y) {\n    return y;\n}\n`);
  });

  it("lambda → arrow with expression-body collapse", () => {
    expect(emit(`(define f (lambda (x) x))`)).toBe(`const f = x => x;\n`);
  });

  it("rest param → RestBinding", () => {
    expect(emit(`(define (f . xs) xs)`)).toBe(`function f(...xs) {\n    return xs;\n}\n`);
  });

  it("begin: all-but-last as statements, last as the value", () => {
    expect(emit(`(define (f) (begin 1 2 3))`)).toBe(`function f() {\n    1;\n    2;\n    return 3;\n}\n`);
  });

  it("internal defines are letrec*-flavored — mutual recursion resolves", () => {
    expect(emit(`(define (f n) (define (even) (odd)) (define (odd) (even)) (even))`)).toBe(
      `function f(n) {\n    const even = () => odd();\n    const odd = () => even();\n    return even();\n}\n`,
    );
  });

  it("top-level defines are letrec*-flavored too (forward reference through a lambda)", () => {
    expect(emit(`(define (f) (g)) (define (g) 1)`)).toBe(
      `function f() {\n    return g();\n}\nfunction g() {\n    return 1;\n}\n`,
    );
  });
});

describe("let family", () => {
  it("plain let: Const sequence, spliced at tail position (no IIFE — the §6 sole-body invariant)", () => {
    expect(emit(`(define (f) (let ((x 1) (y 2)) (+ x y)))`)).toBe(
      `function f() {\n    const x = 1;\n    const y = 2;\n    return x + y;\n}\n`,
    );
  });

  it("let* resolves progressively; emission is identical Consts", () => {
    expect(emit(`(define (f) (let* ((x 1) (y x)) y))`)).toBe(
      `function f() {\n    const x = 1;\n    const y = x;\n    return y;\n}\n`,
    );
  });

  it("letrec emits identically to let (letKind steers resolution only) — forward refs work", () => {
    expect(emit(`(define (f) (letrec ((even (lambda (n) (odd n))) (odd (lambda (n) (even n)))) (even 2)))`)).toBe(
      `function f() {\n    const even = n => odd(n);\n    const odd = n => even(n);\n    return even(2);\n}\n`,
    );
  });

  it("let in expression position → Block → renderer IIFE (position polymorphism, zero walker decisions)", () => {
    expect(emit(`(define (f) (+ 1 (let ((x 2)) x)))`)).toBe(
      `function f() {\n    return 1 + (() => {\n        const x = 2;\n        return x;\n    })();\n}\n`,
    );
  });

  it("a let binding shadowing a param renames instead of redeclaring (overlapping-scope disambiguation)", () => {
    expect(emit(`(define (f x) (let ((x 2)) x))`)).toBe(`function f(x) {\n    const x_2 = 2;\n    return x_2;\n}\n`);
  });
});

// ── Law T ────────────────────────────────────────────────────────────────────────────

describe("Law T — if", () => {
  const src = `(define (f x n) (if (= x n) "a" "b"))`;
  const condIdOf = (r: ClassifyResult): NodeId => ((r.forms[0] as DefineFn).body[0] as CfIf).cond.id;

  it("run register, no facts → the exact-Scheme guard (conservative, Law F)", () => {
    expect(emit(src)).toBe(`function f(x, n) {\n    return x === n !== false ? "a" : "b";\n}\n`);
  });

  it("run register, facts.boolean on the condition → bare ternary (the flip)", () => {
    const classified = cf(src);
    const facts = new Map<NodeId, TypeFacts>([[condIdOf(classified), { boolean: true }]]);
    expect(render(walk(classified, { registry: testRegistry, register: "run", facts }))).toBe(
      `function f(x, n) {\n    return x === n ? "a" : "b";\n}\n`,
    );
  });

  it("read register → always the clean form (glass is never executed)", () => {
    expect(emit(`(define (f x) (if x "a" "b"))`, { register: "read" })).toBe(
      `function f(x) {\n    return x ? "a" : "b";\n}\n`,
    );
  });

  it("the live bug stays dead: (if 0 'a 'b) compiles to the guard, so it picks 'a", () => {
    expect(emit(`(if 0 "a" "b")`)).toBe(`0 !== false ? "a" : "b";\n`);
  });
});

describe("and / or — value semantics", () => {
  it("(or a b): fresh temp, evaluated once, value-returning guard", () => {
    expect(emit(`(define (f a b) (or a b))`)).toBe(
      `function f(a, b) {\n    const __or = a;\n    return __or !== false ? __or : b;\n}\n`,
    );
  });

  it("(or a b c): nested else-position Block → IIFE — b never evaluates unless a is #f-false", () => {
    expect(emit(`(define (f a b c) (or a b c))`)).toBe(
      `function f(a, b, c) {\n    const __or = a;\n    return __or !== false ? __or : (() => {\n        const __or2 = b;\n        return __or2 !== false ? __or2 : c;\n    })();\n}\n`,
    );
  });

  it("(and a b): the flipped check — first #f short-circuits with itself", () => {
    expect(emit(`(define (f a b) (and a b))`)).toBe(
      `function f(a, b) {\n    const __and = a;\n    return __and === false ? __and : b;\n}\n`,
    );
  });

  it("(and) → #t, (or) → #f, single operand → itself", () => {
    expect(emit(`(define (f x) (and)) (define (g x) (or)) (define (h x) (or x))`)).toBe(
      `function f(x) {\n    return true;\n}\nfunction g(x) {\n    return false;\n}\nfunction h(x) {\n    return x;\n}\n`,
    );
  });

  it("all operands proven boolean → native && (the clean fold)", () => {
    const classified = cf(`(define (f a b) (and a b))`);
    const and = (classified.forms[0] as DefineFn).body[0] as And;
    const facts = new Map<NodeId, TypeFacts>(and.args.map((a) => [a.id, { boolean: true as const }]));
    expect(render(walk(classified, { registry: testRegistry, register: "run", facts }))).toBe(
      `function f(a, b) {\n    return a && b;\n}\n`,
    );
  });

  it("read register → native fold unconditionally", () => {
    expect(emit(`(define (f a b) (or a b))`, { register: "read" })).toBe(
      `function f(a, b) {\n    return a || b;\n}\n`,
    );
  });

  it("statement position: the cascade wraps in an explicit IIFE so its Return cannot escape", () => {
    expect(emit(`(define (f a b) (begin (or a b) 1))`)).toBe(
      `function f(a, b) {\n    (() => {\n        const __or = a;\n        return __or !== false ? __or : b;\n    })();\n    return 1;\n}\n`,
    );
  });
});

// ── named let ────────────────────────────────────────────────────────────────────────

describe("named let", () => {
  it("self-tail-only → while(true) with simultaneous ArrayPattern reassign + the fold marker", () => {
    expect(emit(`(define (sum n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc i)))))`)).toBe(
      `function sum(n) {\n    let i = 0;\n    let acc = 0;\n    /*[ts-base/self-tail-loop] named let \`loop\` → while*/\n    while (true) {\n        if (i === n !== false) {\n            return acc;\n        }\n        else {\n            [i, acc] = [i + 1, acc + i];\n            continue;\n        }\n    }\n}\n`,
    );
  });

  it("reassignment is simultaneous — the swap survives (never sequential)", () => {
    const out = emit(`(define (f p a b) (let loop ((a a) (b b)) (if p (loop b a) a)))`);
    expect(out).toBe(
      `function f(p, a, b) {\n    let a_2 = a;\n    let b_2 = b;\n    /*[ts-base/self-tail-loop] named let \`loop\` → while*/\n    while (true) {\n        if (p !== false) {\n            [a_2, b_2] = [b_2, a_2];\n            continue;\n        }\n        else {\n            return a_2;\n        }\n    }\n}\n`,
    );
    // exactly one fold marker per rewritten loop
    expect(out.match(/self-tail-loop/g)).toHaveLength(1);
  });

  it("a non-tail recursive use refuses TCO → the declared stack-bound arrow, faithfully", () => {
    expect(emit(`(define (f n) (let loop ((i n)) (if (= i 0) 0 (+ 1 (loop (- i 1))))))`)).toBe(
      `function f(n) {\n    const loop = i => i === 0 !== false ? 0 : 1 + loop(i - 1);\n    return loop(n);\n}\n`,
    );
  });
});

// ── quote / dict / kwargs ────────────────────────────────────────────────────────────

describe("quote / dict / kwargs", () => {
  it("quoted data: scalars raw, symbols as strings, lists as arrays", () => {
    expect(emit(`'(1 "two" three (4 5))`)).toBe(`[1, "two", "three", [4, 5]];\n`);
  });

  it("folded-dot datum: '(1 . 2) compiles as [1, 2] (⚖️ ruled — classify folds the dot)", () => {
    expect(emit(`'(1 . 2)`)).toBe(`[1, 2];\n`);
  });

  it("dict writes RAW keys and the keyword accessor reads through Index — one shared key-fold", () => {
    expect(emit(`(define d (dict :max-words 5)) (:max-words d)`)).toBe(
      `const d = { "max-words": 5 };\nd["max-words"];\n`,
    );
  });

  it("App kwargs collapse to ONE trailing options object with cleanName'd keys (a different key space than dict)", () => {
    expect(emit(`(define (go f) (f 1 :max-words 5))`)).toBe(
      `function go(f) {\n    return f(1, { maxWords: 5 });\n}\n`,
    );
  });
});

// ── App dispatch (§4.2) ──────────────────────────────────────────────────────────────

describe("App dispatch ladder", () => {
  it("rung 1: an emit rule produces the idiomatic residual through the narrowing seam", () => {
    expect(emit(`(define (f xs) (car xs))`)).toBe(`function f(xs) {\n    return xs[0];\n}\n`);
  });

  it("rung 3: an unruled registry symbol calls through the RuntimeRef shim, and the census sees it", () => {
    const unit = compile(`(define (f xs) (reverse xs))`);
    expect(render(unit)).toBe(`function f(xs) {\n    return reverse(xs);\n}\n`);
    expect([...runtimeRefsOf(unit)]).toEqual(["reverse"]);
  });

  it("a locally-shadowed builtin resolves to the LOCAL binding — the registry is never consulted", () => {
    expect(emit(`(define (f xs) (let ((car (lambda (p) 99))) (car xs)))`)).toBe(
      `function f(xs) {\n    const car = p => 99;\n    return car(xs);\n}\n`,
    );
  });

  it("value position of a registry symbol: refPolicy shim → RuntimeRef (eta degrades to shim this wave)", () => {
    const unit = compile(`(define pick car)`);
    expect(render(unit)).toBe(`const pick = car;\n`);
    expect([...runtimeRefsOf(unit)]).toEqual(["car"]);
  });

  it("an immediate-lambda callee is an ordinary call — parenthesized structurally by the renderer", () => {
    expect(emit(`((lambda (x) (+ x 1)) 5)`)).toBe(`(x => x + 1)(5);\n`);
  });
});

// ── doors ────────────────────────────────────────────────────────────────────────────

describe("doors — the code-prefixed Throw contract", () => {
  it("a classify Door (set!) lands as a Throw whose message BEGINS with the door code", () => {
    expect(emit(`(set! x 1)`)).toMatch(/^throw new Error\("prohibited-dynamics\/set!: /);
  });

  it("a door on an untaken branch does not poison the program (interpreter parity)", () => {
    const out = emit(`(define (f c) (if c 1 (set! x 2)))`);
    // The door rides the else arm as an IIFE-wrapped throw — the surrounding code compiles
    // normally, and the throw fires only if that branch is actually evaluated. The message
    // wording is classify()'s to reword; the CODE prefix is the contract.
    expect(out).toContain(`return c !== false ? 1 : (() => {\n        throw new Error("prohibited-dynamics/set!: `);
  });

  it("require doors in this slice (no loader) — code-prefixed", () => {
    expect(emit(`(require "lib.scm")`)).toMatch(/^throw new Error\("unsupported-form\/require: /);
  });

  it("a registry door row throws its doorReason verbatim behind the code prefix", () => {
    expect(emit(`(define (f) (current-jiffy))`)).toBe(
      `function f() {\n    throw new Error("unsupported-form/current-jiffy: wall-clock reads are a runtime capability, not compilable.");\n}\n`,
    );
  });

  it("refPolicy \"door\" refuses first-class use", () => {
    expect(emit(`(define g first-class-only)`)).toContain(
      `unsupported-form/first-class-only: \`first-class-only\` cannot be used as a first-class value`,
    );
  });

  it("an unresolved identifier doors (never a silent bare reference)", () => {
    expect(emit(`(nope 1)`)).toBe(
      `(() => {\n    throw new Error("unsupported-form/unresolved-identifier: \`nope\` is not lexically bound and is not a registry symbol.");\n})();\n`,
    );
  });

  it("keyword accessor with no operand doors defensively", () => {
    expect(emit(`(:field)`)).toContain("malformed-source/keyword-accessor-arity:");
  });

  it("a rule's ctx.door is the one COMPILE-time refusal — WalkDoorError escapes walk()", () => {
    expect(() => compile(`(define (f) (= 1 2 3))`)).toThrowError(WalkDoorError);
    expect(() => compile(`(define (f) (= 1 2 3))`)).toThrowError(/binary === wants exactly 2 args/);
  });
});

// ── whole program ────────────────────────────────────────────────────────────────────

describe("whole program", () => {
  it("a small program: dict + accessor + Law T guard + call, one golden", () => {
    const src = `
(define config (dict :max-words 5))
(define (clamp words)
  (let ((limit (:max-words config)))
    (if (= words limit) words limit)))
(clamp 3)`;
    expect(emit(src)).toBe(
      `const config = { "max-words": 5 };\nfunction clamp(words) {\n    const limit = config["max-words"];\n    return words === limit !== false ? words : limit;\n}\nclamp(3);\n`,
    );
  });

  it("runtimeRefsOf is a set in first-occurrence order across decls then body", () => {
    const unit = compile(`(define (f xs) (reverse xs)) (define pick car) (reverse (pick))`);
    expect([...runtimeRefsOf(unit)]).toEqual(["reverse", "car"]);
  });
});
