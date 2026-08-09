/**
 * LAW — resource path producers are rosetta-only (suite S2).
 * Natives / sequences cannot declare queries? / effects?.
 */
import { describe, it, expect } from "vitest";
import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import { ResourcePathDeclarationError } from "../resource-paths.js";

describe("resource-path bake (S2)", () => {
  it("P-BAKE-OK — rosetta with Q only / E only / both defines", () => {
    expect(() =>
      symbol.rosetta`rp-q: `({
        input: [z.string],
        output: [z.string],
        queries: (s) => [["d", s]],
      }, (s) => s),
    ).not.toThrow();

    expect(() =>
      symbol.rosetta`rp-e: `({
        input: [z.string],
        output: [z.undefinedResult],
        effects: (s) => [["d", s]],
      }, () => undefined),
    ).not.toThrow();

    expect(() =>
      symbol.rosetta`rp-both: `({
        input: [z.string],
        output: [z.string],
        queries: (s) => [["d", s]],
        effects: (s) => [["d", s]],
      }, (s) => s),
    ).not.toThrow();
  });

  it("N-I9 — native cannot declare Q / E / both", () => {
    expect(() =>
      symbol.native`rp-nat-q: `({
        input: [z.schemeValue],
        output: [z.schemeValue],
        queries: () => [["x"]],
      } as any, (x) => x),
    ).toThrow(ResourcePathDeclarationError);

    expect(() =>
      symbol.native`rp-nat-e: `({
        input: [z.schemeValue],
        output: [z.schemeValue],
        effects: () => [["x"]],
      } as any, (x) => x),
    ).toThrow(ResourcePathDeclarationError);

    expect(() =>
      symbol.native`rp-nat-both: `({
        input: [z.schemeValue],
        output: [z.schemeValue],
        queries: () => [["x"]],
        effects: () => [["x"]],
      } as any, (x) => x),
    ).toThrow(ResourcePathDeclarationError);
  });

  it("N-I9 — sequence cannot declare path axes (Q / E / both)", () => {
    expect(() =>
      symbol.sequence`rp-seq-q: `({
        input: [z.schemeValue],
        output: [z.schemeValue],
        queries: () => [["x"]],
      } as any, (args) => args[0]),
    ).toThrow(ResourcePathDeclarationError);

    expect(() =>
      symbol.sequence`rp-seq-e: `({
        input: [z.schemeValue],
        output: [z.schemeValue],
        effects: () => [["x"]],
      } as any, (args) => args[0]),
    ).toThrow(ResourcePathDeclarationError);

    expect(() =>
      symbol.sequence`rp-seq-both: `({
        input: [z.schemeValue],
        output: [z.schemeValue],
        queries: () => [["x"]],
        effects: () => [["x"]],
      } as any, (args) => args[0]),
    ).toThrow(ResourcePathDeclarationError);
  });

  it("N-I9 — define cannot declare path axes", () => {
    expect(() =>
      symbol.define`rp-def-q: `({
        input: [z.schemeValue],
        output: [z.schemeValue],
        queries: () => [["x"]],
      } as any, "(lambda (s) s)"),
    ).toThrow(ResourcePathDeclarationError);

    expect(() =>
      symbol.define`rp-def-e: `({
        input: [z.schemeValue],
        output: [z.schemeValue],
        effects: () => [["x"]],
      } as any, "(lambda (s) s)"),
    ).toThrow(ResourcePathDeclarationError);
  });

  it("N-I9 — declaration error is contract-shape, not other", () => {
    try {
      symbol.native`rp-cat: `({
        input: [z.schemeValue],
        output: [z.schemeValue],
        queries: () => [["x"]],
      } as any, (x) => x);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ResourcePathDeclarationError);
      expect((err as ResourcePathDeclarationError)["arrival/error-category"]).toBe("contract-shape");
    }
  });
});
