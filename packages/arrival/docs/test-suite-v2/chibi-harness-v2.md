# Chibi Harness v2 — Design Doc

**Package root:** `/Users/jabher/WebstormProjects/dappsnap/foundations/arrival/arrival` (all `src/…`, `vendor/…`, `docs/…` paths below are relative to it; the reverse-membrane proposal lives at `/Users/jabher/WebstormProjects/dappsnap/docs/working-proposals/reverse-membrane-for-callables.md`).

## 0. Ground truth (verified)

| Fact | Where |
|---|---|
| Corpus: 2516 lines, 22 `test-begin` / 21 `test-end` (nested: "Read syntax" @2159 and "Numeric syntax" @2287 sit *inside* "6.13 Input and output" 1957–2477, all inside root "R7RS") | `vendor/chibi-scheme/tests/r7rs-tests.scm` |
| Test-form census: 917 top-level `(test …)`, 4 `test-error`, 9 `test-values`, 99 `test-numeric-syntax`, 0 top-level `test-assert`, plus **58 test forms nested inside top-level `(let () …)` blocks** (e.g. lines 47, 313–316, 1082–1089) — ≈ **1087 individual test forms**; 41 top-level `(define …)` setup forms | corpus, grep census |
| The corpus is genuinely stateful: `(let () (define count 0) … (test 6 (force p)) (test 6 (begin (set! x 10) (force p))))` requires the first `force`'s side effect | corpus lines 308–316 |
| v1 executes the whole file once, split by `test-begin` regex, per-section try/catch, then registers synthetic `it()` rows post-hoc | `src/__tests__/chibi-r7rs.spec.ts:393-450, 558, 561-620` |
| v1 strips complex literals with **content regexes** before parse | `src/__tests__/chibi-r7rs.spec.ts:61-74, 502-551` |
| v1 reports expected failures as `it.skip` — they can never flip loudly | `src/__tests__/chibi-r7rs.spec.ts:602-606` |
| v1 comparator uses `valueOf` duck-tolerance and `String(a) === String(b)` — a direct P4 violation | `src/__tests__/chibi-harness.ts:98-111` |
| `exec(code, { env })` is the glass path: defines land in the passed env, budget via `budgetMs` | `src/eval/generator-exec.ts:117-124, 166-174, 351-353` |
| `Environment.inherit` is an O(1) child frame; `_lookupWithResolvers` walks *every frame's resolvers* on a miss | `src/Environment.ts:125-130, 140-153` |
| `fromJS`/`toJS` are strict doors (already-boxed / non-scheme values throw) | `src/membrane.ts:229-233, 264-269` |
| `applyCallback` is the single reverse-invocation seam; `z.procedure()` is the sanctioned callable codec | `src/values/primitives/ACallable.ts:206-226`, `src/common/scheme-zod.ts:545-575` |
| Reader is a per-datum async generator; complex literals door at read time via `complexDoor` | `src/reader/parse.ts:17-37`, `src/values/numbers.ts:29-37, 142-146` |
| Vitest 4.1.0; config sets no `sequence` overrides → tests within a file run sequentially in registration order; workers parallelize across **files** only | `package.json:134`, `vitest.config.ts:4-11` |
| Top-level `await` at collection time is already proven in this repo | `src/__tests__/chibi-r7rs.spec.ts:558` |

---

## 1. Architecture

Three phases, one spec file:

```
collection time (top-level await)          test time (it bodies)
┌─────────────────────────────┐            ┌──────────────────────────────┐
│ buildManifest(corpusText)   │            │ CorpusRunner (shared, module │
│  • structural form splitter │            │  scope, one env per file)    │
│  • per-form reader parse    │───steps───▶│  it(step) → runner.outcome() │
│  • datum classification     │            │   • exec pending setups      │
│  • verdictFor(registries)   │            │   • exec THIS test form      │
└─────────────────────────────┘            │   • harness sink → outcome   │
        │                                  │   • compare via scheme equal?│
        ▼                                  └──────────────────────────────┘
 it / it.fails / it.skip / it.todo registered IN CORPUS ORDER
```

