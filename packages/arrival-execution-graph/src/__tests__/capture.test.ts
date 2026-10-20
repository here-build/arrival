import { scopeId } from "@here.build/arrival/provenance";
import { EvalTrace } from "@here.build/arrival-provenance";
import { configure, reaction } from "mobx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createExecutionCapture } from "../capture.js";
import { Gate, run, start, text, until } from "./program-harness.js";

const DEFS = `(define (fetch-page u) (io u))
(define (summarize t) (io (string-append "s:" t)))
(define (explode u) (fail u))
`;
// line 4 onward
const SEQ = `${DEFS}(define page (fetch-page "a"))
(summarize (fetch-page page))`;

const bySpan = (trace: EvalTrace, span: string) => trace.invocationLog.filter((i) => scopeId(i.node) === span);

beforeAll(() => configure({ enforceActions: "observed" }));
afterAll(() => configure({ enforceActions: "never" }));

describe("ExecutionCapture", () => {
  it("retains operand and output values the trace prunes", async () => {
    const capture = createExecutionCapture(["fetch-page", "summarize"]);
    expect((await run(SEQ, capture)).error).toBeUndefined();

    const [inner] = bySpan(capture, "fetch-page@4:13");
    // The prune ran: `define` exited and cleared its child's value.
    expect(inner!.value).toBeUndefined();
    const c = capture.captured(inner!)!;
    expect(text(c.output)).toBe("a!");
    expect(c.inputs.map((i) => text(i.value))).toEqual(["a"]);

    const [outer] = bySpan(capture, "summarize@5:0");
    const [nested] = bySpan(capture, "fetch-page@5:11");
    // The operand child's value is gone from the trace, kept by the capture.
    expect(nested!.value).toBeUndefined();
    expect(text(capture.captured(outer!)!.inputs[0]!.value)).toBe("a!!");
    // A symbol operand reads the value it resolved to.
    expect(text(capture.captured(nested!)!.inputs[0]!.value)).toBe("a!");
    expect(text(capture.captured(outer!)!.output)).toBe("s:a!!!");
  });

  it("designates by resolved callee: aliases yes, shadowing locals no, others no", async () => {
    const capture = createExecutionCapture(["fetch-page"]);
    await run(
      `${DEFS}(let ((g fetch-page)) (g "z"))
(let ((fetch-page (lambda (s) s))) (fetch-page "y"))`,
      capture,
    );
    const alias = bySpan(capture, "g@4:22")[0]!;
    expect(capture.isDesignated(alias)).toBe(true);
    expect(text(capture.captured(alias)!.output)).toBe("z!");
    const shadow = bySpan(capture, "fetch-page@5:35")[0]!;
    expect(capture.captured(shadow)).toBeUndefined();
    expect(capture.invocationLog.filter((i) => capture.captured(i)).length).toBe(1);
  });

  it("collection-literal operands have no observable value; apply hosts spread their list", async () => {
    const capture = createExecutionCapture(["count-it", "fetch-page"]);
    await run(
      `${DEFS}(define (count-it v) (vector-length v))
(count-it [1 (fetch-page "v")])
(apply fetch-page "q" '())`,
      capture,
    );
    const count = bySpan(capture, "count-it@5:0")[0]!;
    expect(capture.captured(count)!.inputs[0]!.hasValue).toBe(false);
    expect(capture.captured(count)!.output!.valueOf()).toBe(2);
    const applied = bySpan(capture, "apply@6:0")[0]!;
    const c = capture.captured(applied)!;
    expect(c.inputs.map((i) => text(i.value))).toEqual(["q"]);
    expect(text(c.output)).toBe("q!");
  });

  it("captures the error of a rejected step", async () => {
    const capture = createExecutionCapture(["explode"]);
    const { error } = await run(`${DEFS}(explode "b")`, capture);
    expect(String(error)).toMatch(/fail b/);
    const inv = bySpan(capture, "explode@4:0")[0]!;
    const c = capture.captured(inv)!;
    expect(inv.state).toBe("rejected");
    expect(c.hasOutput).toBe(false);
    expect(String(c.error)).toMatch(/fail b/);
    expect(text(c.inputs[0]!.value)).toBe("b");
  });

  it("keeps the program's own values (base exit result is returned)", async () => {
    const plain = new EvalTrace();
    const capture = createExecutionCapture(["fetch-page", "summarize"]);
    await run(SEQ, plain);
    await run(SEQ, capture);
    const last = (t: EvalTrace) => t.invocationLog.find((i) => scopeId(i.node) === "summarize@5:0")!;
    expect(text(last(capture).value)).toBe(text(last(plain).value));
    // Stamped provenance survived the wrapper: same producer points.
    expect([...last(capture).provenance].length).toBe([...last(plain).provenance].length);
    expect(last(capture).provenance.size).toBeGreaterThan(0);
  });

  it("ticks `revision` on enter AND exit — the final exit too", async () => {
    const capture = createExecutionCapture(["fetch-page"]);
    const seen: string[] = [];
    const dispose = reaction(
      () => capture.revision,
      () => {
        const top = capture.invocationLog.find((i) => scopeId(i.node) === "fetch-page@4:0");
        seen.push(top?.state ?? "none");
      },
    );
    await run(`${DEFS}(fetch-page "a")`, capture);
    dispose();
    expect(capture.revision).toBe(2 * capture.invocationLog.length);
    // The base trace only ticks on enter: its last tick would show the call still running.
    expect(seen.at(-1)).toBe("resolved");
    expect(capture.entries).toBe(capture.invocationLog.length);
  });

  it("reads live operands of a running step", async () => {
    const gate = new Gate();
    gate.hold = true;
    const capture = createExecutionCapture(["fetch-page", "summarize"]);
    const r = start(`${DEFS}(summarize (fetch-page "q"))`, capture, gate);
    await until(() => gate.held.length === 1);
    const outer = bySpan(capture, "summarize@4:0")[0]!;
    expect(capture.captured(outer)).toBeUndefined();
    expect(capture.liveInputs(outer)[0]!.hasValue).toBe(false);
    gate.release("q");
    await until(() => gate.held.length === 1);
    expect(text(capture.liveInputs(outer)[0]!.value)).toBe("q!");
    gate.releaseAll();
    await r.done;
    expect(text(capture.captured(outer)!.output)).toBe("s:q!!");
  });
});
