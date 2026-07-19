/**
 * Engine walker gate tests (engine-walker.md; constitution §3.5/§4.2/§5.2). Every
 * special form renders through the REAL pipeline — parse → desugar → classify →
 * walk → render — to an inline golden (pinned typescript@6.0.2 printer bytes: 4-space
 * indent, LF, trailing newline; prettier runs downstream and is not part of this seam).
 *
 * Door goldens assert the CODE PREFIX (`"<category>/<slug>: …"`), not the teaching
 * message — the code is the stable identity, the wording is free to move
 * (errors-as-doors Rule 3 + the door-throw contract).
 *
 * The five `emit(src)` → byte-golden describes are ONE protocol table
 * (`WALKER_CASES`): `{ topic, name, src, golden }` — each row runs `emit(src)` and
 * asserts `toBe(golden)`; the topical describes are generated from the table in
 * first-seen order, so adding a case is appending a row. Rows carrying walk options
 * (`facts` / `register`) or a second assertion stay plain `it`s in their describes.
 */
import { describe, expect, it } from "vitest";

import type { EmitRule, TypeFacts } from "@inhuman.tools/arrival/emit";

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

interface WalkerCase {
  /** The topical describe this row lands in (describes are generated in first-seen order). */
  readonly topic: string;
  /** The behavior claim — becomes the it name. */
  readonly name: string;
  readonly src: string;
  /** The exact bytes `emit(src)` must render (pinned typescript@6.0.2 printer bytes). */
  readonly golden: string;
}

/** Every `emit(src)` → byte-golden row of the special-form describes, one row per
 *  behavior claim. Rows carrying walk options (`facts` / `register`) or a second
 *  assertion stay plain `it`s in their describes below. */
