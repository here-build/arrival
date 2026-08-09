/**
 * classify()'s own contract (coreform-ir.md §8): shape in → shape out, runnable with
 * zero registry, zero type-lens, zero tsc in the loop. Feeds — but is distinct from —
 * the differential oracle (constitution §5.4).
 */
import { describe, expect, it } from "vitest";

import { classify } from "../coreform/index.js";
import type {
  App,
  Binding,
  ClassifyResult,
  CoreForm,
  Door,
  KwEntry,
  NodeId,
  Param,
  Quote,
  QuoteDatum,
} from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";

/** The full front pipeline: parse → desugar → classify. */
const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));
/** First (often only) top-level form of a program. */
const first = (src: string): CoreForm => {
  const { forms } = cf(src);
  expect(forms.length).toBeGreaterThan(0);
  return forms[0]!;
};

function assertKind<K extends CoreForm["kind"]>(f: CoreForm, kind: K): Extract<CoreForm, { kind: K }> {
  expect(f.kind).toBe(kind);
  return f as Extract<CoreForm, { kind: K }>;
}

const expectDoor = (f: CoreForm, code: string): Door => {
  const door = assertKind(f, "Door");
  expect(door.code).toBe(code);
  expect(door.code.startsWith(`${door.category}/`)).toBe(true);
  return door;
};

type AnyNode = CoreForm | Param | Binding | KwEntry;

/** Walk every id-carrying record in MINTING order (pre-order, field-in-source-order). */
function* walk(n: AnyNode): Generator<AnyNode> {
  yield n;
  if ("recordKind" in n) {
    if (n.recordKind === "binding") yield* walk(n.init);
    else if (n.recordKind === "kwentry") yield* walk(n.value);
    return;
  }
  switch (n.kind) {
    case "Define":
      if (n.overridableType !== undefined) yield* walk(n.overridableType);
      yield* walk(n.value);
      break;
    case "DefineFn":
      for (const p of n.params) yield* walk(p);
      if (n.overridableType !== undefined) yield* walk(n.overridableType);
      for (const b of n.body) yield* walk(b);
      break;
    case "Lambda":
      for (const p of n.params) yield* walk(p);
      for (const b of n.body) yield* walk(b);
      break;
    case "If":
      yield* walk(n.cond);
      yield* walk(n.then);
      yield* walk(n.else);
      break;
    case "And":
    case "Or":
      for (const a of n.args) yield* walk(a);
      break;
    case "Let":
    case "NamedLet":
      for (const b of n.bindings) yield* walk(b);
      for (const b of n.body) yield* walk(b);
      break;
    case "Begin":
      for (const b of n.body) yield* walk(b);
      break;
    case "App":
      yield* walk(n.fn);
      for (const a of n.positionalArgs) yield* walk(a);
      for (const k of n.kwargs) yield* walk(k);
      break;
    case "Dict":
      for (const e of n.entries) yield* walk(e);
      break;
    case "Quote":
    case "Ref":
    case "Lit":
    case "Require":
    case "Door":
      break;
  }
}

const allNodes = (r: ClassifyResult): AnyNode[] => r.forms.flatMap((f) => [...walk(f)]);

const datumSymbols = (d: QuoteDatum): string[] =>
  d.kind === "symbol" ? [d.name] : d.kind === "list" ? d.items.flatMap(datumSymbols) : [];

// ── union member classification ────────────────────────────────────────────────

