/**
 * LEDGER F8 — the suite's truth table, owned in one place (P15).
 *
 * green = design · it.fails = documented gap (flips loudly when fixed) ·
 * it.todo = staged spec. This file indexes every gap/staging/inversion in the
 * suite so "what does green mean" is answerable mechanically. Each entry names
 * its GATE — the ruling or migration that flips it — and the law row that
 * replaces it.
 *
 * LEDGER CONVENTION (enforced below, not just documented): every `it.fails(...)` /
 * `it.fails.each(...)` / `test.fails(...)` call in ANY `*.test.ts` / `*.spec.ts` under src/
 * (node_modules, dist, __benchmarks__, __experiments__ excluded) must carry a
 * `// @ledger: <id>` comment on the line immediately above the call, where `<id>` is the exact
 * `id` string of a row in GAPS or INVERSIONS below. Example:
 *
 *   // @ledger: async sort comparator support
 *   it.fails("fixed vector pattern: ...", () => { ... });
 *
 * This is how the walker meta-test cross-references a red row back to its gate without guessing
 * by test name. The REVERSE check runs too: every GAPS/INVERSIONS id must be cited by at least
 * one `// @ledger: <id>` line somewhere in src (a row nobody cites is dead weight or a gap that
 * lost its test); a STAGED id must be cited by NO `it.fails` (staged = todo, not red-expected).
 *
 * EXEMPT — chibi registry rows. `run: "fails"` rows in
 * src/__tests__/scheme-compliance/chibi/registries*.ts are data, not `it.fails(` literals; they
 * are governed by their own `gate` field and the registry-completeness drift alarms. The two
 * spec files that turn those rows into tests dispatch through one `it.fails(` literal each
 * (variable label, no per-row tag possible) and are exempted by name in CHIBI_DISPATCH_SPECS (as is this file).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface LedgerRow {
  readonly id: string;
  readonly gate: string; // ruling (R1-R7) or migration (bare-value-purge, reverse-membrane, region-discipline, conservation-repair, G2)
  readonly replacedBy: string; // the v2 law row
}

const GAPS: readonly LedgerRow[] = [
  { id: "schema-to-ts vector union not deduped", gate: "printer dedup follow-up", replacedBy: "type-layer suite" },
  // ── ADict top-level provenance stamping ───────────────────────────
  // Surfaced while flipping the equal?-verdict flyweight rows above: mintVerdict
  // faithfully forwards operand provenance, but AJSArray (`borrow-array`'s `fromJS`)
  // and ADict (`dict`'s `new ADict(...)`, env/polyglot/polyglot.ts) never stamp
  // their OWN top-level provenance with the R2 grouping-fact union at construction —
  // independent of the equal?-verdict mint (R8), un-implemented (R2 is its own, later design item).
  // NARROWED to ADict (2026-07-14). It never applied to AJSArray: production DOES stamp a borrowed
  // container with the crossing's provenance (rosetta's inbound `array → borrowed AJSArray` claim,
  // `new AJSArray(v, p)`). The apparent gap was a FIXTURE artifact — `borrow-array` minted
  // through `fromJS`, which deliberately drops provenance (CONSTANT_CTX / EMPTY_PROVENANCE), so the
  // test was building a container production never builds and then ticketing the absence as a code
  // gap. With the fixture crossing its args honestly (V's hygiene law), AJSArray's cells pass on
  // their own merits. ADict's gap is real and stays open.
  {
    id: "ADict container carries no grouping-fact provenance",
    gate: "R2 container-provenance ruling",
    replacedBy: "laws/term-carrier equals cells (ADict)",
  },
  // ── Q9 W1 agreement corpus findings (docs/PROVENANCE.md §7 W1 agreement; provenance/
  // wireframe-agreement.law.test.ts's "FINDINGS" section) — surfaced running the
  // extended generator corpus against BOTH the eager oracle and the wireframe
  // builder. Territory this wave is test files only (builder.ts/uneval.ts are
  // Q8c's); each row below is a REAL divergence, root-caused, awaiting a builder-
  // side fix in a later wave. Three are Q8a's OWN documented first-landing limits
  // (builder.ts's header comment, named there verbatim); two are newly surfaced by
  // this corpus and are NOT conflated with the three documented ones.
  {
    id: "letrec local-closure mux under-designation",
    gate: 'Q8c/Q9-follow-up builder fix (Q8a documented LIMIT, builder.ts header: "A local closure (letrec-bound lambda) wrapping a port under-designates a mux whose selector calls it")',
    replacedBy:
      "provenance/wireframe-agreement.law.test.ts's letrec-closure-mux row, once selectorReachesPort can see through a letrec-bound closure",
  },
  {
    id: "non-tail begin sink sequencing over-includes source",
    gate: 'Q8c/Q9-follow-up builder fix (Q8a documented LIMIT, builder.ts header: "A sink cut in non-tail begin position leaves the wire a sequencing reference to the sink node (D6 territory) — tolerated, not modeled")',
    replacedBy:
      "provenance/wireframe-agreement.law.test.ts's non-tail-begin row, once reachableNodes (or the builder) stops treating a dropped sink's ingress as reachable from the tail value",
  },
  {
    id: "field-shaped pure ops not projection-aware (car/cons sibling leak)",
    gate: "V ruling pending (Q21 audit 2026-07-10: survived the whole Q-track — Q8c built fact wires and Q17 flipped demand-monotonicity WITHOUT a `field` WireframeNode; whether one is added, and where it cuts, is a design ruling. Q9 finding — no `field` WireframeNode is built yet for car/cdr/:field/@ accessors, so a projection's sibling side is NOT pruned from the prospective cone the way the real accessor prunes it from the eager value; distinct from R2 demand-monotonicity, Q8c/Q17's SEPARATE deferred field-DEMAND-lattice concern — this is the ordinary full/flat cone over-including a sibling the runtime provably never touches)",
    replacedBy:
      "provenance/wireframe-agreement.law.test.ts's car/cons row, once a `field` node routes the projection the way §1/§2 describe",
  },
  // ── surfaced by the walker widening to every src test file ────────────
  {
    id: "async sort comparator support",
    gate: "async sort comparator support (a sync lambda eval path or an async sort); today an ALambda comparator hits the AsyncSortComparatorError door",
    replacedBy: "env/srfi srfi-palette lambda-comparator row, once sort accepts lambda comparators",
  },
] as const;

// Empty: both historical rows ("forbidden bare-fn authoring form" — now rejected at the type
// level, capability.test-d.ts; "bare-fn env.set harness wiring" — W8 landed, fixtures bind via
// EnvCapability) are closed. A new `[INVERTS: gate]` row lands here with a citing tag.
const INVERSIONS: readonly LedgerRow[] = [] as const;

/**
 * STAGED — §7 spec-law rows that are LEDGER-ONLY (docs/PROVENANCE.md §7 law table):
 * they get a row here citing their flipping step but no law-test body yet. The surviving
 * row below has no `it.todo`/`it.fails` call anywhere in the suite — this index entry IS
 * its only test-suite presence today.
 * Distinct from GAPS/INVERSIONS (which index real `it.fails` rows the walker below
 * cross-references): a STAGED row is neither a documented gap nor a deliberate
 * inversion, it's a §7 law the plan has explicitly deferred giving a body to.
 */
