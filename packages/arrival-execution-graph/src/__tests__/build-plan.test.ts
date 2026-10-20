import { disposeRunContext, execState, LexicalScope, parse } from "@here.build/arrival";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPlan } from "../build-plan.js";
import type { Plan, PlanItem, Vocabulary } from "../plan.js";

// Designated symbols are program-defined leaves unless a case says otherwise.
const ASK = `(define (ask p) (string-append "A:" p))`;
const FETCH = `(define (fetch u) (string-append "F:" u))`;
const PRED = `(define (pred s) (> (string-length s) 2))`;
const PRELUDE = `${ASK}\n${FETCH}\n${PRED}\n`;

let vocabulary: Vocabulary;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const state = await execState("(begin)", { scope: LexicalScope.fresh("t") });
  if (!state.runCtx.vocabulary) throw new Error("execState returned no vocabulary");
  vocabulary = state.runCtx.vocabulary;
  dispose = () => disposeRunContext(state.runCtx);
});
afterAll(async () => dispose());

/** Plan for `src` (prefixed with the ask/fetch/pred defines, 3 lines) over `symbols`. */
async function plan(src: string, symbols = ["ask", "fetch", "pred"], prelude = PRELUDE): Promise<Plan> {
  const forms = await parse(prelude + src);
  return buildPlan({ forms, symbols: new Set(symbols), vocabulary });
}

/** Compact tree: frames with their attributes, steps with symbol/args/via. */
function shape(p: Plan): string {
  const lines: string[] = [];
  const attrs = (o: Record<string, unknown>): string =>
    Object.entries(o)
      .filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.map((x) => x ?? "-").join(" ")}]` : String(v)}`)
      .join(" ");
  const visit = (item: PlanItem, depth: number): void => {
    const pad = "  ".repeat(depth);
    if (item.kind === "step") {
      const args = item.args.map((a) => (a.slot.startsWith("arg") ? a.source : `${a.slot} ${a.source}`)).join(", ");
      lines.push(`${pad}step ${item.key} ${item.symbol}(${args})${item.via ? ` via=${item.via}` : ""}`);
      return;
    }
    const a = attrs({
      symbol: item.symbol,
      host: item.host,
      params: [...item.params],
      roots: [...item.bodyRoots],
      tests: item.armTests ? [...item.armTests] : undefined,
      recur: item.recurSpans ? [...item.recurSpans] : undefined,
      marker: item.iterationMarker,
      tail: item.tail,
      recursive: item.recursive,
    });
    lines.push(`${pad}${item.frame} ${item.key} "${item.label}"${a ? ` ${a}` : ""}`);
    for (const c of item.children) visit(c, depth + 1);
  };
  for (const c of p.root.children) visit(c, 0);
  if (p.diagnostics.length > 0) lines.push(...p.diagnostics.map((d) => `! ${d}`));
  return `\n${lines.join("\n")}\n`;
}

describe("buildPlan — sequencing", () => {
  it("top-level value defines and their use, map with a lambda", async () => {
    const p = await plan(`(define plan (ask "make a plan"))
(define steps (map (lambda (s) (ask s)) (list plan "b")))
(fetch (car steps))`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      step ask@4:13 ask("make a plan")
      par map@5:14 "map" host=map params=[s] roots=[ask@5:31]
        step ask@5:31 ask(s)
      step fetch@6:0 fetch((car steps))
      "
    `);
    expect(p.edges).toEqual([]);
    expect(p.root.key).toBe("<program>");
  });

  it("nested calls: operands before the call", async () => {
    expect(shape(await plan(`(ask (fetch "x"))`))).toMatchInlineSnapshot(`
      "
      step fetch@4:5 fetch("x")
      step ask@4:0 ask((fetch "x"))
      "
    `);
  });

  it("let* in order, begin in order", async () => {
    expect(shape(await plan(`(let* ((a (ask "1")) (b (fetch a))) (ask b))\n(begin (fetch "a") (ask "b"))`)))
      .toMatchInlineSnapshot(`
      "
      step ask@4:10 ask("1")
      step fetch@4:24 fetch(a)
      step ask@4:36 ask(b)
      step fetch@5:7 fetch("a")
      step ask@5:19 ask("b")
      "
    `);
  });

  it("bracket bindings and collection literals walk their element forms", async () => {
    const p = await plan(`(let* [a (ask "1") b (fetch a)] a)\n(define d {:a (ask "k") :b [(fetch "j") 2]})`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      step ask@4:9 ask("1")
      step fetch@4:21 fetch(a)
      step ask@5:14 ask("k")
      step fetch@5:28 fetch("j")
      "
    `);
  });

  it("quasiquote walks only unquotes; quote walks nothing", async () => {
    expect(shape(await plan('`(ask ,(ask "x") ,@(list (fetch "y")))\n\'(ask "q")'))).toMatchInlineSnapshot(`
      "
      step ask@4:7 ask("x")
      step fetch@4:25 fetch("y")
      "
    `);
  });

  it("keyword arguments get keyword slots", async () => {
    const p = await plan(`(fetch :url "u" :n 2)`, ["fetch"], "");
    const step = p.root.children[0];
    expect(step?.kind === "step" && step.args).toEqual([
      { slot: ":url", source: '"u"' },
      { slot: ":n", source: "2" },
    ]);
  });
});