describe("coreform — every union member classifies", () => {
  it("Define", () => {
    const d = assertKind(first(`(define x 1)`), "Define");
    expect(d.name).toBe("x");
    expect(assertKind(d.value, "Lit").value).toEqual({ kind: "number", text: "1" });
    expect(d.overridableType).toBeUndefined();
  });

  it("Define — define/overridable carries the type slot", () => {
    const d = assertKind(first(`(define/overridable temp s/number 0.7)`), "Define");
    expect(d.name).toBe("temp");
    expect(d.overridableType).toBeDefined();
    expect(assertKind(d.overridableType!, "Ref").name).toBe("s/number");
    expect(assertKind(d.value, "Lit").value).toEqual({ kind: "number", text: "0.7" });
  });

  it("DefineFn — fn shorthand, no synthetic Lambda", () => {
    const d = assertKind(first(`(define (add a b) (+ a b))`), "DefineFn");
    expect(d.name).toBe("add");
    expect(d.params.map((p) => p.name)).toEqual(["a", "b"]);
    expect(d.params.every((p) => !p.rest)).toBe(true);
    expect(d.body).toHaveLength(1);
    assertKind(d.body[0]!, "App");
  });

  it("DefineFn — define/overridable fn shorthand keeps its type (spec §4.8's closed gap)", () => {
    const d = assertKind(first(`(define/overridable (greet name) s/any (str "hi " name))`), "DefineFn");
    expect(d.overridableType).toBeDefined();
    expect(assertKind(d.overridableType!, "Ref").name).toBe("s/any");
    expect(d.body).toHaveLength(1);
  });

  it("DefineFn — dotted rest after zero fixed params is legal define-formals", () => {
    const d = assertKind(first(`(define (f . rest) rest)`), "DefineFn");
    expect(d.params).toHaveLength(1);
    expect(d.params[0]!.name).toBe("rest");
    expect(d.params[0]!.rest).toBe(true);
  });

  it("Lambda — with a dotted rest param", () => {
    const l = assertKind(first(`(lambda (a . rest) a)`), "Lambda");
    expect(l.params.map((p) => [p.name, p.rest])).toEqual([
      ["a", false],
      ["rest", true],
    ]);
  });

  it("If — full and elided-else (filler Lit(undefined) inherits the If's span)", () => {
    const full = assertKind(first(`(if #t 1 2)`), "If");
    expect(assertKind(full.else, "Lit").value).toEqual({ kind: "number", text: "2" });

    const elided = assertKind(first(`(if #t 1)`), "If");
    const els = assertKind(elided.else, "Lit");
    expect(els.value).toEqual({ kind: "undefined" });
    expect(els.span).toEqual(elided.span);
  });

  it("And / Or — dedicated nodes, zero-arg legal (edge #11)", () => {
    const and = assertKind(first(`(and 1 2)`), "And");
    expect(and.args).toHaveLength(2);
    expect(assertKind(first(`(or)`), "Or").args).toEqual([]);
    expect(assertKind(first(`(and)`), "And").args).toEqual([]);
  });

  it("Let — all four letKinds fold into one node (spec §4.10; letrec was lower.ts's silent bug)", () => {
    for (const kind of ["let", "let*", "letrec", "letrec*"] as const) {
      const l = assertKind(first(`(${kind} ((x 1)) x)`), "Let");
      expect(l.letKind).toBe(kind);
      expect(l.bindings).toHaveLength(1);
      expect(l.bindings[0]!.name).toBe("x");
    }
    // edge #1: mutual recursion classifies, never doors
    const rec = assertKind(first(`(letrec ((f (lambda () (g))) (g (lambda () (f)))) (f))`), "Let");
    expect(rec.letKind).toBe("letrec");
    expect(rec.bindings.map((b) => b.name)).toEqual(["f", "g"]);
  });

  it("Let — elided binding init normalizes to Lit(undefined)", () => {
    const l = assertKind(first(`(let ((x)) x)`), "Let");
    expect(assertKind(l.bindings[0]!.init, "Lit").value).toEqual({ kind: "undefined" });
  });

  it("NamedLet — bare `let` head only", () => {
    const n = assertKind(first(`(let loop ((i 0)) (loop (+ i 1)))`), "NamedLet");
    expect(n.loopName).toBe("loop");
    expect(n.bindings[0]!.name).toBe("i");
    expect(n.body).toHaveLength(1);
  });

  it("Begin", () => {
    const b = assertKind(first(`(begin 1 2 3)`), "Begin");
    expect(b.body).toHaveLength(3);
  });

  it("Quote — a barrier: quoted (if a b c) is a datum, never an If node (spec §4.6)", () => {
    const q = assertKind(first(`'(if a b c)`), "Quote");
    expect(q.datum).toEqual({
      kind: "list",
      items: [
        { kind: "symbol", name: "if" },
        { kind: "symbol", name: "a" },
        { kind: "symbol", name: "b" },
        { kind: "symbol", name: "c" },
      ],
    });
  });

  it("Quote — '() and bare () both classify to the empty-list datum", () => {
    for (const src of [`'()`, `()`]) {
      const q = assertKind(first(src), "Quote");
      expect(q.datum).toEqual({ kind: "list", items: [] });
    }
  });

  it("App — positional/kwarg split preserved raw (spec §4.7)", () => {
    const a = assertKind(first(`(f 1 2 :retries 3)`), "App");
    expect(assertKind(a.fn, "Ref").name).toBe("f");
    expect(a.positionalArgs).toHaveLength(2);
    expect(a.kwargs).toHaveLength(1);
    expect(a.kwargs[0]!.key).toBe("retries");
    expect(assertKind(a.kwargs[0]!.value, "Lit").value).toEqual({ kind: "number", text: "3" });
  });

  it("App — keyword head is Lit(keyword), no dedicated variant (spec §4.6)", () => {
    const a = assertKind(first(`(:name user)`), "App");
    expect(assertKind(a.fn, "Lit").value).toEqual({ kind: "keyword", name: "name" });
    expect(assertKind(a.positionalArgs[0]!, "Ref").name).toBe("user");
  });

  it("App — computed callee stays fully general (edge #12, #15)", () => {
    const a = assertKind(first(`((car fns) x)`), "App");
    assertKind(a.fn, "App");
    const iife = assertKind(first(`((lambda (x) x) 1)`), "App");
    assertKind(iife.fn, "Lambda");
  });

  it("Ref / Lit — atoms", () => {
    expect(assertKind(first(`x`), "Ref").name).toBe("x");
    expect(assertKind(first(`42`), "Lit").value).toEqual({ kind: "number", text: "42" });
    expect(assertKind(first(`-7.5e2`), "Lit").value).toEqual({ kind: "number", text: "-7.5e2" });
    expect(assertKind(first(`#t`), "Lit").value).toEqual({ kind: "boolean", value: true });
    expect(assertKind(first(`#f`), "Lit").value).toEqual({ kind: "boolean", value: false });
    expect(assertKind(first(`:kw`), "Lit").value).toEqual({ kind: "keyword", name: "kw" });
  });

  it("Lit — string escapes decode ONCE, at classification (spec §4.13)", () => {
    expect(assertKind(first(String.raw`"a\nb\t\"q\""`), "Lit").value).toEqual({
      kind: "string",
      value: 'a\nb\t"q"',
    });
  });

  it("Dict — keyword and bare-atom keys both legal, colon stripped, key kept raw (edge #14)", () => {
    const d = assertKind(first(`(dict :max-words 5 plain 1)`), "Dict");
    expect(d.entries.map((e) => e.key)).toEqual(["max-words", "plain"]);
    assertKind(d.entries[0]!.value, "Lit");
  });

  it("Require", () => {
    const r = assertKind(first(`(require "./lib.scm")`), "Require");
    expect(r.path).toBe("./lib.scm");
  });

  it("Door — carried as a first-class node (taxonomy below)", () => {
    expectDoor(first("`(1 2)"), "unsupported-form/quasiquote");
  });
});

