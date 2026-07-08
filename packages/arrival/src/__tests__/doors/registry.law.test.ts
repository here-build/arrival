// F6 — Doors (docs/test-suite-v2/DESIGN.md §F6, P5 errors-as-doors, P16 registry
// completeness as a sanctioned drift alarm). REGISTRY-DRIVEN: every row below comes
// from `WELL_KNOWN_SYMBOLS` (env/polyglot-rich-errors/registry.ts) — nothing here is
// hand-enumerated. The registry IS the test input (DESIGN.md's own framing): a door
// added without a registry row, or a registry row whose symbol no longer doors, is a
// completeness gap this file is built to surface.
//
// Three laws, one subject (the registry), so they share this file per DESIGN.md's
// "law files ... contain ONE law (possibly many rows)" — the "one law" here is
// "the registry accurately predicts runtime behavior," tested from three angles:
//   1. every "stubbed" row doors when called (production default env — the pack
//      ships in BASE_PACKS, see base-packs.ts).
//   2. every "famous" row's near-typo gets the LIVE enrichment the registry promises.
//   3. the registry itself is internally coherent (no canonical collisions) and the
//      grids above are not silently vacuous (P16 anti-vacuity floor).
//
// Sibling v1 files this ABSORBS coverage from (kept, not deleted — VERDICTS.md's
// migration sweep retires them later): polyglot-rich-errors-stubs.test.ts (item 1),
// polyglot-rich-errors-typo.test.ts (item 2 + the duplicate-canonical-names check).

import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";
import { PurityError } from "../../errors.js";
import { WELL_KNOWN_SYMBOLS, type WellKnownSymbolEntry } from "../../env/polyglot-rich-errors/registry.js";

const STUBBED = WELL_KNOWN_SYMBOLS.filter((e) => e.status === "stubbed");
const FAMOUS = WELL_KNOWN_SYMBOLS.filter((e) => e.status === "famous");

// ============================================================================
// 1. Every STUBBED well-known symbol doors with teaching
// ============================================================================
//
// Call shape: `(<name>)` — ZERO arguments, uniformly, for every entry regardless
// of the symbol's real arity. This is deliberate, not an oversight: per
// capability.ts's "door" binding (`env.set(verb, () => { throw new PurityError(...) })`),
// the door is a closure that throws UNCONDITIONALLY, before any argument is even
// looked at — JS doesn't enforce arity on a plain function, so calling with 0 args
// never reaches a "wrong number of arguments" problem. This sidesteps the exact
// arity trap `polyglot-rich-errors-stubs.test.ts` documents for setf/defun/
// with-open-file (calling WITH an unbound-variable argument evaluates that argument
// BEFORE the door fires, since doors are procedures, not macros) — zero arguments
// means nothing is evaluated before the call, so the door always fires cleanly.
// FIXED (was a KNOWN GAP, found by this suite): `symbol.notImplemented`'s
// `parseNameDoc` (common/symbols/_bake.ts) used to split the tagged template on the
// FIRST bare colon to separate `name` from `doc` — wrong for any canonical name that
// itself CONTAINS a colon, e.g. SRFI-14's `char-set:whitespace` / `char-set:alphabetic`
// / `char-set:numeric` (env/srfi/srfi-stubs.ts): `"char-set:whitespace: ${CHAR_SET_REASON}"`
// split at the colon between "char-set" and ":whitespace", truncating `def.name` to
// `"char-set"`. `parseNameDoc` now splits on the first ": " (colon-SPACE) instead — a
// colon inside a canonical name is never itself followed by a space, only the real
// name/doc separator is — so these three door with their full name, same as every
// other stubbed entry (formerly ledgered as "weak-door-colon-name-truncation" — GAPS
// row retired).

