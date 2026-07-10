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
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface LedgerRow {
  readonly id: string;
  readonly gate: string; // ruling (R1-R7) or migration (bare-value-purge, reverse-membrane, region-discipline, conservation-repair, G2)
  readonly replacedBy: string; // the v2 law row
}

const GAPS: readonly LedgerRow[] = [
  // "W4 accumulation death" (REWORK-DAG.md P10's own exit-gate phrase: "eager mode
  // demoted to oracle; 186MB failure mode gone (R3 benchmark)") RETIRED at Q20b
  // (PROVENANCE-PLAN.md; docs/PROVENANCE.md §4 C12): op-helpers.ts's
  // `eagerProvenanceOracleEnabled` default flipped false → production hot paths
  // accumulate ZERO stamps unless something explicitly opts in (a test's
  // beforeAll, the CI agreement oracle, or a replay running inside a silent
  // region — see op-helpers.ts's `isEagerAccumulationActive`). Two hand-rolled
  // `unionProvenance` call sites that bypassed `withInputProvenance` entirely
  // (`env/r7rs/numeric.ts`'s `applyNumeric`/`numberToStringFn` — EVERY arithmetic
  // op) were gated on the same switch in-step; without that fix arithmetic would
  // have kept accumulating unconditionally, silently defeating the default flip
  // for the single highest-traffic operation category. Proven end-to-end (not
  // just at op-helpers.ts's own boundary) by `laws/oracle-optout.law.test.ts`'s
  // "W4" row: a real program run through the real interpreter with untouched
  // default flags carries EMPTY provenance. Never had an `it.fails` row (the
  // 186MB failure mode was a memory-growth characterization, not a law-test
  // gap) — recorded here per this ledger's "no ledger gate references a
  // ruling/migration that has already landed" spirit, so the P10 phrase has a
  // present-tense home instead of only living in REWORK-DAG.md's superseded
  // P-track.
  //
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
  // "A13 count-cone over-attribution" RETIRED (c27b2e8b62, C1/C2/C4): length reads the
  // container's own facts — golden-prov-fan + conservation.law rows flipped GREEN. The
  // G2 gate is CLOSED; row kept as comment because a stale GAPS entry is silent false
  // debt (the walker only enforces @ledger on it.fails — grounded-audit find).
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
  // Carried from clone-identity.test.ts (docs/test-suite-v2/REMOVAL-MANIFEST.md §A) — the
  // one still-open site of the `=== nil` identity-equality sweep (docs/archaeology/
  // nil-clone-sweep.md). `schemeToJs`'s entry point special-cases `value === nil` instead
  // of `instanceof ANil`, so a provenance-bearing Nil clone (minted by
  // `restrictControlFlowProvenance`) falls through to the generic `return value` branch
  // and hands back a Nil object where callers expect `null`.
  { id: "nil-clone schemeToJs entry loses identity", gate: "rosetta.ts:70 fix", replacedBy: "laws/identity" },
  // Sunset-suite row (not walker-governed — this file lives under env/r7rs/__tests__, outside
  // the SUNRISE_DIRS this ledger's own walker scans; recorded here anyway per the G3 sunset-
  // cutover triage's own instruction to name every genuine gap). "list->array" was never a
  // bound scheme symbol in any pack (repo-wide grep confirms; R7RS itself has no such builtin)
  // — it's purely an internal error-message label for the pack-local listToArray helper. The
  // test predates the LIPS-legacy dissolution sweep and needs retiring/redirecting, not a
  // reintroduced symbol.
  { id: "list->array phantom symbol", gate: "sunset-suite cleanup pass", replacedBy: "n/a — test retirement, not a feature to land" },
  // ── Q9 W1 agreement corpus findings (PROVENANCE-PLAN.md Q9; provenance/
  // wireframe-agreement.law.test.ts's "FINDINGS" section) — surfaced running the
  // extended generator corpus against BOTH the eager oracle and the wireframe
  // builder. Territory this wave is test files only (builder.ts/uneval.ts are
  // Q8c's); each row below is a REAL divergence, root-caused, awaiting a builder-
  // side fix in a later wave. Three are Q8a's OWN documented first-landing limits
  // (builder.ts's header comment, named there verbatim); two are newly surfaced by
  // this corpus and are NOT conflated with the three documented ones.
  {
    id: "letrec local-closure mux under-designation",
    gate: "Q8c/Q9-follow-up builder fix (Q8a documented LIMIT, builder.ts header: \"A local closure (letrec-bound lambda) wrapping a port under-designates a mux whose selector calls it\")",
    replacedBy: "provenance/wireframe-agreement.law.test.ts's letrec-closure-mux row, once selectorReachesPort can see through a letrec-bound closure",
  },
  {
    id: "non-tail begin sink sequencing over-includes source",
    gate: "Q8c/Q9-follow-up builder fix (Q8a documented LIMIT, builder.ts header: \"A sink cut in non-tail begin position leaves the wire a sequencing reference to the sink node (D6 territory) — tolerated, not modeled\")",
    replacedBy: "provenance/wireframe-agreement.law.test.ts's non-tail-begin row, once reachableNodes (or the builder) stops treating a dropped sink's ingress as reachable from the tail value",
  },
  {
    id: "cond => receiver approximation loses test-value dependency",
    gate: "Q8c/Q9-follow-up builder fix (Q8a documented LIMIT, builder.ts's buildCondMux: \"A `=>` clause's receiver is approximated as the arm — its applied-to-test threading is classifyCond's combine(\\\"=>\\\"), deferred here\")",
    replacedBy: "provenance/wireframe-agreement.law.test.ts's cond=> row, once the arm wire models applying the receiver to the test's value instead of the raw closure",
  },
  // "do-loop result clause unreachable from recur node" RETIRED (Q9 follow-up builder
  // fix, builder.ts's `buildDoBinder`): the result clause now walks under a synthetic
  // `let` frame rebinding every loop variable to a cut sentinel pointed at the `recur`
  // node's id (mirrors `unevalWire`'s own let-frame rewrap) — the egress wire's
  // paramRefs carry a real node ref into `recur`, so `reachableNodes` walks into
  // whatever the step expressions reach, same as named-let gets for free from its
  // literal tail-position recursive call. See provenance/wireframe-agreement.law.
  // test.ts's do-loop row, now a plain `it()`.
  // "first-class source reference bypasses role dispatch (A21 HOF hole)" RETIRED
  // (V ruling, 2026-07-10: "we need to provenance rosetta-to-rosetta; we actually
  // do not care on reassignments here"): `walkForCuts` (builder.ts) now designates
  // a node for a declared-role name (source/sink/fan/loop) occurring as a bare
  // VALUE, not only at an application head — `(define (call-source f) (f))
  // (call-source fetch-item)`'s `fetch-item` argument now cuts to a `source` node
  // at the occurrence, so the prospective cone includes it. Deliberately still OUT
  // of scope, per the ruling: chasing an ALIAS to its later call site (a let-bound
  // name later applied) — no alias-tracking machinery was added. See provenance/
  // wireframe-agreement.law.test.ts's first-class-HOF row, now a plain `it()`.
  {
    id: "field-shaped pure ops not projection-aware (car/cons sibling leak)",
    gate: "V ruling pending (Q21 audit 2026-07-10: survived the whole Q-track — Q8c built fact wires and Q17 flipped demand-monotonicity WITHOUT a `field` WireframeNode; whether one is added, and where it cuts, is a design ruling. Q9 finding — no `field` WireframeNode is built yet for car/cdr/:field/@ accessors, so a projection's sibling side is NOT pruned from the prospective cone the way the real accessor prunes it from the eager value; distinct from R2 demand-monotonicity, Q8c/Q17's SEPARATE deferred field-DEMAND-lattice concern — this is the ordinary full/flat cone over-including a sibling the runtime provably never touches)",
    replacedBy: "provenance/wireframe-agreement.law.test.ts's car/cons row, once a `field` node routes the projection the way §1/§2 describe",
  },
] as const;