- **Manifest** (§3) is built once at collection via top-level await: the corpus is split into an ordered list of *steps* — `setup`, `test`, `block` (a `let` containing nested tests), `unreadable` (reader door), `section` markers.
- **One `it()` per test form** (requirement 1): the spec iterates steps in corpus order and registers a real vitest row whose body *drives that form's evaluation* through `runner.outcomeFor(step)`. The verdict from the registries picks the registration flavor (`it` / `it.fails` / `it.skip` / `it.todo`).
- **CorpusRunner** owns the single shared env (built like `freshEnv()`, `src/__tests__/_fresh-env.ts:35-45`, with the v2 harness capability assembled on top via `assembleEnv` — the same path v1 uses at `chibi-r7rs.spec.ts:411`). It keeps a monotone cursor: `outcomeFor(step)` executes all pending `setup` steps before `step.index`, then execs the test form itself with `exec(step.text, { env, budgetMs: STEP_BUDGET_MS })`. The harness capability's `js-run-test` hook deposits the outcome into a one-slot sink the runner reads back.
- **`it.each` note (deliberate deviation):** partitioning rows into `it.each(runRows)` + `it.fails.each(failRows)` would reorder registration and therefore execution — fatal under the shared-env strategy. Registration is a plain ordered loop dispatching per-row to the right `it` flavor; `it.each` may still be used for *contiguous same-verdict runs* since that preserves order, but it's cosmetic. Ordering is additionally *guarded*, not assumed: `outcomeFor` throws if asked to run a step below the cursor without a cached outcome ("corpus steps executed out of order — check vitest sequence config").

### Block steps (the 58 nested tests)

A top-level `(let () (define …) (test …) (test …))` is one evaluation unit — its inner tests share a lexical frame that cannot be split. Design: the block is a single *execution* with k *outcome slots*. Each nested test still gets its own `it()`; the **first** member's `it` body triggers the block's execution (during test phase, not collection), and every member consumes its slot from the sink. If the block aborts mid-way (a door in an inner form), members after the abort point get an explicit `block-aborted` outcome carrying the abort error — each still a red row with forensics, triaged into the registries. This is the honest boundary of "one it executes one form": the unit of *evaluation* is the top-level form; the unit of *verdict* is the test form. Stated, not hidden.

### Per-step budget

