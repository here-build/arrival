import { CATALOG_CAPS } from "./catalog-budget.js";
import { describe, expect, it } from "vitest";

import { buildCatalog } from "../catalog.js";

// The preamble is asserted as STORYTELLING BEATS, not scattered phrase pins. Each beat row
// carries: the narrative role, WHY its anchors are the load-bearing phrases (so a failing
// regex explains itself), the anchors that must be present, and the anti-patterns that must
// stay absent (negative-form guards and hype registers). Two properties no phrase pin can
// express are asserted separately: the beats appear in chain order, and the whole preamble
// stays under its token budget.

interface Beat {
  beat: string;
  /** Why these anchors are the load-bearing phrases of this beat. */
  why: string;
  /** Identifying phrases: delete the beat's content and these fail together. */
  anchors: readonly RegExp[];
  /** Anti-patterns this beat must never regress into. */
  absent: readonly RegExp[];
}

const BEATS: readonly Beat[] = [
  {
    beat: "WORLD — contrast frame + single-tool fact",
    why:
      "a category claim ('programming environment') updates the model's MCP=single-shot prior; " +
      "intensity adverbs (SotA, next-generation) would be discounted as README noise",
    anchors: [/not an ordinary MCP tool/, /programming environment/, /only tool you can call/],
    absent: [/next-generation|SotA|state.of.the.art/i],
  },
  {
    beat: "SENTENCE — call grammar by anchor",
    why:
      "'keyword arguments' borrows the model's prior (the old &key/**kwargs double analogy is " +
      "redundant next to it); omission is taught positive-form — 'never write a bare :keyword' " +
      "rehearsed the wrong pattern verbatim (ironic priming), the bare-keyword error is door territory",
    anchors: [/keyword arguments/, /any order, one value each/i, /omitting its pair entirely/i],
    absent: [/never write a bare/i, /&key/, /kwargs/i],
  },
  {
    beat: "PROGRAM — composition affordance",
    why:
      "the worked examples smuggle the rules without rule sentences: nesting, keyword access, " +
      "define-persistence, SRFI presence",
    anchors: [
      /writing programs, not single calls/,
      /defines persist across calls/,
      /Compose instead of round-tripping/,
    ],
    absent: [],
  },
  {
    beat: "REPLY — results model + truncation hazard",
    why:
      "the Clojure/EDN anchor delivers the notation by recognition. The truncation line was " +
      "RE-PINNED 2026-07-14 (benchmark-defect-register.md §B1/§D): the old 'elided is gone; " +
      "re-fetch it' was FALSE (elision is display-only; the bound value is intact) and it " +
      "contradicted the dedup door's 'do not re-run identical calls' — the guidance triangle. " +
      "Both models read it as DATA LOSS and permanently fled to mcp-code-executor python. The " +
      "anchor now pins the truth (INTACT + filter in-program) and forbids the old lie. " +
      "'object-typed param takes that same literal' closes the 16-round alist trap (§B6).",
    anchors: [/Clojure-style/, /\{:key value\}/, /-> shape/, /INTACT/, /object-typed param/],
    absent: [/elided is gone/, /re-fetch it/],
  },
  {
    beat: "BOUNDS — evidenced safety",
    why:
      "safety is argued from mechanism (pure + budgeted + per-statement recovery), not asserted; " +
      "fear/punishment vocabulary would ironically prime the aversion it tries to remove",
    anchors: [
      /pure except the bound tools/,
      /per-call time budget/,
      /safe place to experiment/,
      /error message is educational/,
    ],
    absent: [/afraid|punish/i],
  },
];

describe("buildCatalog — storytelling beats", () => {
  it.each(BEATS)("$beat — anchors present, anti-patterns absent", ({ anchors, absent }) => {
    const text = buildCatalog([]);
    for (const anchor of anchors) expect(text).toMatch(anchor);
    for (const pattern of absent) expect(text).not.toMatch(pattern);
  });

  it("the beats read in chain order — WORLD→SENTENCE→PROGRAM→REPLY→BOUNDS", () => {
    // The storytelling chain is an ORDER property: each section answers the question the
    // previous one raises. Asserted structurally via each beat's first anchor position.
    const text = buildCatalog([]);
    const positions = BEATS.map(({ anchors }) => text.search(anchors[0]!));
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].toSorted((a, b) => a - b));
  });

  it.each([
    // The cap is a live guard, not a one-time measurement: it must be re-measured whenever
    // committed preamble prose grows, or a quietly-stale cap stops guarding anything.
    //
    // The `display` HOST EXTENSION line's headroom is BOUGHT, not conceded: `(display …)`
    // hits a hard door on a meaningful fraction of real task runs, costing a full wasted
    // round each time. One line of preamble against that many runs losing a round is a
    // trade worth making deliberately.
    { mode: "available", cap: CATALOG_CAPS.available },
    { mode: "required", cap: CATALOG_CAPS.required },
    { mode: "off", cap: CATALOG_CAPS.off },
  ] as const)("stays lean in attestation '$mode' — measured size + ~8% headroom", ({ mode, cap }) => {
    // The cap is the anti-creep guard: the preamble rides EVERY LLM call, so any addition
    // must displace something or move behind a door. Signatures are excluded deliberately —
    // they scale with the bound-tool count, not with prose creep — and every mode is capped,
    // not just the default.
    expect(buildCatalog([], { attestation: mode }).length).toBeLessThan(cap);
  });
});

