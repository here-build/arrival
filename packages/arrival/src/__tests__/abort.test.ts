/**
 * AbortSignal-based execution budget for the evaluator trampoline.
 *
 * War story: `evaluator.ts:run()` had no abort path until 2026-05-28. The
 * 1000-iter / 5ms event-loop yield kept the UI responsive but did NOT bound
 * CPU — `(define (loop) (loop)) (loop)` would burn a worker forever and the
 * only recourse was killing the process. Sandbox execution and agent-
 * generated Scheme programs needed an actual bound.
 *
 * Design: optional `AbortSignal` at the EvalContext boundary; trampoline
 * checks `signal.aborted` at the existing iteration boundary (the same
 * 1000-iter / 5ms tick where it already yields to the event loop). Throws
 * `signal.reason ?? DOMException("aborted", "AbortError")` — Web-standard
 * shape so it composes naturally with `fetch(url, { signal })` at the
 * rosetta boundary.
 *
 * Why these tests:
 *   1. Infinite-loop abort — the canonical motivation; documents that the
 *      Iron Law from `sandbox-escape.test.ts:201` (`it.skip("TODO: infinite
 *      loop is bounded by a wall-clock budget")`) is now lifted.
 *   2. Pre-aborted signal — caller passes an already-aborted signal; the
 *      trampoline must refuse without allocating state. Mirrors fetch().
 *   3. signal.reason preservation — the Web standard says when a caller
 *      passes a reason to abort(), the throw must surface that reason
 *      (not a generic AbortError). Tests this contract end-to-end.
 */

import { describe, expect, it } from "vitest";
import { exec, execExpr, execState, parse } from "../eval/generator-exec.js";
import { RunContextBusyError } from "../errors.js";
import { EnvCapability } from "../common/capability.js";
import { raceAbort } from "../eval/evaluator.js";
import type { CallCtx } from "../run/CallCtx.js";