describe("F6 doors — every STUBBED well-known symbol doors with teaching (registry-driven)", () => {
  // Anti-vacuity floor (P16/F9): if this ever collapses to 0, `it.each` below
  // silently runs zero tests and the suite stays green while testing nothing.
  it("registry has at least one stubbed entry (anti-vacuity floor)", () => {
    expect(STUBBED.length).toBeGreaterThan(0);
  });

  /** Shared body: fires `(<name>)`, confirms a PurityError door, returns the message
   *  for the caller to assert the naming contract on (green grid asserts it holds;
   *  the `it.fails` grid below asserts the KNOWN violation). */
  async function fireDoor(name: string): Promise<string> {
    let caught: unknown;
    try {
      await exec(`(${name})`);
    } catch (e) {
      caught = e;
    }
    expect(caught, `expected (${name}) to throw`).toBeDefined();
    const direct = caught instanceof PurityError;
    const viaCause = (caught as { cause?: unknown })?.cause instanceof PurityError;
    const message = (caught as Error)?.message ?? String(caught);
    expect(direct || viaCause, `expected a PurityError door for \`${name}\`, got: ${message}`).toBe(true);
    return message;
  }

  /** (b) carries a substantive reason, not just the bare wall — the structural "Why:"
   *  marker is the door template's own teaching hinge (present iff a `def.reason` was
   *  supplied, which `symbol.notImplemented` always requires). Literal substring-
   *  matching this test against `entry.note` was tried and rejected: `note` is an
   *  INDEPENDENTLY-authored paraphrase (registry.ts's header: "SEEDED FROM" the real
   *  stub reasons, verified by grep, not copied verbatim) — e.g. `hash-table-
   *  exists?`'s note ("use @?") shares no substring with the shared `HASH_TABLE_
   *  REASON` blob its actual door throws, even though both are correct descriptions
   *  of the same door. A byte-match assertion would be fragile against wording drift
   *  on either side; the structural "Why:" + non-trivial length check is what stays
   *  true regardless of phrasing, while still failing loudly if a door's reason ever
   *  regresses to empty/near-empty. */
  function expectSubstantiveWhy(message: string): void {
    const whyMatch = message.match(/\bWhy:\s*(.+)$/s);
    expect(whyMatch, `expected a "Why:" reason clause in: ${message}`).not.toBeNull();
    expect(whyMatch![1].trim().length).toBeGreaterThan(15);
  }

  it.each(STUBBED.map((e): [string, WellKnownSymbolEntry] => [e.name, e]))(
    "(%s) doors: names the symbol + carries a substantive teaching reason",
    async (name, entry) => {
      const message = await fireDoor(name);
      // (a) names the symbol — capability.ts's door template is `${def.name} is not
      // available.\n  Why: ${def.reason}`, so the canonical name always leads the message.
      expect(message).toContain(entry.name);
      expectSubstantiveWhy(message);
    },
  );
});

// ============================================================================
// 2. Every FAMOUS-but-absent well-known symbol doors via typo enrichment
// ============================================================================
//
// A "famous" entry (today: only SRFI-1's bare `fold`) is neither bound nor
// stubbed — referencing the EXACT name gets the PLAIN "Unbound variable" (no
// hint: `richErrorFor`'s exact-match guard explicitly skips enrichment for an
// exact registered name — see registry.ts, and
// `polyglot-rich-errors-typo.test.ts`'s "does NOT fire for an EXACT well-known
// name" case). What the registry actually promises for "famous" status is that a
// NEAR-TYPO of it gets enriched with the "did you mean ... it is a well-known
// symbol but is not implemented" hint — that promise is what this grid exercises,
// LIVE, at the real `exec` throw site (Environment.ts/Resolver.ts/evaluator.ts).
describe("F6 doors — every FAMOUS-but-absent well-known symbol doors via typo enrichment (registry-driven)", () => {
  it("registry has at least one famous entry (anti-vacuity floor)", () => {
    expect(FAMOUS.length).toBeGreaterThan(0);
  });

  /** A single-character INSERTION at the end is always edit-distance 1 from
   *  `name` (Levenshtein), regardless of name/length/content — safe for any
   *  future "famous" entry without hand-picking a typo per row. */
  function deriveTypo(name: string): string {
    return `${name}z`;
  }

  const causeEnriched = async (src: string): Promise<{ enriched?: boolean; message: string }> => {
    try {
      await exec(src);
    } catch (e) {
      return { enriched: (e as Error & { cause?: { enriched?: boolean } }).cause?.enriched, message: (e as Error).message };
    }
    throw new Error(`expected exec to reject for: ${src}`);
  };

  it.each(FAMOUS.map((e): [string, WellKnownSymbolEntry] => [e.name, e]))(
    "a typo of famous `%s` throws an ENRICHED unbound-variable error naming it",
    async (name, entry) => {
      const typo = deriveTypo(name);
      const { enriched, message } = await causeEnriched(typo);
      expect(enriched, `expected .cause.enriched=true for typo \`${typo}\`, got message: ${message}`).toBe(true);
      expect(message).toContain(`did you mean \`${entry.name}\``);
      expect(message).toMatch(/not implemented in this runtime/);
    },
  );

  it("the EXACT famous name itself is NOT enriched (nothing to suggest — it either resolves or the stub itself doors it)", async () => {
    for (const entry of FAMOUS) {
      const { enriched } = await causeEnriched(entry.name);
      expect(enriched, `expected exact famous name \`${entry.name}\` to be unenriched`).toBe(false);
    }
  });
});

