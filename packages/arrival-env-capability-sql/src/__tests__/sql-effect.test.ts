/**
 * The sql-effect contract's PURE surface — `describeSqlEffect`, the `sqlParams`
 * arg coercion, and the inert guard — exercised as plain JS functions, no scheme
 * exec involved. (The membrane path — a real `(sql/query …)` form crossing into a
 * stub resolver, incl. the scheme-Nil discipline — lives in sql-capability.test.ts.)
 */
import { describe, expect, it } from "vitest";

import { describeSqlEffect, inertSqlResolver, sqlParams } from "../sql-effect.js";

describe("describeSqlEffect — legible at-a-glance identity", () => {
  it("includes the label", () => {
    expect(describeSqlEffect({ kind: "sql", label: "analytics", query: "select 1", params: [] })).toBe("sql analytics");
  });
});

describe("sqlParams — positional bind shaping", () => {
  it("omitted ⇒ no binds", () => {
    expect(sqlParams(undefined)).toEqual([]);
  });

  it("a JS array binds each element", () => {
    expect(sqlParams([1, "a", true])).toEqual([1, "a", true]);
  });

  it("a bare scalar is sugar for a one-element list", () => {
    expect(sqlParams(42)).toEqual([42]);
  });

  it("null/undefined elements become SQL NULL (a legitimate bind)", () => {
    expect(sqlParams([null, undefined, 7])).toEqual([null, null, 7]);
  });

  it("rejects a composite element with a teaching error naming the position", () => {
    expect(() => sqlParams([1, { nested: true }])).toThrowError(/param \$2 must be a scalar/);
    expect(() => sqlParams([["a"]])).toThrowError(/param \$1 must be a scalar/);
  });
});

describe("inertSqlResolver — the disarmed default", () => {
  it("throws a teaching error that names the effect and the arming door", () => {
    expect(() => inertSqlResolver({}, { kind: "sql", label: "analytics", query: "select 1", params: [] })).toThrowError(
      /sql analytics: sql effects are not enabled in this environment/,
    );
    expect(() => inertSqlResolver({}, { kind: "sql", label: "analytics", query: "select 1", params: [] })).toThrowError(
      /buildArrivalSession\(\{ sql \}\)/,
    );
  });
});