const STAGED: readonly LedgerRow[] = [
  {
    id: "loop-unroll",
    gate: 'first loop-cone consumer wave — the wireframe-walking driver / P11 drill-in (the row SURVIVED the Q-track completion audit (2026-07-10), never silently dropped. docs/PROVENANCE.md §7: "widened vs exact-via-count cones" (finding #19). Both sides\' machinery exists since Q16 — widened loop cones refuse per-wire γ with ReplayScopeError and reconstruct via aggregation count + playback — so the law is BODY-able; nobody has staged its body because no consumer demands the widened-vs-exact comparison yet)',
    replacedBy: "a future `provenance/track-cone.law.test.ts` it.todo row, once its consumer wave stages the body",
  },
  {
    id: "closure nodes — loop binder replay (row 25)",
    gate: "a consumer demands wire-γ over loops. named-let COULD lift cheaply (a recur node's value = the interior replayed with the next params — tail call as recursion), but `do` cannot: its exit test is value-dropped (no mux for continue/stop — a builder precision LIMIT) so its interior carries no termination structure; lifting is also a design change to replay.law's D4 loop door (loops reconstruct via aggregation count + playback). Until then row 25 builds (binder.captures, no unbound slot) but replays via replayProgramWithPlayback",
    replacedBy: "closure-nodes.law.test.ts row 25 record-then-replay, once binder replay lands",
  },
  {
    id: "closure nodes — not representable (LIMITs)",
    gate: "NOT a gap in the closure design — named so nobody files them as closure bugs: (1) runtime code absent from the wireframe — macro-introduced ports and eval/load of source text (representable only over span-propagated EXPANDED forms, or by treating eval as a port); (2) host-determined call order (sort comparator, host JS calling an exported closure) — values replay, ORDER is the host-schedule record (PROVENANCE §3 I3); (3) a named-let/do loop NAME escaping as a first-class value — degrades to `opaque` (a loop is a binder, not a closure); (4) closures over mutable state — none exist while the mutator family is doored; opening a `set!` door voids the sealed-capture invariant; (5) in-γ closure calls are one step-walk step for the wire (the interior is replayable standalone by its template hash)",
    replacedBy: "docs/PROVENANCE.md §1 LIMITs (closure nodes); nothing to flip unless the named design change lands",
  },
  {
    id: "provenance store emission — production arming",
    gate: "first host consumer wires `ExecOptions.emission` (src/eval/provenance-hooks.ts); content identity is SHA-256/128 (store/hash.ts: store/emit.ts hashPayload, wireframe/hash.ts; offload.ts keeps only a 32-bit PRNG seed) — hash tags are -v1 and nothing is persisted yet, so the production host must pin the tag/epoch at that gate",
    replacedBy: "store emission law rows armed by a production host",
  },
] as const;