// ============================================================================
// 5. Completeness drift alarms (P16's sanctioned pins)
// ============================================================================
describe("F6 doors — registry completeness drift alarms", () => {
  // Mirrors registry.ts's private `canonicalize` (not exported — the transform is a
  // one-line, load-bearing-stable collapse, safe to inline rather than widen the
  // module's export surface for a test). FIXED (was a KNOWN GAP, found by this
  // suite): `canonicalize` used to strip EVERY non-`[a-z0-9]` character, so (a) a
  // name built ENTIRELY of punctuation collapsed to the empty string, and (b)
  // stripping `?`/`-` merged genuinely distinct BOUND symbols that differ only by a
  // trailing sigil — three collision groups existed in the table: "" ← `->`, `->>`,
  // `~>`, `~>>`, `@`, `@?`, `<>`; "dict" ← `dict`, `dict?`; "charset" ← `char-set`,
  // `char-set?`. `canonicalize` now strips ONLY word-separator noise (`-`/`_`/
  // whitespace) and keeps every other character (including a trailing `?`/`!` sigil
  // and the punctuation that IS an operator name's whole identity) significant —
  // `->` → `>`, `->>` → `>>`, `~>`/`~>>`/`@`/`@?`/`<>` unchanged, `dict?`/`char-set?`
  // stay distinct from `dict`/`char-set` — while still collapsing dash/underscore/
  // case/spacing variance for word-like names (`string_split`/`STRING-SPLIT`/
  // `String Split` all still collapse to `stringsplit`). Registry now has zero
  // canonical collisions (formerly ledgered as "weak-door-canonical-collision" —
  // GAPS row retired).
  const canonicalize = (s: string): string => s.toLowerCase().replace(/[-_\s]/g, "");

  it("registry has no duplicate CANONICAL names (drift alarm)", () => {
    const seen = new Map<string, string>();
    for (const entry of WELL_KNOWN_SYMBOLS) {
      const key = canonicalize(entry.name);
      const prior = seen.get(key);
      expect(prior, `canonical collision: \`${entry.name}\` collides with \`${prior}\` (both → \`${key}\`)`).toBeUndefined();
      seen.set(key, entry.name);
    }
  });

  it("registry has no duplicate EXACT names", () => {
    const seen = new Set<string>();
    for (const entry of WELL_KNOWN_SYMBOLS) {
      expect(seen.has(entry.name), `duplicate exact name \`${entry.name}\``).toBe(false);
      seen.add(entry.name);
    }
  });

  it("every status is one of the declared WellKnownStatus members (no silent typo status)", () => {
    const valid = new Set(["bound", "stubbed", "famous"]);
    for (const entry of WELL_KNOWN_SYMBOLS) {
      expect(valid.has(entry.status), `\`${entry.name}\` has unknown status \`${entry.status}\``).toBe(true);
    }
  });

  it("every non-bound entry (stubbed/famous) carries a note (the redirect this whole sub-capability exists to give)", () => {
    for (const entry of WELL_KNOWN_SYMBOLS) {
      if (entry.status === "bound") continue;
      expect(entry.note, `\`${entry.name}\` (${entry.status}) has no note`).toBeTruthy();
    }
  });

  // The "dead-registry-row" alarm proper: a STUBBED row whose symbol no longer
  // actually doors (renamed, un-registered, or demoted to a real binding without
  // updating this table) fails item 1's grid above — that grid IS this alarm, one
  // row per registry entry. Documented here as the completeness family's anchor so
  // a reader of THIS describe block finds the pointer without re-deriving it.
  it("dead-registry-row alarm is item 1's per-entry grid, not duplicated here", () => {
    expect(STUBBED.length + FAMOUS.length).toBeGreaterThan(0);
  });
});
