// is_lambda recognizes a real lambda: a FUNCTION carrying the well-known LAMBDA
// brand (Symbol.for("arrival/lambda")). Set by the evaluator on every lambda it
// creates/wraps; read here and by the membrane. (Historically a string/symbol
// mix — the marker is now a single registry symbol.)
import { describe, expect, it } from "vitest";
import { is_lambda } from "../eval/guards.js";

describe("is_lambda recognizes a real lambda (was dead)", () => {
  it("a function with the LAMBDA symbol marker → true", () => {
    const fn = Object.assign(() => 0, { [Symbol.for("arrival/lambda")]: true });
    expect(is_lambda(fn)).toBe(true);
  });
  it("a function with a string \"__lambda__\" property → false (string marker retired)", () => {
    const fn = Object.assign(() => 0, { __lambda__: true });
    expect(is_lambda(fn)).toBe(false);
  });
  it("a plain function (no marker) → false", () => {
    expect(is_lambda(() => 0)).toBe(false);
  });
  it("a non-function with the LAMBDA marker → false (must be a function)", () => {
    expect(is_lambda({ [Symbol.for("arrival/lambda")]: true })).toBe(false);
  });
  it("null/undefined → false", () => {
    expect(is_lambda(null)).toBe(false);
    expect(is_lambda(undefined)).toBe(false);
  });
});