Each `exec` gets `budgetMs` (`src/eval/generator-exec.ts:166-174`) so a wedge (v1's infinite-macro-expansion hazard, `chibi-r7rs.spec.ts:417-420`) becomes a red row with a budget error instead of a hung run + `CHIBI_TRACE` archaeology.

---

## 2. Env-state strategy — decision

**Chosen: (a) ordered sequential `it`s sharing one env within one spec file.**

Verified premise: vitest 4 runs tests within a file sequentially in registration order unless `sequence.shuffle`/`concurrent` is set; this repo's config sets neither (`vitest.config.ts:4-11`). Cross-file worker parallelism is safe because the env, sink, and cursor are module-scoped to the single spec file — no shared mutable state crosses a worker boundary.

Tradeoff accepted: no per-test retry/isolation — a crash in setup step N poisons later rows. Mitigated by (i) the cursor recording *which* setup failed and stamping that into every downstream failure message (§7), and (ii) per-step budget so poisoning is loud and attributed, never a wedge.

Rejected alternatives:

- **(b) checkpoint/fork via `env.inherit()`.** The fork itself is O(1) (`src/Environment.ts:125-130`), but it doesn't buy isolation: closures minted by earlier tests capture their *creation* frame by reference — forking the tip cannot rewind a captured `count` (corpus 308–316), so the "snapshot" is a lie for exactly the stateful cases that motivate it. And chained per-test layers build a ~1100-deep chain where every miss walks `_lookupWithResolvers` through every frame's resolver list (`src/Environment.ts:140-153`) — a real slowdown for zero real isolation. Rejected: false isolation at real cost.
- **(c) prefix-replay with memoization.** True isolation, but memoization cannot cross env identity (a replayed prefix mints fresh closures), so it degenerates to full replay: O(n²) ≈ 600k form evaluations — far outside the 60s envelope. Replaying side-effecting forms (`force`/`delay` counters) also *changes* semantics. Rejected.
- **(d) two-phase dependency analysis.** Requires sound free-variable analysis *through macro expansion* (test forms reference macros defined mid-corpus, e.g. the whole "4.3 Macros" section). An unsound analysis silently reorders stateful tests — the worst possible failure mode is wrong-but-green, which is precisely what P15 forbids the harness to risk. Rejected: complexity buys a hazard.

---

## 3. Manifest format

```ts
// src/__tests__/chibi/manifest.ts
export type TestFormKind = "test" | "test-assert" | "test-error" | "test-values" | "test-numeric-syntax";

export interface RawForm { text: string; line: number }               // splitter output

export type Step =
  | { kind: "section-begin"; name: string; line: number }
  | { kind: "section-end"; line: number }
  | { kind: "setup"; index: number; section: string; text: string; line: number }
  | (TestStep & { nested: false })
  | { kind: "block"; index: number; section: string; text: string; line: number; members: TestStep[] }
  | { kind: "unreadable"; index: number; section: string; text: string; line: number; readerError: string };

export interface TestStep {
  kind: "test";
  index: number;            // corpus order, execution key
  section: string;          // innermost group ("6.2 Numbers")
  sectionPath: string[];    // full nesting for describe blocks
  formKind: TestFormKind;
  text: string;             // exact source slice (forensics + execution)
  line: number;             // r7rs-tests.scm line
  name: string;             // display: normalized form text, ≤200 chars
  symbols: ReadonlySet<string>; // every identifier in the parsed datum (registry matching)
  slot?: number;            // outcome slot within a block, when nested
}

export interface Manifest {
  corpusPath: string;
  steps: Step[];
  tests: TestStep[];        // flattened, includes block members
}
```

Built by: structural splitter (§6) → per-form `readerParse` (`src/reader/parse.ts:39-50`) → head-symbol classification of the datum (`test*` heads; `let`/`letrec` heads scanned for nested `test*` members; everything else → `setup`). `symbols` is a datum walk collecting identifier names — this is what registries match on, replacing v1's substring matching over stringified names.

---

## 4. Registry tables

```ts
// src/__tests__/chibi/registries.ts
export type Matcher =
  | { kind: "symbols"; anyOf: readonly string[] }   // matches if the datum references any of these identifiers
  | { kind: "form"; exact: string }                 // whitespace-normalized exact form text (one-off rows)
  | { kind: "section"; name: string };              // whole-group (v1's EXCLUDED_GROUPS, spec.ts:336-338)

export interface Exclusion       { match: Matcher; feature: string; note?: string }        // → it.skip (design omission: ports, call/cc, values, records, complex, env-reification)
export interface ExpectedFailure { match: Matcher; reason: string; gate: string }          // → it.fails; gate = plan doc / issue that closes it
export interface Staged          { match: Matcher; spec: string }                          // → it.todo (P14-style staging ledger)

export type Verdict =
  | { run: "it" }
  | { run: "skip"; feature: string }
  | { run: "fails"; reason: string; gate: string }
  | { run: "todo"; spec: string };
```

Precedence: excluded > expected-failure > staged > run. The vitest taxonomy IS the ledger (P15, `docs/PRINCIPLES.md:216-229`): green = design, `it.fails` = documented gap that **flips red the day it's fixed** (vitest `fails` semantics: the row fails when the body *passes*), `it.skip` = feature omitted by design, `it.todo` = staged. This fixes v1's silent expected-failure skips (`chibi-r7rs.spec.ts:602-606`).

Registry self-checks (P16's sanctioned harness self-check category, `PRINCIPLES.md:231-240`), run as their own `it`s:
- **dead-rule alarm**: every rule must match ≥ 1 manifest row (a rule orphaned by an upstream fix must be deleted, loudly);
- **over-match alarm**: an `ExpectedFailure` rule matching > its declared `maxMatches` (optional field, default unlimited) — protects sibling tests that pass (the v1 count-to-2 vs count-to-2_ hazard, `chibi-r7rs.spec.ts:224-228`).

Semantic note on exclusions under the shared env: an `it.skip` row's form is *never evaluated*. Excluded features are exactly the forms that door at eval, so this matches v1's behavior — but if a future exclusion covers a state-producing test, downstream breakage surfaces as red rows pointing at the skipped index (forensics carry the cursor history), which is the correct loud outcome.

---

## 5. Comparison through the membrane — decision

**Scheme-side.** Both `expected` and `actual` stay boxed; the harness capability's prelude defines the comparator *in scheme* (`equal?` extended with chibi's float-epsilon rule, structurally recursive — the shape already drafted at `chibi-harness.ts:224-233` but currently unused); `js-run-test` invokes it via `applyCallback` and only the **boolean verdict** crosses out.

Why (P4/P7/P9):
- P4 (`PRINCIPLES.md:85-97`): one representation per side. A JS-side deep-equal requires `toJS` of both values — two crossings that exist only to compare, importing representation-blindness. v1's comparator is the named offender: `valueOf` duck-tolerance and `String(a) === String(b)` (`chibi-harness.ts:98-111`) — exactly the boxed-or-raw acceptance P4 forbids.
- P9 (`PRINCIPLES.md:152-160`): `toJS` is a lossy projection — exact `1` and inexact `1.0` both project to JS `1`, so JS-side comparison would *pass tests the spec distinguishes* (`eqv?` exactness rows in 6.1). The comparison must happen where the distinction exists.
- P7 (`PRINCIPLES.md:124-137`): equality is the class's protocol (`equals`); a hand-rolled JS deep-equal is a competing representation authority.

What crosses, per test: the thunks (scheme closures held boxed by JS, invoked through `applyCallback`), one `ABool` verdict, and — only on failure — two repr strings produced by the class-owned print protocol (`["arrival/print"]` / `toString`, P7-clean protocol dispatch) for the error message.

---

## 6. Reader-level pre-processing — the principled replacement

v1 strips complex forms with content regexes over raw text (`chibi-r7rs.spec.ts:61-74, 502-551`). v2 replaces pattern-matching-on-content with **reader feature-detection per top-level form**:

1. A **structural** splitter cuts the corpus into top-level form slices. It understands only lexical structure — paren/bracket depth, strings, `;` line comments, nested `#| |#` block comments (3 in corpus), `#\` char literals, `#;` datum-comment prefixes (13, mostly in the excluded "Read syntax" group) — and matches **no content patterns whatsoever**. (This is the honest kernel of v1's `stripComplexForms` scanner, `spec.ts:502-551`, promoted from "find complex forms" to "find form boundaries".)
2. Each slice is parsed independently with the real reader (`readerParse`, `src/reader/parse.ts:39-50`). A slice whose parse throws becomes an `unreadable` manifest step carrying the reader's own door message (`complexDoor`'s teaching text, `src/values/numbers.ts:29-37`) — the *reader is the detector*, not a regex approximating the reader.
3. `unreadable` steps get their own `it.skip` rows via an Exclusion rule matching the door message/feature (`feature: "complex tower (R7RS §6.2.3 omitted)"`) — so the ~99+ numeric-syntax complex rows remain visible, counted, and attributed in the vitest tree instead of vanishing pre-parse.

