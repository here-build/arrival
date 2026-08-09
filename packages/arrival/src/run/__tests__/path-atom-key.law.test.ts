/**
 * LAW — Phase 5 reactivity X0: path-atom key & notify algebra (gate 5a).
 *
 * Suite: docs/working-proposals/cqs-reactivity/test-suite-design/reactivity/SUITE.md §X0
 * Product: run/path-atom-bus.ts — key = serializeResourcePath verbatim (RX-KEY).
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  pathsOverlap,
  serializeResourcePath,
  type ResourcePath,
} from "../resource-paths.js";
import {
  atomKey,
  keysArePrefixRelated,
  wouldNotify,
  isPathAtomKey,
  paramAtomKey,
} from "../path-atom-bus.js";

const p = (...segs: string[]): ResourcePath => segs;

/** String segments only (F-RX2 domain). Avoid empty. */
const stringSeg = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((s) => s.length > 0);
const stringPath = fc.array(stringSeg, { minLength: 1, maxLength: 4 });

describe("X0 — path-atom key algebra (5a)", () => {
  it("X-KEY-≡-FOOTPRINT — atomKey === serializeResourcePath", () => {
    const samples: ResourcePath[] = [
      p("db", "projects", "1"),
      p("a/b", "c"),
      p("x"),
      [],
    ];
    for (const path of samples) {
      expect(atomKey(path)).toBe(serializeResourcePath(path));
    }
    fc.assert(
      fc.property(stringPath, (path) => {
        expect(atomKey(path)).toBe(serializeResourcePath(path));
      }),
    );
  });

  it("X-KEY-STABLE — structural equality; independent of array identity", () => {
    const a = p("db", "projects", "1");
    const b = ["db", "projects", "1"] as const;
    expect(atomKey(a)).toBe(atomKey(b));
    expect(atomKey(a)).toBe(atomKey([...a]));
  });

  it("X-KEY-INJECTIVE — quoting terminates the segment (a/b ≠ a,b)", () => {
    expect(atomKey(p("a/b"))).not.toBe(atomKey(p("a", "b")));
    expect(atomKey(p("a/b"))).toBe('"a/b"');
    expect(atomKey(p("a", "b"))).toBe('"a"/"b"');
  });

  it("X-KEY-PREFIX — over string segments: pathsOverlap ⟺ keys prefix-related", () => {
    const parent = p("db", "projects");
    const child = p("db", "projects", "1");
    const sib = p("db", "projects", "2");
    expect(pathsOverlap(parent, child)).toBe(true);
    expect(keysArePrefixRelated(atomKey(parent), atomKey(child))).toBe(true);
    expect(pathsOverlap(child, sib)).toBe(false);
    expect(keysArePrefixRelated(atomKey(child), atomKey(sib))).toBe(false);
  });

  it("X-KEY-STRING-INT — project vs projects not prefix-related at key level", () => {
    const a = atomKey(p("db", "project"));
    const b = atomKey(p("db", "projects"));
    expect(pathsOverlap(p("db", "project"), p("db", "projects"))).toBe(false);
    expect(keysArePrefixRelated(a, b)).toBe(false);
  });

  it("X-KEY-NONSTRING — keys may be string-prefix-related while pathsOverlap is false", () => {
    // Smuggle non-string segments past the type (strictCQSstrings would reject at runtime).
    const a = ["db", 1] as unknown as ResourcePath;
    const b = ["db", 12] as unknown as ResourcePath;
    expect(pathsOverlap(a, b)).toBe(false);
    const ka = atomKey(a);
    const kb = atomKey(b);
    // JSON.stringify(1)="1", JSON.stringify(12)="12" → "…/1" is a string prefix of "…/12"
    expect(keysArePrefixRelated(ka, kb)).toBe(true);
  });

  it("X-KEY-EMPTY — serialize empty is live string; prefix-related to no path key", () => {
    expect(serializeResourcePath([])).toBe("[]");
    expect(atomKey([])).toBe("[]");
    expect(keysArePrefixRelated("[]", atomKey(p("db")))).toBe(false);
    expect(keysArePrefixRelated(atomKey(p("db")), "[]")).toBe(false);
    expect(keysArePrefixRelated("[]", "[]")).toBe(false);
  });

  it("X-KEY-PARAM-NS — param keys are prefix-related to no path key by construction", () => {
    const pathKeys = [atomKey(p("db", "x")), atomKey(p("a")), atomKey([])];
    const param = paramAtomKey("limit");
    expect(isPathAtomKey(param)).toBe(false);
    for (const pk of pathKeys) {
      expect(isPathAtomKey(pk)).toBe(pk === "[]" || pk.startsWith('"'));
      expect(keysArePrefixRelated(param, pk)).toBe(false);
    }
    expect(param.startsWith('"')).toBe(false);
    expect(param).not.toBe("[]");
  });

  it("X-NOTIFY-SOUND / COMPLETE — wouldNotify ⟺ ∃ pathsOverlap", () => {
    const write = p("db", "projects", "1");
    const subsHit = [p("db", "projects"), p("fs", "x")];
    const subsMiss = [p("db", "users"), p("fs", "x")];
    expect(wouldNotify(write, subsHit)).toBe(true);
    expect(wouldNotify(write, subsMiss)).toBe(false);
    expect(wouldNotify(write, [])).toBe(false);
  });

  it("X-NOTIFY-SIB — sibling write → no notify", () => {
    expect(wouldNotify(p("db", "a", "1"), [p("db", "a", "2")])).toBe(false);
  });

  it("F-RX1 — key stability + injectivity over generated segments", () => {
    fc.assert(
      fc.property(stringPath, stringPath, (a, b) => {
        expect(atomKey(a)).toBe(atomKey([...a]));
        // injectivity: equal keys ⇒ equal paths (segment-wise)
        if (atomKey(a) === atomKey(b)) {
          expect(a).toEqual(b);
        }
      }),
    );
  });

  it("F-RX2 — string segments: pathsOverlap ⟺ keysArePrefixRelated", () => {
    fc.assert(
      fc.property(stringPath, stringPath, (a, b) => {
        expect(pathsOverlap(a, b)).toBe(keysArePrefixRelated(atomKey(a), atomKey(b)));
      }),
    );
  });

  it("F-RX3 — wouldNotify sound and complete vs pathsOverlap", () => {
    fc.assert(
      fc.property(stringPath, fc.array(stringPath, { maxLength: 5 }), (w, subs) => {
        const expected = subs.some((q) => pathsOverlap(w, q));
        expect(wouldNotify(w, subs)).toBe(expected);
      }),
    );
  });

  it("F-RX1/F-RX2 over MIXED segments — soundness survives, completeness does not", () => {
    // 5a checklist #5: the generators must include non-string segments, because that is
    // where the string bridge stops being an equivalence. Over mixed segments only the
    // FORWARD direction is a theorem — `pathsOverlap ⟹ keys prefix-related`. The converse
    // is false (X-KEY-NONSTRING), which is the whole reason RX-STRICT exists.
    const mixedSeg = fc.oneof(
      fc.string({ minLength: 1, maxLength: 4 }),
      fc.integer({ min: 0, max: 200 }),
    );
    const mixedPath = fc.array(mixedSeg, { minLength: 1, maxLength: 4 });
    fc.assert(
      fc.property(mixedPath, mixedPath, (rawA, rawB) => {
        const a = rawA as unknown as ResourcePath;
        const b = rawB as unknown as ResourcePath;
        // F-RX1 — stability and injectivity hold regardless of segment type.
        expect(atomKey(a)).toBe(atomKey([...a] as unknown as ResourcePath));
        if (atomKey(a) === atomKey(b)) expect(a).toEqual(b);
        // F-RX2, forward half only.
        if (pathsOverlap(a, b)) {
          expect(keysArePrefixRelated(atomKey(a), atomKey(b))).toBe(true);
        }
      }),
    );
    // The converse is NOT a theorem — one witness is enough to keep it un-promoted.
    const sub = ["db", 12] as unknown as ResourcePath;
    const write = ["db", 1] as unknown as ResourcePath;
    expect(keysArePrefixRelated(atomKey(write), atomKey(sub))).toBe(true);
    expect(pathsOverlap(write, sub)).toBe(false);
  });

  it("N-RX-NO-INLANG — derive/react/latest are unbound (bare eval, no reactivity infra)", async () => {
    const { exec } = await import("../../eval/generator-exec.js");
    for (const form of ["derive", "react", "latest"]) {
      await expect(exec(form)).rejects.toThrow(/unbound variable/i);
    }
  });
});
