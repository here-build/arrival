// render-observation — unit + round-trip coverage for the brace-style observation
// renderer (see ../render-observation.ts for the design rationale). The round-trip
// tests are the load-bearing ones: a rendered dict/list literal must PARSE under
// arrival's committed `{}`/`[]` reader grammar (docs/working-proposals/
// arrival-curly-vector-literals.md), closing the loop between what the model reads
// back and what it itself writes.
//
// String leaves round-trip too (arrival-serializer, 2026-07): toSExpr/formatSExpr now
// print strings as R7RS double-quoted literals (`"Ada"`) with full `\\`/`\"`/`\n`/`\t`/
// `\r` escaping, verified against arrival's own reader. This closes a gap the suite
// used to carve out deliberately — the earlier single-quote convention (`'Ada'`) did
// NOT re-parse (`exec("'hi'")` threw `expecting datum after '''`). See the positive
// test below.

import { exec, sandboxedEnv } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { renderObservation } from "../render-observation.js";

// `exec`'s `env` option is typed against arrival's concrete (intentionally UNEXPORTED)
// `Environment` class; `sandboxedEnv.inherit(...)` returns the public structural
// `SchemeEnv` contract it implements — same widen-then-narrow cast manifold-tool.ts
// itself needs at the one package-boundary crossing (see its ExecEnv comment).
type ExecEnv = NonNullable<Parameters<typeof exec>[1]>["env"];
const run = (env: unknown, expr: string) => exec(expr, { env: env as ExecEnv });

function freshEnv(): unknown {
  return sandboxedEnv.inherit("render-observation-test", {});
}

describe("renderObservation — plain JS values", () => {
  it("renders a flat dict as {:k v ...}", () => {
    expect(renderObservation({ a: 1, b: 2 })).toBe("{:a 1 :b 2}");
  });

  it("renders a flat array as [a b ...]", () => {
    expect(renderObservation([1, 2, 3])).toBe("[1 2 3]");
  });

  it("renders empty dict/list", () => {
    expect(renderObservation({})).toBe("{}");
    expect(renderObservation([])).toBe("[]");
  });

  it("renders nested dict-in-list and list-in-dict", () => {
    expect(renderObservation({ items: [1, { x: 2 }, 3], flag: true })).toBe("{:items [1 {:x 2} 3] :flag true}");
  });

  it("quotes a dict key that isn't a valid bare keyword, mirroring the reader's other admitted key shape", () => {
    expect(renderObservation({ "weird key!": 1 })).toBe('{"weird key!" 1}');
  });

  it("keeps a hyphenated/underscored key bare (both are valid keyword characters)", () => {
    expect(renderObservation({ "flight-number": 1, flight_id: 2 })).toBe("{:flight-number 1 :flight_id 2}");
  });
});

describe("renderObservation — real arrival exec() results", () => {
  it("renders a (dict ...) constructor result braced", async () => {
    const env = freshEnv();
    const [value] = await run(env, "(dict :a 1 :b 2)");
    expect(renderObservation(value)).toBe("{:a 1 :b 2}");
  });

  it("renders a (list ...) constructor result bracketed", async () => {
    const env = freshEnv();
    const [value] = await run(env, "(list 1 2 3)");
    expect(renderObservation(value)).toBe("[1 2 3]");
  });

  it("renders a {} / [] literal round-trip identically (both build the same value)", async () => {
    const env = freshEnv();
    const [value] = await run(env, "{:a 1 :b [2 3]}");
    expect(renderObservation(value)).toBe("{:a 1 :b [2 3]}");
  });

  it("renders nested values head-recursively at any depth (values-wrapped lists still bracket)", async () => {
    const env = freshEnv();
    const [value] = await run(env, "(partition odd? '(1 2 3 4))");
    expect(renderObservation(value)).toBe("(values\n  [1 3]\n  [2 4])");
  });
});

