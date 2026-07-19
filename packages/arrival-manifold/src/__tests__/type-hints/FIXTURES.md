# Type-hints spine fixtures — the acceptance contract

This is the human-readable twin of `spine-fixtures.test.ts` (Ring 3). Each row is one scheme
program run against a fixture `arrival-manifold` env, through the REAL spine
(`createSpineLens` → `selectHints` → `renderHint`), driven by the ACTUAL codes TS fires — see
`docs/working-proposals/research/type-lowering-premises-audit.md` and this package's own
`src/__tests__/json-schema-to-ts.test.ts` integration matrix for the evidence.

**Revision note (2026-07-04):** the original table assumed kwargs mistakes fire 2345 (wrong
value type) / 2353 (any typo). Both audits found this wrong — the checker localizes a
wrong-typed keyword VALUE to its property assignment (**2322**, not 2345) and shadows 2353
with a did-you-mean code (**2561**) whenever a near-name candidate exists (2353 fires only
when there is NONE). `HINT_WHITELIST` was revised accordingly
(`docs/working-proposals/manifold-type-hints-s2-spine.md` §9b). This table is rewritten to
the observed reality, keeping the same mistake CLASSES the design targets, plus a new row
proving the context-define recipe (§9a) actually carries typing across "iterations".

| # | program | context | erroredStatementIndexes | expected code | expected render fragment | class |
|---|---|---|---|---|---|---|
| 1 | `(fx/set_count :count "five")` | — | `[0]` (real runtime error) | `2322` | `expected`/`actual` populated; render mentions `(string->number` | wrong kwarg VALUE TYPE |
| 2 | `(fx/search :query "x" :max_result 5)` | — | `[0]` **by fiat** (see caveat below) | `2561` | `propertyName: "max_result"`, `candidateProperties` contains `"max_results"` | CLOSE-typo kwarg (did-you-mean shadows 2353) |
| 3 | `(fx/search :query "x" :zzzzz_unrelated 5)` | — | `[0]` **by fiat** | `2353` | `propertyName: "zzzzz_unrelated"`, no close candidate | FAR-typo kwarg (no did-you-mean) |
| 4 | `(define (add2 a b) (+ a b)) (add2 1)` | — | `[1]` (real runtime arity error; the `define` succeeds — needs batch 1c's `define`→`const`) | `2554` | — (arity subsumes the `Signature:` echo) | arity on a SCHEME-DEFINED lambda (never a tool call — tool calls lower to one kwargs object, doc §5) |
| 5 | `(define (double x) (* x 2)) (fx/set_count :count (double 21))` | — | `[]` (both genuinely succeed) | n/a | n/a — `selectHints(...)` returns `[]` | precision floor / false-positive canary (polarity) |
| 6 | `(fx/set_count :count bad_count)` | `["(define bad_count \"not-a-number\")"]` | `[0]` (real runtime error — the context define's value is a string) | `2322`, `actual` = `"string"` (TS widens a `const`'s literal initializer at a later reference site) | mentions `(string->number` | CONTEXT-DEFINE CARRYOVER — proves the recipe (re-lowered context source, §9a) actually types `bad_count`, not just "some error fired": a broken/absent context wiring would instead surface an UNBOUND-name diagnostic (2304, off-whitelist → empty selection), not 2322/"string" |
| 7 | (sweep, not its own program) | — | — | — | every hint rendered by rows 1-3 and 6 avoids `Cons<`, `readonly`, `Promise<`, `/TS\d{4}/`, `undefined` | doc §4 "TS never leaks" |

## Fixture tools (bound via the real `buildManifoldEnv`, not a mock)

| qualified name | schema | invoke behavior |
|---|---|---|
| `fx/set_count` | `{ count: number }` (required) | throws if `typeof args.count !== "number"` |
| `fx/search` | `{ query: string }` required, `{ max_results?: number }` optional | throws if `typeof args.query !== "string"`; otherwise echoes `query` |

`fx/set_count` and `fx/search` self-validate their own inputs — a real upstream MCP tool that
receives a wrongly-typed argument either throws or returns `isError: true` (both surface as a
runtime `Error:` block per `manifold-tool.ts`'s frozen error contract), so the fixture's
runtime behavior matches production, not just its schema shape.

## Known ambiguities (flagged, not resolved here — see the agent's final report)

1. **Rows 2/3's activation-policy gap** (unchanged from the prior revision): the kwargs-typo
   call does not itself runtime-error (arrival's kwargs runtime tolerantly drops the unknown
   key), so `erroredStatementIndexes: [0]` is supplied BY FIAT to isolate the spine's
   diagnostic *mechanics* from the separate, undecided *activation* question of whether
   production ever calls `selectHints` for an on-success statement. Ring 2's integration
   suite (already built, `src/__tests__/type-hints/integration.test.ts`) owns that wiring
   question.
2. **Dropped from the prior table: accessor-misuse ("`:total` on a list-returning call" →
   "map over it").** `json-schema-to-ts.ts`'s `toolArrowType` types every tool's RETURN as
   `unknown` for v1, BY DESIGN (its own header comment traces why — `structuredContent` is an
   opt-in MCP capability most servers never declare, and even when declared this harvest
   performs no runtime validation that it conforms). A property read on an `unknown` value is
   TS **18046** ("'x' is of type 'unknown'"), which is NOT and should NOT be whitelisted (an
   unqualified unknown-property warning on every tool-result access would be noise, not
   signal). This fixture class is **structurally unreachable given the current harvest** and
   is dropped rather than faked; see the final report.
3. **Dropped: "list-where-scalar fires some whitelisted code, unspecified which."** Now
   specified: it fires 2322 (the same "wrong kwarg value type" class as row 1), so it is not a
   separate row — row 1 already covers it (a list argument is just another wrong-typed value).