describe("buildPlan — callees", () => {
  it("map: lambda, bare designated symbol, program-define callback", async () => {
    const p = await plan(`(map (lambda (s) (ask s)) (list "a"))
(map ask (list "e1" "e2"))
(define (helper x) (ask x))
(map helper (list (helper "a") "b"))`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      par map@4:0 "map" host=map params=[s] roots=[ask@4:17]
        step ask@4:17 ask(s)
      par map@5:0 "map ask" host=map params=[p]
        step map@5:0#arg0 ask() via=callback
      call helper@7:18 "helper" params=[x] roots=[ask@6:19]
        step helper@7:18▸ask@6:19 ask(x)
      par map@7:0 "map helper" host=map params=[x] roots=[ask@6:19]
        step map@7:0▸ask@6:19 ask(x)
      "
    `);
  });

  it("no phantom steps from cdr cells (F21)", async () => {
    const p = await plan(`(map ask (list "e1" "e2"))\n(list "x" ask)`, ["ask"]);
    expect([...p.bySpan.keys()].filter((s) => s.startsWith("ask@"))).toEqual([]);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      par map@4:0 "map ask" host=map params=[p]
        step map@4:0#arg0 ask() via=callback
      ! \`ask\` passed as a value to \`list\` — not called here
      "
    `);
  });

  it("host contract decides: a lambda position is a callback, a value position is not called", async () => {
    const p = await plan(
      `(list "x" ask)\n(filter-map ask (list "e1"))\n(sort (list "b" "a") (lambda (a b) (pred a)))`,
      ["ask", "pred"],
    );
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      callback filter-map@5:0 "filter-map ask" host=filter-map params=[p]
        step filter-map@5:0#arg0 ask() via=callback
      callback sort@6:0 "sort" host=sort params=[a b] roots=[pred@6:35]
        step pred@6:35 pred(a)
      ! \`ask\` passed as a value to \`list\` — not called here
      "
    `);
  });

  it("recursion through a callback position is a stub inside the par", async () => {
    const p = await plan(`(define (walk t) (if (pair? t) (map walk t) (ask t)))\n(walk (list "a" "b"))`, ["ask"]);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      call walk@5:0 "walk" params=[t] roots=[if@4:17]
        branch walk@5:0▸if@4:17 "if" roots=[map@4:31 ask@4:44]
          arm walk@5:0▸if@4:17#0 "then" roots=[map@4:31]
            par walk@5:0▸map@4:31 "map walk" host=map params=[t] roots=[if@4:17]
              call walk@5:0▸map@4:31▸map@4:31#arg0 "walk" params=[t] roots=[if@4:17] recursive=true
          arm walk@5:0▸if@4:17#1 "else" roots=[ask@4:44]
            step walk@5:0▸ask@4:44 ask(t)
      "
    `);
  });

  it("filter is a par (control), for-each a par (effect), any a callback frame (undeclared)", async () => {
    expect(
      shape(
        await plan(
          `(filter (lambda (s) (pred s)) (list "e1"))\n(for-each (lambda (s) (ask s)) (list "e1"))\n(any (lambda (s) (ask s)) (list "e1"))`,
        ),
      ),
    ).toMatchInlineSnapshot(`
        "
        par filter@4:0 "filter" host=filter params=[s] roots=[pred@4:20]
          step pred@4:20 pred(s)
        par for-each@5:0 "for-each" host=for-each params=[s] roots=[ask@5:22]
          step ask@5:22 ask(s)
        callback any@6:0 "any" host=any params=[s] roots=[ask@6:17]
          step ask@6:17 ask(s)
        "
      `);
  });

  it("reduce: accumulator callback → loop", async () => {
    expect(shape(await plan(`(reduce (lambda (x acc) (ask (string-append acc x))) "" (list "r1" "r2"))`)))
      .toMatchInlineSnapshot(`
      "
      loop reduce@4:0 "reduce" host=reduce params=[x acc] roots=[ask@4:24]
        step ask@4:24 ask((string-append acc x))
      "
    `);
  });

  it("apply with a designated symbol and with a reaching define", async () => {
    const p = await plan(`(define (helper x) (ask x))
(string-append (apply ask (list "x")) (apply helper (list "y")))`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      step apply@5:15 ask((list "x")) via=apply
      call apply@5:38 "helper" params=[x] roots=[ask@4:19]
        step apply@5:38▸ask@4:19 ask(x)
      "
    `);
  });

  it("alias through let, user HOF formal, IIFE", async () => {
    const p = await plan(`(let ((g ask)) (g "x"))
(define (twice f x) (f (f x)))
(twice fetch "y")
((lambda (x) (ask x)) "v")`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      step g@4:15 ask("x")
      call twice@6:0 "twice" params=[f x] roots=[f@5:20]
        step twice@6:0▸f@5:23 fetch(x)
        step twice@6:0▸f@5:20 fetch((f x))
      call ?@7:0 "λ" params=[x] roots=[ask@7:13]
        step ?@7:0▸ask@7:13 ask(x)
      "
    `);
  });

  it("shadowing: a lambda param or local named like a symbol is not designated", async () => {
    const p = await plan(`(map (lambda (ask) (ask "y")) (list string-upcase))
(let ((ask (lambda (x) (string-append "local:" x)))) (ask "y"))`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "

      "
    `);
  });

  it("internal defines, forward references allowed", async () => {
    const p = await plan(`(define (f x)
  (define (g y) (h y))
  (define (h y) (ask y))
  (g (g x)))
(f "q")`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      call f@8:0 "f" params=[x] roots=[define@5:2 define@6:2 g@7:2]
        call f@8:0▸g@7:5 "g" params=[y] roots=[h@5:16]
          call f@8:0▸g@7:5▸h@5:16 "h" params=[y] roots=[ask@6:16]
            step f@8:0▸g@7:5▸h@5:16▸ask@6:16 ask(y)
        call f@8:0▸g@7:2 "g" params=[y] roots=[h@5:16]
          call f@8:0▸g@7:2▸h@5:16 "h" params=[y] roots=[ask@6:16]
            step f@8:0▸g@7:2▸h@5:16▸ask@6:16 ask(y)
      "
    `);
  });

  it("late binding: a redefinition wins for calls walked after it (F16)", async () => {
    const p = await plan(`(define (g x) (ask x))
(define (h x) (g x))
(h "early")
(define (g x) (fetch x))
(h "late")`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      call h@6:0 "h" params=[x] roots=[g@5:14]
        call h@6:0▸g@5:14 "g" params=[x] roots=[ask@4:14]
          step h@6:0▸g@5:14▸ask@4:14 ask(x)
      call h@8:0 "h" params=[x] roots=[g@5:14]
        call h@8:0▸g@5:14 "g" params=[x] roots=[fetch@7:14]
          step h@8:0▸g@5:14▸fetch@7:14 fetch(x)
      "
    `);
  });

  it("designated function: with a designated interior → call frame + symbol; without → step", async () => {
    const p = await plan(`(define (helper x) (ask x))\n(helper "q")\n(ask "z")`, ["helper", "ask"]);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      call helper@5:0 "helper" symbol=helper params=[x] roots=[ask@4:19]
        step helper@5:0▸ask@4:19 ask(x)
      step ask@6:0 ask("z")
      "
    `);
  });

  it("a call reaching a step only inside a dict literal value is inlined", async () => {
    const p = await plan(`(define (wrap x) {:answer (ask x)})\n(wrap "q")`, ["ask"]);
    const [call] = p.root.children;
    expect(call?.kind === "frame" && call.frame).toBe("call");
    expect(call?.kind === "frame" && call.children.map((c) => c.kind === "step" && c.symbol)).toEqual(["ask"]);
  });

  it("scope-bound closures are opaque; designated by name", async () => {
    const scope = LexicalScope.fresh("s");
    const state = await execState(`(define (remote p) (string-append "R:" p))`, { scope });
    await disposeRunContext(state.runCtx);
    const forms = await parse(`(remote (string-upcase "x"))`);
    const p = buildPlan({ forms, symbols: new Set(["remote"]), vocabulary, scope });
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      step remote@1:0 remote((string-upcase "x"))
      "
    `);
  });
});