const WALKER_CASES: readonly WalkerCase[] = [
  {
    topic: "define / lambda / begin",
    name: "top-level define → ConstDecl; top-level DefineFn → FnDecl",
    src: `(define x 1) (define (f y) y)`,
    golden: `const x = 1;\nfunction f(y) {\n    return y;\n}\n`,
  },
  {
    topic: "define / lambda / begin",
    name: "lambda → arrow with expression-body collapse",
    src: `(define f (lambda (x) x))`,
    golden: `const f = x => x;\n`,
  },
  {
    topic: "define / lambda / begin",
    name: "rest param → RestBinding",
    src: `(define (f . xs) xs)`,
    golden: `function f(...xs) {\n    return xs;\n}\n`,
  },
  {
    topic: "define / lambda / begin",
    name: "begin: all-but-last as statements, last as the value",
    src: `(define (f) (begin 1 2 3))`,
    golden: `function f() {\n    1;\n    2;\n    return 3;\n}\n`,
  },
  {
    topic: "define / lambda / begin",
    name: "internal defines are letrec*-flavored — mutual recursion resolves",
    src: `(define (f n) (define (even) (odd)) (define (odd) (even)) (even))`,
    golden: `function f(n) {\n    const even = () => odd();\n    const odd = () => even();\n    return even();\n}\n`,
  },
  {
    topic: "define / lambda / begin",
    name: "top-level defines are letrec*-flavored too (forward reference through a lambda)",
    src: `(define (f) (g)) (define (g) 1)`,
    golden: `function f() {\n    return g();\n}\nfunction g() {\n    return 1;\n}\n`,
  },

  // NOTE (WALKER-NAMING audit finding #2): every fixture below binds through
  // `(+ n 0)` rather than a bare literal/copy — the structural-optimization
  // lane's per-`Let` propagation (`../propagate/index.ts`'s
  // `propagationDecisionAt`) is now UNCONDITIONALLY consulted by `letStmts`
  // (`walk.ts`'s own `propagationFor`, no opt-in gate), so a literal/copy
  // binding no longer reaches this raw-lowering golden at all — it folds
  // away before `render()` ever sees it. An `App` init is never trivially
  // pure, so it survives untouched, keeping these goldens a true test of the
  // WALKER's raw `let` lowering shape, isolated from the fold. (`car`/
  // `reverse` were tried first and rejected here — a sole-use `(car param)`
  // triggers this package's OWN destructuring heuristic, `[head]`-binding the
  // param instead of leaving it a plain `Ref`, which is a different feature
  // entirely and not what these goldens test.)
  {
    topic: "let family",
    name: "plain let: Const sequence, spliced at tail position (no IIFE — the §6 sole-body invariant)",
    src: `(define (f) (let ((x (+ 1 0)) (y (+ 2 0))) (+ x y)))`,
    golden: `function f() {\n    const x = 1 + 0;\n    const y = 2 + 0;\n    return x + y;\n}\n`,
  },
  {
    topic: "let family",
    name: "let* resolves progressively; emission is identical Consts",
    src: `(define (f) (let* ((x (+ 1 0)) (y x)) y))`,
    golden: `function f() {\n    const x = 1 + 0;\n    const y = x;\n    return y;\n}\n`,
  },
  {
    topic: "let family",
    name: "letrec emits identically to let (letKind steers resolution only) — forward refs work",
    src: `(define (f) (letrec ((even (lambda (n) (odd n))) (odd (lambda (n) (even n)))) (even 2)))`,
    golden: `function f() {\n    const even = n => odd(n);\n    const odd = n => even(n);\n    return even(2);\n}\n`,
  },
  {
    topic: "let family",
    name: "let in expression position → Block → renderer IIFE (position polymorphism, zero walker decisions)",
    src: `(define (f) (+ 1 (let ((x (+ 2 0))) x)))`,
    golden: `function f() {\n    return 1 + (() => {\n        const x = 2 + 0;\n        return x;\n    })();\n}\n`,
  },
  {
    topic: "let family",
    name: "a let binding shadowing a param renames instead of redeclaring (overlapping-scope disambiguation)",
    src: `(define (f x) (let ((x (+ x 0))) x))`,
    golden: `function f(x) {\n    const x_2 = x + 0;\n    return x_2;\n}\n`,
  },

  {
    topic: "and / or — value semantics",
    name: "(or a b): fresh temp, evaluated once, value-returning guard",
    src: `(define (f a b) (or a b))`,
    golden: `function f(a, b) {\n    const __or = a;\n    return __or !== false ? __or : b;\n}\n`,
  },
  {
    topic: "and / or — value semantics",
    name: "(or a b c): nested else-position Block → IIFE — b never evaluates unless a is #f-false",
    src: `(define (f a b c) (or a b c))`,
    golden: `function f(a, b, c) {\n    const __or = a;\n    return __or !== false ? __or : (() => {\n        const __or2 = b;\n        return __or2 !== false ? __or2 : c;\n    })();\n}\n`,
  },
  {
    topic: "and / or — value semantics",
    name: "(and a b): the flipped check — first #f short-circuits with itself",
    src: `(define (f a b) (and a b))`,
    golden: `function f(a, b) {\n    const __and = a;\n    return __and === false ? __and : b;\n}\n`,
  },
  {
    topic: "and / or — value semantics",
    name: "(and) → #t, (or) → #f, single operand → itself",
    src: `(define (f x) (and)) (define (g x) (or)) (define (h x) (or x))`,
    golden: `function f(x) {\n    return true;\n}\nfunction g(x) {\n    return false;\n}\nfunction h(x) {\n    return x;\n}\n`,
  },
  {
    topic: "and / or — value semantics",
    name: "statement position: the cascade wraps in an explicit IIFE so its Return cannot escape",
    src: `(define (f a b) (begin (or a b) 1))`,
    golden: `function f(a, b) {\n    (() => {\n        const __or = a;\n        return __or !== false ? __or : b;\n    })();\n    return 1;\n}\n`,
  },

  {
    topic: "named let",
    name: "self-tail-only → while(true) with simultaneous ArrayPattern reassign + the fold marker",
    src: `(define (sum n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc i)))))`,
    golden: `function sum(n) {\n    let i = 0;\n    let acc = 0;\n    /*[ts-base/self-tail-loop] named let \`loop\` → while*/\n    while (true) {\n        if (i === n !== false) {\n            return acc;\n        }\n        else {\n            [i, acc] = [i + 1, acc + i];\n            continue;\n        }\n    }\n}\n`,
  },
  {
    topic: "named let",
    name: "a non-tail recursive use refuses TCO → the declared stack-bound arrow, faithfully",
    src: `(define (f n) (let loop ((i n)) (if (= i 0) 0 (+ 1 (loop (- i 1))))))`,
    golden: `function f(n) {\n    const loop = i => i === 0 !== false ? 0 : 1 + loop(i - 1);\n    return loop(n);\n}\n`,
  },

  {
    topic: "quote / dict / kwargs",
    name: "quoted data: scalars raw, symbols as strings, lists as arrays",
    src: `'(1 "two" three (4 5))`,
    golden: `[1, "two", "three", [4, 5]];\n`,
  },
  {
    topic: "quote / dict / kwargs",
    name: "folded-dot datum: '(1 . 2) compiles as [1, 2] (⚖️ ruled — classify folds the dot)",
    src: `'(1 . 2)`,
    golden: `[1, 2];\n`,
  },
  {
    topic: "quote / dict / kwargs",
    name: "dict writes RAW keys and the keyword accessor reads through Index — one shared key-fold",
    src: `(define d (dict :max-words 5)) (:max-words d)`,
    golden: `const d = { "max-words": 5 };\nd["max-words"];\n`,
  },
  {
    topic: "quote / dict / kwargs",
    name: "App kwargs collapse to ONE trailing options object with cleanName'd keys (a different key space than dict)",
    src: `(define (go f) (f 1 :max-words 5))`,
    golden: `function go(f) {\n    return f(1, { maxWords: 5 });\n}\n`,
  },
];

