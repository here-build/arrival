/**
 * LEDGER F8 — the suite's truth table, owned in one place (P15).
 *
 * green = design · it.fails = documented gap (flips loudly when fixed) ·
 * it.todo = staged spec. This file indexes every gap/staging/inversion in the
 * suite so "what does green mean" is answerable mechanically. Each entry names
 * its GATE — the ruling or migration that flips it — and the law row that
 * replaces it.
 *
 * LEDGER CONVENTION (enforced below, not just documented): every `it.fails(...)`
 * call inside a SUNRISE dir (src/__tests__/{laws,membrane,provenance,ledger,
 * conformance,doors,agreement}/) must carry a `// @ledger: <id>` comment on the
 * line immediately above the call, where `<id>` is the exact `id` string of a
 * row in GAPS or INVERSIONS below. Example:
 *
 *   // @ledger: append drops element provenance
 *   it.fails("(append (list a) (list b)) keeps element ids", () => { ... });
 *
 * This is how the walker meta-test cross-references a red row back to its gate
 * without guessing by test name. The legacy (SUNSET) suite's `it.fails` calls
 * are NOT governed by this convention — the walker only scans the sunrise dirs.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface LedgerRow {
  readonly id: string;
  readonly gate: string; // ruling (R1-R7) or migration (bare-value-purge, reverse-membrane, region-discipline, conservation-repair, G2)
  readonly replacedBy: string; // the v2 law row
}

const GAPS: readonly LedgerRow[] = [
  // "append drops element provenance", "cdr spine unstamped", and "DR4 vector-map
  // re-box mints empty provenance" RETIRED (conservation repair landed): append's
  // rebuilt head and cdr's projected sub-spine now carry the deep-collapsed union
  // of their elements (P10), and AVector's map is box-preserving (P8) — see
  // provenance/conservation.law.test.ts §2 and laws/term-carrier map×AVector/AJSArray,
  // now plain `it()` rows.
  //
  // "equal? verdict is empty-provenance flyweight" RETIRED (R8 mint landed,
  // two-tier-exec-api.md §8 step 2): equal?/eq?/eqv? now route through
  // op-helpers.mintVerdict — see laws/term-carrier equals cells, now plain `it()`.
  // "container toJS leaves boxed element residue" RETIRED (R9 lazy egress landed,
  // two-tier-exec-api.md §5 step 3): AVector/APair/ADict egress as lazy ref-tracking
  // proxies (values/egress-proxy.ts) — elements unwrap through their own arrival/toJS
  // on first read; see laws/term-carrier toJS cells (now plain `it()`) and
  // membrane/crossing's R9 egress-law block. AJSArray was reframed, not fixed: a
  // borrowed source exits by IDENTITY (design §4), so residue planted in the source
  // is JS-side data, not membrane residue.
  { id: "A13 count-cone over-attribution", gate: "G2", replacedBy: "provenance/conservation" },
  { id: "exact/list JSON.stringify throws (BigInt backing)", gate: "numeric-json design", replacedBy: "membrane/crossing" },
  // "live AHalfBaked escapes exec under speculate" RETIRED (halfbaked-existence-review.md,
  // VERDICT KILL): AHalfBaked itself dissolved — the gap became UNREACHABLE, not fixed (no
  // carrier can exist anymore, so force-on-egress has nothing left to force). See
  // docs/test-suite-v2/REMOVAL-MANIFEST.md for the survivor row.
  { id: "null↔nil round-trip asymmetry", gate: "R1-adjacent ruling", replacedBy: "membrane/crossing null row" },
  { id: "schema-to-ts vector union not deduped", gate: "printer dedup follow-up", replacedBy: "type-layer suite" },
  // ── added by the two-tier-exec-api R8 mint sweep (step 2) ─────────────────────────
  // Surfaced while flipping the equal?-verdict flyweight rows above: mintVerdict
  // faithfully forwards operand provenance, but AJSArray (`borrow-array`'s `fromJS`)
  // and ADict (`dict`'s `new ADict(CONSTANT_CTX, ...)`, env/polyglot.ts) never stamp
  // their OWN top-level provenance with the R2 grouping-fact union at construction —
  // independent of R8, un-implemented (R2 is its own, later design item).
  { id: "AJSArray/ADict container carries no grouping-fact provenance", gate: "R2 container-provenance ruling", replacedBy: "laws/term-carrier equals cells (AJSArray/ADict)" },
] as const;

const INVERSIONS: readonly LedgerRow[] = [
  { id: "representation-blind equality (string/boolean boxed≡raw)", gate: "bare-value-purge", replacedBy: "laws/equality strict-door rows" },
  { id: "LAMBDA-branded fn passes jsToScheme by identity", gate: "reverse-membrane step 6", replacedBy: "membrane/crossing function row" },
  { id: "defineRosetta legacy arm authoring form", gate: "McpEnvCapability annotation-lifting", replacedBy: "capability baked-symbol suites" },
  { id: "bare-fn env.set harness wiring", gate: "reverse-membrane", replacedBy: "EnvCapability-wired fixtures" },
  { id: "z.procedure region-free callbacks", gate: "region-discipline", replacedBy: "membrane/region" },
  // "boolean raw exit via op-helpers short-circuit" RETIRED (R1 landed,
  // two-tier-exec-api.md §8 step 4): `exec`'s uniform plain-JS exit + the R8 mint
  // (step 2) together mean every predicate/comparison result is boxed BEFORE the
  // uniform unwrap — see membrane/crossing.law.test.ts's boolean exit row (now
  // plain `it()`, asserted against real `exec` output).
] as const;

// The sunrise family dirs this walker governs — mirrors vitest.sunrise.config.ts's
// include list (laws/membrane/provenance/ledger land now; conformance/doors/agreement
// are pre-declared per docs/test-suite-v2/DESIGN.md §2 and simply won't exist on disk yet).
const SUNRISE_DIRS = ["laws", "membrane", "provenance", "ledger", "conformance", "doors", "agreement"] as const;

const IT_FAILS_RE = /\bit\.fails\s*\(/;
const LEDGER_COMMENT_RE = /^\s*\/\/\s*@ledger:\s*(.+?)\s*$/;

const testsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectTestFiles(dir: string): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // dir doesn't exist yet (conformance/doors/agreement, pre-population)
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Walks every sunrise `.test.ts` file for `it.fails(` occurrences and checks each one's
 * immediately-preceding non-blank line for a `// @ledger: <id>` comment whose id resolves
 * against `knownIds`. Returns one human-readable violation string per problem found.
 */