// ── prohibited dynamics (constitution §2.2 — doors are SYNTACTIC) ─────────────────

describe("coreform — prohibited-dynamics doors, any position", () => {
  it.each([
    [`(set! x 1)`, "prohibited-dynamics/set!"],
    [`(set! (foo x) v)`, "prohibited-dynamics/set!"], // edge #3: target shape irrelevant
    [`(set-car! p v)`, "prohibited-dynamics/set-car!"],
    [`(set-cdr! p v)`, "prohibited-dynamics/set-cdr!"],
    [`(vector-set! v 0 1)`, "prohibited-dynamics/vector-set!"],
    [`(string-set! s 0 c)`, "prohibited-dynamics/string-set!"],
    [`(call/cc (lambda (k) k))`, "prohibited-dynamics/call-cc"],
    [`(call-with-current-continuation (lambda (k) k))`, "prohibited-dynamics/call-with-current-continuation"],
    [`(dynamic-wind before thunk after)`, "prohibited-dynamics/dynamic-wind"],
  ])("%s → %s", (src, code) => {
    const door = expectDoor(first(src), code);
    expect(door.category).toBe("prohibited-dynamics");
    expect(door.message).toMatch(/provenance/); // the message teaches the rationale, not a backlog gap
  });

  it("inside or's UNTAKEN branch — the door is syntactic, not semantic", () => {
    const or = assertKind(first(`(or #t (set! x 1))`), "Or");
    expectDoor(or.args[1]!, "prohibited-dynamics/set!");
  });

  it("nested in a lambda body", () => {
    const fn = assertKind(first(`(define (f p) (set-cdr! p '()))`), "DefineFn");
    expectDoor(fn.body[0]!, "prohibited-dynamics/set-cdr!");
  });

  it("in VALUE position — a bare reference to a banned name doors too", () => {
    const app = assertKind(first(`(map set-car! pairs vals)`), "App");
    expectDoor(app.positionalArgs[0]!, "prohibited-dynamics/set-car!");
  });

  it("collect-all: siblings of a prohibited form classify normally", () => {
    const { forms } = cf(`(define x 1) (set! x 2) (+ x 1)`);
    expect(forms.map((f) => f.kind)).toEqual(["Define", "Door", "App"]);
  });
});

