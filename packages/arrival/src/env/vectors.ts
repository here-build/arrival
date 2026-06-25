/**
 * Vector value-domain primitives (R7RS Section 6.8) — extracted verbatim from
 * the interpreter's \`wrappedOps\` hot path. A vector is exactly a boxed
 * \`SchemeVector\` so the container carries provenance and hosts algebra
 * instances. The mutating members of the family (\`vector-set!\`,
 * \`vector-fill!\`, \`vector-copy!\`) are OMITTED by the purity invariant (frozen
 * entities, doored in core.ts); only the non-mutating constructors,
 * accessors, and the higher-order \`vector-map\` / \`vector-for-each\` (which await
 * async membrane callbacks before settling) live here.
 *
 * MIGRATED to the \`symbol.native\` API: each op declares a SCHEME-IDENTITY zod
 * contract (no codec, no validation — "zod for types purely") and an impl bound
 * raw exactly as the old \`{ value }\` form. Vector args are \`z.svector\`, indices
 * the \`schemeNumber\` tower, predicate/length returns the JS-boolean/number
 * scheme-zod codecs (decoded type \`boolean\`/\`number\`, matching the impls). The
 * representation-blind boundaries — \`asVector\`-coerced variadic/rest vectors
 * (\`vector-append\`, the HOF rest) and elements/list returns — are \`z.unknown()\`,
 * which keeps the bodies' \`unknown[]\` signatures byte-for-byte. The HOF callback
 * is the types-only \`z.custom\` procedure. Bodies are reproduced byte-for-byte.
 */

import * as z from "../common/scheme-zod.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { ctxOf } from "../values/primitives/AValue.js";
import { symbol } from "../common/symbol.js";
import { AVector } from "../values/primitives/AVector.js";
import { AString } from "../values/primitives/AString.js";
import { type SchemeValue } from "../values/types.js";
import { ACharacter } from "../values/primitives/ACharacter.js";
import type { AExact } from "../values/numbers.js";
import { APair } from "../values/primitives/APair.js";
import { is_promise } from "../eval/guards.js";
import { promise_all } from "../utils/promises.js";
import invariant from "tiny-invariant";
import {
  assertAllocatable,
  asVector,
  charValue,
  stringValue,
  toIndex,
  withInputProvenance,
} from "../values/op-helpers.js";

import { EnvCapability } from "../common/capability.js";

