import { disposeRunContext, execState, LexicalScope, parse } from "@here.build/arrival";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPlan } from "../build-plan.js";
import { attachDataflow, wireForm } from "../dataflow.js";
import type { Plan, Vocabulary } from "../plan.js";

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

/** Skeleton + dataflow for `src` (after the 3-line ask/fetch/pred prelude). */
async function joined(src: string, symbols = ["ask", "fetch", "pred"]): Promise<Plan> {
  const forms = await parse(PRELUDE + src);
  const input = { forms, symbols: new Set(symbols), vocabulary };
  return attachDataflow(buildPlan(input), input);
}

/** `from.key:port -> to.key:port [kind]`, then the join's diagnostics. */
function edges(p: Plan): string {
  const lines = p.edges.map(
    (e) => `${e.from.key}:${e.from.port} -> ${e.to.key}:${e.to.port}${e.kind === "data" ? "" : ` [${e.kind}]`}`,
  );
  lines.push(...p.diagnostics.map((d) => `! ${d}`));
  return `\n${lines.join("\n")}\n`;
}

const droppedOf = (p: Plan): number => {
  const line = p.diagnostics.find((d) => d.startsWith("dataflow: "));
  return Number(/dropped (\d+)/.exec(line ?? "")?.[1] ?? Number.NaN);
};

