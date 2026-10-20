// Polyglot by observation: an op whose argument is a LIST of arguments/elements takes any
// sequence a model hands it — a borrowed host array (AJSArray), a boxed vector `#(…)`, or a
// vector-like produced by a carrier-preserving `map` (PRINCIPLES P8). Clojure's `apply` takes any
// seq; so does ours. `map` itself keeps its carrier (a vector stays a vector) — only the CONSUMER
// reads the spine.
import { describe, expect, it } from "vitest";

import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { toJS, jsToScheme } from "../rosetta.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";

const run = async (code: string, bindings: Record<string, unknown> = {}) => {
  const state = await execState(code, {
    env: inferenceEnv.child(
      "list-of-args",
      Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, jsToScheme(CONSTANT_CTX, v)])),
    ),
  });
  return toJS(state.values.at(-1)!);
};
const fails = async (code: string, re: RegExp, bindings: Record<string, unknown> = {}) => {
  await expect(run(code, bindings)).rejects.toThrow(re);
};

const B = {
  xs: [1, 2, 3],
  ss: ["a", "b"],
  objs: [{ a: 1 }, { a: 2 }],
  ps: [
    [1, 2],
    [3, 4],
  ],
};

describe("apply: the final argument is any sequence", () => {
  it.each([
    ["(apply + xs)", 6],
    ["(apply + 1 xs)", 7],
    ["(apply string-append ss)", "ab"],
    ['(apply string-append (map (lambda (x) "a") objs))', "aa"],
    ['(apply string-append #("a" "b"))', "ab"],
    ["(apply max #(1 5 2))", 5],
    ["(apply + #())", 0],
    ["(apply + (vector))", 0],
    ["(apply + [])", 0],
    ["(apply vector xs)", [1, 2, 3]],
    ["(apply list #(1 2))", [1, 2]],
    [
      "(apply map list ps)",
      [
        [1, 3],
        [2, 4],
      ],
    ],
    ["(apply + (list 1 2))", 3],
  ])("%s", async (code, want) => {
    expect(await run(code, B)).toEqual(want);
  });

  it("map stays carrier-preserving: a host array maps to a vector-like, not a list", async () => {
    expect(await run('(list? (map (lambda (x) "a") objs))', B)).toBe(false);
  });
});

describe("other list-of-elements ops accept host arrays and vectors", () => {
  it.each([
    ["(list->vector xs)", [1, 2, 3]],
    ["(list->vector #(1 2))", [1, 2]],
    ["(append xs (list 9))", [1, 2, 3, 9]],
    ["(append (list 9) xs)", [9, 1, 2, 3]],
    ["(append #(1) #(2))", [1, 2]],
    ["(length xs)", 3],
    ["(length #(1 2))", 2],
    ["(reverse xs)", [3, 2, 1]],
    ["(reverse #(1 2))", [2, 1]],
    ["(list-ref xs 1)", 2],
    ["(list-ref #(1 2) 1)", 2],
    ["(list-tail xs 1)", [2, 3]],
    ["(member 2 xs)", [2, 3]],
    ["(assoc 1 ps)", [1, 2]],
    ["(reduce + 0 xs)", 6],
    ["(reduce + 0 #(1 2))", 3],
    ["(fold-right + 0 xs)", 6],
    ["(filter odd? xs)", [1, 3]],
    ["(filter odd? #(1 2 3))", [1, 3]],
    ["(remove odd? xs)", [2]],
    ["(delete 2 xs)", [1, 3]],
    ["(any odd? xs)", true],
    ["(every odd? #(1 3))", true],
    ["(take xs 2)", [1, 2]],
    ["(drop xs 2)", [3]],
    ["(last xs)", 3],
    ["(list-copy xs)", [1, 2, 3]],
    ["(append-map list xs)", [1, 2, 3]],
    ["(delete-duplicates xs)", [1, 2, 3]],
    ["(count odd? xs)", 2],
    ["(find odd? xs)", 1],
    ['(string-join ss ",")', "a,b"],
    ["(sort xs <)", [1, 2, 3]],
    ["(concatenate (list xs xs))", [1, 2, 3, 1, 2, 3]],
    ["(map + xs xs)", [2, 4, 6]],
  ])("%s", async (code, want) => {
    expect(await run(code, B)).toEqual(want);
  });
});

describe("improper-list door names the op and the way out", () => {
  it("a dotted tail names the tail value and the fix", async () => {
    await fails("(apply + (cons 1 2))", /list->array: can't convert improper list.*ends in 2.*'\(\)/);
  });
  it("a vector-like tail suggests vector->list", async () => {
    await fails("(apply + (cons 1 #(2)))", /list->array: can't convert improper list.*vector->list/);
  });
  it("names the calling op", async () => {
    await fails("(list->vector '(1 2 . 3))", /list->vector: can't convert improper list/);
  });
  it("is a TypeError, not a raw invariant", async () => {
    await fails("(apply + (cons 1 2))", /^(?!Invariant failed)/);
  });
});