/**
 * KNOWN_LAYERING_LEAKS — places where a core module names a DOWNSTREAM product's vocabulary.
 * Core depends on nothing above itself, so each of these is a deliberate, documented leak (a
 * leaf string literal, never an import) rather than a gap or a staged law: nothing flips them
 * red, and there is no gate to land — they stay until the downstream name can be injected by
 * the host. Neither GAPS (real `it.fails` rows), INVERSIONS, nor STAGED (law bodies not yet
 * written) fits, so they get their own table. The law below asserts each cited file still
 * contains its `needle`, so a leak that is removed (or moved) forces this note to be updated
 * instead of rotting.
 */
interface LayeringLeak {
  readonly id: string;
  readonly file: string; // relative to src/
  readonly needle: string; // text that must still appear in `file`
  readonly note: string;
}

const KNOWN_LAYERING_LEAKS: readonly LayeringLeak[] = [
  {
    id: "manifold envelope arg names in kwargs rejection",
    file: "common/kwargs-rejection.ts",
    needle: 'new Set(["response-size", "response-attachments", "eval-timeout-ms"])',
    note: "ENVELOPE_ARG_NAMES duplicates the manifold's per-call envelope arg names as leaf string literals (the manifold depends on core, never the reverse) so a dropped `:response-size` on an inner tool call gets a pointed NOTE.",
  },
  {
    id: "@dotprompt: scope marker in provenance scope-id",
    file: "provenance/scope-id.ts",
    needle: 'DOTPROMPT_SOURCE_MARKER = "@dotprompt:"',
    note: "userCallSite recognises the `.prompt` generated-lambda source marker minted by a downstream dotprompt resolver; core only knows the string, not the package.",
  },
] as const;

// Exempt by name: the two chibi dispatch specs (one variable-label `it.fails(` literal generating registry rows each) and this file.
const CHIBI_DISPATCH_SPECS: ReadonlySet<string> = new Set([
  "__tests__/scheme-compliance/conformance/chibi-srfi1.spec.ts",
  "__tests__/scheme-compliance/conformance/chibi-r7rs-v2.spec.ts",
  "__tests__/ledger/index.law.test.ts", // this file: the walker's own regex/message literals mention `it.fails(`
]);

