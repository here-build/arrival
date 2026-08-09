/**
 * The http-effect contract's PURE surface — `describeHttpEffect`, the `httpOptions`
 * arg coercion, and the inert guard — exercised as plain JS functions, no scheme
 * exec involved. (The membrane path — a real `(http/get …)` form crossing into a
 * stub resolver, incl. the scheme-Nil discipline — lives in http-capability.test.ts.)
 */
import { describe, expect, it } from "vitest";

import { describeHttpEffect, httpOptions, inertHttpResolver } from "../http-effect.js";

describe("describeHttpEffect — legible at-a-glance identity", () => {
  it("includes method + label + path", () => {
    expect(describeHttpEffect({ kind: "http", method: "GET", label: "weather-api", path: "/forecast" })).toBe(
      "http GET weather-api/forecast",
    );
  });
});

describe("httpOptions — faithful arg shaping", () => {
  it("absent / non-record opts ⇒ no request fields", () => {
    expect(httpOptions("GET", undefined)).toEqual({});
    expect(httpOptions("GET", null)).toEqual({});
    expect(httpOptions("GET", 42)).toEqual({});
  });

  it("keeps scalar query values verbatim (number/bool identity preserved for the content key)", () => {
    expect(httpOptions("GET", { query: { city: "berlin", days: 3, metric: true } })).toEqual({
      query: { city: "berlin", days: 3, metric: true },
    });
  });

  it("drops absent query entries so the canonical descriptor stays minimal", () => {
    expect(httpOptions("GET", { query: { city: "berlin", since: undefined, page: null } })).toEqual({
      query: { city: "berlin" },
    });
  });

  it("rejects a structured query value with a teaching error naming the key", () => {
    expect(() => httpOptions("GET", { query: { filter: { nested: true } } })).toThrowError(/query param "filter" must be a scalar/);
  });

  it("rejects a non-dict :query with a teaching error", () => {
    expect(() => httpOptions("GET", { query: [1, 2] })).toThrowError(/:query must be a dict of scalar values/);
  });

  it("String()s header scalars (HTTP header values are strings by spec)", () => {
    expect(httpOptions("GET", { headers: { accept: "application/json", retries: 3 } })).toEqual({
      headers: { accept: "application/json", retries: "3" },
    });
  });

  it("a read method (GET) drops a request body even if the program passed one", () => {
    expect(httpOptions("GET", { body: { name: "ada" } })).toEqual({});
  });

  it("a write method (POST) keeps a structured body verbatim", () => {
    const body = { name: "ada", tags: ["x", "y"] };
    expect(httpOptions("POST", { body })).toEqual({ body });
  });

  it("a write method (POST) treats null/undefined :body as no body", () => {
    expect(httpOptions("POST", { body: null })).toEqual({});
    expect(httpOptions("POST", { body: undefined })).toEqual({});
  });
});

describe("inertHttpResolver — the disarmed default", () => {
  it("throws a teaching error that names the effect and the arming door", () => {
    expect(() =>
      inertHttpResolver({}, { kind: "http", method: "GET", label: "weather-api", path: "/forecast" }),
    ).toThrowError(/http GET weather-api\/forecast: http effects are not enabled in this environment/);
    expect(() =>
      inertHttpResolver({}, { kind: "http", method: "GET", label: "weather-api", path: "/forecast" }),
    ).toThrowError(/buildArrivalSession\(\{ http \}\)/);
  });
});