Why not stream-parse the whole file and skip bad datums: `_parse` is a generator (`parse.ts:17-37`) but resume-after-throw is not part of the Parser's contract; per-form parse over structural slices needs no such contract. The isolation also means one unreadable form can never abort its section — the exact failure v1's regexes existed to prevent.

---

## 7. Failure forensics

One error class, built by the runner:

```
[6.2 Numbers] (test 3 (reverse-subtract 7 10))        r7rs-tests.scm:70
  expected: 3
  actual:   4
  section context: 6.2 Numbers (step 214/1087); 3 setup forms executed in this section,
                   last: (define reverse-subtract (lambda (x y) (- y x))) @ r7rs-tests.scm:66
```

Fields: exact source form + corpus `file:line` (from the manifest slice), scheme reprs of expected/actual datums (class-owned print protocol, §5), error text + phase (`expected-eval` / `actual-eval` / `compare` / `budget` / `block-aborted` / `setup-failed@line`) when the failure is a throw, and the section cursor context. All strictly better than v1's `expected ${String(r.expected)}, got ${String(r.actual)}` (`chibi-r7rs.spec.ts:615-619`).

---

## 8. Reverse-membrane integration points

| # | Crossing | Direction | Mechanism |
|---|---|---|---|
| 1 | Harness hooks bound into the env | JS → scheme, assembly | `EnvCapability` with `symbol.native` hooks + scheme prelude, assembled via `assembleEnv` — same path as v1 (`chibi-harness.ts:113-289`) and production (`generator-exec.ts:79-87`) |
| 2 | Per-step evaluation | JS drives scheme | `exec(step.text, { env, budgetMs })` — the forward door (`generator-exec.ts:273-294`) |
| 3 | `test` macro → `js-run-test name expected-thunk actual-thunk` | scheme → JS | v2 macro defers **both** operands as thunks (v1 evaluates `expected` eagerly, `chibi-harness.ts:242-247`, losing attribution when the expected expression itself doors). Contract: `input: [z.value, z.lambda, z.lambda]` — the thunks arrive as boxed `ACallable`s |
| 4 | Thunk invocation | JS re-enters scheme | `applyCallback(thunk, [], runCtx)` — the single seam (`ACallable.ts:206-226`), `canBounce=false` by contract. Region discipline (§7c of the reverse-membrane doc) is satisfied by construction: every re-entry happens *inside* the `js-run-test` invocation that received the thunk, never stashed — no detached-scope capability needed |
| 5 | Comparison | JS re-enters scheme | comparator (prelude-defined lambda, fetched once from the env) invoked via `applyCallback` with the two **boxed** results; one `ABool` verdict returns |
| 6 | Forensic reprs | scheme → JS, failure only | class-owned print protocol per value → string |
| 7 | Outcome delivery | none | the sink is a JS closure inside the capability — no crossing |