export default new EnvCapability("scheme/vectors", {
  symbols: {
    "make-vector": symbol.native`make-vector: a vector of length k, each slot fill`(
      { input: [z.schemeNumber, z.unknown().optional()], output: [z.svector] },
      (k: unknown, fill?: unknown): AVector => {
        const len = Number(typeof k === "number" ? k : (k as AExact).valueOf());
        // O(1) cap check BEFORE Array.from materializes \`len\` slots — see
        // assertAllocatable. \`Array.from({length})\` on an oversized count is the
        // >10s hang the audit caught.
        assertAllocatable(len, "make-vector");
        const arr = Array.from({ length: len }) as SchemeValue[];
        if (fill !== undefined) {
          arr.fill(fill);
        }
        // Boxed into SchemeVector so the container carries provenance and hosts
        // algebra instances. Elements (if AValues) still carry their own provenance.
        return withInputProvenance([fill], new AVector(CONSTANT_CTX, arr));
      },
    ),

    vector: symbol.native`vector: a vector of the given objects`(
      { input: z.array(z.unknown()), output: [z.svector] },
      (...objs: unknown[]): AVector => {
        return withInputProvenance(objs, new AVector(CONSTANT_CTX, [...objs] as SchemeValue[]));
      },
    ),

    "vector-append": symbol.native`vector-append: concatenation of the given vectors`(
      { input: z.array(z.unknown()), output: [z.svector] },
      (...vectors: unknown[]): AVector => {
        const arrays = vectors.map((v) => asVector(v, "vector-append"));
        return withInputProvenance(vectors, new AVector(CONSTANT_CTX, ([] as SchemeValue[]).concat(...arrays)));
      },
    ),

    "vector?": symbol.native`vector?: #t iff obj is a vector`(
      { input: [z.unknown()], output: [z.boolean] },
      (obj: unknown): boolean => {
        // instanceof-only (S10): a vector is exactly a boxed SchemeVector. Unlike a
        // raw Uint8Array (which genuinely IS bytevector-like, so bytevector? stays
        // polymorphic), a raw JS array is an R7RS *list* / FFI array at the membrane,
        // NOT a vector — so it correctly answers #f here. asVector still coerces a
        // raw array defensively for any value that bypasses producers.
        return obj instanceof AVector;
      },
    ),

    "vector-length": symbol.native`vector-length: number of elements in vec`(
      { input: [z.svector], output: [z.number] },
      (vec: unknown): number => {
        return asVector(vec, "vector-length").length;
      },
    ),

    "vector-ref": symbol.native`vector-ref: the element of vec at index k`(
      { input: [z.svector, z.schemeNumber], output: [z.unknown()] },
      (vec: unknown, k: unknown): unknown => {
        const arr = asVector(vec, "vector-ref");
        const idx = typeof k === "number" ? k : (k as AExact).valueOf();
        return arr[idx as number];
      },
    ),

    // vector-set! / vector-fill! / vector-copy! — OMITTED by the purity invariant
    // (frozen entities); doored in core.ts. Non-mutating vector-copy stays.

    "vector->list": symbol.native`vector->list: a list of vec's elements in [start, end)`(
      { input: [z.svector, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.unknown()] },
      (vec: unknown, start?: unknown, end?: unknown): unknown => {
        const arr = asVector(vec, "vector->list");
        const s = start === undefined ? 0 : toIndex(start);
        const e = end === undefined ? arr.length : toIndex(end);
        return APair.fromArray(ctxOf(vec), arr.slice(s, e));
      },
    ),

    "list->vector": symbol.native`list->vector: a vector of the list's elements`(
      { input: [z.union([z.pair, z.nil])], output: [z.svector] },
      (list: unknown): AVector => {
        const result: SchemeValue[] = [];
        let current = list;
        while (current instanceof APair) {
          result.push(current.car);
          current = current.cdr;
        }
        return withInputProvenance([list], new AVector(CONSTANT_CTX, result));
      },
    ),

    "vector->string": symbol.native`vector->string: a string from vec's character elements in [start, end)`(
      { input: [z.svector, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.schemeString] },
      (vec: unknown, start?: unknown, end?: unknown): AString => {
        const arr = asVector(vec, "vector->string");
        const s = start === undefined ? 0 : toIndex(start);
        const e = end === undefined ? arr.length : toIndex(end);
        let result = "";
        for (let i = s; i < e; i++) {
          const ch = arr[i];
          result += ch instanceof ACharacter ? charValue(ch) : String(ch);
        }
        return withInputProvenance([vec], new AString(CONSTANT_CTX, result));
      },
    ),

    "string->vector": symbol.native`string->vector: a vector of str's characters in [start, end)`(
      { input: [z.schemeString, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.svector] },
      (str: unknown, start?: unknown, end?: unknown): AVector => {
        const s_str = stringValue(str);
        const s = start === undefined ? 0 : toIndex(start);
        const e = end === undefined ? s_str.length : toIndex(end);
        const result: SchemeValue[] = [];
        for (let i = s; i < e; i++) {
          result.push(new ACharacter(CONSTANT_CTX, s_str[i]));
        }
        return withInputProvenance([str], new AVector(CONSTANT_CTX, result));
      },
    ),

    "vector-copy": symbol.native`vector-copy: a fresh copy of vec over [start, end)`(
      { input: [z.svector, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.svector] },
      (vec: unknown, start?: unknown, end?: unknown): AVector => {
        const arr = asVector(vec, "vector-copy");
        const s = start === undefined ? 0 : toIndex(start);
        const e = end === undefined ? arr.length : toIndex(end);
        return withInputProvenance([vec], new AVector(CONSTANT_CTX, arr.slice(s, e)));
      },
    ),

    // vector-copy! — OMITTED by the purity invariant (mutates its destination);
    // doored in core.ts. The non-mutating \`vector-copy\` (above) stays.

    "vector-map": symbol.native`vector-map: apply proc across the vectors, collecting results into a new vector`(
      { input: z.tuple([z.custom<(...args: unknown[]) => SchemeValue>()], z.unknown()), output: [z.svector] },
      (proc: (...args: unknown[]) => SchemeValue, ...vectors: unknown[]): AVector | Promise<AVector> => {
        invariant(vectors.length > 0, "vector-map: expected at least one vector argument");
        const arrays = vectors.map((v) => asVector(v, "vector-map"));
        const minLen = Math.min(...arrays.map((a) => a.length));
        const result: SchemeValue[] = [];
        for (let i = 0; i < minLen; i++) {
          const elements = arrays.map((a) => a[i]);
          result.push(proc(...elements));
        }
        // proc may be an async membrane callback → its results are JS Promises. Mirror
        // the list \`map\` (stdlib.ts): if any slot is a promise, await them all so the
        // returned vector holds SETTLED values (not "[object Promise]") and provenance
        // is preserved. (errors-as-doors note: silent leak defeats boxing goal-b.)
        if (result.some(is_promise)) {
          return (promise_all(result) as Promise<SchemeValue[]>).then((resolved) =>
            withInputProvenance(vectors, new AVector(CONSTANT_CTX, resolved)),
          );
        }
        return withInputProvenance(vectors, new AVector(CONSTANT_CTX, result));
      },
    ),

    "vector-for-each": symbol.native`vector-for-each: apply proc across the vectors for effect`(
      { input: z.tuple([z.custom<(...args: unknown[]) => unknown>()], z.unknown()), output: [z.void()] },
      (proc: (...args: unknown[]) => unknown, ...vectors: unknown[]): void | Promise<void> => {
        invariant(vectors.length > 0, "vector-for-each: expected at least one vector argument");
        const arrays = vectors.map((v) => asVector(v, "vector-for-each"));
        const minLen = Math.min(...arrays.map((a) => a.length));
        const pending: unknown[] = [];
        for (let i = 0; i < minLen; i++) {
          const elements = arrays.map((a) => a[i]);
          const ret = proc(...elements);
          if (is_promise(ret)) pending.push(ret);
        }
        // Await any async side effects before returning, so for-each does not complete
        // while promises are still outstanding.
        if (pending.length > 0) return (promise_all(pending) as Promise<unknown[]>).then(() => undefined);
      },
    ),
  },
});