describe("buildPlan — loops and recursion", () => {
  it("named let, tail", async () => {
    expect(
      shape(
        await plan(`(let loop ((i 0) (acc ""))\n  (if (< i 2)\n      (loop (+ i 1) (ask acc))\n      (fetch acc)))`),
      ),
    ).toMatchInlineSnapshot(`
      "
      loop let@4:0 "loop" params=[i acc] roots=[if@5:2] recur=[loop@6:6] tail=true
        branch if@5:2 "if" roots=[loop@6:6 fetch@7:6]
          arm if@5:2#0 "then" roots=[loop@6:6]
            step ask@6:20 ask(acc)
          arm if@5:2#1 "else" roots=[fetch@7:6]
            step fetch@7:6 fetch(acc)
      "
    `);
  });

  it("named let, non-tail", async () => {
    expect(
      shape(await plan(`(let loop ((i 0))\n  (if (< i 2)\n      (string-append (ask "x") (loop (+ i 1)))\n      ""))`)),
    ).toMatchInlineSnapshot(`
      "
      call let@4:0 "loop" params=[i] roots=[if@5:2]
        branch if@5:2 "if" roots=[string-append@6:6]
          arm if@5:2#0 "then" roots=[string-append@6:6]
            step ask@6:21 ask("x")
            call loop@6:31 "loop" params=[i] roots=[if@5:2] recursive=true
          arm if@5:2#1 "else"
      "
    `);
  });

  it("do: flat iteration, results after the loop", async () => {
    expect(
      shape(
        await plan(`(do ((i 0 (+ i 1)) (acc "" (ask acc)))\n    ((= i 2) (fetch acc))\n  (fetch (number->string i)))`),
      ),
    ).toMatchInlineSnapshot(`
      "
      loop do@4:0 "do" params=[i acc] roots=[=@5:5 fetch@6:2 +@4:10 ask@4:27] marker==@5:5
        step fetch@6:2 fetch((number->string i))
        step ask@4:27 ask(acc)
      step fetch@5:13 fetch(acc)
      "
    `);
  });

  it("while", async () => {
    expect(shape(await plan(`(while (pred "go") (ask "body"))`))).toMatchInlineSnapshot(`
      "
      loop while@4:0 "while" roots=[pred@4:7 ask@4:19] marker=pred@4:7
        step pred@4:7 pred("go")
        step ask@4:19 ask("body")
      "
    `);
  });

  it("self tail recursion → loop", async () => {
    expect(
      shape(await plan(`(define (walk n acc)\n  (if (= n 0) (fetch acc) (walk (- n 1) (ask acc))))\n(walk 2 "s")`)),
    ).toMatchInlineSnapshot(`
      "
      loop walk@6:0 "walk" params=[n acc] roots=[if@5:2] recur=[walk@5:26] tail=true
        branch walk@6:0▸if@5:2 "if" roots=[fetch@5:14 walk@5:26]
          arm walk@6:0▸if@5:2#0 "then" roots=[fetch@5:14]
            step walk@6:0▸fetch@5:14 fetch(acc)
          arm walk@6:0▸if@5:2#1 "else" roots=[walk@5:26]
            step walk@6:0▸ask@5:40 ask(acc)
      "
    `);
  });

  it("non-tail recursion → collapsed stub", async () => {
    expect(
      shape(
        await plan(`(define (deep n)\n  (if (= n 0) (fetch "z") (string-append (ask "x") (deep (- n 1)))))\n(deep 2)`),
      ),
    ).toMatchInlineSnapshot(`
      "
      call deep@6:0 "deep" params=[n] roots=[if@5:2]
        branch deep@6:0▸if@5:2 "if" roots=[fetch@5:14 string-append@5:26]
          arm deep@6:0▸if@5:2#0 "then" roots=[fetch@5:14]
            step deep@6:0▸fetch@5:14 fetch("z")
          arm deep@6:0▸if@5:2#1 "else" roots=[string-append@5:26]
            step deep@6:0▸ask@5:41 ask("x")
            call deep@6:0▸deep@5:51 "deep" params=[n] roots=[if@5:2] recursive=true
      "
    `);
  });

  it("mutual recursion → the outer call becomes the loop", async () => {
    expect(
      shape(
        await plan(`(define (ping n acc) (if (= n 0) acc (pong (- n 1) (ask acc))))
(define (pong n acc) (ping n (fetch acc)))
(ping 2 "s")`),
      ),
    ).toMatchInlineSnapshot(`
      "
      loop ping@6:0 "ping" params=[n acc] roots=[if@4:21] recur=[ping@5:21] tail=true
        branch ping@6:0▸if@4:21 "if" roots=[pong@4:37]
          arm ping@6:0▸if@4:21#0 "then"
          arm ping@6:0▸if@4:21#1 "else" roots=[pong@4:37]
            step ping@6:0▸ask@4:51 ask(acc)
            call ping@6:0▸pong@4:37 "pong" params=[n acc] roots=[ping@5:21]
              step ping@6:0▸pong@4:37▸fetch@5:29 fetch(acc)
      "
    `);
  });
});