`z.procedure()`'s decode arm (`scheme-zod.ts:556-560`) is the typed alternative to #4; v2 uses `z.lambda` + explicit `applyCallback` because the runner must thread the step's `runCtx`/try-catch itself — the codec's wrapper would hide the seam the harness exists to exercise. Noted as a deliberate choice, revisit when the region-scope token (§7c) lands and the codec becomes the richer door.

---

## 9. Module layout + API stubs (all new)

```
src/__tests__/chibi/
  manifest.ts            — splitter + classifier → Manifest
  registries.ts          — typed rule tables + verdictFor + coherence checks
  harness-capability.ts  — v2 EnvCapability (macros, hooks, comparator prelude, sink)
  runner.ts              — CorpusRunner (env, cursor, outcomes, forensics)
src/__tests__/chibi-r7rs-v2.spec.ts   — the spec (renames to chibi-r7rs.spec.ts at cutover)
```

```ts
// manifest.ts
export function splitTopLevelForms(text: string): RawForm[];
export async function buildManifest(corpusPath: string): Promise<Manifest>;
export function datumSymbols(datum: SchemeValue): ReadonlySet<string>;

// registries.ts
export const EXCLUDED: readonly Exclusion[];
export const EXPECTED_FAILURES: readonly ExpectedFailure[];
export const STAGED: readonly Staged[];
export function verdictFor(step: TestStep): Verdict;
export function registryCoherenceFindings(manifest: Manifest): string[]; // dead/over-match rules

// harness-capability.ts
export type OutcomePhase = "expected-eval" | "actual-eval" | "compare";
export type StepOutcome =
  | { kind: "pass" }
  | { kind: "fail"; expectedRepr: string; actualRepr: string }
  | { kind: "error"; phase: OutcomePhase | "budget" | "block-aborted" | "setup-failed"; message: string; atLine?: number };
export interface OutcomeSink { drain(): StepOutcome[] }
export function createChibiHarnessV2(): { capability: EnvCapability; sink: OutcomeSink };

// runner.ts
export class CorpusRunner {
  static async create(manifest: Manifest): Promise<CorpusRunner>;   // freshEnv + assembleEnv(harness)
  outcomeFor(step: TestStep): Promise<StepOutcome>;                 // advances cursor; execs pending setups + owning form; caches block slots
  failureError(step: TestStep, outcome: StepOutcome): Error;        // §7 forensics
}

// chibi-r7rs-v2.spec.ts (shape)
const manifest = await buildManifest(CHIBI_TESTS_PATH);             // top-level await, proven pattern
const runner = await CorpusRunner.create(manifest);
// ordered loop: describe per sectionPath; per TestStep dispatch on verdictFor():
//   it / it.fails / it.skip / it.todo — registered in corpus order
// + anti-vacuity its (below) + registry-coherence its
```