// ── door taxonomy (unsupported-form / malformed-source) ───────────────────────────

describe("coreform — door taxonomy", () => {
  it.each([
    ["`(1 ,x)", "unsupported-form/quasiquote"],
    [",x", "unsupported-form/unquote"],
    [",@xs", "unsupported-form/unquote-splicing"],
    [`(case x ((1) 'one) (else 'other))`, "unsupported-form/case"],
    [`(do ((i 0 (+ i 1))) ((= i 3)) (display i))`, "unsupported-form/do"],
    [`(lambda args args)`, "unsupported-form/variadic-lambda"], // edge #2
    [`#\\a`, "unsupported-form/char-literal"],
    [`(cond (a => f) (else b))`, "unsupported-form/cond-clause"],
    [`(dict :a 1 :b)`, "malformed-source/dict-arity"], // edge #4
    [`(dict (nested) 1)`, "malformed-source/dict-key"], // edge #5
    [`(require 42)`, "malformed-source/require-path"], // edge #6
    [`(f :a 1 2)`, "malformed-source/interleaved-args"], // edge #7
    [`(f :a)`, "malformed-source/kwarg-arity"],
    [`(let* loop ((x 1)) x)`, "malformed-source/named-let-head"], // edge #8
    [`(let ((x 1) y) x)`, "malformed-source/let-binding"],
    [`(lambda (a (b)) a)`, "malformed-source/param-list"],
    [`(lambda (. rest) 1)`, "malformed-source/param-list"], // lambda-formals need ≥1 fixed before the dot
    [`(if #t)`, "malformed-source/if-shape"],
    [`(define x)`, "malformed-source/define-shape"],
    [`(quote a b)`, "malformed-source/quote-shape"],
  ])("%s → %s", (src, code) => {
    expectDoor(first(src), code);
  });

  it("granularity is per-subform: (if <malformed-require> a b) keeps the If (spec §6)", () => {
    const f = assertKind(first(`(if (require 42) a b)`), "If");
    expectDoor(f.cond, "malformed-source/require-path");
    assertKind(f.then, "Ref");
    assertKind(f.else, "Ref");
  });

  it("doors[] pre-collects every Door id, in order", () => {
    const r = cf(`(set! x 1) (define y 2) (require 42)`);
    const walked = allNodes(r)
      .filter((n) => "kind" in n && n.kind === "Door")
      .map((n) => n.id);
    expect([...r.doors]).toEqual(walked);
    expect(r.doors).toHaveLength(2);
  });
});

// ── quoted data: the dotted-pair fold (⚖️ ruled — constitution §2.1) ─────────────