function findUnledgeredFails(knownIds: ReadonlySet<string>): string[] {
  const violations: string[] = [];
  for (const dirName of SUNRISE_DIRS) {
    for (const file of collectTestFiles(join(testsRoot, dirName))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return; // doc-comment mentions don't count
        if (!IT_FAILS_RE.test(line)) return;
        let ledgerId: string | undefined;
        for (let back = idx - 1; back >= 0; back--) {
          const prev = lines[back];
          if (prev.trim() === "") continue; // blank lines don't break the search
          const match = prev.match(LEDGER_COMMENT_RE);
          if (match) ledgerId = match[1].trim();
          break; // first non-blank line decides it either way
        }
        const loc = `${file}:${idx + 1}`;
        if (!ledgerId) {
          violations.push(`${loc}: it.fails with no preceding "// @ledger: <id>" comment`);
        } else if (!knownIds.has(ledgerId)) {
          violations.push(`${loc}: @ledger id "${ledgerId}" has no matching GAPS/INVERSIONS row`);
        }
      });
    }
  }
  return violations;
}

describe("ledger — every gap names its gate", () => {
  it.each(GAPS.map((g) => [g.id, g] as const))("GAP %s", () => {
    /* index row — enforcement meta-test lands with the sweep */
  });
  it.each(INVERSIONS.map((g) => [g.id, g] as const))("INVERTS %s", () => {
    /* index row */
  });

  it("meta: no it.fails exists in the suite without a ledger row (walker)", () => {
    const knownIds = new Set([...GAPS, ...INVERSIONS].map((row) => row.id));
    const violations = findUnledgeredFails(knownIds);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it.todo("meta: no ledger gate references a ruling/migration that has already landed (staleness alarm)");
});