describe("renderObservation — round-trip sanity (renders PARSE under the arrival reader)", () => {
  it("a rendered nested dict/list literal parses back and evaluates to an equivalent value", async () => {
    const env = freshEnv();
    const [value] = await run(env, "(dict :a 1 :b (list 2 3 (dict :c 4)))");
    const rendered = renderObservation(value);
    expect(rendered).toBe("{:a 1 :b [2 3 {:c 4}]}");

    // Feed the rendered literal back through the reader/eval — a `(:k <rendered>)`
    // probe, exactly the shape a model would use to read a field off its own
    // previous observation.
    const [a] = await run(env, `(:a ${rendered})`);
    expect(renderObservation(a)).toBe("1");

    // `[...]` is a VECTOR literal (not a list — arrival-curly-vector-literals.md's
    // deliberate choice), so the rendered `:b` reads back as a vector: index with
    // vector-ref, not list accessors.
    const [nestedC] = await run(env, `(:c (vector-ref (:b ${rendered}) 2))`);
    expect(renderObservation(nestedC)).toBe("4");
  });

  it("a rendered flat list parses back as a vector and composes with vector ops", async () => {
    const env = freshEnv();
    const [value] = await run(env, "(list 10 20 30)");
    const rendered = renderObservation(value);
    expect(rendered).toBe("[10 20 30]");
    const [sum] = await run(env, `(vector-fold + 0 ${rendered})`);
    expect(renderObservation(sum)).toBe("60");
  });

  it("a rendered dict with a quoted odd key parses back via the reader's string-key form", async () => {
    const env = freshEnv();
    const rendered = renderObservation({ "weird key!": 42 });
    expect(rendered).toBe('{"weird key!" 42}');
    const [viaAt] = await run(env, `(@ ${rendered} "weird key!")`);
    expect(renderObservation(viaAt)).toBe("42");
  });

  it("a rendered STRING LEAF round-trips end-to-end — the preamble's field-accessor probe chain", async () => {
    // The exact probe shape preamble-honesty.test.ts pins: read a string field off a
    // dict, render it, feed the rendering back through the reader, and confirm it
    // evaluates to the identical string (not just "is defined" — genuinely re-parses).
    const env = freshEnv();
    const [name] = await run(env, '(:name {:name "Ada" :role "analyst"})');
    const rendered = renderObservation(name);
    expect(rendered).toBe('"Ada"');

    const [roundTripped] = await run(env, rendered);
    expect(renderObservation(roundTripped)).toBe('"Ada"');

    // A string containing the escape-worthy characters (quote, backslash, newline,
    // tab, CR) round-trips too — not just the happy-path bare-word case.
    const [tricky] = await run(env, String.raw`"a\"b\\c\nd\te\rf"`);
    const trickyRendered = renderObservation(tricky);
    const [trickyRoundTripped] = await run(env, trickyRendered);
    expect(renderObservation(trickyRoundTripped)).toBe(trickyRendered);
  });
});