describe("coreform — dotted-quote fold at classify time", () => {
  it("'(1 . 2) classifies IDENTICAL to '(1 2)", () => {
    const dotted = assertKind(first(`'(1 . 2)`), "Quote");
    const plain = assertKind(first(`'(1 2)`), "Quote");
    expect(dotted.datum).toEqual(plain.datum);
  });

  it("'(1 2 . 3) folds the atom tail in as the last element", () => {
    const q = assertKind(first(`'(1 2 . 3)`), "Quote");
    expect(q.datum).toEqual({
      kind: "list",
      items: [
        { kind: "number", text: "1" },
        { kind: "number", text: "2" },
        { kind: "number", text: "3" },
      ],
    });
  });

  it("'(a . (b c)) splices a LIST tail — the datum IS (a b c), matching the interpreter's reader", () => {
    const spliced = assertKind(first(`'(a . (b c))`), "Quote");
    const plain = assertKind(first(`'(a b c)`), "Quote");
    expect(spliced.datum).toEqual(plain.datum);
  });

  it("QuoteDatum never contains a bare-dot item", () => {
    for (const src of [`'(1 . 2)`, `'(1 2 . 3)`, `'(a . (b . c))`, `'((1 . 2) (3 . 4))`]) {
      const q = assertKind(first(src), "Quote");
      expect(datumSymbols(q.datum)).not.toContain(".");
    }
  });

  it("malformed dots door as malformed-source/dotted-datum", () => {
    for (const src of [`'(1 . 2 3)`, `'(. 2)`, `'(1 .)`, `'.`]) {
      expectDoor(first(src), "malformed-source/dotted-datum");
    }
  });

  it("nested datum: quoted booleans/strings/numbers keep their scalar kinds", () => {
    const q = assertKind(first(`'(#t "s" 1.5 sym)`), "Quote");
    expect(q.datum).toEqual({
      kind: "list",
      items: [
        { kind: "boolean", value: true },
        { kind: "string", value: "s" },
        { kind: "number", text: "1.5" },
        { kind: "symbol", name: "sym" },
      ],
    });
  });
});

// ── desugar reaching classify: when/unless/cond land as If ────────────────────────

describe("coreform — sugar reaches If through the copied desugar", () => {
  it("(when c a b) → If with a Begin then-arm and a synthesized else", () => {
    const f = assertKind(first(`(when c 1 2)`), "If");
    expect(assertKind(f.cond, "Ref").name).toBe("c");
    const then = assertKind(f.then, "Begin");
    expect(then.body).toHaveLength(2);
    expect(assertKind(f.else, "Lit").value).toEqual({ kind: "undefined" });
  });

  it("(unless c a) → If with a (not c) condition — `not` stays an ordinary App (spec §4.1)", () => {
    const f = assertKind(first(`(unless c 1)`), "If");
    const not = assertKind(f.cond, "App");
    expect(assertKind(not.fn, "Ref").name).toBe("not");
  });

  it("(cond …) → nested If chain, else-clause as the final arm", () => {
    const f = assertKind(first(`(cond ((> x 1) 'big) ((< x 0) 'neg) (else 'mid))`), "If");
    const second = assertKind(f.else, "If");
    assertKind(second.else, "Quote");
  });

  it("cond without else → innermost If gets the synthesized undefined arm", () => {
    const f = assertKind(first(`(cond (a 1) (b 2))`), "If");
    const inner = assertKind(f.else, "If");
    expect(assertKind(inner.else, "Lit").value).toEqual({ kind: "undefined" });
  });

  it("and/or do NOT desugar — Law T's narrowing grammar needs them intact (constitution §3.2)", () => {
    const f = assertKind(first(`(if (and (pair? x) (pair? (cdr x))) 1 2)`), "If");
    assertKind(f.cond, "And");
  });
});

// ── node identity: determinism, density, pre-order ────────────────────────────────

const STABILITY_SRC = `
;; a header comment
(define (f a . rest) (+ a (length rest)))
(define/overridable temp s/number 0.7)
(let loop ((i 0) (acc '()))
  (if (= i 3) acc (loop (+ i 1) (cons i acc))))
(when (> temp 0.5) (f 1 2 3))
(dict :model "small" :retries 2)
(set! temp 0.1)
'(1 . 2)
`;

