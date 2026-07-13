// polyglot-clojure Contract.type pins — harvest signatures for HOF stdlib
// completion (mapv/filterv/partial/juxt). Runtime behavior stays in polyglot-clojure.test.ts.

import { describe, expect, it } from "vitest";
import dedent from "dedent";
import polyglotClojure from "../polyglot-clojure.js";
import type { AEntity } from "../../common/symbol.js";
import { signatureOf } from "../../type-layer/schema-to-ts.js";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const symbolsSpec = polyglotClojure.spec.symbols;
const symbols = (
  typeof symbolsSpec === "function" ? symbolsSpec({ configuration: {}, resources: {} } as never) : (symbolsSpec ?? {})
) as Record<string, AEntity>;

function defineDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`polyglot-clojure pack: no symbol named ${name}`);
  if (def.kind !== "define") throw new Error(`polyglot-clojure pack: ${name} is not a define def (got ${def.kind})`);
  return def;
}

describe("scheme/polyglot-clojure Contract.type — mapv/filterv/partial/juxt harvest", () => {
  it("mapv: map list arities → readonly vector", () => {
    expect(norm(signatureOf(defineDef("mapv")))).toBe(
      norm(dedent`
        {
          <T, B>(f: (x: T) => B, xs: List<T>): readonly B[];
          <A, B, R>(f: (a: A, b: B) => R, as: List<A>, bs: List<B>): readonly R[];
          <A, B, C, R>(f: (a: A, b: B, c: C) => R, as: List<A>, bs: List<B>, cs: List<C>): readonly R[];
        }
      `),
    );
  });

  it("filterv: filter guard arms → readonly vector", () => {
    expect(norm(signatureOf(defineDef("filterv")))).toBe(
      norm(dedent`
        {
          <T, S extends T>(p: (x: T) => x is S, xs: List<T>): readonly S[];
          <T>(p: (x: T) => unknown, xs: List<T>): readonly T[];
        }
      `),
    );
  });

  it("partial: always returns a function", () => {
    expect(norm(signatureOf(defineDef("partial")))).toBe(
      norm(dedent`
        {
          <A extends unknown[], R>(f: (...args: A) => R): (...args: A) => R;
          <A, B, R>(f: (a: A, b: B) => R, a: A): (b: B) => R;
          <A, B, C, R>(f: (a: A, b: B, c: C) => R, a: A): (b: B, c: C) => R;
          <A, B, C, R>(f: (a: A, b: B, c: C) => R, a: A, b: B): (c: C) => R;
          <A, B, C, R>(f: (a: A, b: B, c: C) => R, a: A, b: B, c: C): () => R;
          <R>(f: (...args: unknown[]) => R, ...fixed: unknown[]): (...more: unknown[]) => R;
        }
      `),
    );
  });

  it("juxt: fn rest → (...args) => List<…>", () => {
    expect(norm(signatureOf(defineDef("juxt")))).toBe(
      norm(dedent`
        {
          <A extends unknown[], R1>(f1: (...args: A) => R1): (...args: A) => List<R1>;
          <A extends unknown[], R1, R2>(f1: (...args: A) => R1, f2: (...args: A) => R2): (...args: A) => List<R1 | R2>;
          <A extends unknown[], R1, R2, R3>(f1: (...args: A) => R1, f2: (...args: A) => R2, f3: (...args: A) => R3): (...args: A) => List<R1 | R2 | R3>;
          (...fns: ((...args: unknown[]) => unknown)[]): (...args: unknown[]) => List<unknown>;
        }
      `),
    );
  });

  // comp is a CONSTANT define (eq? compose) — no Contract.type channel.
  it("comp: constant alias — no type override (callable false)", () => {
    const def = defineDef("comp");
    expect(def.callable).toBe(false);
    expect(def.type).toBeUndefined();
  });
});