describe("buildCatalog — capability inventory from live-bound slugs (affordance precedes planning)", () => {
  // A model that concludes a domain is unreachable punts to the user with zero tool calls,
  // and no door can recover a call that was never made — the inventory is the affordance's
  // only channel. It is derived from live bindings by the composer — mechanism, never
  // editorial — and MUST stay domain-blind: no benchmark vocabulary, no path hints, no
  // capability nouns beyond the slugs themselves.
  const slugs = ["filesystem", "git", "memory"];

  it("renders the bound domains and the explore-before-asking pedagogy when slugs are passed", () => {
    const text = buildCatalog([], { serverSlugs: slugs });
    expect(text).toMatch(/span these domains: filesystem, git, memory\./);
    expect(text).toMatch(/explore with these functions before asking the user/);
  });

  it("renders INSIDE the WORLD beat — before the call-grammar sentence (affordance precedes planning)", () => {
    const text = buildCatalog([], { serverSlugs: slugs });
    expect(text.indexOf("span these domains")).toBeGreaterThan(text.indexOf("only tool you can call"));
    expect(text.indexOf("span these domains")).toBeLessThan(text.indexOf("Call a bound tool"));
  });

  it("absent without slugs — the zero-binding catalog makes no reachability claim (H-3: never over-claim)", () => {
    expect(buildCatalog([])).not.toMatch(/span these domains/);
  });

  it("absent when every slug is empty — the bare-name single-server shape has no domain name to claim", () => {
    expect(buildCatalog([], { serverSlugs: [""] })).not.toMatch(/span these domains/);
  });

  it("stays domain-blind: derived slug list only, no invented capability prose", () => {
    const text = buildCatalog([], { serverSlugs: slugs });
    // The only capability words permitted are the slugs themselves + the generic pedagogy —
    // a capability noun in the fixed sentence ("files", "repositories") would claim a domain
    // that may not be bound.
    expect(text).not.toMatch(/\/data|atlas|sandbox container/i);
    expect(text).not.toMatch(/\bfiles\b|\brepositories\b/);
  });

  it("chain order survives the inventory insertion", () => {
    const text = buildCatalog([], { serverSlugs: slugs });
    const positions = BEATS.map(({ anchors }) => text.search(anchors[0]!));
    expect(positions).toEqual([...positions].toSorted((a, b) => a - b));
  });

  it("budget holds with a realistic slug set", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `server-${i}`);
    expect(buildCatalog([], { serverSlugs: twenty }).length).toBeLessThan(2900);
  });
});

describe("buildCatalog — structure", () => {
  it("renders the preamble followed by one signature line per tool, in binding order", () => {
    const text = buildCatalog([
      { params: [], signatureText: "(github_search-issues :query string) - Search issues" },
      { params: [], signatureText: "(slack_send :channel string :text string) - Send a message" },
    ]);
    expect(text).toContain("(github_search-issues :query string) - Search issues");
    expect(text).toContain("(slack_send :channel string :text string) - Send a message");
    expect(text.indexOf("github_search-issues")).toBeLessThan(text.indexOf("slack_send"));
    expect(text).toMatch(/repl-input-scheme-program/);
  });

  it("says plainly that nothing is connected when there are no bound tools", () => {
    const text = buildCatalog([]);
    expect(text.toLowerCase()).toContain("no tools");
  });

  it("still renders a tool's declared -> shape verbatim", () => {
    const text = buildCatalog([
      { params: [], signatureText: "(weather_get-forecast) -> {temp:number} - Get the forecast" },
    ]);
    expect(text).toContain("(weather_get-forecast) -> {temp:number} - Get the forecast");
  });

  it("detail 'summary' keeps the preamble but replaces the signature list with the caller's summaryText", () => {
    const text = buildCatalog(
      [{ params: [], signatureText: "(slack_send-message :channel string) - Send a Slack message" }],
      { detail: "summary", summaryText: "Discover apps with (apis.api_docs.show_api_descriptions ...)." },
    );
    // Preamble (interpreter specifics) is needed truth — always stays.
    expect(text).toMatch(/repl-input-scheme-program/);
    expect(text).toMatch(/only tool you can call/);
    // The signature dump is gone; the caller's summary body is rendered instead.
    expect(text).not.toContain("slack_send-message");
    expect(text).toContain("Discover apps with (apis.api_docs.show_api_descriptions ...).");
  });

  it("detail 'summary' with no signatures still renders the preamble + summaryText, not the 'No tools connected' fallback", () => {
    const text = buildCatalog([], { detail: "summary", summaryText: "Discovery verbs are in-world." });
    expect(text).toContain("Discovery verbs are in-world.");
    expect(text).not.toMatch(/no tools connected/i);
  });

  it('throws when detail is "summary" but summaryText is missing/empty', () => {
    expect(() => buildCatalog([], { detail: "summary" })).toThrow(/summaryText/);
    expect(() => buildCatalog([], { detail: "summary", summaryText: "" })).toThrow(/summaryText/);
  });

  it('detail "full" (explicit or default) is byte-identical', () => {
    const signatures = [{ params: [], signatureText: "(github_search-issues :query string) - Search issues" }];
    expect(buildCatalog(signatures, { detail: "full" })).toBe(buildCatalog(signatures));
  });
});
