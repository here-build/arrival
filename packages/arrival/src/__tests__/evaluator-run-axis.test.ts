/**
 * Run-axis and tail-call doors of the evaluator (R7 batch):
 *   W-R1  abort / budget at TICK drains open invocations; a failed call cancels in-flight fan siblings
 *   W-R2  a closure logs into the CALLING run's tap, never its birth run's
 *   W-R3  procedural-macro (threading) expansions are tapped
 *   tail  a named let's first recur call is a tail call; `apply` in tail position is O(1) host stack
 *   letrec reading a binding before its initializer is a door, not a silent void
 */

import { describe, expect, it } from "vitest";
import { exec, execState } from "../eval/generator-exec.js";
import { EnvCapability } from "../common/capability.js";
import { EvalTrace, type Invocation } from "../provenance/trace.js";
import { LetrecUnassignedError } from "../errors.js";
import type { CallCtx } from "../run/CallCtx.js";

const code = (inv: Invocation): string => inv.node["arrival/print"]();

interface Deferred {
  promise: Promise<number>;
  resolve(v: number): void;
  reject(e: Error): void;
}
function deferred(): Deferred {
  let resolve!: (v: number) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<number>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("W-R1: TICK-detected abort / budget settles open invocations", () => {
  it("budgetMs overrun leaves no invocation `running`", async () => {
    const trace = new EvalTrace();
    await expect(exec("(let loop () (loop))", { tap: trace, budgetMs: 30 })).rejects.toThrow(/budget/);
    expect(trace.invocationLog.length).toBeGreaterThan(0);
    expect(trace.invocationLog.filter((i) => i.state === "running")).toEqual([]);
  });

  it("an AbortSignal leaves no invocation `running`", async () => {
    const trace = new EvalTrace();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    await expect(exec("(let loop () (loop))", { tap: trace, signal: ctrl.signal })).rejects.toThrow();
    expect(trace.invocationLog.length).toBeGreaterThan(0);
    expect(trace.invocationLog.filter((i) => i.state === "running")).toEqual([]);
  });
});

describe("W-R1: a rejected fan track cancels its siblings", () => {
  it("map over async ports: after track 2 rejects, tracks 1 and 3 never reach their second port call", async () => {
    const gates = new Map<number, Deferred>();
    const afterCalls: number[] = [];
    const probe = EnvCapability.define("test/fan-cancel-probe", {
      symbols: (symbol, z) => ({
        gate: symbol.rosetta`gate: park on a test-controlled promise`(
          { input: [z.number], output: [z.number] },
          function (this: CallCtx, n: number) {
            const d = deferred();
            gates.set(n, d);
            return d.promise;
          },
        ),
        after: symbol.rosetta`after: record that a track continued past its gate`(
          { input: [z.number], output: [z.number] },
          function (this: CallCtx, n: number) {
            afterCalls.push(n);
            return n;
          },
        ),
      }),
    });

    const run = exec("(map (lambda (n) (begin (gate n) (after n))) '(1 2 3))", { capabilities: [probe] });
    const settled = run.then(
      () => "resolved",
      () => "rejected",
    );
    while (gates.size < 3) await macrotask();

    gates.get(2)!.reject(new Error("port 2 down"));
    expect(await settled).toBe("rejected");

    gates.get(1)!.resolve(1);
    gates.get(3)!.resolve(3);
    await macrotask();
    await macrotask();
    expect(afterCalls).toEqual([]);
  });
});

describe("W-R2: closures read the calling run's tap", () => {
  it("a fn defined under tap t1 and called under tap t2 logs only into t2, parented in t2", async () => {
    const t1 = new EvalTrace();
    const t2 = new EvalTrace();
    const first = await execState("(define (f x) (+ x 1))", { tap: t1 });
    const before = t1.invocationLog.length;
    await execState("(f 41)", { tap: t2, runCtx: first.runCtx, scope: first.scope });

    expect(t1.invocationLog.length).toBe(before);
    const plus = t2.invocationLog.find((i) => code(i) === "(+ x 1)");
    expect(plus).toBeDefined();
    expect(plus?.parent && code(plus.parent)).toBe("(f 41)");
    expect(t2.invocationLog.every((i) => i.parent === null || t2.invocationLog.includes(i.parent))).toBe(true);
  });
});

describe("W-R3: threading macros are tapped", () => {
  it("(-> 1 (+ 2) (* 3)) shows the pipeline's calls", async () => {
    const trace = new EvalTrace();
    expect(await exec("(-> 1 (+ 2) (* 3))", { tap: trace })).toEqual([9]);
    const codes = trace.invocationLog.map(code);
    expect(codes).toContain("(+ 1 2)");
    expect(codes.some((c) => c.startsWith("(* "))).toBe(true);
  });
});

describe("tail position", () => {
  it("every recur call of a named let is a tail call, the first included", async () => {
    const trace = new EvalTrace();
    await exec("(let loop ((i 0)) (if (< i 3) (loop (+ i 1)) i))", { tap: trace });
    const recurs = trace.invocationLog.filter((i) => code(i).startsWith("(loop "));
    expect(recurs.length).toBe(3);
    expect(recurs.map((i) => i.tailPosition)).toEqual([true, true, true]);
  });

  it("named let in non-tail position still returns its value to the consumer", async () => {
    expect(await exec("(+ 1 (let loop ((i 0)) (if (< i 3) (loop (+ i 1)) i)))")).toEqual([4]);
  });

  it("apply in tail position is a tail call: 20_000 deep does not overflow the host stack", async () => {
    const src = `(define (f n acc) (if (= n 0) acc (apply f (list (- n 1) (+ acc 1)))))
                 (f 20000 0)`;
    expect(await exec(src)).toEqual([undefined, 20_000]);
  });

  it("apply in non-tail position and on natives still works", async () => {
    expect(await exec("(+ 1 (apply (lambda (a b) (* a b)) '(3 4)))")).toEqual([13]);
    expect(await exec("(apply + 1 2 '(3 4))")).toEqual([10]);
    expect(await exec("(map (lambda (l) (apply + l)) '((1 2) (3 4)))")).toEqual([[3, 7]]);
  });
});

describe("letrec", () => {
  it("reading a binding before its initializer is a door", async () => {
    await expect(exec("(letrec ((a b) (b 1)) a)")).rejects.toThrow(LetrecUnassignedError);
    await expect(exec("(letrec ((a b) (b 1)) a)")).rejects.toThrow(/read before initialization.*lambda.*let\*/);
  });

  it("a lambda that reads a later binding late is fine", async () => {
    expect(await exec("(letrec ((a (lambda () b)) (b 1)) (a))")).toEqual([1]);
  });

  it("mutual recursion works", async () => {
    const src = `(letrec ((even? (lambda (n) (if (= n 0) #t (odd? (- n 1)))))
                         (odd? (lambda (n) (if (= n 0) #f (even? (- n 1))))))
                   (even? 10))`;
    expect(await exec(src)).toEqual([true]);
  });
});