const INVERSIONS: readonly LedgerRow[] = [
  // "representation-blind equality (string/boolean boxed≡raw)" RETIRED (bare-value-purge/A4
  // landed, docs/REWORK-DAG.md): op-helpers.ts withInputProvenance/ANil length/
  // Environment.set no longer produce a raw scalar anywhere inside the membrane, so no
  // INTERNAL producer can hand equal?/eq?/eqv? an unboxed operand during real scheme
  // execution. VERDICT — not a strict-door throw: AString/ABool's Setoid-level
  // representation-blindness is independently pinned as DURABLE by scheme-string-
  // algebra.test.ts and boolean-landmine-regression.test.ts (both verified "Clean" —
  // unrelated to this purge, not scheduled to change) — a throw would contradict those
  // siblings, the exact aspirational-door case the purge warns against. See
  // laws/equality.law.test.ts (relocated from equality-representation.test.ts, G2) and
  // tagless-final-equals.test.ts's LANDMINE pin for the full reasoning; both retagged off
  // `[INVERTS: bare-value-purge/P4]`.
  // "LAMBDA-branded fn passes jsToScheme by identity" RETIRED (reverse-membrane-for-
  // callables.md §3 step 1, 2026-07-09): named-let's loopFn — the LAMBDA brand's last live
  // producer per the B4 audit — is a real ALambda now, so the identity-pass-through law is
  // unconditional on `instanceof AValue` (jsToScheme's first case), no brand check involved.
  // The LAMBDA brand itself was deleted (well-known-symbols.ts) along with its readers
  // (membrane.ts isSchemeValue, rosetta.ts jsToScheme, print.ts functionRepr). See
  // membrane-symmetry.test.ts's retagged "a real ALambda passes through jsToScheme by
  // identity" row, now a plain `it()`.
  { id: "defineRosetta legacy arm authoring form", gate: "McpEnvCapability annotation-lifting", replacedBy: "capability baked-symbol suites" },
  // "bare-fn env.set harness wiring" — PARTIALLY retired (B4 audit, 2026-07-09):
  // input-rest-runtime.test.ts / kwargs-runtime.test.ts converted to real
  // EnvCapability-wired fixtures. The pattern still has live instances elsewhere
  // (vector-map-promise-leak.test.ts, generator-exec.spec.ts, laws/_tables/fixtures.ts,
  // evaluator.spec.ts's two deliberately-kept Reflect.apply-fallback probes) — row stays
  // until those convert too (or are confirmed permanent test-harness shortcuts, same as
  // evaluator.spec.ts's pair).
  { id: "bare-fn env.set harness wiring", gate: "reverse-membrane", replacedBy: "EnvCapability-wired fixtures" },
  // "z.procedure region-free callbacks" RETIRED (B4 audit, 2026-07-09 — region-discipline/B3
  // landed 2026-07-09): membrane/region.law.test.ts's "z.procedure decode adopts the same
  // scope token" row is now a plain green `it()`; no `it.fails()` referenced this id.
  // "boolean raw exit via op-helpers short-circuit" RETIRED (R1 landed,
  // two-tier-exec-api.md §8 step 4): `exec`'s uniform plain-JS exit + the R8 mint
  // (step 2) together mean every predicate/comparison result is boxed BEFORE the
  // uniform unwrap — see membrane/crossing.law.test.ts's boolean exit row (now
  // plain `it()`, asserted against real `exec` output).
] as const;