describe("renderObservation — caps + shrink ride the brace notation natively", () => {
  it("reduces an oversize result to fit the budget WITHOUT leaving the brace notation", async () => {
    // SerializeOpts.format: the brace formatter is plugged into toSExprString's own
    // streaming caps + fair shrink-to-fit — no more parens fallback for oversize results.
    const env = freshEnv();
    const [value] = await run(env, String.raw`(map (lambda (x) (make-string 3000 #\a)) (iota 100))`);
    const rendered = renderObservation(value);
    expect(rendered).toMatch(/^#\| ⚠ output reduced to fit response budget/);
    expect(rendered).toMatch(/#\| \+\d+ more of \d+ \|#/);
    expect(rendered).not.toMatch(/\(list/);
    expect(rendered.split("\n")[1]?.startsWith("[")).toBe(true);
  });

  it("honors a caller-provided maxTotalChars budget", async () => {
    const env = freshEnv();
    const [value] = await run(env, "(iota 2000)");
    const roomy = renderObservation(value); // default 40k budget — renders in full
    expect(roomy).not.toContain("output reduced");
    const tight = renderObservation(value, { maxTotalChars: 500 });
    expect(tight).toMatch(/^#\| ⚠ output reduced to fit response budget/);
    expect(tight).toMatch(/#\| \+\d+ more of 2000 \|#/);
    expect(tight.split("\n")[1]?.startsWith("[")).toBe(true);
  });

  it("keeps a capped dict's truncation marker inside the braces", () => {
    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`key_${i}`, "v".repeat(400)]));
    const rendered = renderObservation(wide, { maxTotalChars: 2000 });
    // The marker is the LAST dict entry, immediately before the closing brace.
    expect(rendered).toContain(" more of 300 |#}");
  });

  it("an under-budget observation renders byte-identically to the uncapped formatter", () => {
    // ("two words" — a plain JS string that does NOT pass formatSExpr's bare-symbol
    // heuristic — pins the quoting; symbol-looking plain strings render bare, as before.)
    expect(renderObservation({ a: [1, 2, 3], b: "two words" })).toBe('{:a [1 2 3] :b "two words"}');
  });
});

describe("renderObservation — raw top-level string truncation now carries a remedy (regression: the pre-existing no-remedy gap)", () => {
  // A provenance-less native string (e.g. a bare JS string returned top-level, not boxed
  // in an AString) hits the shortcut branch in renderObservation directly — the ONE path
  // that, before this fix, emitted the factual `+N more chars` note with zero teaching
  // clause. It's now routed through the same collectionRemedyMode/stringRemedyMode gating
  // every other truncation path uses.
  const raw = "x".repeat(1000);

  it("verbose (default, unset mode) carries the full teaching sentence", () => {
    const rendered = renderObservation(raw, { maxTotalChars: 100 });
    expect(rendered).toContain("#| ⚠ output reduced: +900 more chars");
    expect(rendered).toContain(
      "slice the long string with substring, or scan it with string-contains, to pull just the part you need",
    );
  });

  it("compact mode keeps an exact-syntax action kernel, not a bare technique name (errors-as-doors: 'substring helps' is an anti-door)", () => {
    const rendered = renderObservation(raw, { maxTotalChars: 100, stringRemedyMode: "compact" });
    expect(rendered).toContain("(substring s 0 2000)");
    expect(rendered).toContain('(string-contains s "needle")');
    expect(rendered).not.toContain("slice the long string with substring");
  });

  it("suppressed mode drops the remedy clause but keeps the factual +N more chars note", () => {
    const rendered = renderObservation(raw, { maxTotalChars: 100, stringRemedyMode: "suppressed" });
    expect(rendered).toContain("output reduced: +900 more chars");
    expect(rendered).not.toContain("substring");
  });

  it("fires onRemedyRendered('string') exactly when the remedy actually rendered on this path", () => {
    const rendered: string[] = [];
    renderObservation(raw, { maxTotalChars: 100, onRemedyRendered: (cls) => rendered.push(cls) });
    expect(rendered).toEqual(["string"]);

    const renderedNone: string[] = [];
    renderObservation("short", { maxTotalChars: 100, onRemedyRendered: (cls) => renderedNone.push(cls) });
    expect(renderedNone).toEqual([]);
  });

  describe('truncationBanner: "none" — the raw-string shortcut must ALSO go silent, not just the collection path', () => {
    it('drops the "output reduced" note entirely, but still slices the string to the cap', () => {
      const rendered = renderObservation(raw, { maxTotalChars: 100, truncationBanner: "none" });
      expect(rendered).not.toContain("output reduced");
      expect(rendered).not.toContain("⚠");
      // Still a valid JSON string literal, capped at 100 chars of content.
      expect(JSON.parse(rendered)).toBe(raw.slice(0, 100));
    });

    it("never fires onRemedyRendered under none — no clause to report", () => {
      const rendered: string[] = [];
      renderObservation(raw, { maxTotalChars: 100, truncationBanner: "none", onRemedyRendered: (cls) => rendered.push(cls) });
      expect(rendered).toEqual([]);
    });

    it('default (unset) is unchanged — "full" banner still present', () => {
      const rendered = renderObservation(raw, { maxTotalChars: 100 });
      expect(rendered).toContain("output reduced");
    });

    it("an under-budget string is unaffected either way (nothing to silence)", () => {
      const full = renderObservation("short", { maxTotalChars: 100 });
      const none = renderObservation("short", { maxTotalChars: 100, truncationBanner: "none" });
      expect(full).toBe(none);
    });
  });
});
