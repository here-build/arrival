// The dict family and `@values`/`@entries` over receivers the dict-literal tests never use:
// borrowed JS objects, Promise-valued members, an error object, and non-name keys.
//
// Promise-valued members are the async path: `memberEntries` waits for every read before
// building a result, so each case asserts SETTLED values. A leaked Promise would print as
// "[object Promise]" or decode as a Promise, never as the number.
import { describe, expect, it } from "vitest";

import type { ResolvingAmbient } from "../../AmbientRuntime.js";
import { applyCapability } from "../../../__tests__/_fresh-env.js";
import { execStateOverFrame } from "../../../eval/generator-exec.js";
import { jsToScheme, toJS } from "../../../membrane/rosetta.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { inferenceEnv } from "../../inference-env.js";
import polyglotRacket from "../../polyglot/polyglot-racket.js";

const base = inferenceEnv.child("dict-family-receivers");
await applyCapability(base, [polyglotRacket]);

let frame = 0;
function withObj(obj: Record<string, unknown>): ResolvingAmbient {
  return base.child(`dict-family-receivers-${frame++}`, { obj: jsToScheme(CONSTANT_CTX, obj) });
}

/** A Promise that is still pending when the read starts, so the read cannot finish synchronously. */
function later<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 5));
}

async function show(src: string, env: ResolvingAmbient = base): Promise<string> {
  return String((await execStateOverFrame(src, { env })).values[0]);
}

async function decode(src: string, env: ResolvingAmbient = base): Promise<unknown> {
  return toJS((await execStateOverFrame(src, { env })).values[0]!);
}

describe("dict family over a borrowed JS object", () => {
  it("reads keys, values, entries, count and membership through the object's own terms", async () => {
    const env = withObj({ a: 1, b: 2 });
    expect(await show("(dict-keys obj)", env)).toBe("(a b)");
    expect(await show("(dict-values obj)", env)).toBe("(1 2)");
    expect(await decode('(equal? (dict->alist obj) (list (cons "a" 1) (cons "b" 2)))', env)).toBe(true);
    expect(await show("(dict-count obj)", env)).toBe("2");
    expect(await show("(dict-ref obj :b)", env)).toBe("2");
    expect(await show("(dict-ref obj :zz 7)", env)).toBe("7");
    expect(await decode("(dict-has-key? obj :a)", env)).toBe(true);
    expect(await decode("(dict-has-key? obj :zz)", env)).toBe(false);
  });

  it("assoc-in builds a NEW dict and leaves the borrowed object unchanged", async () => {
    const env = withObj({ a: 1, b: 2 });
    expect(await show("(dict-ref (assoc-in obj (list :a) 9) :a)", env)).toBe("9");
    expect(await show("(dict-ref (assoc-in obj (list :a) 9) :b)", env)).toBe("2");
    expect(await show("(@ obj :a)", env)).toBe("1");
  });

  it("dict-values agrees with @values on the same object", async () => {
    const env = withObj({ x: 10, y: 20, z: 30 });
    expect(await decode("(equal? (dict-values obj) (vector->list (@values obj)))", env)).toBe(true);
  });
});

describe("Promise-valued members settle before the result is built", () => {
  it("@values and @entries", async () => {
    expect(await decode("(@values obj)", withObj({ a: later(1), b: 2 }))).toEqual([1, 2]);
    expect(await show("(cdr (vector-ref (@entries obj) 0))", withObj({ a: later(1), b: 2 }))).toBe("1");
  });

  it("dict-values and dict->alist", async () => {
    expect(await show("(dict-values obj)", withObj({ a: later(1), b: later(2) }))).toBe("(1 2)");
    expect(await show('(cdr (assoc "a" (dict->alist obj)))', withObj({ a: later(1), b: 2 }))).toBe("1");
  });

  it("assoc-in and %dict-set carry the settled sibling members into the new dict", async () => {
    expect(await show("(dict-ref (assoc-in obj (list :b) 3) :a)", withObj({ a: later(1), b: 2 }))).toBe("1");
    expect(await show("(dict-ref (%dict-set obj :c 3) :a)", withObj({ a: later(1) }))).toBe("1");
    expect(await show("(get-in (assoc-in obj (list :n :m) 5) (list :n :m))", withObj({ a: later(1) }))).toBe("5");
  });
});

describe("%dict-guard called directly", () => {
  it("returns a dict-shaped argument unchanged", async () => {
    expect(await show('(dict-count (%dict-guard "who" (dict :a 1 :b 2)))')).toBe("2");
    expect(await show('(dict-ref (%dict-guard "who" obj) :a)', withObj({ a: 4 }))).toBe("4");
  });

  it("throws the door text under the caller's name", async () => {
    await expect(show('(%dict-guard "my-verb" 1)')).rejects.toThrow(
      /^my-verb: expected a dict .* got a number — my-verb guards the dict shape/,
    );
  });
});

describe("member reads on receivers without member terms", () => {
  it("an error object has no members: @ is nil, @? is #f, @keys is empty", async () => {
    const err = '(guard (e (#t e)) (error "boom" 1))';
    expect(await show(`(@ ${err} :message)`)).toBe("()");
    expect(await decode(`(@? ${err} :message)`)).toBe(false);
    expect(await decode(`(vector-length (@keys ${err}))`)).toBe(0);
  });

  it("a nil key reads nothing", async () => {
    expect(await show("(@ (dict :a 1) '())")).toBe("()");
    expect(await decode("(@? (dict :a 1) '())")).toBe(false);
  });
});

describe("dict keys that are not keywords, symbols or strings", () => {
  it("a number key stringifies, so it reads back by its string name", async () => {
    expect(await show('(vector-ref (@keys (dict 1 "one")) 0)')).toBe("1");
    expect(await show('(dict-ref (dict 1 "one") "1")')).toBe("one");
  });
});