**Anti-vacuity** (requirement 5, all structural — computed from the manifest/registries at collection, not runtime survival):
- `manifest.tests.length ≥ 1000` (census today: ≈1087) — corpus-parse floor;
- runnable rows (`verdict = it`) `> 500` — preserves v1's floor (`chibi-r7rs.spec.ts:625-628`) as a *registration-time* count;
- registered rows `=== manifest.tests.length` — no row silently dropped between manifest and vitest.

## 10. Perf envelope

- Manifest build: one structural scan of 2516 lines + ~1150 small `readerParse` calls ≈ the cost of v1's single whole-file parse split 1150 ways — low single-digit seconds, once, at collection.
- Execution: total eval work ≈ v1's single pass (same forms, same env) — "seconds" today. Added per-step cost: one `exec` call per form instead of per section (settled-promise bootstrap await + `makeRunContext` + `Resolver` construction, `generator-exec.ts:299-369` — sub-ms each) ≈ 1150 × ~1ms ≈ 1–2s.
- Vitest per-`it` overhead: ~0.5–1ms × ~1150 rows ≈ ~1s.
- Worst case: v2 runs *past* v1's section-abort points (v1 header, `chibi-r7rs.spec.ts:19-23`), adding evaluation of previously-unreached forms — bounded by `STEP_BUDGET_MS` (e.g. 5000ms) per form; realistic wall-clock estimate **10–20s**, hard-bounded well under 60s unless dozens of forms hit the budget (each of which is a red row demanding triage anyway).

## 11. Migration / coexistence

1. **Land v2 alongside** as `chibi-r7rs-v2.spec.ts` + `src/__tests__/chibi/*`. v1 (`chibi-r7rs.spec.ts` + `chibi-harness.ts`) untouched and still gating.
2. **Registry transcription**: port v1's `EXCLUDED_TESTS`/`EXPECTED_FAILURES`/`EXCLUDED_GROUPS` (`chibi-r7rs.spec.ts:80-338`) into typed matchers — substring rules become `symbols` matchers where the substring was an identifier, `form` matchers where it was an expression snippet. Every `ExpectedFailure` gets its `gate` filled from the reasons already written there (purity pass plan, pre-L1 macro gaps, etc.).
3. **Expect registry growth**: per-form execution surfaces rows v1's section aborts never reached (`spec.ts:19-23`). Each new red row is triaged: design omission → Exclusion, gap → ExpectedFailure with gate. This triage *is* the parity work.
4. **Cutover gates** (all must hold before v1 deletion): v2 structural floor green (≥1000 rows, >500 runnable); v2 green count ≥ v1's passed count; registry coherence green (no dead rules); every v1 expected-failure row accounted for in v2's ledger (skip/fails/green-with-rule-deleted).
5. **Delete** v1 spec + `chibi-harness.ts`; rename v2 spec to `chibi-r7rs.spec.ts`.

### Critical Files for Implementation

- /Users/jabher/WebstormProjects/dappsnap/foundations/arrival/arrival/src/__tests__/chibi-r7rs.spec.ts — the v1 harness being replaced; source of registries to transcribe and the section-abort semantics v2 deliberately runs past
- /Users/jabher/WebstormProjects/dappsnap/foundations/arrival/arrival/src/__tests__/chibi-harness.ts — v1 capability; v2's `harness-capability.ts` inherits its `EnvCapability` shape and retires its `valueOf` comparator
- /Users/jabher/WebstormProjects/dappsnap/foundations/arrival/arrival/src/eval/generator-exec.ts — `exec`/`ExecOptions` (glass env path, `budgetMs`) that every step execution rides
- /Users/jabher/WebstormProjects/dappsnap/foundations/arrival/arrival/src/values/primitives/ACallable.ts — `applyCallback`, the reverse-membrane seam for thunk + comparator invocation
- /Users/jabher/WebstormProjects/dappsnap/foundations/arrival/arrival/src/reader/parse.ts — the per-form reader parse that replaces textual complex-stripping with feature-detection