describe("coreform — node-id discipline (spec §4.2)", () => {
  it("two classifies of the same source → the same shape, ids included", () => {
    const a = cf(STABILITY_SRC);
    const b = cf(STABILITY_SRC);
    expect(a.forms).toEqual(b.forms);
    expect(a.doors).toEqual(b.doors);
    expect(a.parentOf).toEqual(b.parentOf);
    expect([...a.originAtom.keys()]).toEqual([...b.originAtom.keys()]);
  });

  it("ids are dense, 0-indexed, unique", () => {
    const r = cf(STABILITY_SRC);
    const ids = allNodes(r)
      .map((n) => n.id as number)
      .sort((x, y) => x - y);
    expect(ids).toEqual(ids.map((_, i) => i));
  });

  it("ids are minted pre-order, left-to-right, source order", () => {
    const r = cf(STABILITY_SRC);
    const inWalkOrder = allNodes(r).map((n) => n.id as number);
    expect(inWalkOrder).toEqual([...inWalkOrder].sort((x, y) => x - y));
  });

  it("every parentOf chain terminates at a root form (the side-table seam analyses key on)", () => {
    const r = cf(`(define x 1)`);
    for (const n of allNodes(r)) {
      let cur = n.id;
      let hops = 0;
      while (r.parentOf.has(cur)) {
        cur = r.parentOf.get(cur)!;
        expect(++hops).toBeLessThan(100);
      }
      expect(r.forms.some((f) => f.id === cur)).toBe(true);
    }
  });
});

// ── spans ──────────────────────────────────────────────────────────────────────────

describe("coreform — span totality (spec §4.3)", () => {
  it("every node — including synthesized fillers and desugar-minted forms — has a bounded span", () => {
    const src = `(if #t 1)\n(let ((x)) x)\n(when c 1 2)\n(cond (a 1))\n(unless c (f))`;
    const r = cf(src);
    for (const n of allNodes(r)) {
      expect(n.span).toBeDefined();
      const [s, e] = n.span;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(e).toBeGreaterThanOrEqual(s);
      expect(e).toBeLessThanOrEqual(src.length);
    }
  });

  it("lead comments carry forward verbatim as source truth (spec §4.4)", () => {
    const r = cf(`;; adds one\n(define (inc x) (+ x 1))`);
    expect(r.forms[0]!.lead).toEqual([";; adds one"]);
  });
});

// ── side tables ────────────────────────────────────────────────────────────────────

describe("coreform — side tables", () => {
  it("originAtom covers every name-bearing site with the ORIGINAL parse atom", () => {
    const r = cf(`(define (f a . rest) (let loop ((x a)) (g x)))`);
    const fn = assertKind(r.forms[0]!, "DefineFn");
    expect(r.originAtom.get(fn.id)?.atom).toBe("f");
    for (const p of fn.params) expect(r.originAtom.get(p.id)?.atom).toBe(p.name);
    const loop = assertKind(fn.body[0]!, "NamedLet");
    expect(r.originAtom.get(loop.id)?.atom).toBe("loop");
    expect(r.originAtom.get(loop.bindings[0]!.id)?.atom).toBe("x");
    for (const n of allNodes(r))
      if ("kind" in n && n.kind === "Ref") expect(r.originAtom.get(n.id)?.atom).toBe(n.name);
  });

  it("parentOf links every child to its structural parent", () => {
    const r = cf(`(if (f x) 1 2)`);
    const iff = assertKind(r.forms[0]!, "If");
    const app = assertKind(iff.cond, "App");
    expect(r.parentOf.get(app.id)).toBe(iff.id);
    expect(r.parentOf.get(app.fn.id)).toBe(app.id);
    expect(r.parentOf.has(iff.id)).toBe(false); // roots have no parent
  });
});

// ── datum labels: the compile-front door (constitution §2.2) ──────────────────────

describe("coreform — reader datum labels", () => {
  it("the copied parser cannot produce a datum-label CONSTRUCT — `#0=(…)` tokenizes as a stray atom + a separate list", () => {
    const forest = parseSexprs(`#0=(1 2)`);
    expect(forest).toHaveLength(2);
    expect(forest[0]).toMatchObject({ atom: "#0=" });
    expect(forest[1] !== undefined && "list" in forest[1]!).toBe(true);
  });

  it("…and the stray label atoms door as unsupported-form/datum-label (the compile-front check)", () => {
    const { forms } = cf(`#0=(1 2)`);
    expectDoor(forms[0]!, "unsupported-form/datum-label");
    expectDoor(first(`'(a . #0#)`), "unsupported-form/datum-label");
  });
});