const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "__benchmarks__", "__experiments__"]);
const TEST_FILE_RE = /\.(?:test|spec)\.ts$/;
const IT_FAILS_RE = /\b(?:it|test)\.fails(?:\.each)?\s*[(`]/;
const LEDGER_COMMENT_RE = /^\s*\/\/\s*@ledger:\s*(\S.*)$/;

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function collectTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }) as Dirent[]) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...collectTestFiles(full));
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

interface Scan {
  /** One entry per governed `it.fails` call: where it is and the id of the tag above it. */
  readonly fails: { loc: string; id: string | undefined }[];
  /** Every `// @ledger: <id>` line anywhere in src (ids as written). */
  readonly tags: Set<string>;
  /** Tag ids sitting directly above an `it.fails`. */
  readonly failTags: Set<string>;
}

function scanSrc(): Scan {
  const scan: Scan = { fails: [], tags: new Set(), failTags: new Set() };
  for (const file of collectTestFiles(srcRoot)) {
    const rel = path.relative(srcRoot, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      const tag = line.match(LEDGER_COMMENT_RE);
      if (tag) scan.tags.add(tag[1].trim());
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) return; // doc-comment mentions don't count
      if (!IT_FAILS_RE.test(line) || CHIBI_DISPATCH_SPECS.has(rel)) return;
      let id: string | undefined;
      for (let back = idx - 1; back >= 0; back--) {
        const prev = lines[back];
        if (prev.trim() === "") continue; // blank lines don't break the search
        const match = prev.match(LEDGER_COMMENT_RE);
        if (match) id = match[1].trim();
        break; // first non-blank line decides it either way
      }
      if (id) scan.failTags.add(id);
      scan.fails.push({ loc: `src/${rel}:${idx + 1}`, id });
    });
  }
  return scan;
}

function findUnledgeredFails(scan: Scan, knownIds: ReadonlySet<string>): string[] {
  return scan.fails.flatMap(({ loc, id }) =>
    id
      ? knownIds.has(id)
        ? []
        : [`${loc}: @ledger id "${id}" has no matching GAPS/INVERSIONS row`]
      : [`${loc}: it.fails with no preceding "// @ledger: <id>" comment`],
  );
}

describe("ledger — every gap names its gate", () => {
  it.each(GAPS.map((g) => [g.id, g] as const))("GAP %s", () => {});
  it.each(INVERSIONS.map((g) => [g.id, g] as const))("INVERTS %s", () => {});

  it.each(STAGED.map((g) => [g.id, g] as const))("STAGED %s", () => {});

  it("meta: no it.fails exists in the suite without a ledger row (walker)", () => {
    const knownIds = new Set([...GAPS, ...INVERSIONS].map((row) => row.id));
    const violations = findUnledgeredFails(scanSrc(), knownIds);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("meta: every GAPS/INVERSIONS row is cited by a tag; STAGED rows by no it.fails (reverse check)", () => {
    const scan = scanSrc();
    const violations = [
      ...[...GAPS, ...INVERSIONS]
        .filter((r) => !scan.tags.has(r.id))
        .map((r) => `row "${r.id}" is cited by no "// @ledger:" tag`),
      ...STAGED.filter((r) => scan.failTags.has(r.id)).map(
        (r) => `STAGED "${r.id}" is cited by an it.fails (staged = todo)`,
      ),
    ];
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("meta: the walker is not vacuous (finds tagged it.fails across src)", () => {
    expect(scanSrc().fails.length).toBeGreaterThan(5);
  });

  it.each(KNOWN_LAYERING_LEAKS.map((l) => [l.id, l] as const))(
    "LEAK %s — the cited code still exists (note cannot rot)",
    (_id, leak) => {
      const text = readFileSync(path.join(srcRoot, leak.file), "utf8");
      expect(text, `${leak.file} no longer contains ${leak.needle} — update or drop this row`).toContain(leak.needle);
    },
  );

  it.todo("meta: no ledger gate references a ruling/migration that has already landed (staleness alarm)");
});