/**
 * STAGED — §7 spec-law rows that are LEDGER-ONLY at Q5 (docs/PROVENANCE-PLAN.md: "Two
 * rows are LEDGER-ONLY, not stub files — they get an `@ledger` row citing their
 * flipping step but no law-test body yet"). The surviving row below has no `it.todo`/
 * `it.fails` call anywhere in the six Q5 stub files (`laws/provenance-roles`,
 * `provenance/{wireframe-agreement,replay,track-cone,track-stream}`,
 * `doors/tier-honesty`) — this index entry IS its only test-suite presence today.
 * Distinct from GAPS/INVERSIONS (which index real `it.fails` rows the walker below
 * cross-references): a STAGED row is neither a documented gap nor a deliberate
 * inversion, it's a §7 law the plan has explicitly deferred giving a body to.
 */
const STAGED: readonly LedgerRow[] = [
  {
    id: "loop-unroll",
    gate: "first loop-cone consumer wave — the wireframe-walking driver / P11 drill-in (Q21 audit 2026-07-10: the row SURVIVED the reconciliation audit per PROVENANCE-PLAN.md Q21's explicit requirement, never silently dropped. docs/PROVENANCE.md §7: \"widened vs exact-via-count cones\" — grok finding #19. Both sides' machinery exists since Q16 — widened loop cones refuse per-wire γ with ReplayScopeError and reconstruct via aggregation count + playback — so the law is BODY-able; nobody has staged its body because no consumer demands the widened-vs-exact comparison yet)",
    replacedBy: "a future `provenance/track-cone.law.test.ts` it.todo row, once its consumer wave stages the body",
  },
  // "memory retention" RETIRED at Q21 (audit 2026-07-10): its gate — Q19, the R3 hard
  // gate — LANDED (e8c5a37ea6). The staged substance ("sealed-value growth measured
  // against Appendix A budget — a benchmark assertion, not a law-test row") now EXISTS
  // as `__benchmarks__/provenance-budget.bench.test.ts`'s C1 conjunct (store accounting
  // vs the 128MB budget + raw process.memoryUsage ceiling) with the workerd C2 conjunct
  // covering real-eviction reconstruction. Same discipline as the A13 retirement above:
  // a STAGED row whose gate has landed is silent false debt, so it becomes a comment.
] as const;

// The sunrise family dirs this walker governs — mirrors vitest.sunrise.config.ts's
// include list (laws/membrane/provenance/ledger land now; conformance/doors/agreement
// are pre-declared per docs/test-suite-v2/DESIGN.md §2 and simply won't exist on disk yet).
const SUNRISE_DIRS = ["laws", "membrane", "provenance", "ledger", "conformance", "doors", "agreement"] as const;

const IT_FAILS_RE = /\bit\.fails\s*\(/;
const LEDGER_COMMENT_RE = /^\s*\/\/\s*@ledger:\s*(.+?)\s*$/;

const testsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectTestFiles(dir: string): string[] {
  // `readdirSync(dir, { withFileTypes: true })` (no `encoding`) resolves the
  // `Dirent[]` (i.e. `Dirent<string>`) overload — `ReturnType<typeof readdirSync>`
  // picks the OTHER (`encoding: "buffer"`) overload's `Dirent<Buffer>[]` instead,
  // since an overloaded function's `typeof` resolves to its last signature.
  let entries: Dirent[];
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

  it.each(STAGED.map((g) => [g.id, g] as const))("STAGED %s", () => {
    /* index row — a §7 law explicitly ledger-only at Q5, no test body yet */
  });

  it("meta: no it.fails exists in the suite without a ledger row (walker)", () => {
    const knownIds = new Set([...GAPS, ...INVERSIONS].map((row) => row.id));
    const violations = findUnledgeredFails(knownIds);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it.todo("meta: no ledger gate references a ruling/migration that has already landed (staleness alarm)");
});
