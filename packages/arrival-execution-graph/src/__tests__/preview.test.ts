import { describe, expect, it } from "vitest";

import { preview } from "../GraphView.js";

describe("preview", () => {
  it("prints a boxed String as a quoted string", () => {
    // eslint-disable-next-line unicorn/new-for-builtins -- arrival boxes strings
    expect(preview(new String("hi"))).toBe('"hi"');
  });

  it("uses arrival's print protocol when the value answers it", () => {
    expect(preview({ "arrival/print": () => "(1 2 3)", provenance: {} })).toBe("(1 2 3)");
  });

  it("prints numbers and booleans as is, objects as compact records", () => {
    expect(preview(42)).toBe("42");
    expect(preview(true)).toBe("true");
    expect(preview({ a: 1, "b-c": "x" })).toBe('{a: 1, "b-c": "x"}');
  });

  it("prints host objects and arrays behind arrival's membrane, nesting summarized", () => {
    const host = (source: object) => ({ kind: Array.isArray(source) ? "vector" : "object", source });
    const inbox = { threads: [{ id: 1 }, { id: 2 }, { id: 3 }], nextPageToken: "p2", meta: { page: { n: 1 } } };
    expect(preview(host(inbox))).toBe('{threads: [3 items], nextPageToken: "p2", meta: {page: {…}}}');
    expect(preview(host([{ id: 1 }, [1]]))).toBe("[{id: 1}, [1 item]]");
    // A scheme list of host objects: the list in its written form, each element a record.
    const pair = (car: unknown, cdr: unknown) => ({ kind: "pair", car, cdr });
    expect(preview(pair(host({ id: 1 }), pair(host({ id: 2 }), { kind: "nil" })))).toBe("({id: 1} {id: 2})");
  });

  it("stops a long collection once the preview is full", () => {
    const text = preview(Array.from({ length: 1000 }, (_, i) => i));
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith("…")).toBe(true);
  });

  it("truncates long output", () => {
    const text = preview("x".repeat(500));
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith("…")).toBe(true);
  });
});