describe("AbortSignal execution budget", () => {
  it("aborts an infinite loop when AbortSignal fires", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    // Use `(do () (#f))` — a do-loop with a constant-false test runs entirely
    // INSIDE one generator's `while(true)` (see evalDo at evaluator.ts:1558),
    // so iteration cycles through `yield { call: evaluate(test) }` and tail-
    // pops back to the same frame. The trampoline's stack[] and the JS
    // microtask chain stay flat, and the TICK abort check at the 5ms / 1000-
    // iter cadence delivers the signal cleanly within ~one tick of the timer.
    //
    // War story: this test used to drive the loop via `(let loop () (loop))`
    // on the assumption that named-let iterated inside the trampoline. It
    // doesn't — each (loop) call invokes the LambdaFunction-style closure
    // installed by evalLet (evaluator.ts:1041-1055), which itself calls
    // `run(...)` recursively. Every recursive call produces a fresh Promise
    // the outer trampoline awaits at the `is_promise(value)` branch
    // (evaluator.ts:533), so each iteration adds one pending await to the JS
    // promise-resolution chain. After ~10k recursions V8's stack overflows
    // inside PromiseRejectCallback — sometimes BEFORE the abort fires
    // (`ArrivalError: Maximum call stack size exceeded`), sometimes AFTER
    // (test "passes" but the worker process crashes with an unhandled
    // RangeError that taints the next test in the suite). Proper TCO (see
    // task #46) would fix the underlying recursion shape; until that lands,
    // exercise the abort budget through a construct that actually iterates
    // flat. `(define (loop) (loop)) (loop)` has the same hazard for the same
    // reason — it goes through evalLambda's `run(...)` wrapper.
    await expect(exec("(do () (#f))", { signal: ctrl.signal })).rejects.toThrow(/abort/i);
  });

  it("throws immediately when signal is already aborted at start", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(exec("(+ 1 2)", { signal: ctrl.signal })).rejects.toThrow(/abort/i);
  });

  it("preserves signal.reason through the throw", async () => {
    const ctrl = new AbortController();
    const reason = new Error("custom budget exhausted");
    ctrl.abort(reason);
    await expect(exec("(+ 1 2)", { signal: ctrl.signal })).rejects.toThrow("custom budget exhausted");
  });

  it("preserves signal.reason when abort fires mid-execution", async () => {
    const ctrl = new AbortController();
    const reason = new Error("mid-run budget exhausted");
    // Fire abort on the next microtask so the trampoline's first TICK check
    // picks it up. The loop body uses `(do () (#f))` rather than named-let
    // for the trampoline-safety reasons documented on the first test above
    // — until TCO (task #46) lands, named-let is a JS-call-stack hazard,
    // not a flat-iteration construct.
    queueMicrotask(() => ctrl.abort(reason));
    await expect(exec("(do () (#f))", { signal: ctrl.signal })).rejects.toThrow("mid-run budget exhausted");
  });

  it("runs to completion when signal never aborts", async () => {
    const ctrl = new AbortController();
    const [result] = await exec("(+ 1 2 3)", { signal: ctrl.signal });
    expect(result).toBe(6);
  });

  it("execExpr honors the abort signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const [expr] = await parse("(+ 1 2)");
    await expect(execExpr(expr, { signal: ctrl.signal })).rejects.toThrow(/abort/i);
  });

  it("AbortError has the standard Web API shape", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    try {
      await exec("(+ 1 2)", { signal: ctrl.signal });
      expect.fail("Should have thrown");
    } catch (error) {
      // When no reason is supplied to abort(), the runtime supplies a default
      // (`new DOMException("aborted", "AbortError")` in modern Node / browsers).
      // We don't assert the exact constructor — runtimes vary in whether
      // DOMException is the constructor of choice — but the name must be
      // recognizable as an abort.
      expect(error).toBeDefined();
      const message = (error as Error)?.message ?? String(error);
      const name = (error as Error)?.name ?? "";
      expect(`${name} ${message}`.toLowerCase()).toMatch(/abort/);
    }
  });

  // ── PARKED HOST-PROMISE abort (raceAbort, evaluator.ts) ──────────────────────
  // The trampoline awaits every host promise (a rosetta / tool-call return) at its
  // one `is_promise(value)` choke point. The TICK-boundary abort check only fires
  // while the trampoline is actively STEPPING, so a host promise PARKED there — a
  // tool call to a stuck upstream that never settles — is not abort-aware on its
  // own: the run would hang until the promise settled, however long that took. The
  // fix races that await against the signal via `raceAbort`. These unit tests
  // exercise `raceAbort` DIRECTLY (a deferred promise we control + an
  // AbortController), which is the deterministic way to pin its contract: the
  // whole-trampoline behaviour is additionally verified out-of-band by a plain-node
  // repro (the vitest worker's own abort/unhandled-rejection handling makes the
  // exec-level parked-hang unobservable from inside a test, so it is not asserted
  // here — see the fix commit's investigation notes).
  const deferred = <T = unknown>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("rejects the moment the signal aborts, without awaiting a still-pending value", async () => {
    const d = deferred(); // never settled — models a stuck upstream host promise
    const ctrl = new AbortController();
    queueMicrotask(() => ctrl.abort());
    await expect(raceAbort(d.promise, ctrl.signal)).rejects.toThrow(/abort/i);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const d = deferred();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(raceAbort(d.promise, ctrl.signal)).rejects.toThrow(/abort/i);
  });

  it("preserves signal.reason through the race", async () => {
    const d = deferred();
    const ctrl = new AbortController();
    const reason = new Error("custom parked-await cancellation");
    queueMicrotask(() => ctrl.abort(reason));
    await expect(raceAbort(d.promise, ctrl.signal)).rejects.toThrow("custom parked-await cancellation");
  });

  it("resolves with the value when it settles before any abort, and a later abort is inert", async () => {
    const d = deferred<number>();
    const ctrl = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      d.resolve(42);
      await expect(raceAbort(d.promise, ctrl.signal)).resolves.toBe(42);
      // The abort listener was removed on the happy path, so aborting now is a
      // no-op and produces no stray rejection.
      ctrl.abort();
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("swallows an abandoned value that rejects AFTER the abort (no unhandled rejection)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const d = deferred();
      const ctrl = new AbortController();
      ctrl.abort();
      // Abort wins the race immediately; the underlying value is abandoned.
      await expect(raceAbort(d.promise, ctrl.signal)).rejects.toThrow(/abort/i);
      // The abandoned value rejects only NOW. raceAbort keeps a rejection handler
      // attached to it, so this must never surface as an unhandledRejection.
      d.reject(new Error("upstream failed late"));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

let finallyRan = false;
const markers: string[] = [];
const probe = EnvCapability.define("test/abort-probe", {
  symbols: (symbol, z) => ({
    "mark!": symbol.rosetta`mark!: record that a finally body ran (test probe)`(
      { input: [], output: [z.number] },
      function (this: CallCtx) {
        finallyRan = true;
        return 1;
      },
    ),
    "catch-mark!": symbol.rosetta`catch-mark!: record that a catch body ran (test probe)`(
      { input: [], output: [z.number] },
      function (this: CallCtx) {
        markers.push("catch");
        return 1;
      },
    ),
    "fin-mark!": symbol.rosetta`fin-mark!: record that a finally body ran (test probe)`(
      { input: [], output: [z.number] },
      function (this: CallCtx) {
        markers.push("finally");
        return 1;
      },
    ),
    "host-abort!": symbol.rosetta`host-abort!: throw an AbortError from an unrelated controller (test probe)`(
      { input: [], output: [z.number] },
      function (this: CallCtx) {
        throw new DOMException("unrelated", "AbortError");
      },
    ),
    "overflow!": symbol.rosetta`overflow!: throw a host stack overflow (test probe)`(
      { input: [], output: [z.number] },
      function (this: CallCtx) {
        throw new RangeError("Maximum call stack size exceeded");
      },
    ),
  }),
});

describe("abort reaches nested trampolines", () => {
  it("pre-aborted signal rejects with the reason", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop-now"));
    await expect(exec("(try 1 (catch (e) 2))", { signal: ctrl.signal })).rejects.toThrow(/stop-now/);
  });

  it("try/catch does not swallow an abort, and finally still runs", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("stop-now")), 50);
    finallyRan = false;
    const capabilities = [probe];
    await expect(
      exec("(try (let loop () (loop)) (catch (e) 1) (finally (mark!)))", { signal: ctrl.signal, capabilities }),
    ).rejects.toThrow(/stop-now/);
    // The outer trampoline awaits the try's own trampoline, so finally completed BEFORE exec settled.
    expect(finallyRan).toBe(true);
  });

  it("a reused runCtx honors the NEW call's signal in nested loops", async () => {
    const first = new AbortController();
    const st = await execState("(define x 1)", { signal: first.signal });
    first.abort();
    const second = new AbortController();
    setTimeout(() => second.abort(new Error("second-abort")), 50);
    const t0 = performance.now();
    await expect(
      execState("(map (lambda (x) (let loop () (loop))) (list 1))", {
        runCtx: st.runCtx,
        scope: st.scope,
        signal: second.signal,
      }),
    ).rejects.toThrow(/second-abort/);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("a concurrent second call on an armed runCtx is a door", async () => {
    const st = await execState("(define x 1)");
    const ctrl = new AbortController();
    const slow = execState("(let loop () (loop))", { runCtx: st.runCtx, scope: st.scope, signal: ctrl.signal });
    const settled = slow.catch((error: unknown) => error);
    await new Promise((r) => setTimeout(r, 50));
    await expect(execState("1", { runCtx: st.runCtx, scope: st.scope })).rejects.toThrow(RunContextBusyError);
    ctrl.abort();
    await settled;
    await expect(execState("1", { runCtx: st.runCtx, scope: st.scope })).resolves.toBeDefined();
  });

  it("catch does not intercept a host stack overflow; finally still runs", async () => {
    finallyRan = false;
    await expect(
      exec("(try (overflow!) (catch (e) 'caught) (finally (mark!)))", { capabilities: [probe] }),
    ).rejects.toThrow(/Maximum call stack/);
    expect(finallyRan).toBe(true);
  });

  it("an aborted try on a reused runCtx never runs its catch, and nothing runs after exec settles", async () => {
    const capabilities = [probe];
    const st = await execState("(define x 1)", { capabilities });
    markers.length = 0;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("custom-stop")), 50);
    await expect(
      execState("(try (do () (#f)) (catch (e) (catch-mark!)) (finally (fin-mark!)))", {
        runCtx: st.runCtx,
        scope: st.scope,
        signal: ctrl.signal,
        capabilities,
      }),
    ).rejects.toThrow(/custom-stop/);
    expect(markers).toEqual(["finally"]);
    expect(st.runCtx.bound.armed).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(markers).toEqual(["finally"]);
  });

  it("a finally that never terminates is cut off after the grace window; exec rejects with the abort reason", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("custom-stop")), 50);
    const t0 = performance.now();
    await expect(exec("(try (do () (#f)) (finally (do () (#f))))", { signal: ctrl.signal })).rejects.toThrow(
      /custom-stop/,
    );
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("a host-raised AbortError from an unrelated controller stays catchable", async () => {
    const ctrl = new AbortController();
    await expect(
      exec("(try (host-abort!) (catch (e) 'caught))", { signal: ctrl.signal, capabilities: [probe] }),
    ).resolves.toBeDefined();
  });

  it("an execExpr that passes its own signal or budget on an armed runCtx is a door, not silently dropped", async () => {
    const [one] = await parse("1");
    const st = await execState("(define x 1)");
    const ctrlA = new AbortController();
    const slow = execState("(let loop () (loop))", { runCtx: st.runCtx, scope: st.scope, signal: ctrlA.signal });
    const settled = slow.catch((error: unknown) => error);
    await new Promise((r) => setTimeout(r, 50));
    const ctrlB = new AbortController();
    await expect(execExpr(one, { runCtx: st.runCtx, signal: ctrlB.signal })).rejects.toThrow(RunContextBusyError);
    await expect(execExpr(one, { runCtx: st.runCtx, budgetMs: 100 })).rejects.toThrow(RunContextBusyError);
    // genuinely nested (runCtx only) still inherits
    await expect(execExpr(one, { runCtx: st.runCtx })).resolves.toBeDefined();
    ctrlA.abort(new Error("abort-A"));
    expect(await settled).toMatchObject({ message: expect.stringMatching(/abort-A/) });
  });

  it("a runCtx minted with a session signal stays abortable by it when a call passes none", async () => {
    const [one] = await parse("1");
    const session = new AbortController();
    const st = await execState("(define x 1)", { signal: session.signal });
    setTimeout(() => session.abort(new Error("session-over")), 50);
    await expect(execState("(do () (#f))", { runCtx: st.runCtx, scope: st.scope })).rejects.toThrow(/session-over/);
    // and the nested-entry path honours it too
    const s2 = new AbortController();
    const st2 = await execState("(define x 1)", { signal: s2.signal });
    s2.abort(new Error("session-over-2"));
    await expect(execExpr(one, { runCtx: st2.runCtx })).rejects.toThrow(/session-over-2/);
  });
});