describe("attachDataflow — straight-line", () => {
  it("let*-chained steps", async () => {
    expect(edges(await joined(`(let* ((a (ask "1")) (b (fetch a))) (ask b))`))).toMatchInlineSnapshot(`
      "
      ask@4:10:out -> fetch@4:24:in:arg0
      fetch@4:24:out -> ask@4:36:in:arg0
      ask@4:36:out -> <program>:out
      ! dataflow: 4 wires, 3 edges, dropped 0, dead-binding 3, 0 steps without a node
      "
    `);
  });

  it("dataflow status: complete when nothing was dropped", async () => {
    expect((await joined(`(let* ((a (ask "1")) (b (fetch a))) (ask b))`)).dataflow).toEqual({
      status: "complete",
      missing: 0,
    });
  });

  it("a re-wrapped binding the wire body never uses contributes no edge", async () => {
    expect(edges(await joined(`(let* ((a (ask "x")) (b (fetch "y"))) (ask b))`))).toMatchInlineSnapshot(`
      "
      fetch@4:24:out -> ask@4:38:in:arg0
      ask@4:38:out -> <program>:out
      ! dataflow: 4 wires, 2 edges, dropped 0, dead-binding 4, 0 steps without a node
      "
    `);
  });

  it("a binding the next binding reads stays live", async () => {
    expect(edges(await joined(`(let* ((a (ask "x")) (b (fetch a))) b)`))).toMatchInlineSnapshot(`
      "
      ask@4:10:out -> fetch@4:24:in:arg0
      fetch@4:24:out -> <program>:out
      ! dataflow: 3 wires, 2 edges, dropped 0, dead-binding 1, 0 steps without a node
      "
    `);
  });

  it("let is parallel: a shadowed outer name stays live through the rhs", async () => {
    expect(edges(await joined(`(let ((a (ask "x"))) (let ((a (fetch a)) (b (ask "unused"))) (ask a)))`)))
      .toMatchInlineSnapshot(`
      "
      ask@4:9:out -> fetch@4:30:in:arg0
      fetch@4:30:out -> ask@4:61:in:arg0
      ask@4:61:out -> <program>:out
      ! dataflow: 5 wires, 3 edges, dropped 0, dead-binding 6, 0 steps without a node
      "
    `);
  });

  it("nested calls", async () => {
    expect(edges(await joined(`(ask (fetch (ask "x")))`))).toMatchInlineSnapshot(`
      "
      ask@4:12:out -> fetch@4:5:in:arg0
      fetch@4:5:out -> ask@4:0:in:arg0
      ask@4:0:out -> <program>:out
      ! dataflow: 4 wires, 3 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
  });
});

describe("attachDataflow — fans", () => {
  it("map with a lambda: collection → par in:s → step → par out → consumer", async () => {
    expect(edges(await joined(`(let ((xs (list (ask "a") "b"))) (fetch (car (map (lambda (s) (ask s)) xs))))`)))
      .toMatchInlineSnapshot(`
        "
        ask@4:16:out -> map@4:45:in:s
        map@4:45:out -> fetch@4:33:in:arg0
        fetch@4:33:out -> <program>:out
        map@4:45:in:s -> ask@4:62:in:arg0
        ask@4:62:out -> map@4:45:out
        ! dataflow: 6 wires, 5 edges, dropped 0, dead-binding 2, 0 steps without a node
        "
      `);
  });

  it("filter: the template egress is the par's control", async () => {
    expect(edges(await joined(`(fetch (car (filter (lambda (s) (pred s)) (list (ask "a")))))`))).toMatchInlineSnapshot(`
      "
      ask@4:48:out -> filter@4:12:in:s
      filter@4:12:out -> fetch@4:0:in:arg0
      fetch@4:0:out -> <program>:out
      filter@4:12:in:s -> pred@4:32:in:arg0
      pred@4:32:out -> filter@4:12:control [control]
      ! dataflow: 6 wires, 5 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
  });

  it("map over a designated symbol and over a program define", async () => {
    expect(
      edges(
        await joined(
          `(define (helper x) (ask (string-append x "!")))\n(ask (car (map helper (list (fetch "a")))))\n(map fetch (list "b"))`,
        ),
      ),
    ).toMatchInlineSnapshot(`
      "
      map@6:0:in:u -> map@6:0#arg0:in:arg0
      map@6:0#arg0:out -> map@6:0:out
      fetch@5:28:out -> map@5:10:in:x
      map@5:10:out -> ask@5:0:in:arg0
      map@6:0:out -> <program>:out
      map@5:10:in:x -> map@5:10▸ask@4:19:in:arg0
      map@5:10▸ask@4:19:out -> map@5:10:out
      ! dataflow: 9 wires, 7 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
  });
});

describe("attachDataflow — loops and calls", () => {
  it("named let: initials → params, recur edges, loop out", async () => {
    expect(
      edges(await joined(`(fetch (let loop ((i 0) (acc (ask "seed"))) (if (< i 3) (loop (+ i 1) (ask acc)) acc)))`)),
    ).toMatchInlineSnapshot(`
      "
      ask@4:29:out -> let@4:7:in:acc
      let@4:7:out -> fetch@4:0:in:arg0
      fetch@4:0:out -> <program>:out
      let@4:7:in:i -> let@4:7:in:i [recur]
      let@4:7:in:acc -> ask@4:70:in:arg0
      ask@4:70:out -> let@4:7:in:acc [recur]
      let@4:7:in:i -> if@4:44:control [control]
      let@4:7:in:acc -> if@4:44:out
      if@4:44:out -> let@4:7:out
      ! dataflow: 12 wires, 9 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
  });

  it("do", async () => {
    expect(edges(await joined(`(do ((i 0 (+ i 1)) (acc (fetch "s") (ask acc))) ((= i 3) acc))`)))
      .toMatchInlineSnapshot(`
        "
        fetch@4:24:out -> do@4:0:in:acc
        do@4:0:out -> <program>:out
        do@4:0:in:i -> do@4:0:in:i [recur]
        do@4:0:in:acc -> ask@4:36:in:arg0
        ask@4:36:out -> do@4:0:in:acc [recur]
        ! dataflow: 8 wires, 5 edges, dropped 0, dead-binding 1, 0 steps without a node
        "
      `);
  });

  it("call frame: actuals → formals, interior, out", async () => {
    expect(edges(await joined(`(define (helper x) (ask (string-append x "!")))\n(fetch (helper (fetch "a")))`)))
      .toMatchInlineSnapshot(`
        "
        fetch@5:15:out -> helper@5:7:in:x
        helper@5:7:out -> fetch@5:0:in:arg0
        fetch@5:0:out -> <program>:out
        helper@5:7:in:x -> helper@5:7▸ask@4:19:in:arg0
        helper@5:7▸ask@4:19:out -> helper@5:7:out
        ! dataflow: 6 wires, 5 edges, dropped 0, dead-binding 0, 0 steps without a node
        "
      `);
  });

  it("tail recursion: recur edges into the loop", async () => {
    expect(
      edges(
        await joined(`(define (walk n acc) (if (= n 0) acc (walk (- n 1) (ask acc))))\n(fetch (walk 3 (fetch "s")))`),
      ),
    ).toMatchInlineSnapshot(`
      "
      fetch@5:15:out -> walk@5:7:in:acc
      walk@5:7:out -> fetch@5:0:in:arg0
      fetch@5:0:out -> <program>:out
      walk@5:7:in:n -> walk@5:7:in:n [recur]
      walk@5:7:in:acc -> walk@5:7▸ask@4:51:in:arg0
      walk@5:7▸ask@4:51:out -> walk@5:7:in:acc [recur]
      walk@5:7:in:n -> walk@5:7▸if@4:21:control [control]
      walk@5:7:in:acc -> walk@5:7▸if@4:21:out
      walk@5:7▸if@4:21:out -> walk@5:7:out
      ! dataflow: 12 wires, 9 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
  });

  it("mutual recursion: the re-entry into the outer call is a recur", async () => {
    expect(
      edges(
        await joined(`(define (ping n acc) (if (= n 0) acc (pong (- n 1) (ask acc))))
(define (pong n acc) (ping n (fetch acc)))
(ping 2 "s")`),
      ),
    ).toMatchInlineSnapshot(`
      "
      ping@6:0:out -> <program>:out
      ping@6:0:in:n -> ping@6:0▸pong@4:37:in:n
      ping@6:0:in:acc -> ping@6:0▸ask@4:51:in:arg0
      ping@6:0▸ask@4:51:out -> ping@6:0▸pong@4:37:in:acc
      ping@6:0:in:n -> ping@6:0▸if@4:21:control [control]
      ping@6:0:in:acc -> ping@6:0▸if@4:21:out
      ping@6:0▸pong@4:37:out -> ping@6:0▸if@4:21:out
      ping@6:0▸if@4:21:out -> ping@6:0:out
      ping@6:0▸pong@4:37:in:n -> ping@6:0:in:n [recur]
      ping@6:0▸pong@4:37:in:acc -> ping@6:0▸pong@4:37▸fetch@5:29:in:arg0
      ping@6:0▸pong@4:37▸fetch@5:29:out -> ping@6:0:in:acc [recur]
      ! dataflow: 14 wires, 11 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
  });

  it("non-tail recursion: the recursive site is a stub", async () => {
    expect(
      edges(
        await joined(
          `(define (deep n) (if (= n 0) (fetch "z") (string-append (ask "x") (deep (- n 1)))))\n(ask (deep 2))`,
        ),
      ),
    ).toMatchInlineSnapshot(`
      "
      deep@5:5:out -> ask@5:0:in:arg0
      ask@5:0:out -> <program>:out
      deep@5:5:in:n -> deep@5:5▸deep@4:66:in:n
      deep@5:5:in:n -> deep@5:5▸if@4:17:control [control]
      deep@5:5▸fetch@4:29:out -> deep@5:5▸if@4:17:out
      deep@5:5▸ask@4:56:out -> deep@5:5▸if@4:17:out
      deep@5:5▸deep@4:66:out -> deep@5:5▸if@4:17:out
      deep@5:5▸if@4:17:out -> deep@5:5:out
      ! dataflow: 10 wires, 8 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
  });
});

describe("attachDataflow — branches", () => {
  it("port-coupled if: selector → control, arms → branch out", async () => {
    expect(edges(await joined(`(fetch (if (pred (fetch "u")) (ask "yes") (ask "no")))`))).toMatchInlineSnapshot(`
      "
      fetch@4:17:out -> pred@4:11:in:arg0
      pred@4:11:out -> if@4:7:control [control]
      ask@4:30:out -> if@4:7:out
      ask@4:42:out -> if@4:7:out
      if@4:7:out -> fetch@4:0:in:arg0
      fetch@4:0:out -> <program>:out
      ! dataflow: 9 wires, 6 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
  });

  it("pure-selector if: producers inside the arms leave through branch out", async () => {
    expect(edges(await joined(`(let* ((x "q") (r (if (> (string-length x) 3) (ask x) (fetch x)))) (ask r))`)))
      .toMatchInlineSnapshot(`
        "
        ask@4:46:out -> if@4:18:out
        fetch@4:54:out -> if@4:18:out
        if@4:18:out -> ask@4:67:in:arg0
        ask@4:67:out -> <program>:out
        ! dataflow: 7 wires, 4 edges, dropped 0, dead-binding 1, 0 steps without a node
        "
      `);
  });

  it("a mux whose branch was pruned is transparent: its selector reaches the consumer as control", async () => {
    expect(edges(await joined(`(fetch (if (pred (ask "u")) "yes" "no"))`))).toMatchInlineSnapshot(`
      "
      ask@4:17:out -> pred@4:11:in:arg0
      pred@4:11:out -> fetch@4:0:in:arg0 [control]
      fetch@4:0:out -> <program>:out
      ! dataflow: 7 wires, 3 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
  });
});

describe("attachDataflow — call paths", () => {
  it("an IIFE joins under its ?@ call path", async () => {
    expect(edges(await joined(`((lambda (x) (ask x)) (fetch "v"))`))).toMatchInlineSnapshot(`
      "
      ?@4:0:out -> <program>:out
      fetch@4:22:out -> <program>:out
      ?@4:0:in:x -> ?@4:0▸ask@4:13:in:arg0
      ?@4:0▸ask@4:13:out -> ?@4:0:out
      ! dataflow: 4 wires, 4 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
  });

  it("undeclared HOF callbacks get their interior ingress from the callback frame's params", async () => {
    expect(edges(await joined(`(fetch (reduce (lambda (x acc) (ask (string-append acc x))) "" (list "a" "b")))`)))
      .toMatchInlineSnapshot(`
        "
        reduce@4:7:out -> fetch@4:0:in:arg0
        fetch@4:0:out -> <program>:out
        reduce@4:7:in:acc -> ask@4:31:in:arg0
        reduce@4:7:in:x -> ask@4:31:in:arg0
        ask@4:31:out -> reduce@4:7:out
        ! dataflow: 4 wires, 5 edges, dropped 0, dead-binding 0, 0 steps without a node
        "
      `);
  });
});

describe("attachDataflow — honest degradation", () => {
  it("a top-level value define used as a value: its producer feeds the reader", async () => {
    const p = await joined(`(define plan (ask "p"))\n(ask plan)`);
    expect(edges(p)).toMatchInlineSnapshot(`
      "
      ask@4:13:out -> ask@5:0:in:arg0
      ask@5:0:out -> <program>:out
      ! dataflow: 3 wires, 2 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
    expect(p.dataflow).toEqual({ status: "complete", missing: 0 });
  });

  it("(for-each helper xs): the define, passed on the fan's fn wire, joins under the par", async () => {
    const p = await joined(`(define (helper x) (ask x))\n(for-each helper (list "a" "b"))`);
    expect(edges(p)).toMatchInlineSnapshot(`
      "
      for-each@5:0:out -> <program>:out
      for-each@5:0:in:x -> for-each@5:0▸ask@4:19:in:arg0
      ! dataflow: 5 wires, 2 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
    expect(p.dataflow).toEqual({ status: "complete", missing: 0 });
  });

  it("a region capture reads what its capture wire supplies", async () => {
    const p = await joined(`(let ((ctx (fetch "c"))) (map (lambda (s) (ask (string-append ctx s))) (list "a" "b")))`);
    expect(edges(p)).toMatchInlineSnapshot(`
      "
      map@4:25:out -> <program>:out
      fetch@4:11:out -> ask@4:42:in:arg0
      map@4:25:in:s -> ask@4:42:in:arg0
      ask@4:42:out -> map@4:25:out
      ! dataflow: 6 wires, 4 edges, dropped 0, dead-binding 2, 0 steps without a node
      "
    `);
    expect(droppedOf(p)).toBe(0);
    expect(p.dataflow).toEqual({ status: "complete", missing: 0 });
  });

  it("a guard drawn as an area: its value from the body's last form, the handler's through on-raise", async () => {
    const p = await joined(`(guard (e (#t (fetch "recovered"))) (ask "first"))`);
    expect(edges(p)).toMatchInlineSnapshot(`
      "
      guard@4:0/raise:out -> guard@4:0:out
      ask@4:36:out -> guard@4:0:out
      fetch@4:14:out -> guard@4:0/raise:out
      guard@4:0:out -> <program>:out
      ! dataflow: 6 wires, 4 edges, dropped 0, dead-binding 3, 0 steps without a node
      "
    `);
  });

  it("a do result clause reads the loop variable's final value from the loop's out:<var> port", async () => {
    const p = await joined(`(do ((i 0 (+ i 1)) (acc "" (ask acc))) ((= i 2) (fetch acc)))`);
    expect(edges(p)).toMatchInlineSnapshot(`
      "
      fetch@4:48:out -> <program>:out
      do@4:0:in:i -> do@4:0:in:i [recur]
      do@4:0:in:acc -> ask@4:27:in:arg0
      ask@4:27:out -> do@4:0:in:acc [recur]
      do@4:0:out:acc -> fetch@4:48:in:arg0
      ! dataflow: 8 wires, 5 edges, dropped 0, dead-binding 3, 0 steps without a node
      "
    `);
    expect(p.dataflow).toEqual({ status: "complete", missing: 0 });
  });

  it("bracket let* bindings join like paren ones", async () => {
    const p = await joined(`(let* [a (ask "1") b (fetch a)] (string-append a b))`);
    expect(edges(p)).toMatchInlineSnapshot(`
      "
      ask@4:9:out -> fetch@4:21:in:arg0
      ask@4:9:out -> <program>:out
      fetch@4:21:out -> <program>:out
      ! dataflow: 3 wires, 3 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
    expect(p.dataflow).toEqual({ status: "complete", missing: 0 });
  });

  it("steps the wireframe never reached are noted", async () => {
    const p = await joined(`(apply ask (list "a"))`);
    expect(edges(p)).toMatchInlineSnapshot(`
      "
      ! dataflow: 1 wires, 0 edges, dropped 0, dead-binding 0, 1 steps without a node
      ! no dataflow for apply@4:0: arrival wireframe kept it inside a wire
      "
    `);
    expect(p.dataflow).toEqual({ status: "partial", missing: 1 });
  });

  it("a define bound to a lambda inlines like a procedure define", async () => {
    const p = await joined(`(define helper (lambda (x) (ask x)))\n(helper "a")`);
    expect(edges(p)).toMatchInlineSnapshot(`
      "
      helper@5:0:out -> <program>:out
      helper@5:0:in:x -> helper@5:0▸ask@4:27:in:arg0
      helper@5:0▸ask@4:27:out -> helper@5:0:out
      ! dataflow: 4 wires, 3 edges, dropped 0, dead-binding 0, 0 steps without a node
      "
    `);
  });
});

describe("attachDataflow — supported corpus drops nothing", () => {
  const corpus = [
    `(let* ((a (ask "1")) (b (fetch a))) (ask b))`,
    `(ask (fetch "x"))`,
    `(begin (fetch "a") (ask "b"))`,
    `(fetch (car (map (lambda (s) (ask s)) (list (ask "a") "b"))))`,
    `(filter (lambda (s) (pred s)) (list "a"))`,
    `(define (helper x) (ask (string-append x "!")))\n(map helper (list (helper "a") "b"))`,
    `(map ask (list "e1" "e2"))`,
    `(let loop ((i 0) (acc "")) (if (< i 3) (loop (+ i 1) (ask acc)) acc))`,
    `(do ((i 0 (+ i 1)) (acc "" (ask acc))) ((= i 3) acc))`,
    `(define (walk n acc) (if (= n 0) acc (walk (- n 1) (ask acc))))\n(walk 3 "s")`,
    `(define (deep n) (if (= n 0) (fetch "z") (string-append (ask "x") (deep (- n 1)))))\n(deep 2)`,
    `(if (string=? (fetch "u") "ok") (ask "yes") (ask "no"))`,
    `(case (fetch "k") (("F:k") (ask "1")) (else (ask "2")))`,
    `(let* ((x "q") (r (if (> (string-length x) 3) (ask x) (fetch x)))) (ask r))`,
    `(for-each (lambda (x) (ask x)) (list "a" "b"))`,
    `(reduce (lambda (x acc) (ask (string-append acc x))) "" (list "a" "b"))`,
    `(or (fetch "a") (ask "b"))`,
    `(when (pred "n") (ask "w"))`,
    `(define (ping n acc) (if (= n 0) acc (pong (- n 1) (ask acc))))\n(define (pong n acc) (ping n (fetch acc)))\n(ping 2 "s")`,
    `(map (lambda (s) (let loop ((i 0) (acc s)) (if (< i 2) (loop (+ i 1) (ask acc)) acc))) (list "a" "b"))`,
    `(let loop ((i 0)) (if (pred (if (> i 4) "y" "n")) i (loop (+ i (string-length (ask "inc"))))))`,
  ];
  for (const src of corpus) {
    it(src.split("\n").at(-1)!, async () => {
      const p = await joined(src);
      expect(p.diagnostics.filter((d) => d.startsWith("dataflow unavailable"))).toEqual([]);
      expect(droppedOf(p), edges(p)).toBe(0);
    });
  }
});

describe("wire shapes", () => {
  const form = async (src: string) => wireForm((await parse(src))[0]);

  it("classifies on the liveness-peeled inner expression, through re-wrapped bindings", async () => {
    expect(await form(`(lambda (in0) in0)`)).toEqual({ kind: "identity" });
    expect(await form(`(lambda (in0 in1) (let* ((plan in0) (steps in1)) steps))`)).toEqual({ kind: "identity" });
    expect(await form(`(lambda (in0 in1) (let* ((plan in0) (steps in1)) (car steps)))`)).toEqual({
      kind: "projection",
      path: [{ car: true }],
    });
    expect(await form(`(lambda (in0) (let ((d in0)) (:url d)))`)).toEqual({
      kind: "projection",
      path: [{ field: "url" }],
    });
    // Application order: `(:text (list-ref (@ d :items) 0))` reads items, then [0], then text.
    expect(await form(`(lambda (d) (:text (list-ref (@ d :items) 0)))`)).toEqual({
      kind: "projection",
      path: [{ field: "items" }, { index: 0 }, { field: "text" }],
    });
    expect(await form(`(lambda (v) (vector-ref v 2))`)).toEqual({ kind: "projection", path: [{ index: 2 }] });
  });

  it("composes a name bound to a projection into the path; a bound compute stays compute", async () => {
    // `(define inbox (:threads (mcp/tool …)))` read by a later step.
    expect(await form(`(lambda (in0) (let* ((inbox (:threads in0))) inbox))`)).toEqual({
      kind: "projection",
      path: [{ field: "threads" }],
    });
    expect(await form(`(lambda (in0) (let* ((a (:x in0)) (b (car a))) b))`)).toEqual({
      kind: "projection",
      path: [{ field: "x" }, { car: true }],
    });
    expect(await form(`(lambda (in0) (let* ((s (string-append in0 "!"))) (:x s)))`)).toEqual({
      kind: "compute",
      op: ":x",
    });
  });

  it("anything else computes: a non-literal index, a call, a literal", async () => {
    expect(await form(`(lambda (xs i) (list-ref xs i))`)).toEqual({ kind: "compute", op: "list-ref" });
    expect(await form(`(lambda (in0 in1) (string-append in0 in1))`)).toEqual({ kind: "compute", op: "string-append" });
    expect(await form(`(lambda (d) (car (cdr d)))`)).toEqual({ kind: "compute", op: "car" });
    expect(await form(`(lambda () "x")`)).toEqual({ kind: "compute" });
  });

  it("stamps every joined edge: one id per wire, the operand's source as text, cut params as producers", async () => {
    const p = await joined(
      `(fetch (car (map (lambda (s) (ask s)) (list (ask "p") "b"))))\n(string-append (ask "a") (fetch "b"))`,
    );
    const shapes = p.edges.flatMap((e) => (e.wire ? [`${e.to.key}:${e.to.port} ${e.wire.kind} ${e.wire.text}`] : []));
    expect(shapes).toEqual(
      expect.arrayContaining([
        `fetch@4:0:in:arg0 projection (car (map (lambda (s) (ask s)) (list (ask "p") "b")))`,
        // A frame port has no operand source: the wire body, the cut `(ask "p")` as its producer.
        `map@4:12:in:s compute (list (ask …) "b")`,
        `<program>:out compute (string-append (ask …) (fetch …))`,
      ]),
    );
    const fanIn = p.edges.filter((e) => e.wire?.op === "string-append" && e.to.key === "<program>");
    expect(fanIn).toHaveLength(2);
    expect(new Set(fanIn.map((e) => e.wire!.id)).size).toBe(1);
  });
});

describe("attachDataflow — a do exit clause runs after the loop", () => {
  const EXIT = `(do ((i 0 (+ i 1)) (acc "" (ask acc))) ((= i 2) (fetch (string-append (number->string i) acc))))`;

  it("no edge enters the loop's own out from outside it; the result goes to the loop's consumers", async () => {
    const p = await joined(`(ask ${EXIT})`);
    const loop = p.edges.find((e) => e.kind === "recur")!.from.key;
    expect(p.edges.filter((e) => e.to.key === loop && e.to.port === "out")).toEqual([]);
    expect(p.edges.filter((e) => e.from.key === loop && e.from.port === "out")).toEqual([]);
    expect(edges(p)).toMatch(/fetch@\d+:\d+:out -> ask@4:0:in:arg0/);
  });

  it("a result step is a sibling of the loop, not inside it", async () => {
    const p = await joined(EXIT);
    const loop = p.root.children.find((c) => c.kind === "frame" && c.frame === "loop");
    expect(loop?.kind === "frame" && loop.children.some((c) => c.key.startsWith("fetch@"))).toBe(false);
    expect(p.root.children.some((c) => c.kind === "step" && c.key.startsWith("fetch@"))).toBe(true);
  });

  it("the exit step's loop-variable reads are wired from the loop's out:<var> ports", async () => {
    const p = await joined(EXIT);
    const lines = edges(p);
    expect(lines).toContain("do@4:0:out:i -> fetch@4:48:in:arg0");
    expect(lines).toContain("do@4:0:out:acc -> fetch@4:48:in:arg0");
    expect(p.dataflow).toEqual({ status: "complete", missing: 0 });
  });

  it("no non-recur cycle", async () => {
    const p = await joined(`(ask ${EXIT})`);
    const next = new Map<string, string[]>();
    for (const e of p.edges) {
      if (e.kind === "recur") continue;
      // a frame's ports are one node
      next.set(e.from.key, [...(next.get(e.from.key) ?? []), e.to.key]);
    }
    const state = new Map<string, 1 | 2>();
    const cyclic = (k: string): boolean => {
      if (state.get(k) === 2) return false;
      if (state.get(k) === 1) return true;
      state.set(k, 1);
      const hit = (next.get(k) ?? []).some((n) => n !== k && cyclic(n));
      state.set(k, 2);
      return hit;
    };
    // loop → its interior (ports feed children) is containment, not a wire cycle: check siblings only
    expect([...next.keys()].some((k) => cyclic(k))).toBe(false);
  });
});

describe("attachDataflow — only the last body form is the value", () => {
  // Every program runs `(fetch "EFFECT")` before the value form of some body; that step runs for
  // effect and must feed no frame's `out`.
  const E = `(fetch "EFFECT")`;
  const bodies = [
    `(map (lambda (s) ${E} (ask s)) (list "a" "b"))`,
    `(map (lambda (s) (let* ((a (ask s))) ${E} (cond ((pred a) (ask "y")) (else (fetch "n"))))) (list "a"))`,
    `(map (lambda (s) (let ((a (ask s))) ${E} (fetch a))) (list "a"))`,
    `(map (lambda (s) (letrec ((a (ask s))) ${E} (fetch a))) (list "a"))`,
    `(filter (lambda (s) ${E} (pred s)) (list "a"))`,
    `(for-each (lambda (s) ${E} (ask s)) (list "a"))`,
    `(let loop ((i 0) (acc "")) ${E} (if (< i 2) (loop (+ i 1) (ask acc)) acc))`,
    `(do ((i 0 (+ i 1)) (acc "" (ask acc))) ((= i 2) acc) ${E})`,
    `(when (pred "n") ${E} (ask "w"))`,
    `(unless (pred "n") ${E} (ask "w"))`,
    `(cond ((pred (fetch "k")) ${E} (ask "1")) (else ${E} (ask "2")))`,
    `(case (fetch "k") (("F:k") ${E} (ask "1")) (else ${E} (ask "2")))`,
    `(guard (e (#t ${E} (ask "h"))) ${E} (fetch "b"))`,
    `(define (f x) ${E} (ask x))\n(f "a")`,
    `(let* ((a (ask "1"))) ${E} (ask a))`,
  ];
  for (const src of bodies) {
    it(src, async () => {
      const p = await joined(src);
      const effects = new Set(
        [...p.byKey.values()]
          .filter((i) => i.kind === "step" && i.args.some((a) => a.source === `"EFFECT"`))
          .map((i) => i.key),
      );
      expect(effects.size).toBeGreaterThan(0);
      const bad = p.edges.filter((e) => effects.has(e.from.key) && e.to.port === "out");
      expect(bad, edges(p)).toEqual([]);
    });
  }
});