describe("buildPlan — branches", () => {
  it("if with designated arms, and with an implicit empty else", async () => {
    expect(shape(await plan(`(if (pred "y") (ask "yes") (fetch "no"))\n(if (pred "n") (ask "only"))`)))
      .toMatchInlineSnapshot(`
      "
      step pred@4:4 pred("y")
      branch if@4:0 "if" roots=[ask@4:15 fetch@4:27]
        arm if@4:0#0 "then" roots=[ask@4:15]
          step ask@4:15 ask("yes")
        arm if@4:0#1 "else" roots=[fetch@4:27]
          step fetch@4:27 fetch("no")
      step pred@5:4 pred("n")
      branch if@5:0 "if" roots=[ask@5:15]
        arm if@5:0#0 "then" roots=[ask@5:15]
          step ask@5:15 ask("only")
        arm if@5:0#1 "else"
      "
    `);
  });

  it("designated only in the selector: no branch frame", async () => {
    expect(shape(await plan(`(if (string=? (fetch "u") "ok") "yes" "no")`))).toMatchInlineSnapshot(`
      "
      step fetch@4:14 fetch("u")
      "
    `);
  });

  it("when / unless", async () => {
    expect(shape(await plan(`(when (pred "n") (ask "w"))\n(unless (pred "n") (fetch "u"))`))).toMatchInlineSnapshot(`
      "
      step pred@4:6 pred("n")
      branch when@4:0 "when" roots=[ask@4:17]
        arm when@4:0#0 "then" roots=[ask@4:17]
          step ask@4:17 ask("w")
        arm when@4:0#1 "else"
      step pred@5:8 pred("n")
      branch unless@5:0 "unless" roots=[fetch@5:19]
        arm unless@5:0#0 "then"
        arm unless@5:0#1 "else" roots=[fetch@5:19]
          step fetch@5:19 fetch("u")
      "
    `);
  });

  it("cond: one branch, later tests inside their arms, => with a designated proc", async () => {
    const p = await plan(`(cond ((pred "n") (ask "one"))
      ((pred "y") (ask "two"))
      (else (ask "three")))
(cond ((fetch "k") => ask))`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      step pred@4:7 pred("n")
      branch cond@4:0 "cond" roots=[ask@4:18 pred@5:7 ask@5:18 ask@6:12] tests=[pred@4:7 pred@5:7 -]
        arm cond@4:0#0 "(pred "n")" roots=[ask@4:18]
          step ask@4:18 ask("one")
        arm cond@4:0#1 "(pred "y")" roots=[ask@5:18]
          step pred@5:7 pred("y")
          step ask@5:18 ask("two")
        arm cond@4:0#2 "else" roots=[ask@6:12]
          step ask@6:12 ask("three")
      step fetch@7:7 fetch("k")
      branch cond@7:0 "cond" tests=[fetch@7:7 -]
        arm cond@7:0#0 "(fetch "k")"
          step cond@7:0#clause0 ask() via=callback
        arm cond@7:0#1 "else"
      "
    `);
  });

  it("case", async () => {
    expect(shape(await plan(`(case (string-length (ask "k"))\n  ((3) (fetch "three"))\n  (else (fetch "other")))`)))
      .toMatchInlineSnapshot(`
      "
      step ask@4:21 ask("k")
      branch case@4:0 "case" roots=[fetch@5:7 fetch@6:8]
        arm case@4:0#0 "(3)" roots=[fetch@5:7]
          step fetch@5:7 fetch("three")
        arm case@4:0#1 "else" roots=[fetch@6:8]
          step fetch@6:8 fetch("other")
      "
    `);
  });

  it("and / or: a seq only when an operand after the first reaches a step", async () => {
    expect(shape(await plan(`(and (pred "n") (string? "x"))`))).toMatchInlineSnapshot(`
      "
      step pred@4:5 pred("n")
      "
    `);
  });

  it("and / or", async () => {
    expect(shape(await plan(`(or (pred "n") (and (pred "y") (ask "both")))`))).toMatchInlineSnapshot(`
      "
      seq or@4:0 "or" roots=[pred@4:4 and@4:15]
        step pred@4:4 pred("n")
        seq and@4:15 "and" roots=[pred@4:20 ask@4:31]
          step pred@4:20 pred("y")
          step ask@4:31 ask("both")
      "
    `);
  });

  it("guard and try: body seq + on-raise branch", async () => {
    const p = await plan(`(guard (e (#t (fetch "recovered")))
  (ask "first")
  (ask "second"))
(try (begin (ask "a") (ask "b"))
  (catch (e) (fetch "recovered")))`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      seq guard@4:0 "guard" roots=[ask@5:2 ask@6:2 fetch@4:14]
        step ask@5:2 ask("first")
        step ask@6:2 ask("second")
        branch guard@4:0/raise "on raise" roots=[fetch@4:14]
          arm guard@4:0/raise#0 "handler" roots=[fetch@4:14]
            step fetch@4:14 fetch("recovered")
      seq try@7:0 "try" roots=[begin@7:5 fetch@8:13]
        step ask@7:12 ask("a")
        step ask@7:22 ask("b")
        branch try@7:0/raise "on raise" roots=[fetch@8:13]
          arm try@7:0/raise#0 "handler" roots=[fetch@8:13]
            step fetch@8:13 fetch("recovered")
      "
    `);
  });

  it("a catch-all clause (`#t` / `else`) is exhaustive; a guard's only else is its clause chain's re-raise", async () => {
    const p = await plan(`(cond ((pred "n") (ask "one")) (#t (ask "two")) ((pred "late") (ask "never")))
(guard (e ((pred "x") (fetch "a")) (#t (fetch "b"))) (ask "body"))
(guard (e ((pred "x") (fetch "a"))) (ask "body"))`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      step pred@4:7 pred("n")
      branch cond@4:0 "cond" roots=[ask@4:18 ask@4:35] tests=[pred@4:7 -]
        arm cond@4:0#0 "(pred "n")" roots=[ask@4:18]
          step ask@4:18 ask("one")
        arm cond@4:0#1 "#t" roots=[ask@4:35]
          step ask@4:35 ask("two")
      seq guard@5:0 "guard" roots=[ask@5:53 pred@5:11 fetch@5:22 fetch@5:39]
        step ask@5:53 ask("body")
        branch guard@5:0/raise "on raise" roots=[pred@5:11 fetch@5:22 fetch@5:39]
          arm guard@5:0/raise#0 "handler" roots=[pred@5:11 fetch@5:22 fetch@5:39]
            step pred@5:11 pred("x")
            branch guard@5:0/handler "guard clauses" roots=[fetch@5:22 fetch@5:39] tests=[pred@5:11 -]
              arm guard@5:0/handler#0 "(pred "x")" roots=[fetch@5:22]
                step fetch@5:22 fetch("a")
              arm guard@5:0/handler#1 "#t" roots=[fetch@5:39]
                step fetch@5:39 fetch("b")
      seq guard@6:0 "guard" roots=[ask@6:36 pred@6:11 fetch@6:22]
        step ask@6:36 ask("body")
        branch guard@6:0/raise "on raise" roots=[pred@6:11 fetch@6:22]
          arm guard@6:0/raise#0 "handler" roots=[pred@6:11 fetch@6:22]
            step pred@6:11 pred("x")
            branch guard@6:0/handler "guard clauses" roots=[fetch@6:22] tests=[pred@6:11 -]
              arm guard@6:0/handler#0 "(pred "x")" roots=[fetch@6:22]
                step fetch@6:22 fetch("a")
              arm guard@6:0/handler#1 "else · re-raise"
      "
    `);
  });

  it("steps inside untracked macro uses are hosted by the macro (via=macro), except in named bodies", async () => {
    const p = await plan(`(-> "q" (ask) (string-append "!") (fetch))
(->> (list "a") (map (lambda (s) (ask s))))
(define (helper x) (ask x))
(-> "q" (helper))
(and-let* ((x (ask "a"))) (fetch x))`);
    expect(shape(p)).toMatchInlineSnapshot(`
      "
      step ask@4:8 ask() via=macro
      step fetch@4:34 fetch() via=macro
      par map@5:16 "map" host=map params=[s] roots=[ask@5:33]
        step ask@5:33 ask(s) via=macro
      call helper@7:8 "helper" params=[x] roots=[ask@6:19]
        step helper@7:8▸ask@6:19 ask(x)
      step ask@8:14 ask("a")
      step fetch@8:26 fetch(x)
      ! "->" at ->@4:0 is a macro the plan does not expand; its operands were walked as plain expressions in order, and their steps take the macro invocation's state
      ! "->>" at ->>@5:0 is a macro the plan does not expand; its operands were walked as plain expressions in order, and their steps take the macro invocation's state
      ! "->" at ->@7:0 is a macro the plan does not expand; its operands were walked as plain expressions in order, and their steps take the macro invocation's state
      ! "and-let*" at and-let*@8:0 is a macro the plan does not expand; its operands were walked as plain expressions in order
      "
    `);
  });

  it("cut in a callback position is the callback itself", async () => {
    expect(shape(await plan(`(map (cut ask <>) (list "a" "b"))`))).toMatchInlineSnapshot(`
      "
      par map@4:0 "map ask" host=map params=[p]
        step map@4:0#arg0 ask() via=callback
      "
    `);
  });

  it("unexpanded macros are walked conservatively, with a diagnostic", async () => {
    expect(shape(await plan(`(-> "q" (ask) (string-append "!") (fetch))`))).toMatchInlineSnapshot(`
      "
      step ask@4:8 ask() via=macro
      step fetch@4:34 fetch() via=macro
      ! "->" at ->@4:0 is a macro the plan does not expand; its operands were walked as plain expressions in order, and their steps take the macro invocation's state
      "
    `);
  });
});

describe("buildPlan — indexes", () => {
  it("byKey and bySpan cover every item; a define inlined twice has two keys per element", async () => {
    const p = await plan(`(define (helper x) (ask (string-append x "!")))
(define a (helper "1"))
(helper a)`);
    const keys: string[] = [];
    const visit = (i: PlanItem): void => {
      keys.push(i.key);
      if (i.kind === "frame") i.children.forEach(visit);
    };
    visit(p.root);
    expect([...p.byKey.keys()].toSorted()).toEqual(keys.toSorted());
    expect(p.bySpan.get("ask@4:19")).toEqual(["helper@5:10▸ask@4:19", "helper@6:0▸ask@4:19"]);
    expect(p.diagnostics).toEqual([]);
  });
});