const WALKER_TOPICS = [...new Set(WALKER_CASES.map((c) => c.topic))];
for (const topic of WALKER_TOPICS) {
  describe(topic, () => {
    for (const c of WALKER_CASES.filter((x) => x.topic === topic)) {
      it(c.name, () => {
        expect(emit(c.src)).toBe(c.golden);
      });
    }
  });
}

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
});

// ── named let ────────────────────────────────────────────────────────────────────────

describe("named let", () => {
  it("reassignment is simultaneous — the swap survives (never sequential)", () => {
    const out = emit(`(define (f p a b) (let loop ((a a) (b b)) (if p (loop b a) a)))`);
    expect(out).toBe(
      `function f(p, a, b) {\n    let a_2 = a;\n    let b_2 = b;\n    /*[ts-base/self-tail-loop] named let \`loop\` → while*/\n    while (true) {\n        if (p !== false) {\n            [a_2, b_2] = [b_2, a_2];\n            continue;\n        }\n        else {\n            return a_2;\n        }\n    }\n}\n`,
    );
    // exactly one fold marker per rewritten loop
    expect(out.match(/self-tail-loop/g)).toHaveLength(1);
  });
});

// ── App dispatch (§4.2) ──────────────────────────────────────────────────────────────

describe("App dispatch ladder", () => {
  it("rung 1: an emit rule produces the idiomatic residual through the narrowing seam", () => {
    // `xs` is used ONLY through a single car access — engine plan §2 E1a moved
    // implicit destruction INTO walk() itself (naming/census.ts's use-shape
    // analysis + naming/allocate.ts's naming policy), so this now destructures
    // to a one-slot ArrayPattern, exactly as the constitution's worked example
    // does for a two-slot tuple (see walker/../legibility.test.ts's own
    // "implicit destruction" describe block).
    expect(emit(`(define (f xs) (car xs))`)).toBe(`function f([head]) {\n    return head;\n}\n`);
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
