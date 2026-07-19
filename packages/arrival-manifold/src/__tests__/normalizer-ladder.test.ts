// normalizer/ladder — pins for the observe-only shape ladder (docs/response-normalizer.md
// §3.5, §6, §6.1, §6.2, §10.4). Every fixture traces to a named clause: monotonic rungs
// that never demote, monotonic key union, kind conflicts that announce instead of door,
// the ≤2-promotions-per-tool invariant (§7), and the V-ruling state-lifetime contract for
// tools/listChanged (§10.4). The module never throws — these tests assert that too.

import { describe, expect, it } from "vitest";

import { ShapeLadder } from "../normalizer/ladder.js";

describe("ShapeLadder — singleton rung and key-union monotonicity", () => {
  it("first object observation is singleton(object) and announces first-shape", () => {
    const ladder = new ShapeLadder();
    const announcement = ladder.observe("get_user", "h1", { id: 1 });

    expect(announcement).not.toBeNull();
    expect(announcement?.kind).toBe("first-shape");
    expect(announcement?.tool).toBe("get_user");

    const shape = ladder.get("get_user");
    expect(shape?.rung).toBe("singleton");
    expect(shape?.kind).toBe("object");
    expect([...(shape?.keys ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual(["id"]);
    expect(shape?.observations).toBe(1);
  });

  it("second object with a new key grows the key union with no announcement (silent T-widening)", () => {
    const ladder = new ShapeLadder();
    ladder.observe("get_user", "h1", { id: 1 });
    const second = ladder.observe("get_user", "h1", { id: 2, name: "ada" });

    // Chosen representation: pure key-union growth (no rung change, no kind conflict)
    // returns null — the Announcement vocabulary's "kind-widened" is reserved for a KIND
    // conflict, not a key addition, and ToolShape.keys already carries the fact for any
    // caller reading state directly.
    expect(second).toBeNull();

    const shape = ladder.get("get_user");
    expect(shape?.rung).toBe("singleton");
    expect([...(shape?.keys ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual(["id", "name"]);
    expect(shape?.observations).toBe(2);
  });

  it("never drops a previously observed key (monotonic union, never shrinks)", () => {
    const ladder = new ShapeLadder();
    ladder.observe("t", "h1", { a: 1, b: 2 });
    ladder.observe("t", "h1", { a: 1 }); // b absent this call — must NOT be forgotten
    expect([...(ladder.get("t")?.keys ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
  });
});

describe("ShapeLadder — vector rung", () => {
  it("array of objects as the FIRST observation goes straight to vector, element keys tracked", () => {
    const ladder = new ShapeLadder();
    const announcement = ladder.observe("search", "h1", [{ title: "a" }, { title: "b", year: 2020 }]);

    expect(announcement?.kind).toBe("first-shape");
    const shape = ladder.get("search");
    expect(shape?.rung).toBe("vector");
    expect(shape?.kind).toBe("object");
    expect([...(shape?.keys ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual(["title", "year"]);
  });

  it("singleton → later array → promotion announcement, rung becomes vector", () => {
    const ladder = new ShapeLadder();
    ladder.observe("search", "h1", { title: "a" });
    const promo = ladder.observe("search", "h1", [{ title: "a" }, { title: "b" }]);

    expect(promo).not.toBeNull();
    expect(promo?.kind).toBe("promotion");
    expect(promo?.text).toContain("From now every response is a vector");
    expect(promo?.text).toContain("map/filter/reduce");
    expect(ladder.get("search")?.rung).toBe("vector");
  });

  it("singleton → a 1-element array ALSO promotes to vector (§6 'or an array' — any array is vector evidence)", () => {
    const ladder = new ShapeLadder();
    ladder.observe("search", "h1", { title: "a" });
    const promo = ladder.observe("search", "h1", [{ title: "a" }]);

    expect(promo?.kind).toBe("promotion");
    expect(ladder.get("search")?.rung).toBe("vector");
  });

  it("vector → later 1-element array with an already-known shape → NO change, NO announcement", () => {
    const ladder = new ShapeLadder();
    ladder.observe("search", "h1", [{ title: "a" }, { title: "b" }]);
    const res = ladder.observe("search", "h1", [{ title: "c" }]);

    expect(res).toBeNull();
    expect(ladder.get("search")?.rung).toBe("vector");
  });
});

describe("ShapeLadder — nested rung (ceiling)", () => {
  it("vector → array-of-arrays promotes to nested", () => {
    const ladder = new ShapeLadder();
    ladder.observe("t", "h1", [{ a: 1 }, { a: 2 }]);
    const promo = ladder.observe("t", "h1", [[{ a: 1 }], [{ a: 2, b: 3 }]]);

    expect(promo?.kind).toBe("promotion");
    expect(promo?.text).toContain("nested");
    const shape = ladder.get("t");
    expect(shape?.rung).toBe("nested");
    expect([...(shape?.keys ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
  });

  it("further deep nesting stays at nested — never a 4th rung, no announcement", () => {
    const ladder = new ShapeLadder();
    ladder.observe("t", "h1", [{ a: 1 }, { a: 2 }]);
    ladder.observe("t", "h1", [[{ a: 1 }], [{ a: 2 }]]); // → nested
    const deeper = ladder.observe("t", "h1", [[[{ a: 1 }]], [[{ a: 2 }]]]);

    expect(deeper).toBeNull();
    expect(ladder.get("t")?.rung).toBe("nested");
  });
});

describe("ShapeLadder — kind conflicts never door (§3.5 audit NEW-2)", () => {
  it("object-asserted tool later yields a scalar → kind-widened announcement, no throw, rung unchanged", () => {
    const ladder = new ShapeLadder();
    ladder.observe("lookup_book", "h1", { title: "Dune", olid: "OL1M" });

    let thrown: unknown = null;
    let result: ReturnType<ShapeLadder["observe"]> = null;
    try {
      result = ladder.observe("lookup_book", "h1", "No book found for olid: OL999X");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeNull();
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("kind-widened");
    expect(result?.text).toContain("no door, no throw");

    const shape = ladder.get("lookup_book");
    expect(shape?.rung).toBe("singleton"); // unchanged — a kind conflict is not a rung event
    expect(shape?.kind).toBeUndefined(); // widened marker
    expect([...(shape?.kindsSeen ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual(["object", "scalar"]);
  });

  it("scalar-only tool (git-like): every call is a string → singleton(scalar), never promotes, no spurious announcements after the first", () => {
    const ladder = new ShapeLadder();
    const first = ladder.observe("git_log", "h1", "commit abc123\nAuthor: v");
    expect(first?.kind).toBe("first-shape");
    expect(ladder.get("git_log")?.rung).toBe("singleton");
    expect(ladder.get("git_log")?.kind).toBe("scalar");

    const messages = ["commit def456\nAuthor: v", "commit ghi789\nAuthor: v", "commit jkl012\nAuthor: v"];
    for (const message of messages) {
      const result = ladder.observe("git_log", "h1", message);
      expect(result).toBeNull();
    }

    const shape = ladder.get("git_log");
    expect(shape?.rung).toBe("singleton");
    expect(shape?.kind).toBe("scalar");
    expect(shape?.observations).toBe(4);
  });
});

describe("ShapeLadder — ≤2 promotions per tool, by construction (§7)", () => {
  it("driving singleton→vector→nested→(more nested) yields exactly 2 promotion announcements total", () => {
    const ladder = new ShapeLadder();
    const kinds: string[] = [];
    const record = (a: ReturnType<ShapeLadder["observe"]>) => {
      if (a) kinds.push(a.kind);
    };

    record(ladder.observe("t", "h1", { a: 1 })); // first-shape
    record(ladder.observe("t", "h1", [{ a: 1 }, { a: 2 }])); // promotion #1: singleton→vector
    record(ladder.observe("t", "h1", [[{ a: 1 }], [{ a: 2 }]])); // promotion #2: vector→nested
    record(ladder.observe("t", "h1", [[{ a: 1 }], [{ a: 2 }], [{ a: 3 }]])); // still nested
    record(ladder.observe("t", "h1", [[[{ a: 1 }]], [[{ a: 2 }]]])); // deeper nested, ceiling holds

    expect(kinds.filter((k) => k === "promotion").length).toBe(2);
    expect(ladder.get("t")?.rung).toBe("nested");
  });

  it("a direct skip from unseen to nested on the FIRST observation is first-shape, not a promotion", () => {
    const ladder = new ShapeLadder();
    const first = ladder.observe("t", "h1", [[{ a: 1 }], [{ a: 2 }]]);
    expect(first?.kind).toBe("first-shape");
    expect(ladder.get("t")?.rung).toBe("nested");
  });
});

describe("ShapeLadder — onListChanged state lifetime (§10.4 V ruling)", () => {
  it("same hash on relist preserves state (rung, keys, observation count)", () => {
    const ladder = new ShapeLadder();
    ladder.observe("t", "h1", { a: 1 });
    ladder.observe("t", "h1", { a: 1, b: 2 });
    expect(ladder.get("t")?.observations).toBe(2);

    ladder.onListChanged([{ name: "t", shapeHash: "h1" }]);

    const shape = ladder.get("t");
    expect(shape?.observations).toBe(2);
    expect(shape?.rung).toBe("singleton");
    expect([...(shape?.keys ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
  });

  it("a changed hash for the same tool name wipes state to fresh unseen", () => {
    const ladder = new ShapeLadder();
    ladder.observe("t", "h1", { a: 1 });
    expect(ladder.get("t")?.rung).toBe("singleton");

    ladder.onListChanged([{ name: "t", shapeHash: "h2" }]);

    const shape = ladder.get("t");
    expect(shape).toBeDefined();
    expect(shape?.rung).toBe("unseen");
    expect(shape?.observations).toBe(0);
    expect(shape?.keys.size).toBe(0);
  });

  it("a removed tool is archived, and untracked", () => {
    const ladder = new ShapeLadder();
    ladder.observe("t", "hX", { a: 1 });
    ladder.onListChanged([]); // tool disappears from the list entirely
    expect(ladder.get("t")).toBeUndefined();
  });

  it("re-introduction under the SAME name with the SAME hash re-attaches (observations survive)", () => {
    const ladder = new ShapeLadder();
    ladder.observe("t", "hX", { a: 1 });
    ladder.observe("t", "hX", { a: 1, b: 2 });
    ladder.onListChanged([]); // removed
    expect(ladder.get("t")).toBeUndefined();

    ladder.onListChanged([{ name: "t", shapeHash: "hX" }]); // re-introduced, same hash
    const shape = ladder.get("t");
    expect(shape?.observations).toBe(2);
    expect(shape?.rung).toBe("singleton");
    expect([...(shape?.keys ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
  });

  it("re-introduction under a DIFFERENT name with the SAME hash re-attaches — hash is the cache key, name is incidental", () => {
    const ladder = new ShapeLadder();
    ladder.observe("toolA", "hX", { a: 1 });
    ladder.observe("toolA", "hX", { a: 1, b: 2 });
    ladder.observe("toolA", "hX", { a: 1, b: 2, c: 3 });
    expect(ladder.get("toolA")?.observations).toBe(3);

    ladder.onListChanged([]); // toolA vanishes
    ladder.onListChanged([{ name: "toolB", shapeHash: "hX" }]); // toolB appears, same hash

    expect(ladder.get("toolA")).toBeUndefined();
    const reattached = ladder.get("toolB");
    expect(reattached).toBeDefined();
    expect(reattached?.observations).toBe(3); // survived — proves it's the archived shape, not fresh
    expect(reattached?.rung).toBe("singleton");
    expect([...(reattached?.keys ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b", "c"]);
  });

  it("a tool present with a hash that matches no archive entry starts fresh on first observe (no false reattachment)", () => {
    const ladder = new ShapeLadder();
    ladder.onListChanged([{ name: "brand_new_tool", shapeHash: "never-seen-before" }]);
    // Not pre-created — lazy creation on first observe(), per the module's design.
    expect(ladder.get("brand_new_tool")).toBeUndefined();

    const first = ladder.observe("brand_new_tool", "never-seen-before", { x: 1 });
    expect(first?.kind).toBe("first-shape");
    expect(ladder.get("brand_new_tool")?.rung).toBe("singleton");
  });
});

describe("ShapeLadder — never throws (observe-only contract, §3.5/§6.2)", () => {
  it("handles a heterogeneous stream of scalars, objects, and arrays for the same tool without ever throwing", () => {
    const ladder = new ShapeLadder();
    const values: unknown[] = [
      "opaque text",
      { status: "ok" },
      [{ status: "ok" }, { status: "warn" }],
      "another opaque string",
      null,
      42,
      [[{ a: 1 }], "not-an-object-element-array" as unknown],
    ];

    expect(() => {
      for (const v of values) ladder.observe("chaotic_tool", "h1", v);
    }).not.toThrow();

    // The ladder never demotes even under this chaos — once structure was observed
    // (object/array), it stays structure-asserted, per OQ1's "structure wins".
    const shape = ladder.get("chaotic_tool");
    expect(shape?.rung).not.toBe("unseen");
  });
});
