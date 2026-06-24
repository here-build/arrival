/**
 * Combinator ops — higher-order FP utilities and small list builders.
 *
 * This pack carries the pure functional combinators (\`complement\`, \`always\`,
 * \`once\`, \`flip\`, \`n-ary\`) alongside the lightweight list helpers \`single\`,
 * \`take\`, \`drop\`, and \`range\`. The list builders walk \`Pair\` chains via the
 * shared \`toIndex\` coercion (and mint exact integers through \`SchemeExact\` for
 * \`range\`); the higher-order combinators wrap an incoming \`Function\` and return
 * a renamed wrapper. Op bodies are reproduced verbatim from \`bridge.ts\`'s
 * \`wrappedOps\` so the interpreter's hot path is byte-for-byte preserved.
 *
 * MIGRATED to the \`symbol.native\` API: each op declares a SCHEME-IDENTITY zod
 * contract (no codec, no validation — "zod for types purely") and an impl bound
 * raw exactly as the old \`{ value }\` form. List args are typed \`Pair | Nil\`,
 * indices/counts the \`schemeNumber\` tower, and the wrapped/returned procedures
 * are the types-only \`z.custom\` function (no scheme-procedure identity primitive
 * exists). Bodies are reproduced byte-for-byte.
 */

import "../errors.js";
import * as z from "./scheme-zod.js";
import { symbol } from "./symbol.js";
import { SchemeExact } from "../values/numbers.js";
import { toIndex } from "../values/op-helpers.js";
import { Pair } from "../values/primitives/Pair.js";
import { Nil, nil } from "../values/primitives/Nil.js";
import { is_false } from "../eval/guards.js";
import { unpromise } from "../utils/promises.js";

import { EnvCapability } from "./capability.js";

export default new EnvCapability("scheme/combinators", {
  symbols: {
    single: symbol.native`single: #t iff list has exactly one element`(
      { input: [z.union([z.pair, z.nil])], output: [z.boolean] },
      (list: unknown): boolean => {
        // Provenance-stamped Nil clones (Nil instances that are NOT the canonical
        // singleton) would make \`single(Pair(x, nil-clone))\` falsely report false,
        // sending callers down the multi-element slow path. Use the structural
        // \`instanceof Nil\` guard.
        return list instanceof Pair && list.cdr instanceof Nil;
      },
    ),

    take: symbol.native`take: the first n elements of lst as a fresh list`(
      { input: [z.union([z.pair, z.nil]), z.schemeNumber], output: [z.union([z.pair, z.nil])] },
      (lst: unknown, n: unknown): Pair | typeof nil => {
        const count = toIndex(n);
        let result: Pair | typeof nil = nil;
        let tail: Pair | null = null;
        let current = lst;
        let i = 0;

        while (current instanceof Pair && i < count) {
          const newPair = new Pair(current.car, nil);
          if (tail === null) {
            result = newPair;
          } else {
            tail.cdr = newPair;
          }
          tail = newPair;
          current = current.cdr;
          i++;
        }
        return result;
      },
    ),

    drop: symbol.native`drop: the sublist of lst after the first n elements`(
      { input: [z.union([z.pair, z.nil]), z.schemeNumber], output: [z.unknown()] },
      (lst: unknown, n: unknown): unknown => {
        const count = toIndex(n);
        let current = lst;
        let i = 0;

        while (current instanceof Pair && i < count) {
          current = current.cdr;
          i++;
        }
        return current;
      },
    ),

    range: symbol.native`range: an exact-integer list [start, stop) by step (1- to 3-arg forms)`(
      { input: z.tuple([z.schemeNumber], z.unknown()), output: [z.union([z.pair, z.nil])] },
      (stopOrStart: unknown, ...rest: unknown[]): Pair | typeof nil => {
        let start: number, stop: number, step: number;

        if (rest.length === 0) {
          start = 0;
          stop = toIndex(stopOrStart);
          step = 1;
        } else if (rest.length === 1) {
          start = toIndex(stopOrStart);
          stop = toIndex(rest[0]);
          step = 1;
        } else {
          start = toIndex(stopOrStart);
          stop = toIndex(rest[0]);
          step = toIndex(rest[1]);
        }

        const result: number[] = [];

        if (start < stop && step > 0) {
          for (let i = start; i < stop; i += step) {
            result.push(i);
          }
        } else if (start > stop && step < 0) {
          for (let i = start; i > stop; i += step) {
            result.push(i);
          }
        }

        // Convert array to list
        if (result.length === 0) return nil;
        let list: Pair | typeof nil = nil;
        for (let i = result.length - 1; i >= 0; i--) {
          list = new Pair(new SchemeExact(BigInt(result[i])), list);
        }
        return list;
      },
    ),

    complement: symbol.native`complement: a predicate returning the boolean negation of fn`(
      { input: [z.custom<(...args: unknown[]) => unknown>()], output: [z.custom<(...args: unknown[]) => unknown>()] },
      (fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown => {
        // \`fn\` may be a scheme lambda, which returns a Promise to JS callers
        // (generator-lambda async return) — so unpromise before testing. And its
        // result may be a boxed SchemeBool (a truthy JS object), so negate via
        // is_false, not \`!\` (always false on an object). Both were latent: plain
        // \`!fn(...)\` failed for async predicates AND for boxed-bool ones.
        const result = (...args: unknown[]) => unpromise(fn(...args), is_false);
        Object.defineProperty(result, "name", { value: "complement" });
        return result;
      },
    ),

    always: symbol.native`always: a thunk that always returns constant`(
      { input: [z.unknown()], output: [z.custom<(...args: unknown[]) => unknown>()] },
      (constant: unknown): (...args: unknown[]) => unknown => {
        const result = () => constant;
        Object.defineProperty(result, "name", { value: "always" });
        return result;
      },
    ),

    once: symbol.native`once: a wrapper that runs fn at most once, caching its result`(
      { input: [z.custom<(...args: unknown[]) => unknown>()], output: [z.custom<(...args: unknown[]) => unknown>()] },
      (fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown => {
        let called = false;
        let result: unknown;
        const wrapped = (...args: unknown[]) => {
          if (!called) {
            called = true;
            result = fn(...args);
          }
          return result;
        };
        Object.defineProperty(wrapped, "name", { value: "once" });
        return wrapped;
      },
    ),

    flip: symbol.native`flip: fn with its first two arguments swapped`(
      { input: [z.custom<(...args: unknown[]) => unknown>()], output: [z.custom<(...args: unknown[]) => unknown>()] },
      (fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown => {
        const result = (a: unknown, b: unknown, ...rest: unknown[]) => fn(b, a, ...rest);
        Object.defineProperty(result, "name", { value: "flip" });
        return result;
      },
    ),

    "n-ary": symbol.native`n-ary: fn restricted to its first n arguments`(
      { input: [z.schemeNumber, z.custom<(...args: unknown[]) => unknown>()], output: [z.custom<(...args: unknown[]) => unknown>()] },
      (n: unknown, fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown => {
        const count = toIndex(n);
        const result = (...args: unknown[]) => fn(...args.slice(0, count));
        Object.defineProperty(result, "name", { value: "n-ary" });
        return result;
      },
    ),
  },
});
